'use strict';

/*
 * Непрерывный проигрыватель живого эфира. Раньше на каждый 40-мс кадр создавался отдельный
 * AudioBufferSourceNode — на телефоне это сотни узлов в секунду, отсюда микро-провалы, треск и
 * «дробление». Здесь один узел на станцию: кадры (16 кГц) складываются в кольцевой буфер и
 * отдаются ровным потоком, пересчитываясь под частоту аудиоконтекста. При нехватке данных (провал
 * сети) звук плавно уходит в тишину и заново набирает запас — без щелчков. Буфер сам растёт на
 * плохой сети и медленно ужимается на хорошей.
 */
class LivePlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.rate = o.rate || 16000;          // частота приходящих кадров, Гц
    this.step = this.rate / sampleRate;   // сколько входных сэмплов на один выходной (пересчёт частоты)
    this.size = Math.max(1, Math.round(this.rate * 6)); // кольцо ~6 с
    this.buf = new Float32Array(this.size);
    this.wr = 0;                 // индекс записи (целый)
    this.rd = 0;                 // индекс чтения (дробный) — для интерполяции
    this.avail = 0;              // сколько входных сэмплов ещё не прочитано
    this.minPre = Math.max(this.rate * 0.15, this.rate * (o.jitter || 0.22));
    this.maxPre = this.rate * 2.5;   // на 2G/рывках буфер уходит глубоко, лишь бы не рвалось (на хорошей сети сам ужмётся)
    this.pre = this.minPre;      // порог набора буфера перед стартом
    this.playing = false;        // набрали ли буфер — идёт ли воспроизведение
    this.env = 0;                // огибающая для мягких фейдов (0..1)
    this.fade = 1 / Math.max(64, Math.round(sampleRate * 0.008)); // ~8 мс
    this.good = 0;               // счётчик стабильных блоков — чтобы медленно ужимать буфер
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.samples) this.push(d.samples);
      else if (d.reset) this.reset();
    };
  }

  reset() {
    this.wr = 0; this.rd = 0; this.avail = 0; this.playing = false; this.env = 0; this.good = 0;
  }

  push(s) {
    const size = this.size;
    for (let i = 0; i < s.length; i++) {
      this.buf[this.wr] = s[i];
      this.wr = this.wr + 1 === size ? 0 : this.wr + 1;
    }
    this.avail += s.length;
    if (this.avail > size) {
      // Перелив (слушатель сильно отстал) — роняем старьё, двигаем чтение вперёд
      const drop = this.avail - size;
      this.rd = (this.rd + drop) % size;
      this.avail = size;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const N = out.length;
    const size = this.size;

    if (!this.playing) {
      // Набор буфера (стартовый или после провала): пока не накопили запас — тишина
      if (this.avail >= this.pre) this.playing = true;
      else { out.fill(0); return true; }
    }

    let under = false;
    for (let i = 0; i < N; i++) {
      if (this.avail < this.step + 2) {
        // Недобор данных: плавно гасим и уходим в набор буфера
        this.env -= this.fade;
        if (this.env <= 0) { this.env = 0; this.playing = false; }
        out[i] = 0;
        under = true;
        continue;
      }
      if (this.env < 1) { this.env += this.fade; if (this.env > 1) this.env = 1; }
      const i0 = this.rd | 0;
      const frac = this.rd - i0;
      const a = this.buf[i0];
      const b = this.buf[i0 + 1 === size ? 0 : i0 + 1];
      out[i] = (a + (b - a) * frac) * this.env;
      let rd = this.rd + this.step;
      if (rd >= size) rd -= size;
      this.rd = rd;
      this.avail -= this.step;
    }

    if (under) {
      // Был провал — на следующий раз набираем больше запаса (адаптивно, до maxPre)
      this.pre = Math.min(this.maxPre, this.pre * 1.6 + this.rate * 0.09);
      this.good = 0;
    } else if (++this.good > 900) {
      // Долго стабильно — очень медленно ужимаем буфер обратно к минимуму (меньше задержка)
      this.good = 0;
      this.pre = Math.max(this.minPre, this.pre * 0.92);
    }
    return true;
  }
}

registerProcessor('live-player', LivePlayer);
