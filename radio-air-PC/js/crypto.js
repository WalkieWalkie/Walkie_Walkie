'use strict';

/*
 * Сквозное шифрование живого эфира.
 *
 * Ключ канала — фраза. Из неё на устройстве выводится ключ AES-GCM (PBKDF2),
 * звук шифруется до отправки, и сервер пересылает байты, которые сам прочитать не может.
 * Фраза никуда не передаётся. В пакете открыто идёт только номер ключа (как KID
 * в цифровых рациях), чтобы приёмник знал, каким ключом из связки пробовать.
 *
 * Пакет звука:
 *   открытый     [0][0][PCM Int16…]
 *   шифрованный  [1][0][номер ключа 8 байт][IV 12 байт][шифротекст + тег 16 байт]
 */

const PACKET_OPEN = 0;
const PACKET_SEALED = 1;
const PACKET_OPEN_C = 4;   // сжатый (ADPCM) открытый звук — в 4 раза меньше данных
const PACKET_SEALED_C = 5; // сжатый шифрованный звук
const PACKET_OPEN_O = 6;   // открытый звук Opus (WebCodecs) — чистый голос на ~16 кбит/с
const PACKET_SEALED_O = 7; // шифрованный звук Opus
const SEALED_HEAD = 22;
const AIR_SALT = new TextEncoder().encode('radio-air/v1');
const AIR_ITERATIONS = 200000;

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// Шифрование доступно только на localhost или по HTTPS
const cryptoAvailable = () => Boolean(window.crypto?.subtle);

async function deriveAirKey(phrase) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: AIR_SALT, iterations: AIR_ITERATIONS, hash: 'SHA-256' },
    base,
    320, // 256 бит ключа + 64 бита номера
  ));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const id = bits.slice(32, 40);
  return { key, id, idHex: toHex(id) };
}

function openPacket(pcm, seq = 0) {
  const out = new Uint8Array(2 + pcm.byteLength);
  out[0] = PACKET_OPEN;
  out[1] = seq & 0xff; // счётчик пакетов — для восстановления потерь на приёме (старые рации его не читают)
  out.set(new Uint8Array(pcm), 2);
  return out.buffer;
}

// Сжатый открытый звук: [4][seq][ADPCM]
function openPacketC(adpcm, seq = 0) {
  const out = new Uint8Array(2 + adpcm.length);
  out[0] = PACKET_OPEN_C;
  out[1] = seq & 0xff;
  out.set(adpcm, 2);
  return out.buffer;
}

// Открытый звук Opus: [6][seq][opus]
function openPacketO(opus, seq = 0) {
  const out = new Uint8Array(2 + opus.length);
  out[0] = PACKET_OPEN_O;
  out[1] = seq & 0xff;
  out.set(opus, 2);
  return out.buffer;
}

// Шифрованный звук Opus: [7][seq][kid8][iv12][AES-GCM(opus)]
async function sealPacketO(entry, opus, seq = 0) {
  const head = new Uint8Array(SEALED_HEAD);
  head[0] = PACKET_SEALED_O;
  head[1] = seq & 0xff;
  head.set(entry.id, 2);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  head.set(iv, 10);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: head.subarray(0, 10) },
    entry.key,
    opus,
  );
  const out = new Uint8Array(SEALED_HEAD + sealed.byteLength);
  out.set(head);
  out.set(new Uint8Array(sealed), SEALED_HEAD);
  return out.buffer;
}

// Сжатый шифрованный звук: [5][seq][kid8][iv12][AES-GCM(ADPCM)]
async function sealPacketC(entry, adpcm, seq = 0) {
  const head = new Uint8Array(SEALED_HEAD);
  head[0] = PACKET_SEALED_C;
  head[1] = seq & 0xff;
  head.set(entry.id, 2);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  head.set(iv, 10);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: head.subarray(0, 10) },
    entry.key,
    adpcm,
  );
  const out = new Uint8Array(SEALED_HEAD + sealed.byteLength);
  out.set(head);
  out.set(new Uint8Array(sealed), SEALED_HEAD);
  return out.buffer;
}

async function sealPacket(entry, pcm, seq = 0) {
  const head = new Uint8Array(SEALED_HEAD);
  head[0] = PACKET_SEALED;
  head[1] = seq & 0xff; // счётчик пакетов (входит в подписанные данные — на приёме проверяется тем же)
  head.set(entry.id, 2);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  head.set(iv, 10);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: head.subarray(0, 10) },
    entry.key,
    pcm,
  );
  const out = new Uint8Array(SEALED_HEAD + sealed.byteLength);
  out.set(head);
  out.set(new Uint8Array(sealed), SEALED_HEAD);
  return out.buffer;
}

// Возвращает PCM или бросает исключение, если ключ не подошёл или пакет повреждён
function unsealPacket(entry, packet) {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: packet.subarray(10, SEALED_HEAD), additionalData: packet.subarray(0, 10) },
    entry.key,
    packet.subarray(SEALED_HEAD),
  );
}

/* Связка ключей приёмника: фраза → ключ, с поиском по номеру ключа из пакета */
class AirKeyring {
  constructor() {
    this.byPhrase = new Map();
    this.byId = new Map();
    this.wanted = new Set();
  }

  async set(phrases) {
    if (!cryptoAvailable()) return;
    this.wanted = new Set(phrases);
    for (const [phrase, entry] of this.byPhrase) {
      if (!this.wanted.has(phrase)) {
        this.byPhrase.delete(phrase);
        this.byId.delete(entry.idHex);
      }
    }
    await Promise.all([...this.wanted].filter((p) => !this.byPhrase.has(p)).map(async (phrase) => {
      const entry = await deriveAirKey(phrase);
      if (!this.wanted.has(phrase)) return; // пока считали, ключ успели удалить
      this.byPhrase.set(phrase, entry);
      this.byId.set(entry.idHex, entry);
    }));
  }

  find(idBytes) {
    return this.byId.get(toHex(idBytes));
  }
}
