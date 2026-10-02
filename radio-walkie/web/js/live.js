'use strict';

/*
 * Живой эфир: станции других людей (приём) и своя станция (передача).
 */

const LIVE_RATE = 16000;   // частота дискретизации живого эфира, Гц
const LIVE_CHUNK = 640;    // сэмплов в одном пакете — 40 мс
const LIVE_JITTER = 0.22;      // запас на неровную доставку, с — минимум (на хорошей сети)
const LIVE_JITTER_MAX = 2.0;   // на плохой сети (2G/«одна палка») буфер сам растёт до этого, чтобы пережить рывки
const LIVE_MAX_LAG = 1.2;      // задержка выросла больше буфера — пересинхронизация, чтобы не копилась
// DTX: передатчик молчит в паузах — тишину в эфир не гоним (экономия трафика и меньше потерь на 2G).
// Хвост ~0.5 с после последнего звука, чтобы не рвать на коротких паузах; chunk 40 мс → 13 кадров.
const TX_HANGOVER = 13;

// Без ключа шифротекст звучит как цифровая рация: байты модулируются четырьмя тонами (4FSK)
const FSK4_TONES = [900, 1500, 2100, 2700];
const FSK4_BAUD = 2400;

/* Станция другого человека. Звук приходит пакетами с сервера. */
class LiveStation extends Station {
  constructor(info) {
    super({ id: `live-${info.id}`, freq: info.freq, name: info.name, seekable: true });
    this.remoteId = info.id;
    this.live = true;
    this.decrypted = false;
    this.lastChunk = -Infinity;
    this.playhead = 0;
    this.fskPhase = 0;
    this.jitter = LIVE_JITTER; // подстраивается под сеть: хуже связь — больше буфер
    this.good = 0;
    this.lastFrame = null;     // последний расшифрованный кадр — для маскировки потерь
    this.lastSeq = undefined;  // номер последнего пакета
    this.update(info);
  }

  update(info) {
    this.freq = info.freq;
    this.name = info.name;
    this.rds = String(info.name).toUpperCase();
  }

  // Звук отдаём непрерывному проигрывателю (один AudioWorklet-узел на станцию) вместо сотни
  // коротких буферов в секунду — так на телефоне не рвётся и не трещит. Если worklet не поднялся,
  // прозрачно падаем на старый путь (this.play/reserve), чтобы звук не пропал.
  build(ctx) {
    if (this.player) { try { this.player.disconnect(); } catch { /* уже */ } }
    const out = super.build(ctx);
    this.player = null;
    this._pQueue = [];
    try {
      const mod = (ctx.__livePlayerModule ??= ctx.audioWorklet.addModule('js/worklets/player.js'));
      mod.then(() => {
        if (this.ctx !== ctx) return; // станцию уже пересобрали/закрыли
        const node = new AudioWorkletNode(ctx, 'live-player', {
          channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
          processorOptions: { rate: LIVE_RATE, jitter: LIVE_JITTER },
        });
        node.connect(this.output);
        this.player = node;
        if (this._pQueue) for (const f of this._pQueue) node.port.postMessage({ samples: f });
        this._pQueue = null;
      }).catch(() => { this.player = null; this._pQueue = null; });
    } catch {
      this.player = null; this._pQueue = null;
    }
    return out;
  }

  // Один декодированный кадр — в проигрыватель. Пока грузится модуль — копим; если не поднялся —
  // старый путь через отдельные буферы.
  emit(frame) {
    if (!frame || !frame.length) return;
    if (this.player) { this.player.port.postMessage({ samples: frame }); return; }
    if (this._pQueue) { if (this._pQueue.length < 60) this._pQueue.push(frame); return; }
    this.play(frame, this.reserve(frame.length));
  }

  // Несущая есть, пока идёт звук: отпустили тангенту — в приёмнике снова шум
  get onAir() {
    return Boolean(this.ctx) && this.ctx.currentTime - this.lastChunk < 0.35;
  }

  // Позывной передаётся открыто, как номер абонента в цифровых рациях, — зашифрован только звук
  lcdText() {
    return this.encrypted && !this.decrypted ? `${this.rds} · ШИФР` : this.rds;
  }

  receive(packet, keyring) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || packet.length < 2) return;
    this.lastChunk = ctx.currentTime;
    const type = packet[0];
    const seq = packet[1];

    // Открытый звук: несжатый (со станции) или сжатый ADPCM (с раций)
    if (type === PACKET_OPEN || type === PACKET_OPEN_C) {
      this.encrypted = false;
      let frame;
      if (type === PACKET_OPEN) {
        const pcm = new Int16Array(packet.buffer, packet.byteOffset + 2, (packet.length - 2) >> 1);
        frame = pcmToFloat(pcm);
      } else {
        const body = packet.subarray(2);
        frame = adpcmDecode(body, adpcmSamples(body.length));
      }
      this.conceal(seq);
      this.lastFrame = frame;
      this.emit(frame);
      return;
    }

    const sealed = type === PACKET_SEALED;
    const sealedC = type === PACKET_SEALED_C;
    if ((!sealed && !sealedC) || packet.length <= SEALED_HEAD + 16) return;

    this.encrypted = true;
    const cipher = packet.subarray(SEALED_HEAD);
    const plainLen = cipher.length - 16;
    const samples = sealed ? plainLen >> 1 : adpcmSamples(plainLen);
    this.conceal(seq);
    const entry = keyring.find(packet.subarray(2, 10));
    if (!entry) {
      this.decrypted = false;
      this.emit(this.sonify(cipher, samples));
      return;
    }
    unsealPacket(entry, packet).then(
      (buf) => {
        this.decrypted = true;
        const frame = sealed ? pcmToFloat(new Int16Array(buf)) : adpcmDecode(new Uint8Array(buf), adpcmSamples(buf.byteLength));
        this.lastFrame = frame;
        this.emit(frame);
      },
      () => {
        this.decrypted = false;
        this.emit(this.sonify(cipher, samples));
      },
    );
  }

  // Пропущены пакеты (по номеру seq) — заполняем дыру затухающим повтором последнего кадра,
  // чтобы вместо щелчка/провала был плавный «хвост». Работает только когда отправитель шлёт seq.
  conceal(seq) {
    if (typeof this.lastSeq === 'number' && this.lastFrame) {
      const gap = (seq - this.lastSeq - 1) & 0xff;
      if (gap > 0 && gap <= 8) {
        for (let k = 0; k < gap; k++) {
          const g = 0.82 ** (k + 1);
          const f = new Float32Array(this.lastFrame.length);
          for (let i = 0; i < f.length; i++) f[i] = this.lastFrame[i] * g;
          this.emit(f);
        }
      }
    }
    this.lastSeq = seq;
  }

  // Время начала следующего куска. Держим ровную очередь: при недоборе (буфер опустел) или
  // при накоплении задержки — пересинхронизируемся, оборвав хвост, иначе звук наложился бы (эхо).
  reserve(samples) {
    const now = this.ctx.currentTime;
    let j = this.jitter;
    if (this.playhead < now) {
      // Недобор: буфер опустел — сильно растим запас, чтобы пережить следующие рывки
      j = Math.min(LIVE_JITTER_MAX, j * 1.8 + 0.08);
      this.jitter = j;
      this.good = 0;
      this.flushScheduled();
      this.playhead = now + j;
    } else if (this.playhead > now + j + LIVE_MAX_LAG) {
      // Задержка накопилась сверх буфера — пересинхронизируемся, оборвав хвост
      this.flushScheduled();
      this.playhead = now + j;
    } else if (this.playhead < now + j * 0.5) {
      // Буфер тает (осталось меньше половины запаса) — заранее подрастим запас, без рывка,
      // чтобы следующий провал сети не дошёл до тишины
      this.jitter = Math.min(LIVE_JITTER_MAX, j * 1.3 + 0.03);
      this.good = 0;
    } else if (++this.good > 300) {
      // Долго стабильно (12 с) — очень медленно ужимаем задержку обратно к минимуму
      this.good = 0;
      this.jitter = Math.max(LIVE_JITTER, j * 0.9);
    }
    const when = this.playhead;
    this.playhead += samples / LIVE_RATE;
    return when;
  }

  play(samples, when) {
    const ctx = this.ctx;
    if (!ctx || !samples.length) return;
    const buf = ctx.createBuffer(1, samples.length, LIVE_RATE);
    buf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Каждый кусок идёт через свой gain — чтобы при обрыве («пересинхронизации») гасить его
    // коротким фейдом, а не резким stop(): резкий обрыв на границе буфера даёт щелчок/треск.
    const g = ctx.createGain();
    src.connect(g).connect(this.output);
    src.start(Math.max(when, ctx.currentTime));
    // Помним запланированные куски, чтобы при пересинхронизации оборвать «хвост» и не было эха
    const item = { src, g };
    (this.scheduled ??= []).push(item);
    src.onended = () => {
      const i = this.scheduled.indexOf(item);
      if (i >= 0) this.scheduled.splice(i, 1);
      try { g.disconnect(); } catch { /* уже */ }
    };
  }

  // Пересинхронизация: гасим ещё не доигранные куски коротким фейдом (8 мс), чтобы новый звук не
  // наложился на старый (эхо) и при этом не было щелчка от резкого обрыва.
  flushScheduled() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const { src, g } of this.scheduled ?? []) {
      try {
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(0, now + 0.008);
        src.onended = null;
        src.stop(now + 0.012);
      } catch {
        /* уже остановлен */
      }
    }
    this.scheduled = [];
  }

  // Шифротекст → 4FSK: каждые два бита выбирают один из четырёх тонов
  sonify(bytes, samples) {
    const out = new Float32Array(samples);
    const perSymbol = LIVE_RATE / FSK4_BAUD;
    let phase = this.fskPhase;
    for (let i = 0; i < samples; i++) {
      const sym = Math.floor(i / perSymbol);
      const byte = bytes[(sym >> 2) % bytes.length];
      const tone = FSK4_TONES[(byte >> ((sym & 3) * 2)) & 3];
      phase += (2 * Math.PI * tone) / LIVE_RATE;
      out[i] = Math.sin(phase) * 0.25;
    }
    this.fskPhase = phase % (2 * Math.PI);
    return out;
  }
}

function pcmToFloat(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

/* Своя станция: микрофон и/или трек → пакеты PCM на сервер. */
class Broadcaster {
  constructor(onChunk) {
    this.onChunk = onChunk;   // (ArrayBuffer) => void
    this.ctx = null;
    this.input = null;
    this.mic = null;
    this.player = null;
    this.onTrackEnd = null;   // трек доиграл — пора следующий
    this.onTrackError = null; // файл не удалось воспроизвести
    this.level = 0;
    this.transmitting = false;
    this.dtx = true;          // не слать тишину в эфир (экономия трафика + меньше потерь на 2G)
    this.txGate = 0.012;      // порог «есть звук» по пиковому уровню кадра
    this._txHang = 0;         // сколько кадров ещё дослать после последнего звука (хвост)
  }

  // Микрофон и AudioWorklet браузер даёт только на localhost или по HTTPS
  static get supported() {
    return window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioWorkletNode !== 'undefined';
  }

  async open() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule('js/worklets/capture.js');
    this.input = ctx.createGain();
    const node = new AudioWorkletNode(ctx, 'capture', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      outputChannelCount: [1],
      processorOptions: { targetRate: LIVE_RATE, chunk: LIVE_CHUNK },
    });
    node.port.onmessage = (e) => {
      const { pcm, peak } = e.data;
      this.level = Math.max(peak, this.level * 0.8);
      if (!this.transmitting) return;
      // Когда играет трек/интернет-радио — поток непрерывный, DTX не применяем (не режем музыку).
      const mediaOn = Boolean(this.player && this.player.getAttribute('src') && !this.player.paused);
      if (!this.dtx || mediaOn || peak >= this.txGate) this._txHang = TX_HANGOVER;
      if (this._txHang > 0) { this._txHang--; this.onChunk(pcm); }
    };
    // Эфирная обработка, как на настоящих станциях: тихое подтягивается, громкое прижимается,
    // поэтому голос и музыка звучат одинаково громко (компрессор сам добавляет усиление)
    // Мягкий левелер голоса: уровень в основном держит браузерный AGC, компрессор лишь аккуратно
    // прижимает пики. Раньше был жёсткий (ratio 8) и вместе с AGC качал/душил звук — отсюда «пампинг».
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 18;
    comp.ratio.value = 3;
    comp.attack.value = 0.006;
    comp.release.value = 0.2;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    // Сюда же подмешивается сигнал ROGER — мимо измерителя голоса, чтобы VOX на него не срабатывал
    this.txIn = AudioKit.filter(ctx, 'lowpass', 7000); // всё выше половины LIVE_RATE всё равно потеряется
    this.input.connect(this.txIn).connect(comp).connect(node).connect(mute).connect(ctx.destination);

    // Чувствительность микрофона и измеритель громкости голоса (до компрессора — для VOX)
    this.micGain = ctx.createGain();
    this.micGain.gain.value = this.micLevel ?? 1;
    this.micGain.connect(this.input);
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 512;
    this.input.connect(this.meter);
    this.meterBuf = new Float32Array(this.meter.fftSize);
  }

  setMicGain(value) {
    this.micLevel = value;
    if (this.micGain) this.micGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.05);
  }

  // Громкость того, что сейчас идёт в передатчик (RMS), — для VOX
  inputLevel() {
    if (!this.meter) return 0;
    this.meter.getFloatTimeDomainData(this.meterBuf);
    let sum = 0;
    for (const v of this.meterBuf) sum += v * v;
    return Math.sqrt(sum / this.meterBuf.length);
  }

  // Сигнал конца передачи (ROGER): два коротких тона в эфир. Промис — когда он прозвучал.
  roger() {
    if (!this.ctx) return Promise.resolve();
    const t = this.ctx.currentTime + 0.02;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.setValueAtTime(1100, t);
    osc.frequency.setValueAtTime(1600, t + 0.09);
    g.gain.setValueAtTime(0, this.ctx.currentTime);
    g.gain.setValueAtTime(0.35, t);
    g.gain.setValueAtTime(0, t + 0.2);
    osc.connect(g).connect(this.txIn);
    osc.start(t);
    osc.stop(t + 0.22);
    return new Promise((resolve) => setTimeout(resolve, 320));
  }

  async setMic(on) {
    if (on && !this.mic) {
      // echoCancellation НЕ включаем: на Android оно загоняет микрофон в «телефонный» режим связи
      // (узкая полоса ~8–16 кГц + жёсткая обработка → тускло и с артефактами). Рация полудуплексная,
      // эхоподавление ей не нужно. Оставляем шумодав и авто-громкость, просим моно.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const src = this.ctx.createMediaStreamSource(stream);
      src.connect(this.micGain);
      this.mic = { stream, src };
    } else if (!on && this.mic) {
      this.mic.src.disconnect();
      this.mic.stream.getTracks().forEach((t) => t.stop());
      this.mic = null;
    }
  }

  // Треки играют через <audio>: файл читается потоково, а не распаковывается целиком в память
  async playTrack(url) {
    if (!this.player) {
      const audio = new Audio();
      const gain = this.ctx.createGain();
      gain.gain.value = 0.8;
      this.ctx.createMediaElementSource(audio).connect(gain).connect(this.input);
      audio.addEventListener('ended', () => this.onTrackEnd?.());
      audio.addEventListener('error', () => {
        if (audio.getAttribute('src')) this.onTrackError?.();
      });
      this.player = audio;
    }
    this.player.src = url;
    await this.player.play();
  }

  stopTrack() {
    if (!this.player) return;
    this.player.pause();
    this.player.removeAttribute('src');
    this.player.load();
  }

  get trackPlaying() {
    return Boolean(this.player && this.player.getAttribute('src') && !this.player.paused);
  }

  async close() {
    this.transmitting = false;
    if (!this.ctx) return;
    await this.setMic(false);
    this.stopTrack();
    this.player = null; // <audio> привязан к контексту навсегда — в следующий раз нужен новый
    await this.ctx.close();
    this.ctx = null;
    this.meter = null;
    this.micGain = null;
    this.level = 0;
  }
}
