'use strict';

/*
 * Тот же IMA ADPCM, что и в браузере (js/codec.js), но для Node — чтобы кодировать эфир
 * прямо в main-процессе (серверная ретрансляция интернет-радио, без Web Audio в окне).
 * Формат пакета байт-в-байт совпадает с openPacketC: [4][seq][ADPCM], поэтому рации
 * и приёмники декодируют его штатно.
 */

const IMA_STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
  73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
  494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272,
  2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

const PACKET_OPEN_C = 4; // сжатый (ADPCM) открытый звук — тот же код, что в js/crypto.js

// Int16Array → Uint8Array. Идентично js/codec.js:adpcmEncode.
function adpcmEncode(pcm) {
  let pred = pcm.length ? pcm[0] | 0 : 0;
  let index = 0;
  const out = new Uint8Array(3 + ((pcm.length + 1) >> 1));
  out[0] = pred & 0xff;
  out[1] = (pred >> 8) & 0xff;
  out[2] = index;
  let o = 3;
  let nibble = 0;
  let hasNibble = false;
  for (let i = 0; i < pcm.length; i++) {
    let step = IMA_STEP[index];
    let diff = pcm[i] - pred;
    let code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    let vpdiff = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; vpdiff += step; }
    step >>= 1;
    if (diff >= step) { code |= 2; diff -= step; vpdiff += step; }
    step >>= 1;
    if (diff >= step) { code |= 1; vpdiff += step; }
    pred += (code & 8) ? -vpdiff : vpdiff;
    if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
    index += IMA_INDEX[code];
    if (index < 0) index = 0; else if (index > 88) index = 88;
    if (hasNibble) { out[o++] = nibble | (code << 4); hasNibble = false; } else { nibble = code; hasNibble = true; }
  }
  if (hasNibble) out[o++] = nibble;
  return out;
}

// Сжатый открытый пакет [4][seq][ADPCM] как Buffer — ровно как js/crypto.js:openPacketC
function openPacketC(adpcm, seq = 0) {
  const out = Buffer.allocUnsafe(2 + adpcm.length);
  out[0] = PACKET_OPEN_C;
  out[1] = seq & 0xff;
  Buffer.from(adpcm.buffer, adpcm.byteOffset, adpcm.length).copy(out, 2);
  return out;
}

module.exports = { adpcmEncode, openPacketC };
