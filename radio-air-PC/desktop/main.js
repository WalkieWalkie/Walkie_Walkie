'use strict';

/*
 * Приложение «Радио» для Windows.
 * Показывает тот же приёмник, что и сайт, но микрофон работает без HTTPS,
 * а свой сервер открывается одной кнопкой: встроенный сервер + UPnP в роутере.
 *
 * Два вида окна: большой приёмник и рация-виджет на рабочий стол. Открыт всегда один:
 * так у приложения одно подключение к серверу и нет эха от самого себя.
 * Рацию можно свернуть в полоску поверх игр и видео — это то же окно, только компактное.
 *
 * Та же оболочка собирается и отдельной программой «Рация»: в package.json стоит
 * "walkieOnly": true, и тогда большого окна нет вовсе (см. pack_walkie.py).
 */

const { app, BrowserWindow, Menu, ipcMain, net, protocol, screen, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { AirServer } = require('./air-server');
const { PortMapper, lanAddresses, isPublicIp, publicAddresses } = require('./upnp');
const { TelegramBot } = require('./telegram');
const { ControlServer } = require('./control');
const { Hotkeys, ACTIONS, DEFAULTS, label } = require('./hotkeys');

const pkg = require('./package.json');

// Только рация, без большого приёмника
const WALKIE_ONLY = pkg.walkieOnly === true || process.argv.includes('--walkie-only');
const APP_TITLE = WALKIE_ONLY ? 'Рация' : 'Радио';

// Страницы: в установленном приложении — рядом с ним, при разработке — из папки Radio
// (или из той, что указана в package.json как webRoot)
const WEB_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.resolve(__dirname, typeof pkg.webRoot === 'string' ? pkg.webRoot : '..');
const PAGES = WALKIE_ONLY ? ['widget.html'] : ['index.html', 'widget.html']; // первая — страница по умолчанию
const WIDGET_SIZE = { width: 300, height: 528 };
const BAR_SIZE = { width: 540, height: 46 };  // полоска и немного места под тень
const BAR_PANEL_HEIGHT = 640;                 // полоска с открытыми настройками

// Отладка: RADIO_DEBUG_PORT=9222 открывает протокол DevTools для автоматических проверок,
// RADIO_USER_DATA — отдельная папка профиля, чтобы проверки не трогали настоящие настройки
if (process.env.RADIO_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.RADIO_DEBUG_PORT);
if (process.env.RADIO_USER_DATA) app.setPath('userData', process.env.RADIO_USER_DATA);
// RADIO_DEBUG_LOG — файл, куда пишутся ошибки из консоли страниц (для поиска редких сбоев)
if (process.env.RADIO_DEBUG_LOG) {
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (event, legacyLevel, legacyMessage) => {
      const level = event.level ?? legacyLevel;
      if (level !== 'error' && level !== 3) return;
      const message = event.message ?? legacyMessage;
      fs.appendFileSync(process.env.RADIO_DEBUG_LOG, `${new Date().toISOString()} [${wc.getType()} ${wc.getURL() || 'пусто'}] ${message}\n`);
    });
  });
}

// Своя схема app:// — защищённая, поэтому страницу пускают к микрофону и шифрованию
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let server = null;      // встроенный сервер, если открыт
let mapper = null;      // проброс порта в роутере
let hosting = null;     // { port, reused }
let hostResult = null;  // что сообщили странице при открытии сервера

// ───────── Настройки окон ─────────

const prefsFile = () => path.join(app.getPath('userData'), 'window.json');
let prefs = {
  mode: 'full',
  view: 'widget', // окно рации: 'widget' — рация, 'bar' — полоска
  widget: { onTop: false },
  bar: { opacity: 0.92, clickThrough: false },
  hotkeys: { bindings: { ...DEFAULTS }, pttMode: 'hold' },
  autoUpdate: true, // тихо качать и ставить обновления из релизов GitHub
  telegram: { token: '', password: '', chats: [] }, // управление станцией из Телеграма
  control: { enabled: false, port: 8766, password: '' }, // веб-панель управления (когда ТГ недоступен)
};

function validCombo(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.mouse) return [3, 4, 5].includes(c.mouse) ? c : null;
  return typeof c.key === 'string' && c.key.length <= 20 ? c : null;
}

function loadPrefs() {
  try {
    const data = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    const saved = data.hotkeys?.bindings ?? {};
    const bindings = {};
    for (const action of ACTIONS) bindings[action] = action in saved ? validCombo(saved[action]) : DEFAULTS[action] ?? null;
    prefs = {
      mode: data.mode === 'widget' ? 'widget' : 'full',
      view: data.view === 'bar' ? 'bar' : 'widget',
      widget: { onTop: false, ...data.widget },
      bar: {
        ...data.bar,
        opacity: Number.isFinite(data.bar?.opacity) ? Math.min(1, Math.max(0.35, data.bar.opacity)) : 0.92,
        clickThrough: Boolean(data.bar?.clickThrough),
      },
      hotkeys: { bindings, pttMode: data.hotkeys?.pttMode === 'toggle' ? 'toggle' : 'hold' },
      autoUpdate: data.autoUpdate !== false,
      telegram: {
        token: typeof data.telegram?.token === 'string' ? data.telegram.token : '',
        password: typeof data.telegram?.password === 'string' ? data.telegram.password : '',
        chats: Array.isArray(data.telegram?.chats) ? data.telegram.chats.filter((n) => Number.isInteger(n)) : [],
      },
      control: {
        enabled: Boolean(data.control?.enabled),
        port: Number.isInteger(data.control?.port) && data.control.port > 0 && data.control.port < 65536 ? data.control.port : 8766,
        password: typeof data.control?.password === 'string' ? data.control.password : '',
      },
    };
  } catch {
    /* первый запуск — настройки по умолчанию */
  }
}

function savePrefs() {
  try {
    fs.writeFileSync(prefsFile(), JSON.stringify(prefs));
  } catch {
    /* не страшно: в следующий раз окно откроется по умолчанию */
  }
}

// ───────── Окна ─────────

function webPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    // Серверы без HTTPS (ws://) — это нормально для приложения: звук шифруется отдельно
    allowRunningInsecureContent: true,
  };
}

function guard(w) {
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
}

function createMain() {
  const w = new BrowserWindow({
    width: 1120,
    height: 940,
    minWidth: 400,
    minHeight: 500,
    backgroundColor: '#0b0c0f',
    title: APP_TITLE,
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  });
  guard(w);
  w.loadURL('app://radio/index.html');
  return w;
}

// Сохранённое место, если оно всё ещё на одном из экранов
function savedPosition({ x, y }, size) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    x > a.x - size.width / 2 && y >= a.y - 20 &&
    x < a.x + a.width - size.width / 2 && y < a.y + a.height - 40);
  return visible ? { x, y } : null;
}

function widgetBounds() {
  return { ...WIDGET_SIZE, ...savedPosition(prefs.widget, WIDGET_SIZE) };
}

// Полоска по умолчанию — сверху по центру экрана, как у программ записи экрана
function barBounds(near) {
  const pos = savedPosition(prefs.bar, BAR_SIZE);
  if (pos) return { ...BAR_SIZE, ...pos };
  const area = (near ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay()).workArea;
  return { ...BAR_SIZE, x: Math.round(area.x + (area.width - BAR_SIZE.width) / 2), y: area.y + 6 };
}

let panelOpen = false;
let altHeld = false;

// «Мышь насквозь»: полоска не перехватывает щелчки, пока не зажат Alt
function applyClickThrough() {
  if (!win || prefs.mode !== 'widget' || prefs.view !== 'bar') return;
  const through = prefs.bar.clickThrough && !panelOpen && !altHeld;
  win.setIgnoreMouseEvents(through, { forward: true });
}

function createWidget() {
  const bar = prefs.view === 'bar';
  const w = new BrowserWindow({
    ...(bar ? barBounds() : widgetBounds()),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: !bar, // полоска не забирает фокус у игры
    backgroundColor: '#00000000',
    title: 'Рация',
    webPreferences: webPreferences(),
  });
  guard(w);
  if (bar) w.setAlwaysOnTop(true, 'screen-saver');
  else if (prefs.widget.onTop) w.setAlwaysOnTop(true, 'floating');
  w.on('moved', () => {
    if (prefs.view === 'bar' && panelOpen) return; // полоску сдвинули, чтобы влезли настройки
    const [x, y] = w.getPosition();
    const key = prefs.view === 'bar' ? 'bar' : 'widget';
    prefs[key] = { ...prefs[key], x, y };
    savePrefs();
  });
  w.loadURL('app://radio/widget.html?view=' + prefs.view);
  return w;
}

// Рация ⇄ полоска — то же окно и тот же эфир, меняется только вид
function setView(view) {
  if (!win || prefs.mode !== 'widget') return;
  const w = win;
  prefs.view = view;
  panelOpen = false;
  savePrefs();
  if (view === 'bar') {
    w.setFocusable(false);
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setBounds(barBounds(w.getBounds()));
    applyClickThrough();
  } else {
    w.setIgnoreMouseEvents(false);
    w.setFocusable(true);
    w.setAlwaysOnTop(Boolean(prefs.widget.onTop), 'floating');
    w.setBounds(widgetBounds());
    w.focus();
  }
}

// Настройки полоски раскрываются вниз; если внизу не хватает места — полоска приподнимается
function setPanel(open) {
  if (!win || prefs.view !== 'bar') return;
  panelOpen = open;
  const base = barBounds(win.getBounds());
  if (open) {
    const area = screen.getDisplayMatching(base).workArea;
    const y = Math.min(base.y, area.y + area.height - BAR_PANEL_HEIGHT);
    win.setBounds({ ...base, y: Math.max(area.y, y), height: BAR_PANEL_HEIGHT });
  } else {
    win.setBounds(base);
  }
  applyClickThrough();
}

function openWindow(mode) {
  if (WALKIE_ONLY) mode = 'widget';
  const old = win;
  const created = mode === 'widget' ? createWidget() : createMain();
  created.on('closed', () => {
    if (win === created) win = null;
  });
  win = created;
  prefs.mode = mode;
  panelOpen = false;
  savePrefs();
  old?.destroy(); // новое окно уже открыто — приложение не закроется
  applyClickThrough();
}

ipcMain.handle('window:get', () => ({
  walkieOnly: WALKIE_ONLY,
  mode: prefs.mode,
  view: prefs.view,
  onTop: Boolean(prefs.widget.onTop),
  bar: { opacity: prefs.bar.opacity, clickThrough: prefs.bar.clickThrough },
  bounds: win?.getBounds(),
  focusable: win?.isFocusable(),
  alwaysOnTop: win?.isAlwaysOnTop(),
  visible: win?.isVisible(),
}));
ipcMain.handle('view:set', (_e, view) => {
  if (view !== 'bar' && view !== 'widget') return false;
  setView(view);
  return true;
});
ipcMain.handle('bar:panel', (_e, open) => setPanel(Boolean(open)));
ipcMain.handle('bar:settings', (_e, { opacity, clickThrough } = {}) => {
  if (Number.isFinite(opacity)) prefs.bar.opacity = Math.min(1, Math.max(0.35, opacity));
  if (typeof clickThrough === 'boolean') prefs.bar.clickThrough = clickThrough;
  savePrefs();
  applyClickThrough();
  return { opacity: prefs.bar.opacity, clickThrough: prefs.bar.clickThrough };
});
ipcMain.handle('window:mode', (_e, mode) => {
  if (mode !== 'widget' && (mode !== 'full' || WALKIE_ONLY)) return false;
  setImmediate(() => openWindow(mode)); // сначала ответ странице, потом смена окна
  return true;
});
ipcMain.handle('window:on-top', (_e, on) => {
  prefs.widget.onTop = Boolean(on);
  savePrefs();
  if (prefs.mode === 'widget') win?.setAlwaysOnTop(prefs.widget.onTop, 'floating');
  return prefs.widget.onTop;
});
ipcMain.handle('window:minimize', () => win?.minimize());
ipcMain.handle('window:close', () => app.quit());

// ───────── Свой сервер ─────────

// Уже работает наш сервер на этом порту (например, python server.py)?
function isAirServer(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(/<title>(Радио|Рация)<\/title>/.test(body)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function hostStart({ port = 8765, local = false, upnp = true } = {}) {
  // Сервер уже открыт (например, из другого окна) — просто сообщаем, как к нему подключиться
  if (hosting && hosting.port === port && hostResult) return hostResult;
  if (hosting) await hostStop();
  let reused = false;
  const candidate = new AirServer(WEB_ROOT, { pages: PAGES });
  try {
    await candidate.start(port, local ? '127.0.0.1' : '0.0.0.0');
    server = candidate;
  } catch (err) {
    if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && await isAirServer(port)) {
      reused = true; // сервер уже запущен отдельно — приложение просто им пользуется
    } else if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      return { ok: false, error: `Порт ${port} занят другой программой` };
    } else {
      return { ok: false, error: err.message };
    }
  }
  hosting = { port, reused };

  const publicIps = publicAddresses();
  const result = { ok: true, port, reused, lan: lanAddresses(), publicIps, upnp: null };
  // На VPS/сервере белый IP висит прямо на карте — роутера нет, UPnP не нужен и только
  // висит 3 секунды на таймауте, а потом пугает «роутер не открыл порт». Пропускаем его.
  if (upnp && !local && publicIps.length === 0) {
    mapper = new PortMapper();
    try {
      const externalIp = await mapper.externalIp();
      await mapper.open(port, APP_TITLE);
      result.upnp = { ok: true, externalIp, public: Boolean(externalIp) && isPublicIp(externalIp) };
    } catch (err) {
      result.upnp = { ok: false, error: err.message };
      mapper = null;
    }
  }
  hostResult = result;
  return result;
}

// keepPort — оставить порт в роутере открытым (сервер работает и без приложения)
async function hostStop({ keepPort = false } = {}) {
  const m = mapper;
  const s = server;
  mapper = null;
  server = null;
  hosting = null;
  hostResult = null;
  await Promise.allSettled([keepPort ? m?.forget() : m?.close(), s?.stop()]);
}

ipcMain.handle('host:start', (_e, options) => hostStart(options));
ipcMain.handle('host:stop', () => hostStop());
ipcMain.handle('host:status', () => hostResult);

// ───────── Рация по горячей клавише, даже когда окно свёрнуто ─────────

const hotkeys = new Hotkeys({
  onAction(action) {
    // «Спрятать / показать» работает с окном рации, даже когда его не видно
    if (action === 'hide') {
      if (!win || prefs.mode !== 'widget') return;
      if (win.isVisible()) win.hide();
      else win.showInactive();
      return;
    }
    win?.webContents.send('hotkey', action);
  },
  onAlt(held) {
    altHeld = held;
    applyClickThrough();
    win?.webContents.send('bar:alt', held);
  },
});

function hotkeyState() {
  return {
    hooked: hotkeys.hooked,
    error: hotkeys.error,
    pttMode: prefs.hotkeys.pttMode,
    bindings: Object.fromEntries(ACTIONS.map((a) => [a, { combo: prefs.hotkeys.bindings[a] ?? null, label: label(prefs.hotkeys.bindings[a]) }])),
  };
}

function applyHotkeys() {
  hotkeys.configure(prefs.hotkeys);
  savePrefs();
}

ipcMain.handle('hotkeys:get', () => hotkeyState());
ipcMain.handle('hotkeys:active', (_e, on) => {
  hotkeys.setActive(Boolean(on));
  return true;
});
ipcMain.handle('hotkeys:set', (_e, action, combo) => {
  if (!ACTIONS.includes(action)) return hotkeyState();
  prefs.hotkeys.bindings[action] = validCombo(combo);
  applyHotkeys();
  return hotkeyState();
});
ipcMain.handle('hotkeys:mode', (_e, mode) => {
  prefs.hotkeys.pttMode = mode === 'toggle' ? 'toggle' : 'hold';
  applyHotkeys();
  return hotkeyState();
});
ipcMain.handle('hotkeys:capture', async () => {
  const result = await hotkeys.captureNext();
  return result.combo ? { combo: result.combo, label: label(result.combo) } : result;
});
ipcMain.handle('hotkeys:cancel', () => hotkeys.cancelCapture());
// Только для автоматических проверок: «нажать» горячую клавишу без клавиатуры
ipcMain.handle('hotkeys:simulate', (_e, action, phase) => Boolean(process.env.RADIO_DEBUG_PORT) && hotkeys.simulate(action, phase));

// ───────── Жизненный цикл ─────────

/* ───────── Автообновление из релизов GitHub (electron-updater) ─────────
 * Тихо проверяет релизы репозитория при запуске и раз в час, качает новую версию в фоне и
 * ставит при выходе (или сразу — по кнопке на странице). «Радио» и «Рация» лежат в одних
 * релизах, но у каждой свой файл-манифест (канал): latest.yml и walkie.yml — не мешают друг другу.
 */
let updaterState = { state: app.isPackaged ? 'idle' : 'dev', version: app.getVersion(), percent: 0, message: null };
let autoUpdater = null;

function sendUpdater() {
  win?.webContents?.send('updater:status', updaterState);
}

function setupUpdater() {
  if (!app.isPackaged) return; // автообновление — только в установленном приложении
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return; // модуль не собрался — работаем без автообновления
  }
  if (WALKIE_ONLY) {
    // «Рация» обновляется своим треком: отдельные релизы-предрелизы с манифестом walkie.yml.
    // Так станция и рация на ПК обновляются независимо (см. pack_walkie.py и workflow).
    autoUpdater.channel = 'walkie';
    autoUpdater.allowPrerelease = true;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => { updaterState = { state: 'checking', version: app.getVersion(), percent: 0, message: null }; sendUpdater(); });
  autoUpdater.on('update-available', (info) => { updaterState = { state: 'downloading', version: info?.version || null, percent: 0, message: null }; sendUpdater(); });
  autoUpdater.on('update-not-available', () => { updaterState = { state: 'none', version: app.getVersion(), percent: 0, message: null }; sendUpdater(); });
  autoUpdater.on('download-progress', (p) => { updaterState = { state: 'downloading', version: updaterState.version, percent: Math.round(p?.percent || 0), message: null }; sendUpdater(); });
  autoUpdater.on('update-downloaded', (info) => { updaterState = { state: 'ready', version: info?.version || null, percent: 100, message: null }; sendUpdater(); });
  autoUpdater.on('error', (err) => { updaterState = { state: 'error', version: null, percent: 0, message: String(err?.message || err) }; sendUpdater(); });
  const check = () => { if (prefs.autoUpdate !== false) autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 4000);
  setInterval(check, 60 * 60 * 1000);
}

ipcMain.handle('updater:get', () => updaterState);
ipcMain.handle('updater:check', () => {
  if (autoUpdater) autoUpdater.checkForUpdates().catch(() => {});
  return updaterState;
});
ipcMain.handle('updater:install', () => {
  // Ставим сразу: закрыть и установить. Страница разрешает кнопку только когда не в эфире.
  if (autoUpdater && updaterState.state === 'ready') autoUpdater.quitAndInstall(false, true);
  return updaterState;
});
ipcMain.handle('updater:auto', (_e, on) => {
  prefs.autoUpdate = Boolean(on);
  savePrefs();
  if (prefs.autoUpdate && autoUpdater) autoUpdater.checkForUpdates().catch(() => {});
  return prefs.autoUpdate;
});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:auto-update', () => prefs.autoUpdate !== false);

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// ───────── Телеграм-бот управления станцией ─────────

const bot = new TelegramBot({
  get: () => prefs.telegram,
  save: (patch) => { prefs.telegram = { ...prefs.telegram, ...patch }; savePrefs(); },
});

let botReqId = 0;
const botPending = new Map();

// Команду исполняет окно станции (renderer): там broadcaster, link, плейлист, оповещения.
// Общий диспатч команд станции — зовут и телеграм-бот, и веб-панель.
function runStationCommand(cmd, args) {
 return new Promise((resolve) => {
  // Управление самим приложением — прямо в main (окно для этого не нужно)
  if (cmd === 'restart') {
    resolve('♻️ Перезапускаю станцию — вернусь через несколько секунд.');
    setTimeout(() => { app.relaunch(); app.quit(); }, 1500);
    return;
  }
  if (cmd === 'quit') {
    resolve('🛑 Выключаю станцию. Обратно из Телеграма включить не получится — команду принимать будет некому.');
    setTimeout(() => app.quit(), 1500);
    return;
  }
  if (cmd === 'station_off') {
    // «Выключить» станцию из ТГ = уйти в фон: эфир и свой сервер стоп, окно спрятать,
    // но процесс и бот живут — иначе включить обратно из Телеграма было бы некому.
    if (win && !win.isDestroyed()) { win.webContents.send('bot:command', { id: -1, cmd: 'stopall', args: '' }); win.hide(); }
    resolve('💤 Станция свёрнута в фон: эфир и свой сервер остановлены, окно спрятано. Вернуть: /station_on. Бот остаётся на связи.');
    return;
  }
  if (cmd === 'station_on') {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    resolve('▶️ Станция активна, окно открыто. Дальше: /server_on, затем /on 101.5.');
    return;
  }
  if (cmd === 'check') {
    if (autoUpdater) autoUpdater.checkForUpdates().catch(() => {});
    resolve('🔍 Проверяю обновления… через минуту — /status или /update.');
    return;
  }
  if (cmd === 'update') {
    if (!autoUpdater) { resolve('Обновление работает только в установленном приложении.'); return; }
    const st = updaterState && updaterState.state;
    if (st === 'ready') {
      resolve('⬇️ Ставлю обновление и перезапускаюсь…');
      setTimeout(() => { try { autoUpdater.quitAndInstall(false, true); } catch { /* ждём выхода из эфира */ } }, 1200);
    } else if (st === 'downloading') {
      resolve(`Уже качаю обновление… ${updaterState.percent || 0}%. Повторите /update, когда докачается.`);
    } else {
      autoUpdater.checkForUpdates().catch(() => {});
      resolve('Ищу обновление. Если найдётся — скачаю; затем /update ещё раз, чтобы поставить.');
    }
    return;
  }
  if (!win || win.isDestroyed()) { resolve('Станция сейчас закрыта.'); return; }
  const id = ++botReqId;
  botPending.set(id, resolve);
  win.webContents.send('bot:command', { id, cmd, args });
  setTimeout(() => {
    if (botPending.has(id)) { botPending.delete(id); resolve('Станция не ответила — окно эфира закрыто?'); }
  }, 8000);
 });
}

bot.onCommand((cmd, args) => runStationCommand(cmd, args));

ipcMain.handle('bot:answer', (_e, { id, text } = {}) => {
  const resolve = botPending.get(id);
  if (resolve) { botPending.delete(id); resolve(text || ''); }
});

ipcMain.handle('telegram:get', () => ({
  token: prefs.telegram.token,
  hasPassword: Boolean(prefs.telegram.password),
  chats: prefs.telegram.chats.length,
  running: bot.running,
  username: bot.me && bot.me.username ? bot.me.username : '',
}));

ipcMain.handle('telegram:set', async (_e, cfg = {}) => {
  const next = { ...prefs.telegram };
  if (typeof cfg.token === 'string') next.token = cfg.token.trim();
  if (typeof cfg.password === 'string') next.password = cfg.password;
  if (cfg.forget === true) next.chats = []; // «забыть доверенные чаты»
  prefs.telegram = next;
  savePrefs();
  bot.stop();
  let error = '';
  if (next.token) {
    try { await bot.start(); } catch (e) { error = e.message; }
  }
  return { running: bot.running, username: bot.me && bot.me.username ? bot.me.username : '', error, hasPassword: Boolean(next.password), chats: next.chats.length };
});

// ───────── Веб-панель управления станцией (запасной путь, когда ТГ недоступен) ─────────

const control = new ControlServer(
  {
    get: () => prefs.control,
    save: (patch) => { prefs.control = { ...prefs.control, ...patch }; savePrefs(); },
  },
  (cmd, args) => runStationCommand(cmd, args),
);

function localAddresses() {
  try { return lanAddresses(); } catch { return []; }
}

ipcMain.handle('control:get', () => ({
  enabled: Boolean(prefs.control.enabled),
  port: prefs.control.port || 8766,
  hasPassword: Boolean(prefs.control.password),
  running: control.running,
  addresses: localAddresses(),
}));

ipcMain.handle('control:set', async (_e, cfg = {}) => {
  const next = { ...prefs.control };
  if (typeof cfg.enabled === 'boolean') next.enabled = cfg.enabled;
  if (cfg.port !== undefined) {
    const p = Number(cfg.port);
    if (Number.isInteger(p) && p > 0 && p < 65536) next.port = p;
  }
  if (typeof cfg.password === 'string') next.password = cfg.password;
  prefs.control = next;
  savePrefs();
  control.stop();
  let error = '';
  if (next.enabled && next.password) {
    try { await control.start(); } catch (e) { error = e && e.message ? e.message : String(e); }
  } else if (next.enabled && !next.password) {
    error = 'Без пароля панель не запускается — задай пароль.';
  }
  return {
    running: control.running,
    enabled: next.enabled,
    port: next.port,
    hasPassword: Boolean(next.password),
    addresses: localAddresses(),
    error,
  };
});

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '') || PAGES[0];
    const file = path.resolve(WEB_ROOT, rel);
    const resolved = path.relative(WEB_ROOT, file).split(path.sep).join('/');
    const allowed = PAGES.includes(resolved) || /^(css|js|fonts)\//.test(resolved);
    if (!allowed || !file.startsWith(WEB_ROOT + path.sep)) return new Response('Not Found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Микрофон странице разрешён; остальное — нет
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  // Интернет-радио в эфир: живой поток играет через <audio> и снимается Web Audio для передачи.
  // Web Audio глушит cross-origin медиа без CORS, а интернет-станции заголовок ACAO почти
  // никогда не шлют — добавляем его сами к http(s)-ответам, иначе поток «тух» бы в тишину.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (/^https?:/i.test(details.url)) {
      callback({ responseHeaders: { ...details.responseHeaders, 'Access-Control-Allow-Origin': ['*'] } });
    } else {
      callback({});
    }
  });

  if (app.isPackaged) Menu.setApplicationMenu(null);
  loadPrefs();
  hotkeys.configure(prefs.hotkeys);
  hotkeys.start();
  openWindow(process.argv.includes('--widget') ? 'widget' : prefs.mode);
  setupUpdater();
  bot.start().catch(() => {}); // молча: не настроен или сеть — не мешаем запуску станции
  control.start()?.catch(() => {}); // веб-панель — если включена и с паролем
});

app.on('window-all-closed', () => app.quit());

// Перед выходом закрываем встроенный сервер и порт в роутере. Если приложение пользовалось
// отдельно запущенным сервером (server.py с автозапуском), он продолжает работать — тогда и порт
// оставляем открытым, иначе друзья из интернета перестанут до него доставать.
let cleaned = false;
app.on('will-quit', (e) => {
  hotkeys.stop();
  if (cleaned || !hosting) return;
  e.preventDefault();
  hostStop({ keepPort: hosting.reused }).finally(() => {
    cleaned = true;
    app.quit();
  });
});
