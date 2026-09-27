'use strict';

/*
 * Экран радиостанции. Всё, что звучит и уходит в эфир, делает приложение (Station.java);
 * здесь — только показ состояния и кнопки. Состояние приходит в window.__station ~4 раза в секунду,
 * список треков — в window.__tracks, когда меняется.
 */
// Список изменений — зашит в приложение, чтобы плашка работала без интернета (пополняется при релизе)
window.STATION_CHANGELOG = [
  { ver: '1.0.33', items: [
    { level: 0, text: '**Кнопка «Полностью закрыть станцию».** Внизу настроек — останавливает эфир и выгружает станцию из памяти. Обычный выход кнопкой «Назад», как и раньше, оставляет её работать в фоне.' },
    { level: 0, text: '**Обновления встают чисто.** Исправлен редкий пустой экран после обновления (старый кэш вперемешку с новыми файлами) — кэш сбрасывается сам при установке новой версии, настройки сохраняются.' },
  ] },
  { ver: '1.0.28', items: [
    { level: 0, text: '**Обновления как в рации:** проверка при запуске и раз в час, уведомление о новой версии, резервный источник если GitHub недоступен.' },
    { level: 0, text: '**«Что нового» — за все пропущенные версии** и «История изменений» кнопкой; работает без интернета.' },
    { level: 0, text: '**Список треков не дёргает страницу** при смене трека.' },
  ] },
  { ver: '1.0.24', items: [
    { level: 0, text: 'Убран «Свой сервер» — станцию не было слышно на рациях, пока он был включён. Станция снова работает через сервер по адресу.' },
  ] },
  { ver: '1.0.19', items: [
    { level: 0, text: '**Внешний вид 🎨:** темы, дисплей, узоры, фоны и шрифты, своя картинка.' },
  ] },
];

(() => {
  const app = window.StationApp;
  const $ = (id) => document.getElementById(id);
  const FM_MIN = 87.5;
  const FM_MAX = 108;

  let st = {};
  let tracks = [];
  let editing = null; // поле, которое сейчас правят, — его не перезаписываем состоянием
  let freqDraft = null;

  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const fmt = (f) => Number(f).toFixed(1);
  const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'трек' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'трека' : 'треков');

  /* ───────── Шкала FM ───────── */

  const scale = $('scale');
  const ticks = $('ticks');
  const pct = (f) => ((f - FM_MIN) / (FM_MAX - FM_MIN)) * 94 + 3; // поля по краям — под подписи

  for (let f = 88; f <= 108; f += 0.5) {
    const big = Number.isInteger(f / 2);
    const t = document.createElement('i');
    t.className = big ? 'big' : '';
    t.style.left = `${pct(f)}%`;
    ticks.append(t);
    if (big && f % 4 === 0) {
      const label = document.createElement('span');
      label.textContent = String(f);
      label.style.left = `${pct(f)}%`;
      ticks.append(label);
    }
  }

  function freqFromX(x) {
    const r = scale.getBoundingClientRect();
    const p = ((x - r.left) / r.width) * 100;
    const f = FM_MIN + ((p - 3) / 94) * (FM_MAX - FM_MIN);
    return Math.round(Math.max(FM_MIN, Math.min(FM_MAX, f)) * 10) / 10;
  }

  scale.addEventListener('pointerdown', (e) => {
    scale.setPointerCapture(e.pointerId);
    freqDraft = freqFromX(e.clientX);
    render();
  });
  scale.addEventListener('pointermove', (e) => {
    if (freqDraft === null) return;
    freqDraft = freqFromX(e.clientX);
    render();
  });
  const commitScale = () => {
    if (freqDraft === null) return;
    const f = freqDraft;
    freqDraft = null;
    sendStation({ freq: f });
  };
  scale.addEventListener('pointerup', commitScale);
  scale.addEventListener('pointercancel', commitScale);

  const stepFreq = (d) => sendStation({ freq: Math.round(Math.max(FM_MIN, Math.min(FM_MAX, (st.freq ?? 100) + d)) * 10) / 10 });
  $('down').addEventListener('click', () => stepFreq(-0.1));
  $('up').addEventListener('click', () => stepFreq(0.1));

  /* ───────── Настройки станции ───────── */

  function sendStation(change) {
    const next = { name: st.name ?? '', freq: st.freq ?? 100, key: st.key ?? '', rds: st.rds ?? true, ...change };
    Object.assign(st, next);
    app?.setStation(JSON.stringify(next));
    render();
  }

  for (const id of ['name', 'key', 'address']) {
    const el = $(id);
    el.addEventListener('focus', () => { editing = id; });
    el.addEventListener('blur', () => {
      editing = null;
      if (id === 'address') return;
      if (el.value.trim() !== (st[id] ?? '')) sendStation({ [id]: el.value.trim() });
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.blur();
    });
  }

  $('connect').addEventListener('click', () => {
    const a = $('address').value.trim();
    st.address = a;
    app?.setServer(a);
  });
  $('address').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('connect').click();
  });

  $('rds').addEventListener('click', () => sendStation({ rds: !st.rds }));
  $('monitor').addEventListener('click', () => {
    st.monitor = !st.monitor;
    app?.setMonitor(st.monitor);
    render();
  });
  $('music').addEventListener('input', (e) => app?.setMusic(Number(e.target.value)));

  // Полностью закрыть станцию: глушит эфир и выгружает приложение из памяти (натив: StationApp.quit)
  $('quit')?.addEventListener('click', () => app?.quit());

  /* ───────── Эфир ───────── */

  $('go').addEventListener('click', () => (st.onAir ? app?.stop() : app?.start()));
  $('next').addEventListener('click', () => app?.next());

  const talk = $('talk');
  const talkOn = (e) => {
    talk.setPointerCapture?.(e.pointerId);
    talk.classList.add('is-on');
    app?.mic(true);
  };
  const talkOff = () => {
    if (!talk.classList.contains('is-on')) return;
    talk.classList.remove('is-on');
    app?.mic(false);
  };
  talk.addEventListener('pointerdown', talkOn);
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) talk.addEventListener(t, talkOff);
  talk.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ───────── Плейлист ───────── */

  $('pick').addEventListener('click', () => app?.pickFolder());
  $('rescan').addEventListener('click', () => app?.rescan());
  for (const b of document.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      st.mode = b.dataset.mode;
      app?.setMode(b.dataset.mode);
      render();
    });
  }

  function renderList() {
    const list = $('list');
    list.replaceChildren();
    if (!tracks.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = st.folder ? 'В папке нет музыки (mp3, m4a, flac, ogg, wav…)' : 'Выберите папку с музыкой';
      list.append(li);
      return;
    }
    tracks.forEach((title, i) => {
      const li = document.createElement('li');
      const n = document.createElement('b');
      n.textContent = String(i + 1);
      const t = document.createElement('span');
      t.textContent = title;
      li.append(n, t);
      li.addEventListener('click', () => app?.play(i));
      list.append(li);
    });
  }

  /* ───────── Обновления ───────── */

  $('upd-btn').addEventListener('click', () => app?.update());
  $('upd-auto').addEventListener('click', () => app?.setUpdateAuto(!(st.update?.auto !== false)));
  $('upd-log').addEventListener('click', () => openChangelog());

  function renderUpdate() {
    const u = st.update || {};
    const texts = {
      checking: 'Проверяю…',
      latest: 'Последняя версия',
      available: `Есть версия ${u.latest}`,
      downloading: `Скачиваю ${u.latest}: ${u.progress || 0}%`,
      ready: `Версия ${u.latest} скачана${st.onAir ? ' — поставлю после эфира' : ''}`,
      installing: `Ставлю ${u.latest}…`,
      confirm: `Подтвердите установку ${u.latest}`,
      error: 'Не получилось',
    };
    $('upd-ver').textContent = u.current ? `версия ${u.current}` : '';
    $('upd-text').textContent = texts[u.state] || 'Нажмите «Проверить»';
    const btn = $('upd-btn');
    btn.textContent = u.state === 'available' ? 'Скачать' : u.state === 'ready' || u.state === 'confirm' ? (u.canInstall ? 'Установить' : 'Разрешить') : 'Проверить';
    btn.disabled = ['checking', 'downloading', 'installing'].includes(u.state);
    $('upd-error').hidden = !u.error;
    $('upd-error').textContent = u.error || '';
    $('upd-auto').classList.toggle('is-on', u.auto !== false);
  }

  /* ───────── Показ ───────── */

  const meter = $('meter');
  for (let i = 0; i < 16; i++) meter.append(document.createElement('i'));

  let lastCurrent = -2;

  function render() {
    const f = freqDraft ?? st.freq ?? 100;
    $('freq').textContent = fmt(f);
    $('needle').style.left = `${pct(f)}%`;

    const lamp = $('lamp');
    const lost = st.onAir && !st.online;
    lamp.className = `lamp${st.onAir ? (lost ? ' is-lost' : ' is-on') : ''}`;
    $('lamp-text').textContent = st.onAir ? (lost ? 'НЕТ СВЯЗИ' : 'В ЭФИРЕ') : 'НЕ В ЭФИРЕ';

    $('b-rds').classList.toggle('is-on', Boolean(st.rds));
    $('b-key').classList.toggle('is-on', Boolean(st.key));
    $('b-mic').classList.toggle('is-on', Boolean(st.mic));
    $('airname').textContent = st.onAir ? st.airName : (st.name || 'РАДИО');
    $('now').textContent = st.mic ? '🎙 Голос поверх музыки' : st.title ? `▶ ${st.title}` : tracks.length ? 'Нажмите «Выйти в эфир»' : 'Выберите папку с музыкой';
    const p = st.duration > 0 ? Math.min(1, st.position / st.duration) : 0;
    $('progress').style.width = `${(st.onAir ? p : 0) * 100}%`;
    $('pos').textContent = clock(st.onAir ? st.position : 0);
    $('dur').textContent = clock(st.duration || 0);

    const lit = Math.round(Math.min(1, (st.level || 0) * 1.1) * 16);
    meter.querySelectorAll('i').forEach((el, i) => {
      el.className = i < lit ? `is-on${i >= 14 ? ' is-peak' : i >= 11 ? ' is-hot' : ''}` : '';
    });

    const go = $('go');
    go.textContent = st.onAir ? 'Закончить эфир' : 'Выйти в эфир';
    go.classList.toggle('is-on', Boolean(st.onAir));

    let status;
    if (st.problem) status = st.problem;
    else if (st.onAir && st.keyPending) status = 'Считаю ключ канала… звук пойдёт через секунду.';
    else if (st.onAir) status = `В эфире на ${fmt(st.freq)} МГц · слушателей: ${st.listeners ?? 0}.${st.online ? '' : ' Нет связи с сервером — переподключаюсь.'}`;
    else status = 'Не в эфире.';
    $('status').textContent = status;

    const srv = $('srv-state');
    srv.className = `dot${st.online ? ' is-on' : st.address ? ' is-lost' : ''}`;
    srv.textContent = st.online ? 'на связи' : st.address ? 'нет связи' : 'не подключено';
    const err = $('srv-error');
    err.hidden = !st.serverError || st.online;
    err.textContent = st.serverError ? `Нет связи: ${st.serverError}` : '';

    if (editing !== 'address') $('address').value = st.address ?? '';
    if (editing !== 'name') $('name').value = st.name ?? '';
    if (editing !== 'key') $('key').value = st.key ?? '';
    $('rds').classList.toggle('is-on', Boolean(st.rds));
    $('monitor').classList.toggle('is-on', Boolean(st.monitor));
    if (document.activeElement !== $('music')) $('music').value = String(st.music ?? 90);

    $('folder').textContent = st.folder ? `📁 ${st.folder}` : 'Папка не выбрана';
    $('count').textContent = st.scanning ? 'ищу музыку…' : `${tracks.length} ${plural(tracks.length)}`;
    for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('is-on', b.dataset.mode === (st.mode || 'loop'));

    if (st.current !== lastCurrent) {
      lastCurrent = st.current;
      document.querySelectorAll('.list li').forEach((li, i) => li.classList.toggle('is-current', i === st.current && st.onAir));
      // Прокрутка только внутри списка, не дёргая всю страницу
      const cur = document.querySelector('.list li.is-current');
      const list = $('list');
      if (cur && list) {
        const top = cur.offsetTop - list.offsetTop;
        if (top < list.scrollTop || top + cur.offsetHeight > list.scrollTop + list.clientHeight) {
          list.scrollTop = top - list.clientHeight / 2 + cur.offsetHeight;
        }
      }
    }
    renderUpdate();
    $('version').textContent = `Радиостанция${st.version ? ` ${st.version}` : ''} · Авторы: BuninSil и Valex`;
  }

  window.__station = (s) => {
    const wasOn = st.onAir;
    st = s;
    if (wasOn !== s.onAir) lastCurrent = -2;
    render();
  };
  window.__tracks = (t) => {
    tracks = Array.isArray(t) ? t : [];
    lastCurrent = -2;
    renderList();
    render();
  };

  /* ───────── Плашка «Что нового» после обновления ─────────
   * Версия поменялась — берём описание этого релиза с GitHub (раздел «## Новое…») и показываем
   * списком. Нет интернета — покажем в следующий раз. Первая установка — молча запоминаем версию. */
  function whatsNew(version, tag, hadData, css) {
    const SEEN = 'station.seenVersion';
    let seen = null;
    try {
      seen = localStorage.getItem(SEEN);
    } catch {
      return;
    }
    if (!version || seen === version) return;
    if (!seen && !hadData) {
      localStorage.setItem(SEEN, version);
      return;
    }
    const num = (v) => { const m = /1\.0\.(\d+)/.exec(v || ''); return m ? +m[1] : -1; };
    const curN = num(version);
    const seenN = num(seen);
    // Список изменений зашит в приложении — плашка не зависит от интернета
    const groups = changelogGroups().filter((g) => g.n <= curN && (seenN < 0 ? g.n === curN : g.n > seenN));
    try {
      localStorage.setItem(SEEN, version);
    } catch {
      /* покажем ещё раз — не страшно */
    }
    if (groups.length) showPlate(version, groups, css);
  }

  function changelogGroups() {
    const num = (v) => { const m = /1\.0\.(\d+)/.exec(v || ''); return m ? +m[1] : -1; };
    return (Array.isArray(window.STATION_CHANGELOG) ? window.STATION_CHANGELOG : [])
      .map((g) => ({ n: num(g.ver), ver: g.ver, items: g.items }))
      .filter((g) => g.n > 0 && Array.isArray(g.items) && g.items.length)
      .sort((a, b) => b.n - a.n);
  }

  function openChangelog() {
    const css = WN_CSS.replace('var(--wn-accent, #ff9a3c)', '#ffb547');
    const groups = changelogGroups();
    showPlate(st.version || '', groups.length ? groups : [{ ver: st.version || '', items: [{ level: 0, text: 'Список изменений пока пуст.' }] }], css, 'История изменений');
  }

  // Из Markdown релиза — пункты раздела «## Новое…» (или первого списка) с вложенными
  function notesList(md) {
    const lines = md.replace(/\r/g, '').split('\n');
    let start = lines.findIndex((l) => /^##\s+Новое/i.test(l));
    if (start < 0) start = lines.findIndex((l) => /^\s*[-*]\s/.test(l)) - 1;
    if (start < -1) return null;
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^##\s/.test(l)) break;
      const m = /^(\s*)[-*]\s+(.*)$/.exec(l);
      if (m) out.push({ level: m[1].length >= 2 ? 1 : 0, text: m[2] });
      else if (out.length && l.trim() && !/^\s*$/.test(l) && /^\s{2,}/.test(l)) out[out.length - 1].text += ` ${l.trim()}`;
      else if (out.length && !l.trim()) break;
    }
    return out.length ? out : null;
  }

  function inline(text) {
    const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return esc.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  }

  function showPlate(version, groups, css, heading) {
    const wrap = document.createElement('div');
    wrap.className = 'wn';
    const card = document.createElement('div');
    card.className = 'wn__card';
    const head = document.createElement('div');
    head.className = 'wn__head';
    const many = groups.length > 1;
    head.innerHTML = heading
      ? `<span>📋</span><b>${inline(heading)}</b>`
      : `<span>✨</span><b>Обновлено до ${inline(version)}</b>${many ? `<i class="wn__span">за ${groups.length} версий</i>` : ''}`;
    const list = document.createElement('ul');
    list.className = 'wn__list';
    list.innerHTML = groups.map((g) =>
      (many ? `<li class="wn__ver">${inline(g.ver)}</li>` : '')
      + g.items.map((it) => `<li class="${it.level ? 'is-sub' : ''}">${inline(it.text)}</li>`).join(''),
    ).join('');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'wn__ok';
    ok.textContent = 'Понятно';
    const close = () => {
      wrap.classList.add('is-out');
      setTimeout(() => wrap.remove(), 250);
    };
    ok.addEventListener('click', close);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close();
    });
    card.append(head, list, ok);
    wrap.append(card);
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    document.body.append(wrap);
  }

  const WN_CSS = `
    .wn { position: fixed; inset: 0; z-index: 80; display: flex; align-items: flex-start; justify-content: center;
      padding: 14px 12px; background: rgba(5, 6, 8, 0.45); animation: wn-in 0.25s ease-out; touch-action: pan-y; }
    .wn.is-out { animation: wn-out 0.25s ease-in forwards; }
    .wn__card { width: 100%; max-width: 440px; max-height: 70vh; display: flex; flex-direction: column;
      border: 1px solid #2c2d33; border-radius: 16px; background: linear-gradient(180deg, #1f2025, #15161a);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6); color: #ecebe6; font: 14px/1.4 system-ui, sans-serif; overflow: hidden; }
    .wn__head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 6px; font-size: 16px; }
    .wn__list { margin: 0; padding: 4px 18px 4px 34px; overflow-y: auto; }
    .wn__list li { margin: 5px 0; }
    .wn__list li.is-sub { margin-left: 16px; list-style: circle; color: #c9c6be; font-size: 13px; }
    .wn__span { color: var(--wn-accent, #ff9a3c); font-size: 12px; font-style: normal; font-weight: 700; }
    .wn__list li.wn__ver { margin: 12px 0 4px -16px; list-style: none; color: var(--wn-accent, #ff9a3c); font-weight: 800; font-size: 13px; letter-spacing: 0.04em; }
    .wn__list li.wn__ver:first-child { margin-top: 2px; }
    .wn__list b { color: #fff; }
    .wn__list code { font-size: 12px; color: #c9c6be; }
    .wn__ok { margin: 10px 14px 14px; padding: 11px; border: 0; border-radius: 12px; background: var(--wn-accent, #ff9a3c);
      color: #141414; font: 700 15px system-ui, sans-serif; }
    @keyframes wn-in { from { opacity: 0; transform: translateY(-16px); } }
    @keyframes wn-out { to { opacity: 0; transform: translateY(-16px); } }
  `;

  try {
    st = JSON.parse(app?.state() ?? '{}');
    tracks = JSON.parse(app?.tracks() ?? '[]');
  } catch {
    /* первый показ — без данных */
  }
  renderList();
  render();
  // Станция уже была настроена (сервер или папка) — значит, это обновление, а не первая установка
  setTimeout(() => whatsNew(st.version, `station-v${st.version}`, Boolean(st.address || st.folder), WN_CSS.replace('var(--wn-accent, #ff9a3c)', '#ffb547')), 1200);
})();
