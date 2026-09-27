'use strict';

/* Интерфейс приёмника: шкала, ручки, дисплей, декодер, ключи и журнал. */

(() => {
  const MHZ_PER_TURN = 2;  // один полный оборот ручки настройки
  const TUNE_STEP = 0.05;  // шаг колеса мыши и стрелок, МГц
  const STORE_KEY = 'radio.v1';

  const $ = (id) => document.getElementById(id);
  const radioEl = $('radio');
  const els = {
    power: $('power'),
    scale: $('scale'),
    track: $('track'),
    ticks: $('ticks'),
    marks: $('marks'),
    needle: $('needle'),
    freq: $('freq'),
    rds: $('rds'),
    flagRds: $('flag-rds'),
    flagSt: $('flag-st'),
    flagEnc: $('flag-enc'),
    smeter: $('smeter-bars'),
    scope: $('scope'),
    knobTune: $('knob-tune'),
    knobTuneBody: $('knob-tune-body'),
    knobVol: $('knob-vol'),
    knobVolBody: $('knob-vol-body'),
    seekDown: $('seek-down'),
    seekUp: $('seek-up'),
    squelch: $('squelch'),
    decoder: $('decoder-text'),
    keyForm: $('key-form'),
    keyInput: $('key-input'),
    keyList: $('key-list'),
    log: $('log'),
    logEmpty: $('log-empty'),
    toast: $('toast'),
    onair: $('onair'),
    net: $('net'),
    netText: $('net-text'),
    onairName: $('onair-name'),
    onairFreq: $('onair-freq'),
    onairTake: $('onair-take'),
    onairKey: $('onair-key'),
    srcMic: $('src-mic'),
    srcMonitor: $('src-monitor'),
    srcTrack: $('src-track'),
    trackPick: $('track-pick'),
    playlist: $('playlist'),
    playlistList: $('playlist-list'),
    playlistCount: $('playlist-count'),
    playlistEmpty: $('playlist-empty'),
    playlistNext: $('playlist-next'),
    netRadioUrl: $('net-radio-url'),
    netRadioToggle: $('net-radio-toggle'),
    netRadioStatus: $('net-radio-status'),
    onairToggle: $('onair-toggle'),
    ptt: $('ptt'),
    vuBar: $('vu-bar'),
    onairStatus: $('onair-status'),
    serverPanel: $('server-panel'),
    serverNet: $('server-net'),
    serverNetText: $('server-net-text'),
    serverForm: $('server-form'),
    serverAddress: $('server-address'),
    serverRecent: $('server-recent'),
    hostToggle: $('host-toggle'),
    hostInfo: $('host-info'),
    serverAuto: $('server-auto'),
    toWidget: $('to-widget'),
  };

  const stations = createStations();
  const engine = new RadioEngine(stations);
  const saved = load();
  const found = new Set(saved.found ?? []);
  const heard = loadHeard(saved.heard); // любительские станции: позывной|частота → запись журнала
  engine.setFrequency(Number.isFinite(saved.freq) ? saved.freq : 97.2);
  engine.setVolume(Number.isFinite(saved.volume) ? saved.volume : 0.7);
  engine.setSquelch(Boolean(saved.squelch));

  // Одна связка ключей на всё: встроенный шифрованный канал и живые станции
  const airKeyring = new AirKeyring();
  applyKeys(saved.keys ?? []);

  function applyKeys(keys) {
    engine.setKeys(keys);
    airKeyring.set([...engine.keys]);
  }

  // Своя станция
  const broadcast = {
    active: false,  // станция в эфире
    busy: false,    // передатчик включается
    freq: null,
    name: '',
    key: null,      // ключ канала, если эфир шифруется
    listeners: 0,
    mode: saved.onair?.mode === 'ptt' ? 'ptt' : 'continuous',
    ptt: false,     // тангента нажата
  };
  const playlist = new Playlist();
  playlist.setShuffle(saved.onair?.shuffle === true);

  // Приложение для Windows: сервер выбирают сами (на сайте он всегда тот, что отдал страницу)
  const desktop = window.radioDesktop ?? null;
  const serverState = {
    address: typeof saved.server?.address === 'string' ? saved.server.address : '',
    recent: Array.isArray(saved.server?.recent) ? saved.server.recent.filter((a) => typeof a === 'string').slice(0, 6) : [],
    hosting: false,  // свой сервер открыт
    busy: false,
    info: null,      // что сообщило приложение при открытии сервера
    auto: saved.server?.auto !== false, // подключаться к запомненному серверу при запуске
  };

  /* ───────── Хранение ───────── */

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        freq: engine.freq,
        volume: engine.volume,
        keys: [...engine.keys],
        found: [...found],
        heard: [...heard.values()],
        squelch: engine.squelch,
        server: {
          address: serverState.address,
          recent: serverState.recent,
          host: serverState.hosting,
          auto: serverState.auto,
        },
        onair: {
          name: els.onairName.value,
          freq: els.onairFreq.value,
          key: els.onairKey.value,
          mode: broadcast.mode,
          mic: els.srcMic.checked,
          monitor: els.srcMonitor.checked,
          shuffle: playlist.shuffle,
        },
      }));
    } catch {
      /* хранилище недоступно — просто не запоминаем */
    }
  }

  function loadHeard(list) {
    const map = new Map();
    if (!Array.isArray(list)) return map;
    for (const e of list) {
      if (e && typeof e.name === 'string' && Number.isFinite(e.freq) && Number.isFinite(e.last)) {
        map.set(heardKey(e.name, e.freq), { name: e.name, freq: e.freq, last: e.last, encrypted: Boolean(e.encrypted) });
      }
    }
    return map;
  }

  function heardKey(name, freq) {
    return `${name}|${freq.toFixed(2)}`;
  }

  let saveTimer;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }

  /* ───────── Шкала ───────── */

  const pct = (f) => ((f - BAND.min) / (BAND.max - BAND.min)) * 100;

  function buildScale() {
    const frag = document.createDocumentFragment();
    for (let i = 880; i <= 1080; i += 2) {
      const f = i / 10;
      const tick = document.createElement('span');
      tick.className = 'tick' + (i % 20 === 0 ? ' tick--major' : i % 10 === 0 ? ' tick--mid' : '');
      tick.style.left = pct(f) + '%';
      frag.append(tick);
      if (i % 20 === 0) {
        const label = document.createElement('span');
        label.className = 'tick-label';
        label.textContent = f;
        label.style.left = pct(f) + '%';
        frag.append(label);
      }
    }
    els.ticks.append(frag);
  }

  function renderMarks() {
    const mark = (freq, live) => {
      const m = document.createElement('span');
      m.className = live ? 'mark mark--live' : 'mark';
      m.style.left = pct(freq) + '%';
      return m;
    };
    els.marks.replaceChildren(
      ...stations.filter((st) => !st.live && found.has(st.id)).map((st) => mark(st.freq, false)),
      ...[...heard.values()].map((e) => mark(e.freq, true)),
    );
  }

  function freqFromX(clientX) {
    const r = els.track.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return BAND.min + x * (BAND.max - BAND.min);
  }

  let scaleDrag = false;
  els.scale.addEventListener('pointerdown', (e) => {
    stopSeek();
    scaleDrag = true;
    els.scale.setPointerCapture(e.pointerId);
    engine.setFrequency(freqFromX(e.clientX));
  });
  els.scale.addEventListener('pointermove', (e) => {
    if (scaleDrag) engine.setFrequency(freqFromX(e.clientX));
  });
  for (const type of ['pointerup', 'pointercancel']) {
    els.scale.addEventListener(type, () => {
      scaleDrag = false;
      saveSoon();
    });
  }
  els.scale.addEventListener('wheel', (e) => {
    e.preventDefault();
    stopSeek();
    nudge(-Math.sign(e.deltaY) * TUNE_STEP * (e.shiftKey ? 10 : 1));
  }, { passive: false });

  // Сдвиг частоты с привязкой к сетке 0,05 МГц
  function nudge(delta) {
    engine.setFrequency(Math.round((engine.freq + delta) / TUNE_STEP) * TUNE_STEP);
    saveSoon();
  }

  /* ───────── Ручки ───────── */

  // onTurn получает поворот в долях полного оборота (по часовой — положительный)
  function makeKnob(el, { onTurn, wheelStep }) {
    let last = null;
    const angleOf = (e) => {
      const r = el.getBoundingClientRect();
      return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
    };
    el.addEventListener('pointerdown', (e) => {
      stopSeek();
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-grabbing');
      last = angleOf(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (last === null) return;
      const a = angleOf(e);
      let d = a - last;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      last = a;
      onTurn(d / (2 * Math.PI), false);
    });
    for (const type of ['pointerup', 'pointercancel']) {
      el.addEventListener(type, () => {
        last = null;
        el.classList.remove('is-grabbing');
        saveSoon();
      });
    }
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      stopSeek();
      onTurn(-Math.sign(e.deltaY) * wheelStep * (e.shiftKey ? 10 : 1), true);
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      stopSeek();
      onTurn(dir * wheelStep * (e.shiftKey ? 10 : 1), true);
    });
  }

  makeKnob(els.knobTune, {
    wheelStep: TUNE_STEP / MHZ_PER_TURN,
    onTurn(turns, stepped) {
      if (stepped) nudge(turns * MHZ_PER_TURN);
      else engine.setFrequency(engine.freq + turns * MHZ_PER_TURN);
    },
  });

  makeKnob(els.knobVol, {
    wheelStep: 0.05 * 0.75,
    onTurn(turns, stepped) {
      engine.setVolume(engine.volume + turns / 0.75); // 270° — от нуля до максимума
      if (stepped) saveSoon();
    },
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, .knob')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      stopSeek();
      nudge((e.key === 'ArrowRight' ? 1 : -1) * TUNE_STEP * (e.shiftKey ? 10 : 1));
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      seek(e.key === 'PageUp' ? 1 : -1);
    }
  });

  /* ───────── Поиск ───────── */

  let seekFrame = null;

  function stopSeek() {
    if (seekFrame) cancelAnimationFrame(seekFrame);
    seekFrame = null;
  }

  // Проезжает по шкале до следующей сильной станции, замедляясь на подходе
  function seek(dir) {
    stopSeek();
    if (!engine.on) {
      toast('Сначала включите приёмник');
      return;
    }
    const range = BAND.max - BAND.min;
    // Только станции этой шкалы: рации (400–470 МГц) приёмнику не видны
    const cands = stations
      .filter((st) => st.seekable && st.onAir && st.freq >= BAND.min && st.freq <= BAND.max)
      .map((st) => st.freq)
      .sort((a, b) => a - b);
    const cur = engine.freq;
    const target = dir > 0
      ? cands.find((f) => f > cur + 0.05) ?? cands[0]
      : [...cands].reverse().find((f) => f < cur - 0.05) ?? cands[cands.length - 1];
    let remaining = dir > 0 ? (target - cur + range) % range : (cur - target + range) % range;
    let last = performance.now();

    const step = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const dist = Math.max(0.8, Math.min(4.5, remaining * 4)) * dt;
      if (dist >= remaining) {
        engine.setFrequency(target);
        seekFrame = null;
        saveSoon();
        return;
      }
      remaining -= dist;
      let f = engine.freq + dir * dist;
      if (f > BAND.max) f -= range;
      if (f < BAND.min) f += range;
      engine.setFrequency(f);
      seekFrame = requestAnimationFrame(step);
    };
    seekFrame = requestAnimationFrame(step);
  }

  els.seekUp.addEventListener('click', () => seek(1));
  els.seekDown.addEventListener('click', () => seek(-1));

  /* ───────── Шумоподавитель ───────── */

  function renderSquelch() {
    els.squelch.setAttribute('aria-pressed', String(engine.squelch));
  }

  els.squelch.addEventListener('click', () => {
    engine.setSquelch(!engine.squelch);
    renderSquelch();
    save();
    toast(engine.squelch ? 'Шумоподавитель включён: тишина, пока нет сигнала' : 'Шумоподавитель выключен');
  });

  /* ───────── Питание ───────── */

  let powerBusy = false;
  els.power.addEventListener('click', async () => {
    if (powerBusy) return;
    powerBusy = true;
    try {
      if (engine.on) {
        stopSeek();
        morse.detach();
        await engine.powerOff();
      } else {
        await engine.powerOn();
        morse.attach(engine);
        if (found.size === 0) toast('Крутите ручку настройки или нажмите ПОИСК');
      }
    } finally {
      powerBusy = false;
    }
    radioEl.dataset.power = engine.on ? 'on' : 'off';
    els.power.setAttribute('aria-pressed', String(engine.on));
    if (!engine.on) {
      els.rds.textContent = 'ПИТАНИЕ ВЫКЛ.';
      rdsTarget = '';
      for (const flag of [els.flagRds, els.flagSt, els.flagEnc]) flag.classList.remove('is-on');
    }
  });

  /* ───────── Ключи ───────── */

  const normalizeKey = (v) => v.trim().toUpperCase();

  function renderKeys() {
    els.keyList.replaceChildren(...[...engine.keys].map((k) => {
      const li = document.createElement('li');
      li.className = 'chip';
      const text = document.createElement('span');
      text.textContent = k;
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', `Удалить ключ ${k}`);
      del.addEventListener('click', () => {
        const keys = new Set(engine.keys);
        keys.delete(k);
        applyKeys(keys);
        renderKeys();
        renderLog();
        save();
      });
      li.append(text, del);
      return li;
    }));
  }

  els.keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = normalizeKey(els.keyInput.value);
    if (!key) return;
    els.keyInput.value = '';
    if (engine.keys.has(key)) {
      toast('Этот ключ уже в связке');
      return;
    }
    applyKeys([...engine.keys, key]);
    renderKeys();
    renderLog();
    save();
    toast(`Ключ ${key} добавлен в связку`);
  });

  /* ───────── Журнал ───────── */

  const HEARD_LIMIT = 50; // столько любительских станций хранится в журнале

  const logKey = (st) => (st.live ? heardKey(st.name, st.freq) : st.id);

  function heardAt(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return `сегодня, ${time}`;
    if (d.toDateString() === yesterday.toDateString()) return `вчера, ${time}`;
    return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${time}`;
  }

  function renderLog() {
    const onAirNow = new Set([...liveById.values()].map(logKey));
    const rows = [
      ...stations.filter((st) => !st.live && found.has(st.id)).map((st) => ({
        key: st.id, freq: st.freq, name: st.displayName(),
      })),
      ...[...heard.entries()].map(([key, e]) => ({
        key, freq: e.freq, name: e.name, live: true, last: e.last, encrypted: e.encrypted, now: onAirNow.has(key),
      })),
    ].sort((a, b) => a.freq - b.freq);

    els.log.replaceChildren(...rows.map((row) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'log__main';
      btn.dataset.key = row.key;
      const f = document.createElement('span');
      f.className = 'f';
      f.textContent = row.freq.toFixed(2);
      const name = document.createElement('span');
      name.className = 'log__name';
      name.textContent = row.name;
      btn.append(f, name);
      btn.addEventListener('click', () => {
        stopSeek();
        engine.setFrequency(row.freq);
        saveSoon();
      });
      li.append(btn);

      if (row.live) {
        const meta = document.createElement('span');
        meta.className = 'log__meta';
        const when = document.createElement('span');
        if (row.now) {
          when.className = 'live-dot';
          when.textContent = 'в эфире';
        } else {
          when.textContent = `слышали ${heardAt(row.last)}`;
        }
        meta.append(when);
        if (row.encrypted) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = 'ШИФР';
          meta.append(badge);
        }
        btn.append(meta);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'icon-btn';
        del.textContent = '×';
        del.setAttribute('aria-label', `Убрать ${row.name} из журнала`);
        del.addEventListener('click', () => {
          heard.delete(row.key);
          renderLog();
          save();
        });
        li.append(del);
      }
      return li;
    }));
    els.logEmpty.hidden = rows.length > 0;
    renderMarks();
  }

  function logLiveStation(st) {
    const key = logKey(st);
    const fresh = !heard.has(key);
    heard.set(key, { name: st.name, freq: st.freq, last: Date.now(), encrypted: st.encrypted });
    if (heard.size > HEARD_LIMIT) {
      const oldest = [...heard.entries()].sort((a, b) => a[1].last - b[1].last)[0][0];
      heard.delete(oldest);
    }
    renderLog();
    save();
    if (fresh) toast(`В журнале: ${st.name} — ${st.freq.toFixed(2)} МГц`);
  }

  let holdStation = null;
  let holdSince = 0;
  let holdLogged = false;

  // Станция попадает в журнал, если её удержали точно настроенной полторы секунды.
  // У любительских станций при каждом таком приёме обновляется время «слышали».
  function trackDiscovery(now) {
    const st = engine.best;
    const locked = st && !st.own && engine.bestCloseness > 0.8 && engine.bestSignal > 0.3;
    if (!locked) {
      holdStation = null;
      return;
    }
    if (holdStation !== st) {
      holdStation = st;
      holdSince = now;
      holdLogged = false;
      return;
    }
    if (holdLogged || now - holdSince < 1500) return;
    holdLogged = true;
    if (st.live) {
      logLiveStation(st);
    } else if (!found.has(st.id)) {
      found.add(st.id);
      renderLog();
      save();
      toast(`В журнале: ${st.displayName()} — ${st.freq.toFixed(2)} МГц`);
    }
  }

  /* ───────── Дисплей ───────── */

  const segs = Array.from({ length: 12 }, (_, i) => {
    const s = document.createElement('span');
    s.className = 'seg' + (i >= 9 ? ' seg--hot' : '');
    els.smeter.append(s);
    return s;
  });

  let meter = 0;
  let meterTarget = 0;
  let meterTick = 0;

  function renderMeter() {
    if (++meterTick % 6 === 0) {
      meterTarget = engine.on ? Math.min(1, engine.bestSignal * 1.02 + 0.05 + (Math.random() - 0.5) * 0.06) : 0;
    }
    meter += (meterTarget - meter) * 0.2;
    const lit = Math.round(meter * segs.length);
    segs.forEach((s, i) => s.classList.toggle('is-on', i < lit));
  }

  // RDS декодируется не сразу — текст появляется по буквам
  let rdsTarget = '';
  let rdsShown = 0;
  let rdsNext = 0;

  function currentLcdText() {
    const st = engine.best;
    if (!st || engine.bestSignal < 0.08) return '· · ·  ШУМ  · · ·';
    if (engine.bestCloseness > 0.7 && engine.bestSignal > 0.3) return st.lcdText();
    return 'СЛАБЫЙ СИГНАЛ';
  }

  function renderLcd(now) {
    const text = currentLcdText();
    if (text !== rdsTarget) {
      rdsTarget = text;
      const st = engine.best;
      rdsShown = st && st.rds && text === st.rds ? 0 : text.length;
    }
    if (rdsShown < rdsTarget.length && now >= rdsNext) {
      rdsShown++;
      rdsNext = now + 45;
    }
    const shown = rdsTarget.slice(0, rdsShown);
    if (els.rds.textContent !== shown) els.rds.textContent = shown || ' ';

    const st = engine.best;
    const locked = st && engine.bestCloseness > 0.7 && engine.bestSignal > 0.3;
    els.flagRds.classList.toggle('is-on', Boolean(locked && st.rds));
    els.flagSt.classList.toggle('is-on', Boolean(st && st.stereo && engine.bestSignal > 0.6));
    els.flagEnc.classList.toggle('is-on', Boolean(st && st.encrypted && engine.bestSignal > 0.15));
  }

  let scopeBuf = null;
  let scopeCleared = false;

  function renderScope() {
    const cv = els.scope;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      scopeCleared = false;
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!engine.on) {
      if (scopeCleared) return;
      g.clearRect(0, 0, w, h);
      g.strokeStyle = '#143a32';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(0, h / 2);
      g.lineTo(w, h / 2);
      g.stroke();
      scopeCleared = true;
      return;
    }
    scopeCleared = false;

    const an = engine.analyser;
    if (!scopeBuf) scopeBuf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(scopeBuf);
    g.clearRect(0, 0, w, h);
    g.beginPath();
    for (let i = 0; i < scopeBuf.length; i++) {
      const x = (i / (scopeBuf.length - 1)) * w;
      const y = h / 2 - Math.max(-1, Math.min(1, scopeBuf[i])) * h * 0.45;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = 'rgba(110, 242, 208, 0.9)';
    g.lineWidth = 1.5;
    g.shadowColor = 'rgba(110, 242, 208, 0.6)';
    g.shadowBlur = 6;
    g.stroke();
    g.shadowBlur = 0;
  }

  /* ───────── Декодер Морзе ───────── */

  let decoded = '';

  function renderDecoder() {
    if (decoded) {
      els.decoder.textContent = decoded;
      els.decoder.classList.remove('is-empty');
    } else {
      els.decoder.textContent = 'Настройтесь на телеграфную станцию — расшифровка появится здесь.';
      els.decoder.classList.add('is-empty');
    }
  }

  // Декодер слушает то же, что и вы: любую станцию, вместе с помехами
  const morse = new MorseDecoder((ch) => {
    if (ch === ' ' && (!decoded || decoded.endsWith(' '))) return;
    decoded = (decoded + ch).slice(-160);
    renderDecoder();
  });

  /* ───────── Живой эфир: приём ───────── */

  const liveById = new Map();

  const link = new AirLink({
    status(online) {
      if (!online) clearLive();
      renderOnAir();
      renderServer();
    },
    message: onServerMessage,
    audio(id, packet) {
      const st = liveById.get(id);
      // Свою шифрованную станцию слышим с ключом канала, даже если его нет в связке
      if (engine.on && st) st.receive(packet, st.own ? ownKeyring : airKeyring);
    },
  });

  function upsertLive(info) {
    if (!info || !Number.isInteger(info.id) || !Number.isFinite(info.freq)) return;
    const st = liveById.get(info.id);
    if (st) {
      st.update(info);
      engine.applyTuning();
    } else {
      const fresh = new LiveStation(info);
    fresh.own = Boolean(info.own);
      liveById.set(info.id, fresh);
      engine.addStation(fresh);
    }
    renderLog(); // отметка «в эфире» у станций из журнала
  }

  function removeLive(id) {
    const st = liveById.get(id);
    if (!st) return;
    liveById.delete(id);
    engine.removeStation(st);
    renderLog();
  }

  function clearLive() {
    for (const id of [...liveById.keys()]) removeLive(id);
  }

  function onServerMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        clearLive();
        if (Array.isArray(msg.stations)) msg.stations.forEach(upsertLive);
        // После переподключения сервер нас не помнит — заявляем станцию заново
        if (broadcast.active) sendOnAir();
        break;
      case 'station-on':
        upsertLive(msg.station);
        break;
      case 'station-off':
        removeLive(msg.id);
        break;
      case 'server-notice': {
        // Оповещение от хозяина сервера (когда мы подключены к чужому эфиру) — показываем тостом
        const labels = { update: 'Обновление', restart: 'Перезапуск', shutdown: 'Выключение', live: 'В работе' };
        toast(`Сервер: ${labels[msg.state] || 'сообщение'}${msg.text ? ` · ${msg.text}` : ''}`);
        break;
      }
      case 'onair-ok':
        if (msg.station) {
          broadcast.name = msg.station.name;
          broadcast.stationId = msg.station.id;
          // «Слышать себя»: своя станция появляется в приёмнике, звук сервер присылает обратно
          if (els.srcMonitor.checked) upsertLive({ ...msg.station, own: true });
          else removeLive(msg.station.id);
        }
        renderOnAir();
        break;
      case 'listeners':
        broadcast.listeners = Number(msg.count) || 0;
        renderOnAir();
        break;
      case 'error':
        toast(String(msg.message));
        break;
    }
  }

  /* ───────── Живой эфир: передача ───────── */

  const broadcaster = new Broadcaster(transmit);

  // Интернет-радио как источник эфира: когда включено, в эфир идёт живой поток вместо плейлиста
  const netRadio = { active: false, url: '' };

  broadcaster.onStreamState = (state) => {
    if (!els.netRadioStatus) return;
    els.netRadioStatus.hidden = !netRadio.active;
    if (!netRadio.active) return;
    els.netRadioStatus.textContent = state === 'reconnect' ? 'Поток прервался — переподключаюсь…' : 'Интернет-радио в эфире.';
  };

  // monitor — сервер присылает звук станции и ей самой (слышать свой эфир в приёмнике)
  function sendOnAir() {
    link.send({ type: 'onair', freq: broadcast.freq, name: broadcast.name, monitor: els.srcMonitor.checked });
  }

  // Для своей станции ключ канала известен и без связки
  const ownKeyring = {
    find: (id) => (broadcast.key && toHex(id) === broadcast.key.idHex ? broadcast.key : undefined),
  };
  let sealing = Promise.resolve();

  // Звук сжимается (ADPCM, ~4x меньше) — держит связь на слабой сети; seq для восстановления потерь
  let txSeq = 0;
  function transmit(pcm) {
    const seq = (txSeq = (txSeq + 1) & 0xff);
    const adpcm = adpcmEncode(new Int16Array(pcm));
    const entry = broadcast.key;
    if (!entry) {
      link.sendAudio(openPacketC(adpcm, seq));
      return;
    }
    sealing = sealing
      .then(() => sealPacketC(entry, adpcm, seq))
      .then((packet) => link.sendAudio(packet))
      .catch(() => {});
  }

  function readFreqInput() {
    const f = parseFloat(els.onairFreq.value.replace(',', '.'));
    return f >= BAND.min && f <= BAND.max ? Math.round(f * 100) / 100 : null;
  }

  function updateTransmit() {
    broadcaster.transmitting = broadcast.active && (broadcast.mode === 'continuous' || broadcast.ptt);
    els.onair.classList.toggle('is-transmitting', broadcaster.transmitting);
    els.ptt.classList.toggle('is-held', broadcast.ptt);
    // Видно и на панели задач, когда окно свёрнуто
    document.title = broadcaster.transmitting ? '● Передача — Радио' : 'Радио';
  }

  async function goOnAir() {
    const freq = readFreqInput();
    if (freq == null) {
      toast('Частота должна быть от 87.5 до 108 МГц');
      els.onairFreq.focus();
      return;
    }
    broadcast.busy = true;
    renderOnAir();
    try {
      await broadcaster.open();
      const phrase = normalizeKey(els.onairKey.value);
      broadcast.key = phrase ? await deriveAirKey(phrase) : null;
    } catch (err) {
      await broadcaster.close();
      broadcast.busy = false;
      renderOnAir();
      toast(`Не удалось включить передатчик: ${err.message}`);
      return;
    }
    await connectMic();
    if (netRadio.active && netRadio.url) await broadcaster.playStream(netRadio.url).catch(() => {});
    else if (playlist.size) await playNext();
    Object.assign(broadcast, { active: true, busy: false, freq, name: els.onairName.value.trim(), listeners: 0 });
    els.onairFreq.value = freq.toFixed(2);
    sendOnAir();
    updateTransmit();
    renderOnAir();
    renderPlaylist();
    save();
  }

  async function goOffAir() {
    broadcast.active = false;
    broadcast.ptt = false;
    broadcast.pttSource = null;
    updateTransmit();
    link.send({ type: 'offair' });
    if (broadcast.stationId != null) removeLive(broadcast.stationId);
    broadcast.stationId = null;
    // Недоигранный трек начнётся заново, когда снова выйдете в эфир
    if (broadcaster.trackPlaying && playlist.currentItem) playlist.cue(playlist.currentItem.id);
    await broadcaster.close();
    broadcast.key = null;
    renderOnAir();
    renderPlaylist();
  }

  async function connectMic() {
    if (!broadcaster.ctx) return;
    try {
      await broadcaster.setMic(els.srcMic.checked);
    } catch (err) {
      els.srcMic.checked = false;
      toast(err.name === 'NotAllowedError' ? 'Нет доступа к микрофону — эфир без голоса' : `Микрофон не включился: ${err.message}`);
    }
  }

  /* ───────── Плейлист ───────── */

  const AUDIO_EXT = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|webm)$/i;
  let trackErrors = 0;

  const plural = (n, one, few, many) => {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };

  async function playNext() {
    if (netRadio.active) { renderPlaylist(); return; } // в эфире интернет-радио — плейлист не крутим
    const item = playlist.next();
    renderPlaylist();
    if (!broadcaster.ctx) return;
    if (!item) {
      broadcaster.stopTrack();
      return;
    }
    try {
      await broadcaster.playTrack(item.url);
      trackErrors = 0;
      renderPlaylist();
    } catch (err) {
      // Битый файл придёт отдельно через событие error, смену трека на ходу (AbortError) не считаем
      if (err.name === 'NotAllowedError') toast('Браузер не дал включить трек — нажмите «Следующий»');
    }
  }

  // Если подряд не играет ни один файл — останавливаемся, а не крутимся по кругу
  function onTrackFailed() {
    const item = playlist.currentItem;
    if (item) toast(`Не удалось воспроизвести «${item.name}»`);
    if (++trackErrors < playlist.size) {
      playNext();
    } else {
      trackErrors = 0;
      broadcaster.stopTrack();
      renderPlaylist();
    }
  }

  broadcaster.onTrackEnd = () => {
    trackErrors = 0;
    playNext();
  };
  broadcaster.onTrackError = onTrackFailed;

  /* ───────── Интернет-радио как источник ───────── */

  function renderNetRadio() {
    els.netRadioToggle.textContent = netRadio.active ? 'Выключить радио' : 'Радио в эфир';
    els.netRadioToggle.classList.toggle('btn--amber', netRadio.active);
  }

  async function toggleNetRadio() {
    if (netRadio.active) {
      netRadio.active = false;
      broadcaster.stopTrack();
      els.netRadioStatus.hidden = true;
      els.netRadioStatus.textContent = '';
      if (broadcast.active && playlist.size) playNext(); // вернуться к плейлисту
      renderNetRadio();
      return;
    }
    const url = (els.netRadioUrl.value || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      toast('Укажите URL потока (http:// или https://)');
      return;
    }
    netRadio.active = true;
    netRadio.url = url;
    renderNetRadio();
    els.netRadioStatus.hidden = false;
    if (broadcast.active && broadcaster.ctx) {
      els.netRadioStatus.textContent = 'Подключаюсь к потоку…';
      try {
        await broadcaster.playStream(url);
      } catch {
        els.netRadioStatus.textContent = 'Не удалось подключиться к потоку.';
      }
    } else {
      els.netRadioStatus.textContent = 'Включится, когда выйдете в эфир.';
    }
  }

  els.netRadioToggle.addEventListener('click', () => { toggleNetRadio(); });

  function addTracks(files) {
    const tracks = [...files].filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
    if (!tracks.length) {
      toast('Это не аудиофайлы');
      return;
    }
    playlist.add(tracks);
    toast(`В плейлисте: +${tracks.length} ${plural(tracks.length, 'трек', 'трека', 'треков')}`);
    if (broadcaster.ctx && !broadcaster.trackPlaying) playNext();
    else renderPlaylist();
  }

  function renderPlaylist() {
    const onAir = Boolean(broadcaster.ctx);
    els.playlistList.replaceChildren(...playlist.items.map((item, i) => {
      const current = i === playlist.current;
      const li = document.createElement('li');
      li.className = current ? 'track is-current' : 'track';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'track__play';
      btn.title = onAir ? 'Включить сейчас' : 'Начать эфир с этого трека';
      const num = document.createElement('span');
      num.className = 'track__num';
      num.textContent = current && broadcaster.trackPlaying ? '▶' : String(i + 1);
      const name = document.createElement('span');
      name.className = 'track__name';
      name.textContent = item.name;
      btn.append(num, name);
      btn.addEventListener('click', () => {
        playlist.cue(item.id);
        if (onAir) playNext();
        else renderPlaylist();
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn';
      del.textContent = '×';
      del.setAttribute('aria-label', `Убрать «${item.name}» из плейлиста`);
      del.addEventListener('click', () => {
        const wasPlaying = playlist.remove(item.id) && broadcaster.trackPlaying;
        if (wasPlaying) playNext();
        else renderPlaylist();
      });
      li.append(btn, del);
      return li;
    }));
    const n = playlist.size;
    els.playlistCount.textContent = n ? `· ${n} ${plural(n, 'трек', 'трека', 'треков')}` : '';
    els.playlistEmpty.hidden = n > 0;
    els.playlistNext.disabled = n === 0;
    els.trackPick.classList.toggle('has-file', n > 0);
  }

  els.srcTrack.addEventListener('change', () => {
    addTracks(els.srcTrack.files);
    els.srcTrack.value = ''; // чтобы те же файлы можно было выбрать снова
  });

  els.playlistNext.addEventListener('click', () => {
    if (broadcaster.ctx) {
      playNext();
      return;
    }
    // Не в эфире — просто сдвигаем, с какого трека начнётся эфир
    playlist.cued = false;
    playlist.next();
    playlist.cued = true;
    renderPlaylist();
  });

  for (const input of document.querySelectorAll('input[name="playlist-mode"]')) {
    input.checked = (input.value === 'shuffle') === playlist.shuffle;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      playlist.setShuffle(input.value === 'shuffle');
      saveSoon();
    });
  }

  // Файлы можно перетащить прямо в плейлист
  const draggingFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  els.playlist.addEventListener('dragover', (e) => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    els.playlist.classList.add('is-dragover');
  });
  els.playlist.addEventListener('dragleave', (e) => {
    if (!els.playlist.contains(e.relatedTarget)) els.playlist.classList.remove('is-dragover');
  });
  els.playlist.addEventListener('drop', (e) => {
    e.preventDefault();
    els.playlist.classList.remove('is-dragover');
    addTracks(e.dataTransfer.files);
  });
  // Промахнулись мимо плейлиста — браузер не должен уходить со страницы, открывая файл
  window.addEventListener('dragover', (e) => {
    if (draggingFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (draggingFiles(e)) e.preventDefault();
  });

  // source: 'hold' — держат кнопку или пробел; 'latch' — включили горячей клавишей до повторного нажатия
  function setPtt(held, source = 'hold') {
    if (!broadcast.active || broadcast.mode !== 'ptt') held = false;
    if (broadcast.ptt === held) return;
    broadcast.ptt = held;
    broadcast.pttSource = held ? source : null;
    updateTransmit();
  }

  const releaseHeldPtt = () => {
    if (broadcast.pttSource === 'hold') setPtt(false);
  };

  // Горячая клавиша рации работает из любого окна, только пока вы в эфире в режиме рации
  let globalPttOn = false;
  let pttHotkey = { label: '', hold: false }; // как назначена клавиша (настраивается в полоске рации)
  function syncGlobalPtt() {
    const want = Boolean(desktop) && broadcast.active && broadcast.mode === 'ptt';
    if (want === globalPttOn) return;
    globalPttOn = want;
    desktop.setHotkeysActive(want);
  }

  function onAirStatusText() {
    if (!link.available) {
      return desktop
        ? 'Подключитесь к серверу или откройте свой — панель «Сервер» выше.'
        : 'Живой эфир работает через сервер: запустите python server.py и откройте http://localhost:8765.';
    }
    if (!link.online) {
      return desktop
        ? 'Нет связи с сервером. Проверьте адрес — приложение переподключается само.'
        : 'Нет связи с сервером эфира. Запустите python server.py — страница подключится сама.';
    }
    if (!Broadcaster.supported) return 'Отсюда можно только слушать: браузер даёт микрофон лишь на localhost или по HTTPS.';
    if (broadcast.active) {
      const hotkey = desktop && pttHotkey.label
        ? ` ${pttHotkey.label} — ${pttHotkey.hold ? 'говорить, пока держите,' : 'включить или выключить передачу'} из любого окна.`
        : '';
      const how = broadcast.mode === 'ptt'
        ? `Держите кнопку или пробел, чтобы говорить.${hotkey}`
        : 'Всё, что звучит в микрофоне и плейлисте, уходит в эфир.';
      const lock = broadcast.key ? ' · канал зашифрован' : '';
      return `Вы в эфире на ${broadcast.freq.toFixed(2)} МГц${lock} · слушателей: ${broadcast.listeners}. ${how}`;
    }
    return 'Своя станция на своей частоте: её услышат все, кто настроится рядом. '
      + 'С ключом канала голос разберут только те, у кого этот ключ есть в связке. '
      + 'Лучше в наушниках — иначе приёмник из соседней вкладки попадёт обратно в микрофон.';
  }

  function renderOnAir() {
    const { active, busy } = broadcast;
    els.onair.dataset.state = active ? 'live' : 'idle';
    els.net.classList.toggle('is-online', link.online);
    els.netText.textContent = link.online ? 'сервер на связи' : 'нет связи';
    els.onairToggle.textContent = busy ? 'Включаем…' : active ? 'Закончить эфир' : 'Выйти в эфир';
    els.onairToggle.disabled = busy || (!active && (!link.online || !Broadcaster.supported));
    els.onairName.disabled = active;
    els.onairFreq.disabled = active;
    els.onairTake.disabled = active;
    els.onairKey.disabled = active;
    els.ptt.hidden = !(active && broadcast.mode === 'ptt');
    els.onairStatus.textContent = onAirStatusText();
    syncGlobalPtt();
  }

  els.onairToggle.addEventListener('click', () => {
    if (broadcast.busy) return;
    if (broadcast.active) goOffAir();
    else goOnAir();
  });

  els.onairTake.addEventListener('click', () => {
    els.onairFreq.value = engine.freq.toFixed(2);
    saveSoon();
  });
  els.onairName.addEventListener('input', saveSoon);
  els.onairFreq.addEventListener('input', saveSoon);
  els.onairKey.addEventListener('input', saveSoon);

  els.srcMonitor.addEventListener('change', () => {
    saveSoon();
    if (broadcast.active) sendOnAir();
  });

  els.srcMic.addEventListener('change', () => {
    saveSoon();
    connectMic();
  });

  for (const input of document.querySelectorAll('input[name="onair-mode"]')) {
    input.checked = input.value === broadcast.mode;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      broadcast.mode = input.value;
      broadcast.ptt = false;
      broadcast.pttSource = null;
      updateTransmit();
      renderOnAir();
      saveSoon();
    });
  }

  // Тангента: кнопка на экране или пробел
  els.ptt.addEventListener('pointerdown', (e) => {
    els.ptt.setPointerCapture(e.pointerId);
    setPtt(true);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    els.ptt.addEventListener(type, releaseHeldPtt);
  }
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || !broadcast.active || broadcast.mode !== 'ptt') return;
    if (e.target.closest('input, textarea, select, button:not(#ptt)')) return;
    e.preventDefault();
    setPtt(true);
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') releaseHeldPtt();
  });
  // Ушли в другое окно, держа пробел, — отпускание уже не увидим, поэтому отпускаем сами.
  // Передачу, включённую горячей клавишей, это не касается.
  window.addEventListener('blur', releaseHeldPtt);
  // Горячая клавиша: «держу — говорю» (ptt-down/up) или «нажал/нажал» (ptt-toggle)
  desktop?.onHotkey((action) => {
    if (action === 'ptt-toggle') setPtt(!broadcast.ptt, 'latch');
    else if (action === 'ptt-down') setPtt(true, 'key');
    else if (action === 'ptt-up' && broadcast.pttSource === 'key') setPtt(false);
  });
  desktop?.setHotkeysActive(false); // у большого окна клавиша рации работает только в эфире
  desktop?.hotkeys().then((state) => {
    pttHotkey = { label: state.bindings.ptt.label, hold: state.pttMode === 'hold' && state.hooked };
    renderOnAir();
  });

  /* ───────── Сервер (в приложении) ───────── */

  function rememberServer(address) {
    serverState.recent = [address, ...serverState.recent.filter((a) => a !== address)].slice(0, 6);
  }

  function connectTo(address) {
    const url = AirLink.serverUrl(address);
    if (!url) {
      toast('Не похоже на адрес сервера. Пример: 93.184.1.2:8765');
      return;
    }
    serverState.address = address;
    rememberServer(address);
    link.setServer(url);
    renderServer();
    save();
  }

  async function startHosting() {
    serverState.busy = true;
    renderServer();
    const result = await desktop.hostStart({ port: 8765 });
    serverState.busy = false;
    if (!result.ok) {
      renderServer();
      toast(`Не удалось открыть сервер: ${result.error}`);
      return;
    }
    serverState.hosting = true;
    serverState.info = result;
    link.setServer(`ws://localhost:${result.port}/ws`);
    renderServer();
    save();
  }

  async function stopHosting() {
    serverState.busy = true;
    renderServer();
    await desktop.hostStop();
    Object.assign(serverState, { busy: false, hosting: false, info: null });
    link.setServer(null);
    renderServer();
    save();
  }

  // Что сказать про свой сервер: адрес для друзей и что с портом в роутере
  function hostInfoLines() {
    const info = serverState.info;
    if (!serverState.hosting || !info) {
      return [['Свой сервер — это эфир, к которому подключаются друзья по вашему адресу. Работает, пока открыто приложение.']];
    }
    const port = info.port;
    const lan = info.lan?.[0];
    const pub = info.publicIps?.[0];
    const lines = [];
    if (info.reused) lines.push(['На этом компьютере уже работает сервер эфира (например, python server.py) — приложение подключилось к нему.']);
    const up = info.upnp;
    if (pub) {
      // VPS/сервер: белый IP прямо на карте, роутера нет — это и есть адрес для друзей.
      lines.push(['Адрес для друзей: ', { addr: `${pub}:${port}` }]);
      lines.push([`Публичный IP — проброс не нужен. Если друзья не подключаются, откройте TCP-порт ${port} в файрволе сервера (например, ufw allow ${port}).`]);
    } else if (up?.ok && up.public) {
      lines.push(['Адрес для друзей: ', { addr: `${up.externalIp}:${port}` }]);
      lines.push(['Порт в роутере открыт автоматически.']);
    } else if (up?.ok) {
      lines.push([{ warn: `Внешний адрес ${up.externalIp} — «серый»: из интернета к вам не подключиться. Нужен белый IP у провайдера.` }]);
    } else if (lan) {
      lines.push([{ warn: `Роутер не открыл порт сам: ${up?.error ?? 'нет ответа'}.` }]);
      lines.push([`Пробросьте в роутере TCP-порт ${port} на ${lan}, и друзья подключатся по вашему белому IP.`]);
    } else {
      // Ни домашней сети, ни роутера, ни публичного адреса на карте — скорее всего сервер за NAT
      // провайдера (VPS с приватным IP). Локально белый адрес не узнать, подсказываем что делать.
      lines.push([`Дайте друзьям внешний IP этого сервера и порт ${port}, и откройте TCP-порт ${port} в файрволе (например, ufw allow ${port}). Узнать внешний IP: curl ifconfig.me.`]);
    }
    if (lan) lines.push(['В вашей Wi-Fi сети: ', { addr: `${lan}:${port}` }]);
    return lines;
  }

  function renderServer() {
    if (!desktop) return;
    const label = serverState.hosting ? 'свой сервер' : serverState.address;
    els.serverNet.classList.toggle('is-online', link.online);
    els.serverNetText.textContent = link.online
      ? `на связи: ${label}`
      : link.available ? 'подключаемся…' : 'не подключено';

    els.hostToggle.textContent = serverState.busy ? 'Подождите…' : serverState.hosting ? 'Закрыть свой сервер' : 'Открыть свой сервер';
    els.hostToggle.disabled = serverState.busy;

    els.hostInfo.replaceChildren(...hostInfoLines().map((parts) => {
      const p = document.createElement('p');
      for (const part of parts) {
        if (typeof part === 'string') {
          p.append(part);
        } else if (part.addr) {
          const addr = document.createElement('span');
          addr.className = 'addr';
          addr.textContent = part.addr;
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'btn btn--sm';
          copy.textContent = 'Копировать';
          copy.style.marginLeft = '10px';
          copy.addEventListener('click', () => {
            navigator.clipboard.writeText(part.addr).then(() => toast('Адрес скопирован'), () => toast(part.addr));
          });
          p.append(addr, copy);
        } else if (part.warn) {
          const warn = document.createElement('span');
          warn.className = 'warn';
          warn.textContent = part.warn;
          p.append(warn);
        }
      }
      return p;
    }));

    els.serverRecent.replaceChildren(...serverState.recent.map((address) => {
      const li = document.createElement('li');
      li.className = 'chip chip--link';
      const text = document.createElement('span');
      text.textContent = address;
      text.addEventListener('click', () => {
        els.serverAddress.value = address;
        if (serverState.hosting) stopHosting().then(() => connectTo(address));
        else connectTo(address);
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', `Забыть ${address}`);
      del.addEventListener('click', () => {
        serverState.recent = serverState.recent.filter((a) => a !== address);
        renderServer();
        save();
      });
      li.append(text, del);
      return li;
    }));
  }

  els.serverForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const address = els.serverAddress.value.trim();
    if (!address) return;
    if (serverState.hosting) stopHosting().then(() => connectTo(address));
    else connectTo(address);
  });

  els.hostToggle.addEventListener('click', () => {
    if (serverState.busy) return;
    if (serverState.hosting) stopHosting();
    else startHosting();
  });

  // Оповестить всех в эфире: кнопка статуса → сервер разошлёт server-notice всем клиентам
  // (рациям и станциям). Работает и на своём сервере, и когда подключён к чужому.
  {
    const noticeText = $('notice-text');
    const noticeStatus = $('notice-status');
    const noticeLabels = { update: 'Обновление', restart: 'Перезапуск', shutdown: 'Выключение', live: 'В работе' };
    document.querySelectorAll('[data-notice]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!link.online) {
          if (noticeStatus) noticeStatus.textContent = 'Нет связи с сервером — оповещение не отправить.';
          return;
        }
        const state = btn.getAttribute('data-notice');
        const text = (noticeText && noticeText.value || '').trim().slice(0, 120);
        link.send({ type: 'notice', state, text });
        if (noticeStatus) noticeStatus.textContent = `Отправлено всем: «${noticeLabels[state] || state}»${text ? ` · ${text}` : ''}.`;
      });
    });
  }

  /* ───────── Уведомления ───────── */

  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('is-shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-shown'), 2800);
  }

  /* ───────── Главный цикл ───────── */

  let lastAria = '';
  let lastTuned;

  function frame(now) {
    // Сервер шлёт звук живых станций только тем, кто настроен рядом
    const tuned = engine.on ? engine.freq : null;
    if (tuned !== lastTuned) {
      lastTuned = tuned;
      link.tune(tuned);
    }
    els.vuBar.style.transform = `scaleX(${broadcaster.ctx ? Math.min(1, broadcaster.level * 1.4) : 0})`;

    const f = engine.freq;
    els.needle.style.left = pct(f) + '%';
    const fText = f.toFixed(2);
    if (els.freq.textContent !== fText) els.freq.textContent = fText;
    els.knobTuneBody.style.transform = `rotate(${((f - BAND.min) / MHZ_PER_TURN) * 360}deg)`;
    els.knobVolBody.style.transform = `rotate(${-135 + engine.volume * 270}deg)`;

    const aria = `${fText}|${Math.round(engine.volume * 100)}`;
    if (aria !== lastAria) {
      lastAria = aria;
      els.scale.setAttribute('aria-valuenow', fText);
      els.scale.setAttribute('aria-valuetext', `${fText} МГц`);
      els.knobTune.setAttribute('aria-valuenow', fText);
      els.knobTune.setAttribute('aria-valuetext', `${fText} МГц`);
      els.knobVol.setAttribute('aria-valuenow', String(Math.round(engine.volume * 100)));
    }

    const current = engine.best && engine.bestCloseness > 0.8 ? logKey(engine.best) : null;
    for (const btn of els.log.querySelectorAll('.log__main')) {
      btn.classList.toggle('is-current', btn.dataset.key === current);
    }

    renderMeter();
    renderScope();
    if (engine.on) {
      renderLcd(now);
      trackDiscovery(now);
    }
    requestAnimationFrame(frame);
  }

  window.radio = { engine, stations, link, broadcaster, airKeyring, playlist, morse }; // для отладки из консоли браузера

  els.onairName.value = saved.onair?.name ?? '';
  els.onairFreq.value = saved.onair?.freq ?? '';
  els.onairKey.value = saved.onair?.key ?? '';
  els.srcMic.checked = saved.onair?.mic ?? true;
  els.srcMonitor.checked = saved.onair?.monitor ?? true;

  buildScale();
  renderKeys();
  renderLog();
  renderDecoder();
  renderPlaylist();
  renderOnAir();
  renderSquelch();

  if (desktop) {
    // Приложение: подключаемся туда же, где были в прошлый раз
    els.serverPanel.hidden = false;
    els.toWidget.hidden = false;
    els.toWidget.addEventListener('click', () => {
      save();
      desktop.switchMode('widget');
    });
    els.serverAuto.checked = serverState.auto;
    els.serverAuto.addEventListener('change', () => {
      serverState.auto = els.serverAuto.checked;
      save();
    });
    els.serverAddress.value = serverState.address;
    renderServer();
    if (saved.server?.host) startHosting();
    else if (serverState.address && serverState.auto) connectTo(serverState.address);
  } else {
    link.connect();
  }
  requestAnimationFrame(frame);
})();
