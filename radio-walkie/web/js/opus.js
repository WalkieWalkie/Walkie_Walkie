'use strict';

/*
 * Opus-кодек живого эфира через WebCodecs (AudioEncoder/AudioDecoder).
 *
 * Зачем: 4-битный IMA ADPCM звучит «хрустяще» и жрёт ~64 кбит/с. Opus даёт чистый голос на
 * ~16 кбит/с — заметно лучше И вчетверо легче для слабой сети (2G, VPN на мобильном). Доступен
 * в Chromium (Electron, свежий Android WebView). Где WebCodecs нет — вызывающий код сам
 * откатывается на ADPCM.
 *
 * Каждый opus-пакет = один кадр 40 мс и самодостаточен: потеря пакета не ломает остальные.
 *
 * Декодер Opus в Chromium всегда отдаёт 48 кГц — sampleRate из configure() для Opus
 * игнорируется, — а эфир везде 16 кГц. Поэтому приёмник пересчитывает частоту сам (Resampler).
 * Без этого 1920 сэмплов на кадр играются как 16-килогерцевые: голос втрое ниже и медленнее,
 * задержка растёт — из-за этого Opus в 0.3.11 откатывали.
 *
 * API (window.OpusVoice):
 *   supported            — есть ли WebCodecs в этом рантайме
 *   ready                — Promise<boolean>: Opus реально кодируется и декодируется (isConfigSupported)
 *   ok                   — то же синхронно, после ready (до него false)
 *   new Tx(onPacket)     — передатчик: push(Int16Array) → onPacket(Uint8Array) (асинхронно)
 *   new Rx(onPcm)        — приёмник: decode(Uint8Array) → onPcm(Float32Array, 16 кГц) (асинхронно)
 */
(() => {
  const RATE = 16000;        // частота эфира (совпадает с LIVE_RATE)
  const FRAME_US = 40000;    // 40 мс — один кадр = один пакет (как LIVE_CHUNK=640)
  const BITRATE = 16000;     // ~16 кбит/с, голосу хватает с запасом

  const ENC_CONFIG = {
    codec: 'opus',
    sampleRate: RATE,
    numberOfChannels: 1,
    bitrate: BITRATE,
    opus: { application: 'voip', signal: 'voice', frameDuration: FRAME_US, usedtx: false },
  };
  const DEC_CONFIG = { codec: 'opus', sampleRate: RATE, numberOfChannels: 1 };

  const supported = typeof AudioEncoder !== 'undefined'
    && typeof AudioDecoder !== 'undefined'
    && typeof AudioData !== 'undefined'
    && typeof EncodedAudioChunk !== 'undefined';

  /*
   * Пересчёт частоты кадров декодера в частоту эфира. Кратное отношение (48 → 16 кГц) —
   * FIR-фильтр нижних частот (срез ~7 кГц, окно Блэкмана) с прореживанием; хвост кадра
   * переносится в следующий — на стыках кадров нет щелчков. Некратное — линейная интерполяция.
   */
  class Resampler {
    constructor(from, to) {
      this.from = from;
      this.to = to;
      this.m = from % to === 0 ? from / to : 0;
      if (this.m > 1) {
        const n = 16 * this.m + 1;           // 49 отводов для 48 → 16 кГц
        const fc = (0.44 * to) / from;        // срез в долях частоты входа
        const h = new Float32Array(n);
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const k = i - (n - 1) / 2;
          const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
          const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
          h[i] = sinc * w;
          sum += h[i];
        }
        for (let i = 0; i < n; i++) h[i] /= sum;
        this.h = h;
        this.hist = new Float32Array(n - 1);
      } else {
        this.t = 0;
        this.last = 0;
      }
    }

    process(input) {
      if (this.from === this.to) return input;
      return this.m > 1 ? this.decimate(input) : this.linear(input);
    }

    decimate(input) {
      const { h, m } = this;
      const n = h.length;
      const buf = new Float32Array(this.hist.length + input.length);
      buf.set(this.hist);
      buf.set(input, this.hist.length);
      const count = buf.length >= n ? Math.floor((buf.length - n) / m) + 1 : 0;
      const out = new Float32Array(count);
      let pos = 0;
      for (let k = 0; k < count; k++, pos += m) {
        let s = 0;
        for (let j = 0; j < n; j++) s += buf[pos + j] * h[j];
        out[k] = s;
      }
      this.hist = buf.slice(pos); // начало следующего окна
      return out;
    }

    linear(input) {
      const step = this.from / this.to;
      const out = [];
      let t = this.t;
      const at = (i) => (i < 0 ? this.last : input[i]);
      while (t < input.length - 1) {
        const i = Math.floor(t);
        const f = t - i;
        out.push(at(i) * (1 - f) + at(i + 1) * f);
        t += step;
      }
      this.t = t - input.length;
      this.last = input[input.length - 1] ?? this.last;
      return Float32Array.from(out);
    }
  }

  // Opus есть не во всех сборках WebCodecs — проверяем, что кодер и декодер реально поднимутся
  let ok = false;
  const ready = !supported ? Promise.resolve(false) : Promise.all([
    AudioEncoder.isConfigSupported(ENC_CONFIG),
    AudioDecoder.isConfigSupported(DEC_CONFIG),
  ]).then(([e, d]) => (ok = Boolean(e.supported && d.supported)), () => false);

  class Tx {
    constructor(onPacket) {
      this.onPacket = onPacket;
      this.enc = null;
      this.ts = 0;
      this.ready = false;
    }

    async start() {
      if (!supported) throw new Error('WebCodecs нет');
      const enc = new AudioEncoder({
        output: (chunk) => {
          const b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          this.onPacket(b);
        },
        error: (e) => { console.warn('opus enc', e); this.ready = false; },
      });
      enc.configure(ENC_CONFIG);
      this.enc = enc;
      this.ts = 0;
      this.ready = true;
    }

    // Один захваченный кадр (Int16Array) → в кодер; пакет вылетит в onPacket асинхронно
    push(int16) {
      if (!this.ready || !this.enc) return;
      const n = int16.length;
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = int16[i] / 32768;
      let ad;
      try {
        ad = new AudioData({ format: 'f32', sampleRate: RATE, numberOfFrames: n, numberOfChannels: 1, timestamp: this.ts, data: f });
      } catch (e) { console.warn('AudioData', e); return; }
      this.ts += Math.round((n / RATE) * 1e6);
      try { this.enc.encode(ad); } catch (e) { console.warn('encode', e); this.ready = false; }
      ad.close();
    }

    close() {
      try { if (this.enc) this.enc.close(); } catch { /* уже */ }
      this.enc = null;
      this.ready = false;
    }
  }

  class Rx {
    constructor(onPcm) {
      this.onPcm = onPcm;
      this.dec = null;
      this.ts = 0;
      this.ready = false;
      this.resampler = null;
    }

    async start() {
      if (!supported) throw new Error('WebCodecs нет');
      const dec = new AudioDecoder({
        output: (ad) => {
          const n = ad.numberOfFrames;
          const f = new Float32Array(n);
          try { ad.copyTo(f, { planeIndex: 0, format: 'f32' }); }
          catch { try { ad.copyTo(f, { planeIndex: 0 }); } catch { /* не вышло */ } }
          const rate = ad.sampleRate || RATE;
          ad.close();
          if (!this.resampler || this.resampler.from !== rate) this.resampler = new Resampler(rate, RATE);
          const pcm = this.resampler.process(f);
          if (pcm.length) this.onPcm(pcm);
        },
        // Декодер упал (битый пакет и т.п.) — на следующем пакете поднимем заново
        error: (e) => { console.warn('opus dec', e); this.ready = false; },
      });
      dec.configure(DEC_CONFIG);
      this.dec = dec;
      this.ts = 0;
      this.ready = true;
    }

    // Один opus-пакет (Uint8Array) → декодеру; PCM вылетит в onPcm асинхронно
    decode(bytes) {
      if (!this.ready) {
        this.close();
        this.start().catch(() => {}); // async: неудача — здесь же this.dec останется null
      }
      if (!this.dec) return;
      try {
        this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.ts, data: bytes }));
      } catch (e) { console.warn('decode', e); this.ready = false; }
      this.ts += FRAME_US;
    }

    close() {
      try { if (this.dec && this.dec.state !== 'closed') this.dec.close(); } catch { /* уже */ }
      this.dec = null;
      this.ready = false;
    }
  }

  window.OpusVoice = {
    supported, RATE, Tx, Rx, Resampler, ready,
    get ok() { return ok; },
  };
})();
