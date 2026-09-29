'use strict';

/*
 * Сервер эфира внутри приложения — то же, что server.py, только на Node.
 * Отдаёт страницу приёмника (для гостей из браузера) и ретранслирует живые станции.
 * Ничего не записывает: знает только, какие станции в эфире и кто на какой частоте.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const BANDS = [[87.5, 108.0], [400.0, 470.0]]; // FM-вещание и рации (UHF)
const HEAR_RANGE = 0.5;       // МГц: дальше этого звук станции приёмнику уже не слышен
const LISTEN_RANGE = 0.2;     // МГц: кто настроен ближе — считается слушателем (FM)
const LISTEN_RANGE_UHF = 0.006; // МГц: у раций каналы узкие — слушатель только на том же канале
const MAX_FRAME = 64 * 1024;
const MAX_BUFFER = 512 * 1024; // клиент не успевает принимать — звук для него пропускается
const NAME_LEN = 24;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function parseFreq(value) {
  if (value === null || value === undefined || value === '') return null;
  const f = Math.round(Number(value) * 1e5) / 1e5;
  return Number.isFinite(f) && BANDS.some(([lo, hi]) => f >= lo && f <= hi) ? f : null;
}

const listenRange = (freq) => (freq < 300 ? LISTEN_RANGE : LISTEN_RANGE_UHF);
const hears = (client, freq, reach) => client.freqs.some((f) => Math.abs(f - freq) <= reach);

function cleanName(value) {
  const text = String(value ?? '').replace(/[\p{C}]/gu, '').split(/\s+/).filter(Boolean).join(' ');
  return text.slice(0, NAME_LEN) || 'БЕЗ ПОЗЫВНОГО';
}

// Подключаться можно со страницы этого же сервера или из приложения (не http/https)
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
    return url.host === req.headers.host;
  } catch {
    return false;
  }
}

class AirServer {
  // pages — какие страницы отдавать гостям из браузера; первая открывается по адресу «/»
  constructor(webRoot, { pages = ['index.html', 'widget.html'] } = {}) {
    this.webRoot = path.resolve(webRoot);
    this.pages = pages;
    this.clients = new Set();
    this.nextId = 1;
    this.http = null;
    this.port = null;
  }

  start(port, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
      const server = http.createServer((req, res) => this.serveStatic(req, res));
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname !== '/ws' || !originAllowed(req)) {
          socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.session(ws));
      });
      server.once('error', reject);
      // exclusive: второй сервер на том же порту не должен тихо разделить эфир на два
      server.listen({ port, host, exclusive: true }, () => {
        server.off('error', reject);
        this.http = server;
        this.wss = wss;
        this.port = port;
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.http) return resolve();
      for (const c of this.clients) c.ws.terminate();
      this.clients.clear();
      this.wss.close();
      this.http.close(() => resolve());
      this.http.closeAllConnections?.();
      this.http = null;
    });
  }

  // ───────── Страница для гостей из браузера ─────────

  serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || this.pages[0];
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = path.resolve(this.webRoot, rel);
    // Наружу — только сам приёмник: страница, стили и скрипты.
    // Проверяем уже разобранный путь, иначе /js/../что-угодно проскочит
    const resolved = path.relative(this.webRoot, file).split(path.sep).join('/');
    const inside = file.startsWith(this.webRoot + path.sep) && (this.pages.includes(resolved) || /^(css|js)\//.test(resolved));
    const type = STATIC_TYPES[path.extname(file).toLowerCase()];
    const hidden = path.relative(this.webRoot, file).split(path.sep).some((p) => p.startsWith('.'));
    if (!inside || !type || hidden) {
      res.writeHead(404).end('Not Found');
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'GET' ? body : undefined);
    });
  }

  // ───────── Эфир ─────────

  session(ws) {
    const client = { id: this.nextId++, ws, freqs: [], station: null, listeners: -1 };
    this.clients.add(client);
    this.sendJson(client, { type: 'welcome', stations: this.stations().map((st) => st.info()) });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.relay(client, data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') this.handleMessage(client, msg);
    });
    ws.on('close', () => this.leave(client));
    ws.on('error', () => {});
  }

  stations() {
    return [...this.clients].filter((c) => c.station).map((c) => c.station);
  }

  sendJson(client, obj) {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(obj));
  }

  broadcast(obj, exclude) {
    for (const c of this.clients) if (c !== exclude) this.sendJson(c, obj);
  }

  updateListeners() {
    for (const st of this.stations()) {
      let count = 0;
      for (const c of this.clients) {
        if (c !== st.owner && hears(c, st.freq, listenRange(st.freq))) count++;
      }
      if (count !== st.owner.listeners) {
        st.owner.listeners = count;
        this.sendJson(st.owner, { type: 'listeners', count });
      }
    }
  }

  leave(client) {
    if (!this.clients.delete(client)) return;
    if (client.station) this.offAir(client);
    this.updateListeners();
  }

  onAir(client, freq, name, monitor = false) {
    if (client.station) {
      client.station.freq = freq;
      client.station.name = name;
    } else {
      const st = { id: this.nextId++, owner: client, freq, name, monitor: false };
      st.info = () => ({ id: st.id, freq: st.freq, name: st.name });
      client.station = st;
      client.listeners = -1;
    }
    client.station.monitor = monitor;
    // О своей станции владелец узнаёт из onair-ok; её звук ему — только с monitor
    this.broadcast({ type: 'station-on', station: client.station.info() }, client);
    this.sendJson(client, { type: 'onair-ok', station: client.station.info() });
    this.updateListeners();
  }

  offAir(client) {
    const st = client.station;
    client.station = null;
    this.broadcast({ type: 'station-off', id: st.id }, client);
  }

  // Содержимое пакета сервер не разбирает: шифрованный звук он и не может прочитать
  relay(client, packet) {
    const st = client.station;
    if (!st || !packet.length) return;
    const head = Buffer.alloc(4);
    head.writeUInt32BE(st.id);
    const frame = Buffer.concat([head, packet]);
    for (const c of this.clients) {
      // Себе — только если ведущий хочет слышать свой эфир (monitor)
      if ((c === client && !st.monitor) || !hears(c, st.freq, HEAR_RANGE)) continue;
      if (c.ws.readyState === c.ws.OPEN && c.ws.bufferedAmount < MAX_BUFFER) c.ws.send(frame, { binary: true });
    }
  }

  // ───────── Локальная станция и оповещения из самого приложения (main) ─────────

  // Виртуальная станция без сокета: звук вливает main (серверная ретрансляция интернет-радио).
  // Для рассылки она — обычный клиент-владелец эфира, но сама ничего не принимает (заглушка ws).
  addLocalStation() {
    const ws = { readyState: 0, OPEN: 1, send() {}, terminate() {} };
    const client = { id: this.nextId++, ws, freqs: [], station: null, listeners: -1, local: true };
    this.clients.add(client);
    return {
      onAir: (freq, name, monitor = false) => {
        const f = parseFreq(freq);
        if (f === null) return false;
        this.onAir(client, f, cleanName(name), monitor === true);
        return true;
      },
      setFreq: (freq) => {
        const f = parseFreq(freq);
        if (f === null || !client.station) return false;
        client.station.freq = f;
        this.broadcast({ type: 'station-on', station: client.station.info() }, client);
        this.updateListeners();
        return true;
      },
      send: (packet) => this.relay(client, Buffer.isBuffer(packet) ? packet : Buffer.from(packet)),
      offAir: () => { if (client.station) { this.offAir(client); this.updateListeners(); } },
      close: () => this.leave(client),
      get onAirNow() { return Boolean(client.station); },
      get listeners() { return Math.max(0, client.listeners); },
    };
  }

  // Оповещение всем подключённым (рациям и станциям) прямо из main — без окна станции.
  broadcastNotice(state, text) {
    if (!['update', 'restart', 'shutdown', 'live', 'msg'].includes(state)) return false;
    this.broadcast({ type: 'server-notice', state, text: String(text || '').trim().slice(0, 120) });
    return true;
  }

  handleMessage(client, msg) {
    if (msg.type === 'tune') {
      const values = Array.isArray(msg.freqs) ? msg.freqs.slice(0, 4) : [msg.freq];
      client.freqs = values.map(parseFreq).filter((f) => f !== null);
      this.updateListeners();
    } else if (msg.type === 'onair') {
      const freq = parseFreq(msg.freq);
      if (freq === null) {
        this.sendJson(client, { type: 'error', message: 'Частота должна быть 87.5–108 или 400–470 МГц' });
        return;
      }
      this.onAir(client, freq, cleanName(msg.name), msg.monitor === true);
    } else if (msg.type === 'offair' && client.station) {
      this.offAir(client);
      this.updateListeners();
    } else if (msg.type === 'notice') {
      // Оповещение хозяина эфира — рассылаем всем подключённым (рациям и станциям).
      if (['update', 'restart', 'shutdown', 'live', 'msg'].includes(msg.state)) {
        const text = String(msg.text || '').trim().slice(0, 120);
        this.broadcast({ type: 'server-notice', state: msg.state, text }, client);
      }
    }
  }
}

module.exports = { AirServer };
