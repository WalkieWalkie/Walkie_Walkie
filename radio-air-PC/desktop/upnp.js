'use strict';

/*
 * UPnP: просим роутер открыть порт и узнаём внешний IP — без захода в настройки роутера.
 * Работает, если в роутере включён UPnP (у многих включён по умолчанию).
 *
 * 1. Ищем роутер в сети (SSDP, групповой запрос на 239.255.255.250:1900).
 * 2. Читаем его описание и находим службу WANIPConnection / WANPPPConnection.
 * 3. Вызываем её методы: GetExternalIPAddress, AddPortMapping, DeletePortMapping.
 */

const dgram = require('node:dgram');
const http = require('node:http');
const os = require('node:os');

const SSDP = { address: '239.255.255.250', port: 1900 };
const GATEWAY_TYPES = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
];
const SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

// Адреса компьютера в домашней сети. Адаптеры VPN (например, 198.18.x.x у TUN-режима) пропускаются.
function lanAddresses() {
  const home = [/^192\.168\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./];
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && home.some((re) => re.test(a.address))) found.push(a.address);
    }
  }
  return found.sort((x, y) => home.findIndex((re) => re.test(x)) - home.findIndex((re) => re.test(y)));
}

// Внешний адрес из «серых» диапазонов значит, что снаружи до компьютера не достучаться
function isPublicIp(ip) {
  const [a, b] = ip.split('.').map(Number);
  if ([a, b].some((n) => !Number.isInteger(n))) return false;
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT провайдера
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

// Публичные IPv4 прямо на сетевой карте — так бывает на VPS/сервере: белый адрес висит
// на интерфейсе, роутера и UPnP нет. Тогда это и есть адрес для друзей, пробрасывать нечего.
function publicAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && isPublicIp(a.address)) found.push(a.address);
    }
  }
  return found;
}

function discover(localAddress, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeout);
    socket.on('error', () => finish(null));
    socket.on('message', (msg) => {
      const text = msg.toString();
      const location = /^location:\s*(\S+)/im.exec(text);
      if (location && GATEWAY_TYPES.some((t) => text.includes(t))) finish(location[1]);
    });
    // Привязываемся к домашнему адаптеру, иначе запрос может уйти в туннель VPN
    socket.bind(0, localAddress, () => {
      try {
        socket.setMulticastInterface(localAddress);
      } catch {
        /* не у всех систем есть — попробуем как есть */
      }
      for (const st of GATEWAY_TYPES) {
        const query = Buffer.from(
          'M-SEARCH * HTTP/1.1\r\n' +
          `HOST: ${SSDP.address}:${SSDP.port}\r\n` +
          'MAN: "ssdp:discover"\r\nMX: 2\r\n' +
          `ST: ${st}\r\n\r\n`,
        );
        socket.send(query, SSDP.port, SSDP.address);
      }
    });
  });
}

function request(url, { method = 'GET', headers = {}, body = null, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, localAddress, timeout: 5000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('Роутер не ответил')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const tag = (xml, name) => new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`).exec(xml)?.[1]?.trim();

async function findService(location, localAddress) {
  const { body } = await request(location, { localAddress });
  for (const type of SERVICE_TYPES) {
    const block = body.split(/<service>/i).find((part) => part.includes(type));
    const control = block && tag(block, 'controlURL');
    if (control) return { type, url: new URL(control, tag(body, 'URLBase') || location).toString() };
  }
  return null;
}

async function soap(service, action, args, localAddress) {
  const params = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${service.type}">${params}</u:${action}></s:Body></s:Envelope>`;
  const res = await request(service.url, {
    method: 'POST',
    localAddress,
    body,
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': Buffer.byteLength(body),
      SOAPAction: `"${service.type}#${action}"`,
    },
  });
  if (res.status !== 200) {
    const code = tag(res.body, 'errorCode');
    const text = tag(res.body, 'errorDescription');
    throw new Error(`роутер отказал${code ? ` (${code}${text ? ` ${text}` : ''})` : ''}`);
  }
  return res.body;
}

class PortMapper {
  constructor() {
    this.service = null;
    this.localAddress = null;
    this.mapped = null;
  }

  async connect() {
    if (this.service) return;
    const local = lanAddresses()[0];
    if (!local) throw new Error('компьютер не подключён к домашней сети');
    const location = await discover(local);
    if (!location) throw new Error('роутер не ответил по UPnP — возможно, UPnP в нём выключен');
    const service = await findService(location, local);
    if (!service) throw new Error('роутер не умеет открывать порты по UPnP');
    this.service = service;
    this.localAddress = local;
  }

  async externalIp() {
    await this.connect();
    const xml = await soap(this.service, 'GetExternalIPAddress', {}, this.localAddress);
    return tag(xml, 'NewExternalIPAddress') || null;
  }

  async open(port, description = 'Radio') {
    await this.connect();
    const mapping = {
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: 'TCP',
      NewInternalPort: port,
      NewInternalClient: this.localAddress,
      NewEnabled: 1,
      NewPortMappingDescription: description,
    };
    // Бессрочно, а если роутер так не умеет — на два часа с продлением
    try {
      await soap(this.service, 'AddPortMapping', { ...mapping, NewLeaseDuration: 0 }, this.localAddress);
    } catch {
      await soap(this.service, 'AddPortMapping', { ...mapping, NewLeaseDuration: 7200 }, this.localAddress);
      this.renew = setInterval(() => {
        soap(this.service, 'AddPortMapping', { ...mapping, NewLeaseDuration: 7200 }, this.localAddress).catch(() => {});
      }, 3600 * 1000);
    }
    this.mapped = port;
  }

  // Перестать следить за пробросом, не удаляя его из роутера
  forget() {
    clearInterval(this.renew);
    this.renew = null;
    this.mapped = null;
  }

  async close() {
    clearInterval(this.renew);
    this.renew = null;
    if (!this.mapped || !this.service) return;
    const port = this.mapped;
    this.mapped = null;
    await soap(this.service, 'DeletePortMapping', {
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: 'TCP',
    }, this.localAddress).catch(() => {});
  }
}

module.exports = { PortMapper, lanAddresses, isPublicIp, publicAddresses };
