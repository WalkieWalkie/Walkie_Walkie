'use strict';

/*
 * Телеграм-бот для управления станцией без RDP на сервер.
 *
 * Живёт в main-процессе Electron: сам ходит в Telegram по long-polling (getUpdates),
 * поэтому серверу не нужен ни открытый порт, ни белый IP — бот стучится наружу.
 * Токен и пароль берутся из настроек (prefs) и в репозиторий не попадают.
 *
 * Доступ — по паролю: `/login <пароль>` делает чат доверенным (chat_id запоминается
 * в prefs). Команды исполняет не бот, а окно станции: main прокидывает { cmd, args, chatId }
 * в renderer, тот выполняет и присылает назад текст ответа, который бот шлёт в чат.
 *
 * Наружу: TelegramBot { start(), stop(), reply(chatId, text), onCommand(fn) }.
 */

const https = require('node:https');

const API = 'https://api.telegram.org';

function apiCall(token, method, params) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(params || {}), 'utf8');
    const req = https.request(
      `${API}/bot${token}/${method}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            json.ok ? resolve(json.result) : reject(new Error(json.description || 'Telegram error'));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(35000, () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

class TelegramBot {
  // store: { get(): {token, password, chats:[]}, save(patch) } — доступ к prefs.telegram
  constructor(store) {
    this.store = store;
    this.running = false;
    this.offset = 0;
    this.handler = null; // (cmd, args, chatId) => Promise<string> | string
    this.me = null;
  }

  onCommand(fn) {
    this.handler = fn;
  }

  get config() {
    return this.store.get() || {};
  }

  authorized(chatId) {
    return (this.config.chats || []).includes(chatId);
  }

  authorize(chatId) {
    const chats = new Set(this.config.chats || []);
    chats.add(chatId);
    this.store.save({ chats: [...chats] });
  }

  async reply(chatId, text) {
    if (!this.config.token || !chatId) return;
    try {
      await apiCall(this.config.token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
    } catch {
      /* сеть моргнула — не критично */
    }
  }

  async start() {
    if (this.running) return;
    if (!this.config.token) return; // не настроен — молча не запускаемся
    this.running = true;
    try {
      this.me = await apiCall(this.config.token, 'getMe', {});
    } catch (e) {
      this.running = false;
      throw new Error('Токен бота не принят: ' + e.message);
    }
    // Сбрасываем накопившиеся старые апдейты, чтобы бот не отвечал на позавчерашние команды
    try {
      const old = await apiCall(this.config.token, 'getUpdates', { offset: -1, timeout: 0 });
      if (old.length) this.offset = old[old.length - 1].update_id + 1;
    } catch { /* не страшно */ }
    this.loop();
  }

  stop() {
    this.running = false;
  }

  async loop() {
    while (this.running) {
      let updates = [];
      try {
        updates = await apiCall(this.config.token, 'getUpdates', { offset: this.offset, timeout: 30 });
      } catch {
        await new Promise((r) => setTimeout(r, 3000)); // сеть/таймаут — подождём и попробуем снова
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        const msg = u.message || u.edited_message;
        if (msg && typeof msg.text === 'string') this.handle(msg).catch(() => {});
      }
    }
  }

  async handle(msg) {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // Логин по паролю
    if (text.startsWith('/login')) {
      const pass = text.slice(6).trim();
      if (this.config.password && pass === this.config.password) {
        this.authorize(chatId);
        await this.reply(chatId, '✅ Доступ открыт. /help — что умею.');
      } else {
        await this.reply(chatId, '❌ Неверный пароль. Напишите: /login ВАШ_ПАРОЛЬ');
      }
      return;
    }

    if (!this.authorized(chatId)) {
      await this.reply(chatId, '🔒 Сначала войдите: /login ВАШ_ПАРОЛЬ');
      return;
    }

    // /команда args…  или просто текст (тогда это оповещение в эфир)
    let cmd;
    let args;
    if (text.startsWith('/')) {
      const sp = text.indexOf(' ');
      cmd = (sp < 0 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
      args = sp < 0 ? '' : text.slice(sp + 1).trim();
      // убрать «@ботимя» из команды в группах
      cmd = cmd.replace(/@.*$/, '');
    } else {
      cmd = 'say';
      args = text;
    }

    if (!this.handler) {
      await this.reply(chatId, 'Станция ещё не готова, попробуйте через пару секунд.');
      return;
    }
    try {
      const answer = await this.handler(cmd, args, chatId);
      if (answer) await this.reply(chatId, answer);
    } catch (e) {
      await this.reply(chatId, '⚠️ ' + (e && e.message ? e.message : 'ошибка'));
    }
  }
}

module.exports = { TelegramBot };
