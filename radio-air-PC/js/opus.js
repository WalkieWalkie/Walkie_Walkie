'use strict';

/*
 * Opus-кодек живого эфира через WebCodecs (AudioEncoder/AudioDecoder).
 *
 * Зачем: 4-битный IMA ADPCM звучит «хрустяще» и жрёт ~64 кбит/с. Opus даёт чистый голос на
 * ~16 кбит/с — заметно лучше И втрое легче для слабой сети (2G). Доступен в Chromium (Electron,
 * свежий Android WebView). Где WebCodecs нет — вызывающий код сам откатывается на ADPCM.
 *
 * Каждый opus-пакет = один кадр и самодостаточен: потеря пакета не ломает остальные (как и ADPCM).
 * Включён inband-FEC — декодер частично восстанавливает потерянное по следующему пакету.
 *
 * API (window.OpusVoice):
 *   supported            — есть ли WebCodecs-Opus в этом рантайме
 *   new Tx(onPacket)     — передатчик: push(Int16Array) → onPacket(Uint8Array) (асинхронно)
 *   new Rx(onPcm)        — приёмник: decode(Uint8Array) → onPcm(Float32Array) (асинхронно)
 */
(() => {
  const RATE = 16000;        // частота эфира (совпадает с LIVE_RATE)
  const FRAME_US = 40000;    // 40 мс — один кадр = один пакет (как LIVE_CHUNK=640)
  const BITRATE = 16000;     // ~16 кбит/с, голосу хватает с запасом

  const supported = typeof AudioEncoder !== 'undefined'
    && typeof AudioDecoder !== 'undefined'
    && typeof AudioData !== 'undefined'
    && typeof EncodedAudioChunk !== 'undefined';

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
      enc.configure({
        codec: 'opus',
        sampleRate: RATE,
        numberOfChannels: 1,
        bitrate: BITRATE,
        opus: { application: 'voip', frameDuration: FRAME_US, useinbandfec: true, usedtx: false },
      });
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
      try { this.enc.encode(ad); } catch (e) { console.warn('encode', e); }
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
    }

    async start() {
      if (!supported) throw new Error('WebCodecs нет');
      const dec = new AudioDecoder({
        output: (ad) => {
          const n = ad.numberOfFrames;
          const f = new Float32Array(n);
          try { ad.copyTo(f, { planeIndex: 0, format: 'f32' }); }
          catch { try { ad.copyTo(f, { planeIndex: 0 }); } catch { /* не вышло */ } }
          this.onPcm(f);
          ad.close();
        },
        error: (e) => { console.warn('opus dec', e); },
      });
      dec.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1 });
      this.dec = dec;
      this.ts = 0;
      this.ready = true;
    }

    // Один opus-пакет (Uint8Array) → декодеру; PCM вылетит в onPcm асинхронно
    decode(bytes) {
      if (!this.ready || !this.dec) return;
      try {
        this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.ts, data: bytes }));
      } catch (e) { console.warn('decode', e); }
      this.ts += FRAME_US;
    }

    close() {
      try { if (this.dec) this.dec.close(); } catch { /* уже */ }
      this.dec = null;
      this.ready = false;
    }
  }

  window.OpusVoice = { supported, RATE, Tx, Rx };
})();
