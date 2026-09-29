'use strict';

/*
 * Веб-панель управления станцией — на случай, когда Телеграм недоступен (или просто удобнее).
 * Отдаёт защищённую паролем страницу по своему порту; открываешь с телефона в браузере
 * (http://адрес-сервера:порт) и рулишь станцией теми же командами, что и бот.
 *
 * Живёт в main-процессе (свой HTTP-сервер, независимо от эфир-сервера). Команды исполняет
 * не сам сервер, а окно станции — тот же общий диспатч runStationCommand, что и у бота.
 *
 * store: { get(): {enabled, port, password}, save(patch) }.  run: (cmd, args) => Promise<string>.
 */

const http = require('node:http');

const PAGE = String.raw`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Радио — управление</title>
<style>
:root{--bg:#0b0c0f;--ink:#ebe8e1;--muted:#8e8c94;--line:#26272e;--panel:#15161b;--panel2:#1c1d23;--amber:#ffb547;--amber2:#ffcd7a;--red:#ff4b3e;--green:#4be08a;--mono:'JetBrains Mono',ui-monospace,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(1000px 500px at 50% -10%,#1b1c22,var(--bg) 60%) var(--bg);color:var(--ink);font-family:system-ui,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:720px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:20px;margin:4px 0 2px;letter-spacing:.5px}
.sub{color:var(--muted);font-size:13px;margin:0 0 18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 16px 18px;margin-bottom:14px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);margin:0 0 12px;font-weight:700}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.grow{flex:1 1 auto;min-width:0}
input{width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:11px;color:var(--ink);font:15px var(--mono);padding:12px 14px;outline:none}
input:focus{border-color:var(--amber)}
button{font:600 14px/1 system-ui,'Segoe UI',sans-serif;color:var(--ink);background:var(--panel2);border:1px solid var(--line);border-radius:11px;padding:12px 16px;cursor:pointer;transition:.12s;-webkit-tap-highlight-color:transparent}
button:hover{border-color:#4a4b53}
button:active{transform:translateY(1px)}
.b-amber{background:var(--amber);border-color:var(--amber);color:#1a1204}
.b-amber:hover{background:var(--amber2)}
.b-red{background:transparent;border-color:#5a2420;color:#ff9d94}
.b-red:hover{background:#3a1512;border-color:var(--red)}
.b-wide{flex:1 1 140px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.status{display:flex;align-items:center;gap:10px;background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin-bottom:14px}
.dot{width:12px;height:12px;border-radius:50%;background:#4a4b53;flex:0 0 auto;box-shadow:0 0 0 4px rgba(255,255,255,.03)}
.dot.on{background:var(--red);box-shadow:0 0 12px 2px rgba(255,75,62,.6)}
.dot.idle{background:var(--muted)}
.st-main{font-weight:700;font-size:16px}
.st-sub{color:var(--muted);font-size:13px;margin-top:2px}
.hint{color:var(--muted);font-size:12.5px;line-height:1.5;margin:10px 0 0}
.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%) translateY(20px);background:#22242c;border:1px solid var(--line);border-radius:12px;padding:12px 16px;max-width:90vw;opacity:0;transition:.25s;pointer-events:none;font-size:14px;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.login{max-width:360px;margin:14vh auto 0;text-align:center}
.login .card{padding:22px}
.hidden{display:none}
.tag{font:700 11px var(--mono);letter-spacing:1px;color:var(--amber);border:1px solid rgba(255,181,71,.4);border-radius:6px;padding:2px 7px}
</style></head>
<body>
<div class="wrap">
  <div id="login" class="login">
    <h1>Радио</h1><p class="sub">Управление станцией</p>
    <div class="card">
      <div class="row"><input id="pass" type="password" placeholder="пароль" autocomplete="current-password" class="grow"></div>
      <div class="row" style="margin-top:10px"><button class="b-amber b-wide" id="enter">Войти</button></div>
      <p class="hint" id="login-err"></p>
    </div>
  </div>

  <div id="panel" class="hidden">
    <div class="row" style="justify-content:space-between;align-items:flex-end">
      <div><h1>Радио <span class="tag">панель</span></h1><p class="sub">Управление станцией</p></div>
      <button id="refresh" title="Обновить статус">↻</button>
    </div>

    <div class="status">
      <span class="dot idle" id="st-dot"></span>
      <div><div class="st-main" id="st-main">—</div><div class="st-sub" id="st-sub"></div></div>
    </div>

    <div class="card"><h2>Эфир</h2>
      <div class="row"><input id="freq" class="grow" inputmode="decimal" placeholder="частота, напр. 101.5"><button id="freq-set">Частота</button></div>
      <div class="row" style="margin-top:8px">
        <button class="b-amber b-wide" data-cmd="on" data-freq>Выйти в эфир</button>
        <button class="b-wide" data-cmd="off">Закончить</button>
        <button class="b-wide" data-cmd="next">Следующий трек</button>
      </div>
    </div>

    <div class="card"><h2>Интернет-радио → эфир</h2>
      <div class="row"><input id="radio-url" class="grow" placeholder="URL потока (http://…)"><button class="b-amber" id="radio-on">В эфир</button></div>
      <div class="row" style="margin-top:8px"><button class="b-wide" data-cmd="radio_off">Выключить радио</button></div>
      <div class="row" style="margin-top:8px"><input id="air-name" class="grow" maxlength="24" placeholder="позывной эфира (напр. Радио)"><button id="air-name-save">Позывной</button></div>
      <div class="row" style="margin-top:8px"><input id="ff-path" class="grow" placeholder="путь к ffmpeg (пусто = из PATH)"><button id="ff-save">ffmpeg</button></div>
      <p class="hint">Поток тянет сам сервер через ffmpeg — окну считать звук не надо, поэтому эфир не заикается. На сервере нужен установленный ffmpeg (в PATH) или укажи путь.</p>
    </div>

    <div class="card"><h2>Оповестить всех в эфире</h2>
      <div class="grid">
        <button data-notice="update">Обновление</button>
        <button data-notice="restart">Перезапуск</button>
        <button data-notice="shutdown">Выключение</button>
        <button class="b-amber" data-notice="live">В работе</button>
      </div>
      <div class="row" style="margin-top:8px"><input id="notice-text" class="grow" maxlength="120" placeholder="свой текст — уйдёт всем в эфир"><button id="notice-send">Отправить</button></div>
    </div>

    <div class="card"><h2>Сервер эфира</h2>
      <div class="row"><button class="b-amber b-wide" data-cmd="server_on">Открыть сервер</button><button class="b-wide" data-cmd="server_off">Закрыть сервер</button></div>
    </div>

    <div class="card"><h2>Станция</h2>
      <div class="grid">
        <button data-cmd="station_off">Свернуть в фон</button>
        <button data-cmd="station_on">Поднять</button>
        <button data-cmd="restart">Перезапустить</button>
        <button data-cmd="check">Проверить обновления</button>
        <button class="b-amber" data-cmd="update">Обновить станцию</button>
        <button class="b-red" data-cmd="quit" data-confirm="Полностью выключить станцию? Обратно удалённо не поднять.">Выключить</button>
      </div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const $=(id)=>document.getElementById(id);
let pass=sessionStorage.getItem('radio.pass')||'';
const toast=(t)=>{const el=$('toast');el.textContent=t;el.classList.add('show');clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove('show'),3500)};
async function cmd(c,args){
  try{
    const r=await fetch('api/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pass,cmd:c,args:args||''})});
    if(r.status===401){show(false);toast('Нужен пароль');return null}
    const j=await r.json();
    if(j.answer)toast(j.answer);
    return j;
  }catch(e){toast('Нет связи со станцией');return null}
}
function show(authed){$('login').classList.toggle('hidden',authed);$('panel').classList.toggle('hidden',!authed)}
async function refresh(){
  const j=await cmd('status');
  if(!j)return;
  const on=/В эфире|🔴/.test(j.answer);
  $('st-dot').className='dot '+(on?'on':'idle');
  const parts=j.answer.replace(/^[^A-Za-zА-Яа-я0-9]+/,'').split('\n');
  $('st-main').textContent=parts[0]||'—';
  $('st-sub').textContent=parts.slice(1).join(' ')||'';
}
$('enter').onclick=async()=>{
  pass=$('pass').value;
  const j=await cmd('status');
  if(j){sessionStorage.setItem('radio.pass',pass);show(true);refresh()}
  else $('login-err').textContent='Не подошло или станция недоступна.';
};
$('pass').addEventListener('keydown',(e)=>{if(e.key==='Enter')$('enter').click()});
$('refresh').onclick=refresh;
$('freq-set').onclick=()=>cmd('freq',$('freq').value).then(refresh);
$('radio-on').onclick=()=>cmd('radio',$('radio-url').value).then(()=>setTimeout(refresh,600));
$('air-name-save').onclick=()=>{const v=$('air-name').value.trim();if(v)cmd('name',v)};
$('ff-save').onclick=()=>cmd('ffmpeg',$('ff-path').value.trim());
$('notice-send').onclick=()=>{const t=$('notice-text').value.trim();if(t)cmd('say',t)};
document.querySelectorAll('[data-cmd]').forEach((b)=>b.onclick=()=>{
  const c=b.getAttribute('data-cmd');
  if(b.dataset.confirm&&!confirm(b.dataset.confirm))return;
  const args=b.hasAttribute('data-freq')?$('freq').value:'';
  cmd(c,args).then(()=>setTimeout(refresh,600));
});
document.querySelectorAll('[data-notice]').forEach((b)=>b.onclick=()=>{
  const t=$('notice-text').value.trim();
  cmd('notice',b.getAttribute('data-notice')+(t?' '+t:''));
});
// автообновление статуса
if(pass){show(true);refresh()}else show(false);
setInterval(()=>{if(!$('panel').classList.contains('hidden'))refresh()},7000);
</script>
</body></html>`;

class ControlServer {
  constructor(store, run) {
    this.store = store;
    this.run = run;
    this.server = null;
  }

  get config() {
    return this.store.get() || {};
  }

  ok(chatless) {
    return true;
  }

  async handle(req, res) {
    const cfg = this.config;
    // Статика: сама страница
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/cmd')) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', async () => {
        let msg;
        try { msg = JSON.parse(body); } catch { res.writeHead(400).end('{}'); return; }
        if (!cfg.password || msg.password !== cfg.password) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const cmd = String(msg.cmd || '').slice(0, 32).replace(/[^a-z_]/g, '');
        const args = String(msg.args || '').slice(0, 200);
        let answer = '';
        try { answer = await this.run(cmd, args); } catch (e) { answer = 'Ошибка: ' + (e && e.message || e); }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ answer }));
      });
      return;
    }
    res.writeHead(404).end('not found');
  }

  start() {
    this.stop();
    const cfg = this.config;
    if (!cfg.enabled || !cfg.password) return; // без пароля панель не поднимаем — безопасность
    const port = Number(cfg.port) || 8766;
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res).catch(() => { try { res.writeHead(500).end(); } catch {} }));
      server.on('error', (e) => { this.server = null; reject(e); });
      server.listen({ port, host: '0.0.0.0' }, () => { this.server = server; resolve(port); });
    });
  }

  stop() {
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
  }

  get running() {
    return Boolean(this.server);
  }
}

module.exports = { ControlServer };
