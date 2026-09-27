'use strict';

/*
 * Рация-виджет по мотивам Quansheng UV-K5 (логика — по её инструкции).
 *
 * Два канала A и B: каналы PMR/LPD (режим MR) или любая частота 400–470 МГц (VFO).
 * FM-радио 88–108 МГц — по F+0. Меню с пунктами по номерам, F-функции, блокировка,
 * сканирование, Monitor, VOX, ROGER, таймер передачи, двойное прослушивание, шифрование.
 */

(() => {
  const desktop = window.radioDesktop ?? null;
  const STORE = 'radio.widget.v1';
  const APP_STORE = 'radio.v1'; // общее с большим окном: связка ключей, сервер

  const round5 = (f) => Math.round(f * 1e5) / 1e5;
  const PLANS = {
    PMR: Array.from({ length: 16 }, (_, i) => round5(446.00625 + i * 0.0125)),
    LPD: Array.from({ length: 69 }, (_, i) => round5(433.075 + i * 0.025)),
  };
  const STEPS = [2.5, 5, 6.25, 10, 12.5, 25]; // кГц
  const SQL_LEVELS = [0, 0.06, 0.12, 0.2, 0.28, 0.36, 0.45, 0.55, 0.68, 0.82];
  const VOX_LEVELS = [0, 0.1, 0.075, 0.055, 0.04, 0.03, 0.022, 0.016, 0.012, 0.009, 0.007]; // громкость голоса (RMS)
  const MIC_GAINS = [0.5, 0.75, 1, 1.4, 2];
  const ABR_TIMES = [0, 5, 10, 20, 30]; // подсветка, с; 0 — всегда
  const VOX_HANG = 900;   // мс тишины, после которых VOX отпускает передачу
  const DW_HOLD = 5000;   // мс после приёма на втором канале, пока ответ уходит туда же
  const LONG_PRESS = 600;
  const NEW = '\u0000new'; // пункт «новый…» в списках

  const $ = (id) => document.getElementById(id);
  const rigEl = $('rig');
  const lcdEl = $('lcd');
  const input = $('text-entry');

  /* ───────── Хранение ───────── */

  function loadJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch {
      return {};
    }
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* хранилище недоступно — просто не запоминаем */
    }
  }

  // Общие с большим окном данные меняем точечно, не затирая остальное
  function updateApp(change) {
    const data = loadJson(APP_STORE);
    change(data);
    saveJson(APP_STORE, data);
  }

  const intIn = (v, def, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : def);
  const boolOr = (v, def) => (typeof v === 'boolean' ? v : def);

  function sanitizeVfo(v, def) {
    const plan = PLANS[v?.plan] ? v.plan : def.plan;
    return {
      mode: v?.mode === 'vfo' || v?.mode === 'mr' ? v.mode : def.mode,
      plan,
      ch: intIn(v?.ch, def.ch, 0, PLANS[plan].length - 1),
      freq: Number.isFinite(v?.freq) && v.freq >= UHF.min && v.freq <= UHF.max ? v.freq : def.freq,
    };
  }

  const saved = loadJson(STORE);
  const appSaved = loadJson(APP_STORE);

  // Настройки меню
  const cfg = {
    sql: intIn(saved.cfg?.sql, 3, 0, 9),
    step: intIn(saved.cfg?.step, 4, 0, STEPS.length - 1),
    scr: typeof saved.cfg?.scr === 'string' ? saved.cfg.scr : '',
    vox: intIn(saved.cfg?.vox, 0, 0, 10),
    voxLast: intIn(saved.cfg?.voxLast, 5, 1, 10),
    mic: intIn(saved.cfg?.mic, 2, 0, 4),
    tot: intIn(saved.cfg?.tot, 3, 1, 10),
    roger: boolOr(saved.cfg?.roger, true),
    dw: boolOr(saved.cfg?.dw, false),
    beep: boolOr(saved.cfg?.beep, true),
    abr: intIn(saved.cfg?.abr, 2, 0, ABR_TIMES.length - 1),
    name: typeof saved.cfg?.name === 'string' && saved.cfg.name ? saved.cfg.name : appSaved.onair?.name || 'РАЦИЯ',
  };

  const vfo = {
    A: sanitizeVfo(saved.vfo?.A, { mode: 'mr', plan: 'PMR', ch: 0, freq: 446.00625 }),
    B: sanitizeVfo(saved.vfo?.B, { mode: 'vfo', plan: 'PMR', ch: 0, freq: 433.075 }),
  };

  const radio = {
    power: saved.power !== false,
    volume: Number.isFinite(saved.volume) ? Math.min(1, Math.max(0, saved.volume)) : 0.7,
    active: saved.active === 'B' ? 'B' : 'A',
    fm: false,
    fmFreq: Number.isFinite(saved.fmFreq) && saved.fmFreq >= BAND.min && saved.fmFreq <= BAND.max ? saved.fmFreq : 101.7,
    lock: false,
    fn: false,
    monitor: false,
    torch: false,
  };

  function save() {
    saveJson(STORE, {
      power: radio.power,
      volume: radio.volume,
      active: radio.active,
      fmFreq: radio.fmFreq,
      vfo,
      cfg,
    });
  }

  let saveTimer;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }

  /* ───────── Частоты и каналы ───────── */

  const other = (line) => (line === 'A' ? 'B' : 'A');

  function freqOf(line) {
    const v = vfo[line];
    return v.mode === 'mr' ? PLANS[v.plan][v.ch] : v.freq;
  }

  // Что слушает приёмник: FM-станцию, рабочий канал или оба канала при двойном прослушивании
  function listenFreqs() {
    if (radio.fm) return [radio.fmFreq];
    return cfg.dw ? [freqOf(radio.active), freqOf(other(radio.active))] : [freqOf(radio.active)];
  }

  function nearestChannel(plan, freq) {
    let best = 0;
    PLANS[plan].forEach((f, i) => {
      if (Math.abs(f - freq) < Math.abs(PLANS[plan][best] - freq)) best = i;
    });
    return best;
  }

  function wrapFm(f) {
    const r = Math.round(f * 10) / 10;
    if (r > BAND.max) return BAND.min;
    if (r < BAND.min) return BAND.max;
    return r;
  }

  /* ───────── Приёмник ───────── */

  const stations = createStations(); // встроенные FM-станции — для режима FM-радио (F+0)
  const engine = new RadioEngine(stations);
  engine.setBand(UHF, freqOf(radio.active));
  engine.setVolume(radio.volume);

  // Как у настоящей рации: скремблер (SCR) один и на передачу, и на приём.
  // Слышно только то, что зашифровано тем же ключом; с другим ключом или при OFF — цифровой шум.
  const scrKeyring = {
    find: (id) => (txKey && toHex(id) === txKey.idHex ? txKey : undefined),
  };

  function appKeys() {
    const keys = loadJson(APP_STORE).keys;
    return Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : [];
  }

  // Встроенный шифрованный канал в FM-радио тоже открывается только ключом SCR
  function applyKeys() {
    engine.setKeys(cfg.scr ? [cfg.scr.trim().toUpperCase()] : []);
  }

  function addKey(phrase) {
    const key = phrase.trim().toUpperCase();
    if (!key) return;
    updateApp((d) => {
      d.keys = [...new Set([...(Array.isArray(d.keys) ? d.keys : []), key])];
    });
    applyKeys();
  }

  applyKeys();

  // Настроить приёмник на текущие частоты и сообщить серверу, что слушаем
  function retune() {
    if (radio.fm) {
      engine.setWatch(null);
      engine.setBand(BAND, radio.fmFreq);
      engine.setSquelchLevel(0); // у FM-радио шумоподавителя нет
    } else {
      const [a, b] = listenFreqs();
      engine.setBand(UHF, a);
      engine.setWatch(b ?? null);
      engine.setSquelchLevel(SQL_LEVELS[cfg.sql]);
    }
    link.tune(radio.power ? listenFreqs() : null);
    registerSoon();
    render();
  }

  // Кто сейчас принимается и на каком канале (A или B)
  function receiving() {
    const st = engine.best;
    if (!radio.power || !st || tx.active) return null;
    const threshold = radio.fm ? 0.3 : Math.max(0.05, radio.monitor ? 0.05 : SQL_LEVELS[cfg.sql]);
    if (engine.bestSignal < threshold) return null;
    if (radio.fm) return { line: 'A', st };
    const lines = cfg.dw ? ['A', 'B'] : [radio.active];
    const line = lines.reduce((a, b) => (engine.closeness(st, freqOf(a)) >= engine.closeness(st, freqOf(b)) ? a : b));
    return { line, st };
  }

  /* ───────── Связь с сервером ───────── */

  const liveById = new Map();
  let registered = null; // что сервер знает о нашей станции: «частота|позывной»
  let regTimer = null;

  const link = new AirLink({
    status(online) {
      if (!online) {
        clearLive();
        registered = null;
      }
      render();
    },
    message: onServerMessage,
    audio(id, packet) {
      if (radio.power) liveById.get(id)?.receive(packet, scrKeyring);
    },
  });

  function upsertLive(info) {
    if (!info || !Number.isInteger(info.id) || !Number.isFinite(info.freq)) return;
    const st = liveById.get(info.id);
    if (st) {
      st.update(info);
      engine.applyTuning();
      return;
    }
    const fresh = new LiveStation(info);
    liveById.set(info.id, fresh);
    engine.addStation(fresh);
  }

  function removeLive(id) {
    const st = liveById.get(id);
    if (!st) return;
    liveById.delete(id);
    engine.removeStation(st);
  }

  function clearLive() {
    for (const id of [...liveById.keys()]) removeLive(id);
  }

  function onServerMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        clearLive();
        if (Array.isArray(msg.stations)) msg.stations.forEach(upsertLive);
        registered = null;
        registerStation();
        break;
      case 'station-on':
        upsertLive(msg.station);
        break;
      case 'station-off':
        removeLive(msg.id);
        break;
      case 'error':
        flash(String(msg.message).toUpperCase(), 2500);
        break;
    }
  }

  // Рация «стоит на канале», пока включена: сервер знает её частоту и позывной,
  // а несущая появляется только во время передачи
  function stationFreq() {
    return tx.active && tx.line ? freqOf(tx.line) : freqOf(radio.active);
  }

  function registerStation(freq = stationFreq()) {
    clearTimeout(regTimer);
    if (!link.online) return;
    if (!radio.power) {
      if (registered) link.send({ type: 'offair' });
      registered = null;
      return;
    }
    const key = `${freq}|${cfg.name}`;
    if (key === registered) return;
    registered = key;
    link.send({ type: 'onair', freq, name: cfg.name });
  }

  function registerSoon() {
    clearTimeout(regTimer);
    regTimer = setTimeout(() => registerStation(), 300);
  }

  /* ───────── Сервер: подключение и свой сервер (в приложении) ───────── */

  let hostInfo = null;
  let onTop = false;

  const serverInfo = () => loadJson(APP_STORE).server ?? {};

  function connectTo(address) {
    const url = AirLink.serverUrl(address);
    if (!url) {
      flash('ОШИБКА АДРЕСА');
      errorBeep();
      return;
    }
    hostInfo = null;
    link.setServer(url);
    updateApp((d) => {
      const s = d.server ?? {};
      d.server = { ...s, address, host: false, recent: [address, ...(s.recent ?? []).filter((a) => a !== address)].slice(0, 6) };
    });
    flash('ПОДКЛЮЧАЮСЬ');
  }

  function hostAddress(res) {
    if (res.publicIps?.[0]) return `${res.publicIps[0]}:${res.port}`;
    if (res.upnp?.ok && res.upnp.public) return `${res.upnp.externalIp}:${res.port}`;
    return res.lan?.[0] ? `${res.lan[0]}:${res.port}` : `ПОРТ ${res.port}`;
  }

  async function startHosting(quiet = false) {
    if (!quiet) flash('ОТКРЫВАЮ…', 8000);
    const res = await desktop.hostStart({ port: 8765 });
    if (!res.ok) {
      flash(`ОШИБКА: ${res.error}`.toUpperCase(), 3000);
      return;
    }
    hostInfo = res;
    link.setServer(`ws://localhost:${res.port}/ws`);
    updateApp((d) => {
      d.server = { ...(d.server ?? {}), host: true };
    });
    if (!quiet) flash(hostAddress(res), 6000);
  }

  async function stopHosting() {
    await desktop.hostStop();
    hostInfo = null;
    link.setServer(null);
    updateApp((d) => {
      d.server = { ...(d.server ?? {}), host: false };
    });
    flash('СЕРВЕР ЗАКРЫТ');
  }

  async function connectAtStart() {
    if (!desktop) {
      link.connect(); // в браузере сервер — тот, что отдал страницу
      return;
    }
    const s = serverInfo();
    if (s.host || await desktop.hostStatus()) {
      await startHosting(true);
    } else if (s.address && s.auto !== false) {
      connectTo(s.address);
    }
  }

  /* ───────── Передача ───────── */

  const broadcaster = new Broadcaster(transmit);
  const tx = { active: false, starting: false, stopping: false, source: null, since: 0, line: null };
  const lastRx = { line: null, at: 0 };
  const vox = { last: 0 };
  let pttHeld = false;
  let txKey = null;
  let sealing = Promise.resolve();

  // Ключ канала (SCR) выводится заранее, чтобы передача не ждала
  async function updateTxKey() {
    txKey = null;
    applyKeys();
    const phrase = cfg.scr.trim().toUpperCase();
    if (!phrase || !cryptoAvailable()) return;
    const entry = await deriveAirKey(phrase);
    if (cfg.scr.trim().toUpperCase() === phrase) txKey = entry; // пока считали, ключ могли сменить
  }

  // Звук сжимается (ADPCM, ~4x меньше) — держит связь на слабой сети; seq для восстановления потерь
  let txSeq = 0;
  function transmit(pcm) {
    const seq = (txSeq = (txSeq + 1) & 0xff);
    const adpcm = adpcmEncode(new Int16Array(pcm));
    if (!cfg.scr) {
      link.sendAudio(openPacketC(adpcm, seq));
      return;
    }
    const entry = txKey;
    if (!entry) return;
    sealing = sealing
      .then(() => sealPacketC(entry, adpcm, seq))
      .then((packet) => link.sendAudio(packet))
      .catch(() => {});
  }

  async function ensureMic() {
    if (!broadcaster.ctx) await broadcaster.open();
    broadcaster.setMicGain(MIC_GAINS[cfg.mic]);
    if (!broadcaster.mic) await broadcaster.setMic(true);
  }

  // Микрофон нужен заранее, если включён VOX
  function armMic() {
    ensureMic().catch((err) => flash(err?.name === 'NotAllowedError' ? 'МИКРОФОН ЗАПРЕЩЁН' : 'НЕТ МИКРОФОНА', 2500));
  }

  // Канал передачи: рабочий, а при двойном прослушивании — тот, где только что ответили (символ >)
  function txLine() {
    if (cfg.dw && lastRx.line && lastRx.line !== radio.active && performance.now() - lastRx.at < DW_HOLD) return lastRx.line;
    return radio.active;
  }

  async function txStart(source) {
    if (!radio.power || tx.active || tx.starting || tx.stopping) return;
    // Занятый канал (BCL): пока кто-то говорит на канале, ручную передачу не начать (VOX не трогаем)
    if (source !== 'vox' && window.WalkieChannel?.guardPtt?.()) return;
    stopScan();
    if (radio.fm) {
      radio.fm = false; // передача всегда на рабочем канале рации
      retune();
    }
    if (!link.online) {
      flash('НЕТ СВЯЗИ');
      errorBeep();
      return;
    }
    tx.starting = true;
    try {
      await ensureMic();
    } catch (err) {
      tx.starting = false;
      flash(err?.name === 'NotAllowedError' ? 'МИКРОФОН ЗАПРЕЩЁН' : 'НЕТ МИКРОФОНА', 2500);
      errorBeep();
      return;
    }
    tx.starting = false;
    // Отпустили, пока включался микрофон
    if ((source === 'hold' && !pttHeld) || (source === 'hotkey' && !hotkeyHeld) || !radio.power) return;
    tx.line = txLine();
    registerStation(freqOf(tx.line));
    Object.assign(tx, { active: true, source, since: performance.now() });
    broadcaster.transmitting = true;
    document.title = '● Передача — Рация';
    wake();
    render();
  }

  async function txStop() {
    if (!tx.active || tx.stopping) return;
    tx.stopping = true;
    if (cfg.roger && link.online) await broadcaster.roger();
    broadcaster.transmitting = false;
    Object.assign(tx, { active: false, stopping: false, source: null, line: null });
    document.title = 'Рация';
    registerSoon(); // если отвечали на втором канале — вернуться на рабочий
    render();
  }

  function pttDown() {
    pttHeld = true;
    if (!radio.power) return;
    if (tx.active && tx.source !== 'hold') {
      txStop();
      return;
    }
    txStart('hold');
  }

  function pttUp() {
    pttHeld = false;
    if (tx.active && tx.source === 'hold') txStop();
  }

  function voxTick(now) {
    if (!radio.power || !cfg.vox || radio.fm || !broadcaster.mic || tx.starting || tx.stopping) return;
    if (tx.active && tx.source !== 'vox') return;
    if (broadcaster.inputLevel() > VOX_LEVELS[cfg.vox]) {
      vox.last = now;
      if (!tx.active) txStart('vox');
    } else if (tx.active && now - vox.last > VOX_HANG) {
      txStop();
    }
  }

  // TOT: передача не может длиться дольше заданного времени
  function totTick(now) {
    if (tx.active && !tx.stopping && now - tx.since > cfg.tot * 60000) {
      txStop();
      flash('TOT', 2000);
      errorBeep();
    }
  }

  /* ───────── Сканирование (держите *) ───────── */

  let scan = null; // { dir, next, hold }

  // В режиме VFO сканируются частоты, на которых сервер знает станции
  function scanTargets() {
    return [...liveById.values()]
      .map((st) => st.freq)
      .filter((f) => f >= UHF.min && f <= UHF.max)
      .sort((a, b) => a - b);
  }

  function startScan() {
    if (!radio.fm && vfo[radio.active].mode === 'vfo' && !scanTargets().length) {
      flash('НЕТ СТАНЦИЙ');
      return;
    }
    scan = { dir: 1, next: 0, hold: 0 };
    flash('SCAN');
  }

  function stopScan() {
    if (!scan) return;
    scan = null;
    save();
    render();
  }

  function scanStep() {
    const v = vfo[radio.active];
    if (radio.fm) {
      radio.fmFreq = wrapFm(radio.fmFreq + 0.1 * scan.dir);
    } else if (v.mode === 'mr') {
      const n = PLANS[v.plan].length;
      v.ch = (v.ch + scan.dir + n) % n;
    } else {
      const list = scanTargets();
      if (!list.length) {
        stopScan();
        return;
      }
      const cur = v.freq;
      v.freq = scan.dir > 0
        ? list.find((f) => f > cur + 1e-6) ?? list[0]
        : [...list].reverse().find((f) => f < cur - 1e-6) ?? list[list.length - 1];
    }
    retune();
  }

  // Нашли передачу — стоим, пока она идёт, и ещё 3 секунды после (как SC-REV «CO»)
  function scanTick(now) {
    if (!scan) return;
    if (receiving()) {
      scan.hold = now + 3000;
      return;
    }
    if (now < scan.hold || now < scan.next) return;
    scanStep();
    scan.next = now + (radio.fm ? 140 : 450);
  }

  /* ───────── Меню ───────── */

  const onOff = (v) => (v ? 'ON' : 'OFF');
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  const MENU = [
    { code: 'SQL', hint: 'ШУМОПОДАВИТЕЛЬ 0–9', options: () => range(0, 9), get: () => cfg.sql, show: String,
      apply: (v) => { cfg.sql = v; retune(); } },
    { code: 'STEP', hint: 'ШАГ ЧАСТОТЫ В VFO', options: () => STEPS.map((_, i) => i), get: () => cfg.step,
      show: (i) => `${STEPS[i]}K`, apply: (i) => { cfg.step = i; } },
    { code: 'SCR', hint: 'КЛЮЧ: ПЕРЕДАЧА И ПРИЁМ', options: () => ['', ...appKeys(), NEW], get: () => cfg.scr,
      show: (v) => (v === '' ? 'OFF' : v === NEW ? 'НОВЫЙ…' : v),
      apply: (v) => {
        if (v === NEW) {
          startEntry('SCR', '', (text) => {
            addKey(text);
            cfg.scr = text.trim().toUpperCase();
            updateTxKey();
          });
          return;
        }
        cfg.scr = v;
        updateTxKey();
      } },
    { code: 'VOX', hint: 'ПЕРЕДАЧА ГОЛОСОМ 1–10', options: () => range(0, 10), get: () => cfg.vox,
      show: (v) => (v ? String(v) : 'OFF'),
      apply: (v) => {
        cfg.vox = v;
        if (v) {
          cfg.voxLast = v;
          armMic();
        }
      } },
    { code: 'MIC', hint: 'ЧУВСТВИТЕЛЬНОСТЬ МИКРОФОНА', options: () => range(0, 4), get: () => cfg.mic, show: String,
      apply: (v) => { cfg.mic = v; broadcaster.setMicGain(MIC_GAINS[v]); } },
    { code: 'TOT', hint: 'ПРЕДЕЛ ДЛИНЫ ПЕРЕДАЧИ', options: () => range(1, 10), get: () => cfg.tot,
      show: (v) => `${v} МИН`, apply: (v) => { cfg.tot = v; } },
    { code: 'ROGER', hint: 'СИГНАЛ В КОНЦЕ ПЕРЕДАЧИ', options: () => [false, true], get: () => cfg.roger, show: onOff,
      apply: (v) => { cfg.roger = v; } },
    { code: 'DW', hint: 'ДВОЙНОЕ ПРОСЛУШИВАНИЕ A+B', options: () => [false, true], get: () => cfg.dw, show: onOff,
      apply: (v) => { cfg.dw = v; retune(); } },
    { code: 'BEEP', hint: 'ЗВУК КНОПОК', options: () => [false, true], get: () => cfg.beep, show: onOff,
      apply: (v) => { cfg.beep = v; } },
    { code: 'ABR', hint: 'ПОДСВЕТКА ЭКРАНА', options: () => range(0, ABR_TIMES.length - 1), get: () => cfg.abr,
      show: (i) => (ABR_TIMES[i] ? `${ABR_TIMES[i]} С` : 'ВСЕГДА'), apply: (i) => { cfg.abr = i; } },
    { code: 'NAME', hint: 'ПОЗЫВНОЙ В ЭФИРЕ', text: true, get: () => cfg.name, show: (v) => v,
      apply: (text) => { cfg.name = text.slice(0, 24); registerStation(); } },
    { code: 'SERVER', hint: 'АДРЕС СЕРВЕРА', desktop: true,
      options: () => [...(serverInfo().recent ?? []), NEW],
      get: () => (hostInfo ? 'СВОЙ' : serverInfo().address ?? ''),
      show: (v) => (v === NEW ? 'НОВЫЙ…' : v || 'НЕТ'),
      apply: (v) => {
        const go = (address) => (hostInfo ? stopHosting().then(() => connectTo(address)) : connectTo(address));
        if (v === NEW) startEntry('SERVER', '', go);
        else go(v);
      } },
    { code: 'AUTO', hint: 'ПОДКЛЮЧАТЬСЯ ПРИ ЗАПУСКЕ', desktop: true, options: () => [false, true],
      get: () => serverInfo().auto !== false, show: onOff,
      apply: (v) => updateApp((d) => { d.server = { ...(d.server ?? {}), auto: v }; }) },
    { code: 'HOST', hint: 'СВОЙ СЕРВЕР', desktop: true, options: () => [false, true], get: () => Boolean(hostInfo),
      show: onOff, apply: (v) => (v ? startHosting() : hostInfo && stopHosting()) },
    { code: 'TOP', hint: 'ПОВЕРХ ВСЕХ ОКОН', desktop: true, options: () => [false, true], get: () => onTop, show: onOff,
      apply: (v) => setOnTop(v) },
  ].filter((item) => !item.desktop || desktop);

  let menu = null; // { index, editing, options, pick, num }

  function menuHint(item) {
    if (item.code === 'HOST' && hostInfo) return `ДРУЗЬЯМ: ${hostAddress(hostInfo)}`;
    if (item.code === 'SERVER') return link.online ? 'НА СВЯЗИ' : link.available ? 'ПОДКЛЮЧАЮСЬ…' : 'НЕ ПОДКЛЮЧЕНО';
    return item.hint;
  }

  function openMenu() {
    menu = { index: menu?.index ?? 0, editing: false, options: [], pick: 0, num: '' };
  }

  function menuKey(key) {
    const item = MENU[menu.index];
    if (!menu.editing) {
      if (key === 'up' || key === 'down') {
        const n = MENU.length;
        menu.index = (menu.index + (key === 'up' ? -1 : 1) + n) % n;
      } else if (/^\d$/.test(key)) {
        // Номер пункта набирается цифрами, как на рации
        menu.num = (menu.num + key).slice(-2);
        clearTimeout(menu.numTimer);
        const n = Number(menu.num);
        if (n >= 1 && n <= MENU.length) menu.index = n - 1;
        menu.numTimer = setTimeout(() => { if (menu) menu.num = ''; }, 900);
      } else if (key === 'menu') {
        if (item.text) {
          startEntry(item.code, item.get(), item.apply);
        } else {
          menu.options = item.options();
          menu.pick = Math.max(0, menu.options.indexOf(item.get()));
          menu.editing = true;
        }
      } else if (key === 'exit') {
        menu = null;
      }
      return;
    }
    if (key === 'up' || key === 'down') {
      const n = menu.options.length;
      menu.pick = (menu.pick + (key === 'up' ? 1 : -1) + n) % n;
    } else if (key === 'menu') {
      menu.editing = false;
      item.apply(menu.options[menu.pick]);
      confirmBeep();
      save();
    } else if (key === 'exit') {
      menu.editing = false;
    }
  }

  /* ───────── Ввод текста (позывной, адрес, ключ) ───────── */

  let entry = null; // { code, done }

  function startEntry(code, initial, done) {
    entry = { code, done };
    input.value = initial ?? '';
    input.focus();
    render();
  }

  function finishEntry(ok) {
    if (!entry) return;
    const { done } = entry;
    const text = input.value.trim();
    entry = null;
    input.blur();
    if (ok && text) {
      done(text);
      confirmBeep();
      save();
    }
    render();
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishEntry(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishEntry(false);
    }
  });
  input.addEventListener('blur', () => {
    if (entry) setTimeout(() => entry && input.focus(), 0); // пока идёт ввод, фокус держим в поле
  });

  /* ───────── Кнопки ───────── */

  let digits = null; // набор канала или частоты цифрами
  let fnTimer = null;

  function digit(d) {
    const v = vfo[radio.active];
    digits = digits ?? { text: '' };
    digits.text += d;
    clearTimeout(digits.timer);
    const maxLen = radio.fm ? 4 : v.mode === 'mr' ? 2 : 6;
    if (digits.text.length >= maxLen) commitDigits();
    else digits.timer = setTimeout(commitDigits, radio.fm || v.mode === 'mr' ? 1300 : 2500);
  }

  function commitDigits() {
    if (!digits) return;
    const text = digits.text;
    clearTimeout(digits.timer);
    digits = null;
    const v = vfo[radio.active];
    if (radio.fm) {
      const f = Number(text) / 10; // 1017 → 101.7
      if (f >= BAND.min && f <= BAND.max) radio.fmFreq = f;
      else flash('ERR');
    } else if (v.mode === 'mr') {
      const n = Number(text);
      if (n >= 1 && n <= PLANS[v.plan].length) v.ch = n - 1;
      else flash('НЕТ КАНАЛА');
    } else {
      // 446006 → 446.006 МГц, дальше — к ближайшему шагу
      const step = STEPS[cfg.step] / 1000;
      const f = round5(Math.round((Number(text.padEnd(6, '0')) / 1000) / step) * step);
      if (f >= UHF.min && f <= UHF.max) v.freq = f;
      else flash('ERR');
    }
    retune();
    save();
  }

  // line — какой канал крутить (колесо над каналом в полоске); по умолчанию рабочий
  function stepTuning(dir, line = radio.active) {
    if (radio.fm) {
      radio.fmFreq = wrapFm(radio.fmFreq + 0.1 * dir);
    } else {
      const v = vfo[line];
      if (v.mode === 'mr') {
        const n = PLANS[v.plan].length;
        v.ch = (v.ch + dir + n) % n;
      } else {
        const step = STEPS[cfg.step] / 1000;
        let f = round5(Math.round(v.freq / step) * step + dir * step);
        if (f > UHF.max) f = UHF.min;
        if (f < UHF.min) f = UHF.max;
        v.freq = f;
      }
    }
    retune();
    saveSoon();
  }

  function toggleFm(on) {
    radio.fm = on;
    flash(on ? 'FM РАДИО' : 'РАЦИЯ');
    retune();
  }

  // F + цифра — функции, как на рации
  function fnKey(key) {
    const v = vfo[radio.active];
    switch (key) {
      case '1':
        if (radio.fm) break;
        if (v.mode !== 'mr') {
          flash('ТОЛЬКО В MR');
          break;
        }
        v.plan = v.plan === 'PMR' ? 'LPD' : 'PMR';
        v.ch = Math.min(v.ch, PLANS[v.plan].length - 1);
        flash(v.plan);
        retune();
        break;
      case '2':
        radio.active = other(radio.active);
        flash(`КАНАЛ ${radio.active}`);
        retune();
        break;
      case '3':
        if (radio.fm) break;
        if (v.mode === 'mr') {
          v.freq = PLANS[v.plan][v.ch];
          v.mode = 'vfo';
        } else {
          v.ch = nearestChannel(v.plan, v.freq);
          v.mode = 'mr';
        }
        flash(v.mode === 'mr' ? 'MR' : 'VFO');
        retune();
        break;
      case '7':
        cfg.vox = cfg.vox ? 0 : cfg.voxLast;
        flash(cfg.vox ? `VOX ${cfg.vox}` : 'VOX OFF');
        if (cfg.vox) armMic();
        break;
      case '0':
        toggleFm(!radio.fm);
        break;
      default:
        flash('НЕТ ФУНКЦИИ');
        errorBeep();
    }
    save();
  }

  function press(key, long = false) {
    if (!radio.power) return;
    wake();
    if (entry) {
      if (key === 'menu') finishEntry(true);
      else if (key === 'exit') finishEntry(false);
      return;
    }
    if (key === 'f' && long) {
      radio.lock = !radio.lock;
      radio.fn = false;
      flash(radio.lock ? 'LOCK' : 'UNLOCK');
      confirmBeep();
      render();
      return;
    }
    if (radio.lock) {
      flash('LOCK');
      errorBeep();
      return;
    }
    keyBeep();
    if (scan) {
      if (key === 'up' || key === 'down') scan.dir = key === 'up' ? 1 : -1;
      else stopScan();
      render();
      return;
    }
    if (menu) {
      menuKey(key);
      render();
      return;
    }
    if (radio.fn && key !== 'f') {
      radio.fn = false;
      clearTimeout(fnTimer);
      fnKey(key);
      render();
      return;
    }
    switch (key) {
      case 'f':
        radio.fn = !radio.fn;
        clearTimeout(fnTimer);
        if (radio.fn) fnTimer = setTimeout(() => { radio.fn = false; render(); }, 3000);
        break;
      case 'menu':
        commitDigits();
        openMenu();
        break;
      case 'exit':
        if (digits) {
          clearTimeout(digits.timer);
          digits = null;
        } else if (radio.fm) {
          toggleFm(false);
        }
        break;
      case 'up':
      case 'down':
        commitDigits();
        stepTuning(key === 'up' ? 1 : -1);
        break;
      case 'star':
        if (long) startScan();
        else flash('ДЕРЖИТЕ ✱');
        break;
      default:
        if (/^\d$/.test(key)) digit(key);
    }
    render();
  }

  // Долгое нажатие (F — блокировка, ✱ — сканирование)
  const holds = {};
  const LONG_KEYS = new Set(['f', 'star']);

  function keyDown(key) {
    showPressed(key, true);
    if (!LONG_KEYS.has(key)) {
      press(key);
      return;
    }
    clearTimeout(holds[key]);
    holds[key] = setTimeout(() => {
      holds[key] = null;
      press(key, true);
    }, LONG_PRESS);
  }

  function keyUp(key) {
    showPressed(key, false);
    if (LONG_KEYS.has(key) && holds[key]) {
      clearTimeout(holds[key]);
      holds[key] = null;
      press(key, false);
    }
  }

  function showPressed(key, on) {
    document.querySelector(`.key[data-key="${key}"]`)?.classList.toggle('is-pressed', on);
  }

  for (const el of document.querySelectorAll('.key')) {
    const key = el.dataset.key;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      keyDown(key);
    });
    el.addEventListener('pointerup', () => keyUp(key));
    el.addEventListener('pointercancel', () => keyUp(key));
  }

  const KEYMAP = {
    Enter: 'menu', Escape: 'exit', Backspace: 'exit', ArrowUp: 'up', ArrowDown: 'down',
    '*': 'star', f: 'f', F: 'f', 'а': 'f', 'А': 'f',
  };

  document.addEventListener('keydown', (e) => {
    if (entry) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) pttDown();
      return;
    }
    const key = /^\d$/.test(e.key) ? e.key : KEYMAP[e.key];
    if (!key) return;
    e.preventDefault();
    if (!e.repeat) keyDown(key);
  });

  document.addEventListener('keyup', (e) => {
    if (entry) return;
    if (e.code === 'Space') {
      pttUp();
      return;
    }
    const key = /^\d$/.test(e.key) ? e.key : KEYMAP[e.key];
    if (key) keyUp(key);
  });

  // Тангента: боковая кнопка, пробел (пока держите) или F8 из любого окна (вкл/выкл)
  const pttEl = $('ptt');
  pttEl.addEventListener('pointerdown', (e) => {
    pttEl.setPointerCapture(e.pointerId);
    pttDown();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) pttEl.addEventListener(type, () => {
    if (pttHeld) pttUp();
  });
  window.addEventListener('blur', () => {
    if (pttHeld) pttUp();
  });
  // Горячие клавиши из любого окна (назначаются в настройках полоски)
  let hotkeyHeld = false;
  let mutedVolume = null; // громкость до «без звука»

  desktop?.onHotkey((action) => {
    switch (action) {
      case 'ptt-down':
        hotkeyHeld = true;
        if (tx.active && tx.source !== 'hotkey') txStop();
        else txStart('hotkey');
        break;
      case 'ptt-up':
        hotkeyHeld = false;
        if (tx.active && tx.source === 'hotkey') txStop();
        break;
      case 'ptt-toggle':
        if (tx.active) txStop();
        else txStart('latch');
        break;
      case 'ab':
        if (radio.power) switchAB();
        break;
      case 'chUp':
      case 'chDown':
        if (radio.power) stepTuning(action === 'chUp' ? 1 : -1);
        break;
      case 'mute':
        toggleMute();
        break;
      case 'view':
        setView(view === 'bar' ? 'widget' : 'bar');
        break;
    }
  });

  function switchAB() {
    radio.active = other(radio.active);
    flash(`КАНАЛ ${radio.active}`);
    retune();
    save();
  }

  function toggleMute() {
    if (mutedVolume === null) {
      mutedVolume = radio.volume || 0.7;
      setVolume(0);
      flash('БЕЗ ЗВУКА');
    } else {
      const restore = mutedVolume;
      mutedVolume = null;
      setVolume(restore);
    }
  }

  // Боковая 1 — Monitor, боковая 2 — фонарик
  $('side1').addEventListener('click', () => {
    if (!radio.power) return;
    radio.monitor = !radio.monitor;
    engine.setMonitor(radio.monitor);
    flash(radio.monitor ? 'MONITOR ON' : 'MONITOR OFF');
    keyBeep();
    render();
  });
  $('side2').addEventListener('click', () => {
    radio.torch = !radio.torch;
    render();
  });

  /* ───────── Ручка: щелчок — питание, поворот — громкость ───────── */

  const knobEl = $('knob');
  let knobDrag = null;

  function setVolume(v) {
    radio.volume = Math.min(1, Math.max(0, Math.round(v * 20) / 20));
    engine.setVolume(radio.volume);
    if (radio.power) flash(`VOL ${Math.round(radio.volume * 10)}`, 700);
    knobEl.setAttribute('aria-valuenow', String(Math.round(radio.volume * 10)));
    saveSoon();
    render();
  }

  knobEl.addEventListener('pointerdown', (e) => {
    knobEl.setPointerCapture(e.pointerId);
    knobDrag = { y: e.clientY, start: radio.volume, moved: false };
  });
  knobEl.addEventListener('pointermove', (e) => {
    if (!knobDrag) return;
    const dy = knobDrag.y - e.clientY;
    if (Math.abs(dy) > 3) knobDrag.moved = true;
    if (knobDrag.moved && radio.power) setVolume(knobDrag.start + dy / 120);
  });
  knobEl.addEventListener('pointerup', () => {
    const drag = knobDrag;
    knobDrag = null;
    if (drag && !drag.moved) setPower(!radio.power);
  });
  knobEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (radio.power) setVolume(radio.volume - Math.sign(e.deltaY) * 0.05);
  }, { passive: false });
  knobEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      setPower(!radio.power);
    }
  });

  async function setPower(on) {
    radio.power = on;
    if (on) {
      await engine.powerOn();
      engine.beep(880, 0.07);
      retune();
      registerStation();
      // Микрофон греем сразу при включении, а не при первом PTT — тангента срабатывает мгновенно.
      armMic();
    } else {
      pttHeld = false;
      await txStop();
      stopScan();
      menu = null;
      finishEntry(false);
      radio.monitor = false;
      engine.setMonitor(false);
      registerStation(); // сервер узнает, что рация выключена
      link.tune(null);
      await engine.powerOff();
      await broadcaster.close();
    }
    save();
    render();
  }

  /* ───────── Звуки кнопок ───────── */

  const keyBeep = () => cfg.beep && engine.beep(1300, 0.03, 0.08);
  const confirmBeep = () => cfg.beep && engine.beep(1700, 0.06, 0.08);
  const errorBeep = () => cfg.beep && engine.beep(420, 0.14, 0.1);

  /* ───────── Экран ───────── */

  let message = null; // { text, until }
  let lastWake = performance.now();

  function flash(text, ms = 1200) {
    message = { text, until: performance.now() + ms };
    wake();
    render();
  }

  function wake() {
    lastWake = performance.now();
  }

  const setText = (el, text) => {
    if (el.textContent !== text) el.textContent = text;
  };

  function lineView(line, rx) {
    const el = $(`line-${line}`);
    const v = vfo[line];
    const parts = {
      mark: el.querySelector('.line__mark'),
      tag: el.querySelector('.line__tag'),
      rt: el.querySelector('.line__rt'),
      freq: el.querySelector('.line__freq'),
      sub: el.querySelector('.line__sub'),
    };
    let mark = '';
    let tag;
    let freq;
    let sub = '';
    let rt = '';

    if (radio.fm && line === 'A') {
      tag = 'FM РАДИО';
      freq = digits ? digitsView() : radio.fmFreq.toFixed(1);
      sub = rx ? rx.st.lcdText() : '';
      if (rx) rt = 'RX';
    } else {
      const active = line === radio.active;
      if (active) mark = '▶';
      else if (!tx.active && txLine() === line) mark = '>';
      if (tx.active && tx.line === line) mark = '▶';
      tag = v.mode === 'mr' ? `${line} CH-${String(v.ch + 1).padStart(3, '0')}` : `${line} VFO`;
      freq = active && digits && !radio.fm ? digitsView() : freqOf(line).toFixed(5);
      if (tx.active && tx.line === line) {
        rt = 'TX';
        sub = cfg.scr ? `${cfg.name} · SCR` : cfg.name;
      } else if (rx && rx.line === line && !radio.fm) {
        rt = 'RX';
        sub = rx.st.lcdText();
      } else {
        sub = v.mode === 'mr' ? `${v.plan} ${v.ch + 1}` : `ШАГ ${STEPS[cfg.step]}K`;
      }
    }
    setText(parts.mark, mark);
    setText(parts.tag, tag);
    setText(parts.freq, freq);
    setText(parts.sub, sub);
    setText(parts.rt, rt);
    el.classList.toggle('is-rx', rt === 'RX');
    el.classList.toggle('is-dim', radio.fm && line === 'B');
  }

  // Набираемая частота: 446.0__ или канал
  function digitsView() {
    const text = digits.text;
    if (radio.fm) return `${text}_`;
    if (vfo[radio.active].mode === 'mr') return `CH-${text.padStart(2, '_')}`;
    const full = text.padEnd(6, '_');
    return `${full.slice(0, 3)}.${full.slice(3)}`;
  }

  function render() {
    const now = performance.now();
    rigEl.dataset.power = radio.power ? 'on' : 'off';
    rigEl.classList.toggle('torch-on', radio.torch);
    $('side1').classList.toggle('is-on', radio.monitor);
    pttEl.classList.toggle('is-held', tx.active);
    $('knob-cap').style.transform = `rotate(${-140 + radio.volume * 280}deg)`;

    const rx = receiving();
    if (rx && !radio.fm) Object.assign(lastRx, { line: rx.line, at: now });

    // Светодиод и подсветка: красный — передача, зелёный — приём
    const led = $('led');
    led.classList.toggle('is-tx', radio.power && tx.active);
    led.classList.toggle('is-rx', radio.power && !tx.active && Boolean(rx));
    const abr = ABR_TIMES[cfg.abr];
    const lit = radio.power && (!abr || now - lastWake < abr * 1000 || Boolean(rx) || tx.active || Boolean(menu) || Boolean(entry));
    lcdEl.classList.toggle('is-lit', lit);

    // Строка значков
    const level = tx.active ? Math.min(1, broadcaster.level * 1.6) : rx || radio.monitor ? engine.bestSignal : 0;
    const bars = Math.round(level * 5);
    document.querySelectorAll('#smeter i').forEach((el, i) => el.classList.toggle('is-on', i < bars));
    $('ico-f').classList.toggle('is-on', radio.fn);
    $('ico-dw').classList.toggle('is-on', cfg.dw && !radio.fm);
    $('ico-vox').classList.toggle('is-on', cfg.vox > 0);
    $('ico-scr').classList.toggle('is-on', Boolean(cfg.scr));
    $('ico-mon').classList.toggle('is-on', radio.monitor);
    $('ico-lock').classList.toggle('is-on', radio.lock);
    $('ico-net').classList.toggle('is-on', link.online);

    // Основной экран, меню или ввод текста
    const inMenu = Boolean(menu) || Boolean(entry);
    $('screen-main').hidden = inMenu;
    $('screen-menu').hidden = !inMenu;
    if (entry) {
      const item = MENU.find((m) => m.code === entry.code);
      setText($('menu-num'), 'ВВОД');
      setText($('menu-code'), entry.code);
      const value = $('menu-value');
      setText(value, input.value);
      value.classList.add('is-entry');
      value.classList.remove('is-editing');
      setText($('menu-hint'), `${item?.hint ?? ''} · ENTER — ОК`);
    } else if (menu) {
      const item = MENU[menu.index];
      setText($('menu-num'), String(menu.index + 1).padStart(2, '0'));
      setText($('menu-code'), item.code);
      const value = $('menu-value');
      const shown = menu.editing ? item.show(menu.options[menu.pick]) : item.show(item.get());
      setText(value, shown);
      value.classList.toggle('is-editing', menu.editing);
      value.classList.remove('is-entry');
      setText($('menu-hint'), menuHint(item));
    } else {
      lineView('A', rx);
      lineView('B', rx);
    }

    // Короткие сообщения поверх экрана
    const msg = $('lcd-msg');
    const showMsg = message && now < message.until;
    msg.hidden = !showMsg;
    if (showMsg) setText(msg, message.text);
    else message = null;

    renderChrome();
    if (view === 'bar') renderBar(rx, now);
  }

  /* ───────── Окно: поверх всех, развернуть, свернуть, закрыть ───────── */

  function renderChrome() {
    if (!desktop) return;
    $('win-top').setAttribute('aria-pressed', String(onTop));
  }

  async function setOnTop(v) {
    onTop = await desktop.setOnTop(v);
    flash(onTop ? 'ПОВЕРХ ОКОН' : 'ОБЫЧНОЕ ОКНО');
    render();
  }

  /* ───────── Полоска: рация, свёрнутая в строку поверх игр и видео ───────── */

  const barEl = $('bar');
  const HOTKEY_LABELS = {
    ptt: 'Рация (PTT)',
    ab: 'Канал A / B',
    chUp: 'Канал ▲',
    chDown: 'Канал ▼',
    mute: 'Без звука',
    view: 'Рация ⇄ полоска',
    hide: 'Спрятать / показать',
  };
  let view = desktop && new URLSearchParams(location.search).get('view') === 'bar' ? 'bar' : 'widget';
  let barPanel = false;
  let barOpacity = 0.92;
  let clickThrough = false;
  let hk = null;         // горячие клавиши, как их видит приложение
  let capturing = null;  // действие, которому сейчас назначаем клавишу
  document.body.dataset.view = view;

  async function setView(next) {
    if (!desktop || next === view) return;
    if (barPanel) await setBarPanel(false);
    menu = null;
    finishEntry(false);
    view = next;
    document.body.dataset.view = view;
    await desktop.setView(view);
    render();
  }

  async function setBarPanel(open) {
    if (capturing) desktop.cancelCapture();
    barPanel = open;
    $('bar-panel').hidden = !open;
    barEl.classList.toggle('is-panel', open);
    await desktop.setBarPanel(open);
    if (open) await loadHotkeys();
    renderBarPanel();
  }

  async function loadHotkeys() {
    hk = await desktop.hotkeys();
    renderBarPanel();
    render();
  }

  function applyBarOpacity() {
    barEl.style.setProperty('--bar-opacity', String(barOpacity));
  }

  // Назначить клавишу: ждём нажатия в любом окне (Esc — отмена)
  async function captureHotkey(action) {
    if (capturing || !hk?.hooked) return;
    capturing = action;
    renderBarPanel();
    const res = await desktop.captureHotkey();
    capturing = null;
    if (res.combo) {
      // Одна клавиша — одно действие: у прежнего владельца её убираем
      for (const [other, b] of Object.entries(hk.bindings)) {
        if (other !== action && b.label === res.label) hk = await desktop.setHotkey(other, null);
      }
      hk = await desktop.setHotkey(action, res.combo);
    }
    renderBarPanel();
    render();
  }

  function renderBarPanel() {
    if (!hk || !barPanel) return;
    $('bp-keys').replaceChildren(...Object.entries(HOTKEY_LABELS).flatMap(([action, text]) => {
      const name = document.createElement('span');
      name.textContent = text;
      const bound = hk.bindings[action]?.label;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bp-key';
      btn.textContent = capturing === action ? 'Нажмите клавишу…' : bound || 'не задана';
      btn.classList.toggle('is-empty', !bound && capturing !== action);
      btn.classList.toggle('is-capturing', capturing === action);
      btn.disabled = !hk.hooked;
      btn.title = 'Щёлкните и нажмите клавишу или боковую кнопку мыши. Esc — отмена';
      btn.addEventListener('click', () => captureHotkey(action));
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'bp-x';
      clear.textContent = '×';
      clear.title = 'Убрать клавишу';
      clear.disabled = !bound;
      clear.addEventListener('click', async () => {
        hk = await desktop.setHotkey(action, null);
        renderBarPanel();
        render();
      });
      return [name, btn, clear];
    }));

    const note = $('bp-hook');
    note.textContent = hk.hooked
      ? 'Работают в любом окне, в том числе в играх. Боковые кнопки мыши тоже подходят.'
      : `Слежение за клавиатурой недоступно${hk.error ? ` (${hk.error})` : ''}: клавиши работают только как «нажал / нажал».`;
    note.classList.toggle('is-warn', !hk.hooked);
    for (const b of $('bp-ptt-mode').querySelectorAll('button')) {
      b.classList.toggle('is-on', (hk.hooked ? hk.pttMode : 'toggle') === b.dataset.mode);
      b.disabled = !hk.hooked;
    }
    $('bp-opacity').value = String(Math.round(barOpacity * 100));
    $('bp-volume').value = String(Math.round(radio.volume * 100));
    const through = $('bp-through');
    through.setAttribute('aria-pressed', String(clickThrough));
    through.disabled = !hk.hooked; // без слежения за Alt полоску потом не поймать мышью
    $('bp-mic').textContent = broadcaster.mic ? 'Включён' : 'Включить';
  }

  // Частота покороче: 433.075, 446.00625; для каналов — «PMR 1»
  function shortChannel(line) {
    const v = vfo[line];
    if (v.mode === 'mr') return `${v.plan} ${v.ch + 1}`;
    return freqOf(line).toFixed(5).replace(/(\.\d{3}\d*?)0+$/, '$1');
  }

  const clock = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function renderBar(rx, now) {
    let state = 'idle';
    let text = radio.fm ? 'FM-РАДИО' : 'НА ПРИЁМЕ';
    if (!radio.power) [state, text] = ['off', 'ВЫКЛЮЧЕНА'];
    else if (tx.active) [state, text] = ['tx', `ПЕРЕДАЧА ${clock(now - tx.since)}`];
    else if (desktop && !link.online) [state, text] = ['lost', link.available ? 'НЕТ СВЯЗИ' : 'НЕТ СЕРВЕРА'];
    else if (rx) [state, text] = ['rx', rx.st.lcdText()];
    else if (scan) [state, text] = ['scan', 'СКАНИРОВАНИЕ'];
    if (message && now < message.until && state !== 'tx') text = message.text;

    $('bar-lamp').className = `bar__lamp${state === 'idle' ? '' : ` is-${state}`}`;
    const status = $('bar-status');
    status.className = `bar__status${['rx', 'tx', 'lost'].includes(state) ? ` is-${state}` : ''}`;
    setText(status, text);
    status.title = text;

    for (const line of ['A', 'B']) {
      const el = $(`bar-ch-${line}`);
      const fmHere = radio.fm && line === 'A';
      el.classList.toggle('is-hidden', radio.fm && line === 'B');
      el.classList.toggle('is-active', fmHere || (!radio.fm && line === radio.active));
      el.classList.toggle('is-rx', Boolean(rx) && rx.line === line);
      setText(el.querySelector('.bar__ch-tag'), fmHere ? 'FM' : line === radio.active ? `${line}▶` : line);
      setText(el.querySelector('.bar__ch-freq'), fmHere ? radio.fmFreq.toFixed(1) : shortChannel(line));
      el.title = fmHere ? 'FM-радио' : `Канал ${line}: ${freqOf(line).toFixed(5)} МГц. Щелчок — рабочий, колесо — другой канал`;
    }

    // Микрофон: уровень голоса, отметка — порог VOX
    const mic = $('bar-mic');
    const level = broadcaster.mic ? Math.min(1, broadcaster.inputLevel() * 6) : 0;
    const lit = Math.round(level * 8);
    const vox = cfg.vox ? Math.max(0, Math.round(Math.min(1, VOX_LEVELS[cfg.vox] * 6) * 8) - 1) : -1;
    mic.querySelectorAll('i').forEach((el, i) => {
      el.classList.toggle('is-on', i < lit);
      el.classList.toggle('is-vox', i === vox);
    });
    mic.title = broadcaster.mic ? 'Уровень микрофона' : 'Микрофон ещё не включался — включится при первой передаче';

    const key = $('bar-key');
    const binding = hk?.bindings.ptt.label ?? '';
    setText(key, binding);
    key.classList.toggle('is-tx', tx.active);
    key.title = hk?.hooked && hk.pttMode === 'hold' ? 'Держите, чтобы говорить' : 'Нажмите — говорить, ещё раз — стоп';
  }

  if (desktop) {
    $('chrome').hidden = false;
    $('win-top').addEventListener('click', () => setOnTop(!onTop));
    $('win-bar').addEventListener('click', () => setView('bar'));
    $('win-full').addEventListener('click', () => {
      save();
      desktop.switchMode('full');
    });
    $('win-min').addEventListener('click', () => desktop.minimize());
    $('win-close').addEventListener('click', () => {
      save();
      desktop.quit();
    });

    $('bar-expand').addEventListener('click', () => setView('widget'));
    $('bar-settings').addEventListener('click', () => setBarPanel(!barPanel));
    $('bp-close').addEventListener('click', () => setBarPanel(false));
    for (const line of ['A', 'B']) {
      const el = $(`bar-ch-${line}`);
      el.addEventListener('click', () => {
        if (radio.power && !radio.fm && line !== radio.active) switchAB();
      });
      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (radio.power) stepTuning(e.deltaY < 0 ? 1 : -1, line);
      }, { passive: false });
    }
    for (const b of $('bp-ptt-mode').querySelectorAll('button')) {
      b.addEventListener('click', async () => {
        hk = await desktop.setPttMode(b.dataset.mode);
        renderBarPanel();
        render();
      });
    }
    $('bp-opacity').addEventListener('input', (e) => {
      barOpacity = Number(e.target.value) / 100;
      applyBarOpacity();
      desktop.setBarSettings({ opacity: barOpacity });
    });
    $('bp-volume').addEventListener('input', (e) => setVolume(Number(e.target.value) / 100));
    $('bp-through').addEventListener('click', async () => {
      ({ clickThrough } = await desktop.setBarSettings({ clickThrough: !clickThrough }));
      renderBarPanel();
    });
    $('bp-mic').addEventListener('click', async () => {
      if (!radio.power) await setPower(true);
      armMic();
      setTimeout(renderBarPanel, 800);
    });
    desktop.onBarAlt((held) => barEl.classList.toggle('is-alt', held && clickThrough));

    desktop.setHotkeysActive(true); // клавиши рации работают, пока открыто окно рации
    loadHotkeys();
    desktop.windowState().then((state) => {
      $('win-full').hidden = state.walkieOnly; // отдельная «Рация» — большого окна нет
      onTop = state.onTop;
      barOpacity = state.bar.opacity;
      clickThrough = state.bar.clickThrough;
      applyBarOpacity();
      render();
    });
  }

  window.addEventListener('beforeunload', save);

  // В обычном браузере звук разрешают только после первого нажатия на странице
  const resumeAudio = () => {
    if (radio.power && engine.ctx?.state === 'suspended') engine.ctx.resume();
  };
  document.addEventListener('pointerdown', resumeAudio, { capture: true });
  document.addEventListener('keydown', resumeAudio, { capture: true });

  /* ───────── Главный цикл ───────── */

  let frameNo = 0;
  function frame(now) {
    voxTick(now);
    totTick(now);
    scanTick(now);
    if (++frameNo % 4 === 0 || tx.active) render();
    requestAnimationFrame(frame);
  }

  window.radioWidget = { engine, link, broadcaster, cfg, vfo, radio, tx, press, pttDown, pttUp, setPower }; // для отладки

  updateTxKey();
  connectAtStart();
  render();
  if (radio.power) setPower(true);
  requestAnimationFrame(frame);
})();
