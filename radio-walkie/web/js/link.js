'use strict';

/*
 * Связь с сервером эфира по WebSocket.
 * Текстовые сообщения — JSON, двоичные — звук: 4 байта номера станции + пакет (см. crypto.js).
 *
 * На сайте сервер — тот, что отдал страницу. В приложении сервер выбирают сами:
 * по адресу вида 93.184.1.2:8765 или radio.example.ru.
 */
class AirLink {
  constructor(handlers) {
    this.handlers = handlers; // { status(online), message(msg), audio(stationId, packet) }
    this.url = AirLink.pageServer();
    this.ws = null;
    this.online = false;
    this.retry = 0;
    this.retryTimer = null;
    this.freq = null;         // частота приёмника; null — приёмник выключен
    this.sentFreq = undefined;
    this.tuneTimer = null;
    // Проверка Opus асинхронная — как закончится, сервер узнает, что мы его понимаем
    window.OpusVoice?.ready?.then(() => this.flushTune());
  }

  // Какие кодеки звука мы умеем принимать — сервер по ним выбирает кодек передатчикам
  static codecs() {
    return window.OpusVoice?.ok ? ['opus'] : [];
  }

  // Сервер, который отдал эту страницу (для приложения его нет — адрес выбирают)
  static pageServer() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }

  // Адрес от человека → адрес WebSocket. IP или порт — без шифрования канала, голый домен — через HTTPS.
  static serverUrl(address) {
    const text = String(address ?? '').trim();
    if (!text) return null;
    try {
      if (/^wss?:\/\//i.test(text)) {
        const u = new URL(text);
        return `${u.protocol}//${u.host}${u.pathname.length > 1 ? u.pathname : '/ws'}`;
      }
      if (/^https?:\/\//i.test(text)) {
        const u = new URL(text);
        return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws`;
      }
      const u = new URL(`http://${text}`);
      const plain = u.port || /^[\d.]+$/.test(u.hostname) || u.hostname === 'localhost';
      return plain ? `ws://${u.hostname}:${u.port || 8765}/ws` : `wss://${u.host}/ws`;
    } catch {
      return null;
    }
  }

  get available() {
    return Boolean(this.url);
  }

  // Переключиться на другой сервер (null — отключиться)
  setServer(url) {
    clearTimeout(this.retryTimer);
    const old = this.ws;
    this.ws = null;
    this.url = url;
    this.retry = 0;
    if (old) {
      old.close();
      if (this.online) {
        this.online = false;
        this.handlers.status(false);
      }
    }
    this.connect();
  }

  connect() {
    if (!this.url) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.online = true;
      this.retry = 0;
      this.sentFreq = undefined;
      this.flushTune();
      this.handlers.status(true);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      if (typeof e.data === 'string') {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg && typeof msg === 'object') this.handlers.message(msg);
      } else if (e.data.byteLength > 4) {
        const id = new DataView(e.data).getUint32(0);
        this.handlers.audio(id, new Uint8Array(e.data, 4));
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // это старое соединение, мы уже переключились
      this.online = false;
      this.ws = null;
      this.handlers.status(false);
      this.retryTimer = setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** this.retry++));
    };
    this.ws = ws;
  }

  send(obj) {
    if (this.online) this.ws.send(JSON.stringify(obj));
  }

  // Сеть не успевает — пакет пропускаем, а не копим: голос, отправленный с опозданием в
  // десяток секунд, в рации бесполезен (32 КБ — ~4 с ADPCM или ~14 с Opus)
  // true — пакет ушёл в сеть (для статистики передачи на экране)
  sendAudio(buffer) {
    if (!this.online || this.ws.bufferedAmount >= 32 * 1024) return false;
    this.ws.send(buffer);
    return true;
  }

  // Частота приёмника уходит на сервер не чаще пяти раз в секунду.
  // Можно передать несколько частот — при двойном прослушивании рации.
  tune(freq) {
    const list = freq == null ? null : [].concat(freq).map((f) => Math.round(f * 1e5) / 1e5);
    this.freq = list;
    if (this.tuneTimer) return;
    this.flushTune();
    this.tuneTimer = setTimeout(() => {
      this.tuneTimer = null;
      this.flushTune();
    }, 200);
  }

  flushTune() {
    const codecs = AirLink.codecs();
    const key = JSON.stringify([this.freq, codecs]);
    if (!this.online || key === this.sentFreq) return;
    this.sentFreq = key;
    this.send({ type: 'tune', freq: this.freq ? this.freq[0] : null, freqs: this.freq, codecs });
  }
}
