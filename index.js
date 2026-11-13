  // file: index.js
'use strict';

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const makeWASocket = baileys.default?.default || baileys.default || baileys;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = baileys;

// ==================== КОНФИГУРАЦИЯ ====================
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error('Ошибка: не задана переменная окружения TELEGRAM_TOKEN.');
  process.exit(1);
}

const OWNER_ID = 5846687574;
const SUB_ADMINS = new Set([8264531154]);
const MAX_USERS = 25;
const PAGE_SIZE = 10;
const ADMIN_PAGE_SIZE = 6;
const BROADCAST_DELAY_MS = 18000;
const COLLECTOR_CHECK_DELAY_MS = 2500;
const COLLECTOR_TARGET_LIMIT = 1000;
const COLLECTOR_MAX_DURATION_MS = 24 * 60 * 60 * 1000; // 24 часа
const TG_FILE_LIMIT = 20 * 1024 * 1024;

const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isOwner = (id) => Number(id) === OWNER_ID;
const isSubAdmin = (id) => SUB_ADMINS.has(Number(id));
const isAdmin = (id) => isOwner(id) || (isSubAdmin(id) && !bannedUsers.has(Number(id)));

const INVITE_REGEX = /(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{20,26})/gi;
const TOPIC_REGEX = /(купи|купл|продай|продаж|комиссион|комисион|барахол|объявлен|обьявлен|авито|avito|реклам|ссыл|рынок|доска|рассылк|бесплатн|товар|одежд|опт|розниц|услуг|взаимн|пиар)/i;
const BLACKLIST_REGEX = /(получении прав|водительск|svgroup|казино|ставк|крипт|арбитраж|интим|18\+)/i;

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

function safeTitle(str, len = 30) {
  const clean = String(str || 'Без названия').replace(/[\r\n\t\u200B-\u200D\uFEFF]+/g, ' ').trim();
  return Array.from(clean).slice(0, len).join('') || 'Группа';
}

function downloadBuffer(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 60000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(downloadBuffer(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// ==================== ХРАНИЛИЩЕ И СОСТОЯНИЕ ====================
const sessions = new Map();
const bannedUsers = new Set();
const usersMeta = new Map();
const globalCollectors = new Map(); // chatId -> collector state

const BANNED_FILE = path.join(__dirname, 'banned.json');
const META_FILE = path.join(__dirname, 'users_meta.json');

function readJson(f, def) {
  try {
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (e) {
    console.error('readJson', f, e.message);
  }
  return def;
}

function writeJson(f, d) {
  try {
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf-8');
    fs.renameSync(tmp, f);
  } catch (e) {
    console.error('writeJson', f, e.message);
  }
}

readJson(BANNED_FILE, []).forEach((id) => bannedUsers.add(Number(id)));
Object.entries(readJson(META_FILE, {})).forEach(([k, v]) => usersMeta.set(Number(k), v));

const saveBanned = () => writeJson(BANNED_FILE, [...bannedUsers]);
const saveUsersMeta = () => writeJson(META_FILE, Object.fromEntries(usersMeta));

const getUserExclPath = (id) => path.join(__dirname, `excluded_${id}.json`);
const getUserAuthDir = (id) => path.join(__dirname, `auth_info_${id}`);
const getCollectorPath = (id) => path.join(__dirname, `collector_state_${id}.json`);
const getExportPath = (id) => path.join(__dirname, `open_trade_groups_${id}.txt`);

function loadExcluded(id, s) {
  const arr = readJson(getUserExclPath(id), []);
  if (Array.isArray(arr)) s.excludedGroups = new Set(arr.map(String));
}
const saveExcluded = (id, s) => writeJson(getUserExclPath(id), [...s.excludedGroups]);

const shortId = (gid) => String(gid).replace(/@g\.us$/, '');
const findGroupByShort = (s, sid) => s.groupsCache.find((g) => shortId(g.id) === sid);

function getUserCollector(chatId) {
  const id = Number(chatId);
  if (!globalCollectors.has(id)) {
    const c = {
      isCollecting: false,
      startTime: 0,
      processingQueue: false,
      statusMsgId: null,
      lastUiUpdate: 0,
      stats: { skippedMine: 0, skippedClosed: 0, skippedOffTopic: 0, skippedDead: 0 },
      myGroupJids: new Set(),
      checkedCodes: new Set(),
      pendingQueue: [],
      collected: []
    };
    const raw = readJson(getCollectorPath(id), null);
    if (raw) {
      if (raw.isCollecting) {
        c.isCollecting = true;
        c.startTime = raw.startTime || Date.now();
      }
      if (Array.isArray(raw.checkedCodes)) raw.checkedCodes.forEach((code) => c.checkedCodes.add(String(code)));
      if (Array.isArray(raw.collected)) c.collected = raw.collected;
      if (raw.stats) c.stats = { ...c.stats, ...raw.stats };
    }
    globalCollectors.set(id, c);
  }
  return globalCollectors.get(id);
}

function saveUserCollector(chatId) {
  const id = Number(chatId);
  const c = globalCollectors.get(id);
  if (!c) return;
  writeJson(getCollectorPath(id), {
    isCollecting: c.isCollecting,
    startTime: c.startTime,
    checkedCodes: [...c.checkedCodes],
    collected: c.collected,
    stats: c.stats
  });
}

function extractTextFromWaMessage(msg) {
  if (!msg?.message) return '';
  const m = msg.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  );
}

function isTargetTradeGroup(info) {
  const onlyAdmins = Boolean(info.announce || info.isCommunityAnnounce);
  const joinApproval = Boolean(info.joinApprovalMode || info.membershipApprovalMode);
  const subject = String(info.subject || '').trim();
  const desc = String(info.desc || '').trim();
  const haystack = `${subject} ${desc}`;

  let status = '🟢 ОТКРЫТАЯ';
  if (joinApproval) status = '🟡 ПО ЗАЯВКЕ';

  if (BLACKLIST_REGEX.test(haystack) || !TOPIC_REGEX.test(haystack)) {
    return { ok: false, reason: 'offtopic' };
  }

  return { ok: true, status, onlyAdmins, joinApproval };
}

function getCollectorInlineKeyboard(c) {
  if (c.isCollecting) {
    return {
      inline_keyboard: [
        [{ text: '🛑 Остановиться и получить список', callback_data: 'col_stop_send' }],
        [{ text: '🔄 Обновить статус', callback_data: 'col_refresh' }]
      ]
    };
  }
  return {
    inline_keyboard: [
      [{ text: '▶️ Начать сканирование ссылок (24ч)', callback_data: 'col_start' }],
      [{ text: '📥 Скачать текущий .txt файл', callback_data: 'col_download' }],
      [{ text: '🧹 Очистить базу', callback_data: 'col_clear' }]
    ]
  };
}

function buildCollectorStatusText(chatId) {
  const s = sessions.get(Number(chatId));
  const c = getUserCollector(chatId);
  const waOk = Boolean(s?.isConnected);

  let timeLeftStr = '24 часа';
  if (c.isCollecting && c.startTime > 0) {
    const elapsed = Date.now() - c.startTime;
    const left = Math.max(0, COLLECTOR_MAX_DURATION_MS - elapsed);
    const hours = Math.floor(left / (1000 * 60 * 60));
    const mins = Math.floor((left % (1000 * 60 * 60)) / (1000 * 60));
    timeLeftStr = `${hours}ч ${mins}мин`;
  }

  const modeStr = c.isCollecting
    ? `🟢 Сканирование активнео (Осталось: ${timeLeftStr})`
    : '⏸ ОСТАНОВЛЕН / ЗАВЕРШЕН';

  return (
    `🔍 <b>Сканер ссылок и групп (24 часа)</b>\n` +
    `<i>Тематика: купи-продаи, авито, комиссионки, ссылки</i>\n\n` +
    `Статус WhatsApp: ${waOk ? '🟢 Подключен' : '🔴 Не подключен'}\n` +
    `Статус: <b>${modeStr}</b>\n` +
    `В очереди на проверку: <b>${c.pendingQueue.length}</b>\n\n` +
    `🚫 Авто-фильтр отсеял:\n` +
    `• Своих чатов: ${c.myGroupJids.size}\n` +
    `• Закрытых стен: ${c.stats.skippedClosed}\n` +
    `• Не по теме: ${c.stats.skippedOffTopic}\n` +
    `• Битых ссылок: ${c.stats.skippedDead}\n\n` +
    `📦 <b>Собрано ${c.collected.length} групп из ${COLLECTOR_TARGET_LIMIT}</b>`
  );
}

async function updateCollectorUi(chatId, force = false) {
  const id = Number(chatId);
  const c = getUserCollector(id);
  const now = Date.now();
  if (!force && now - c.lastUiUpdate < 3500) return;
  c.lastUiUpdate = now;

  const text = buildCollectorStatusText(id);
  const reply_markup = getCollectorInlineKeyboard(c);

  if (c.statusMsgId) {
    try {
      await bot.editMessageText(text, {
        chat_id: id,
        message_id: c.statusMsgId,
        parse_mode: 'HTML',
        reply_markup
      });
      return;
    } catch (e) {
      if (String(e?.message || '').includes('message is not modified')) return;
    }
  }

  const sent = await bot.sendMessage(id, text, {
    parse_mode: 'HTML',
    reply_markup
  }).catch(() => null);

  if (sent) c.statusMsgId = sent.message_id;
}

function buildCollectorTxtContent(chatId) {
  const c = getUserCollector(chatId);
  const sorted = [...c.collected].sort((a, b) => (b.size || 0) - (a.size || 0));
  const lines = [
    `📊 ОТЧЕТ ПО ГРУППАМ WHATSAPP`,
    `Всего собрано: ${sorted.length} из ${COLLECTOR_TARGET_LIMIT}`,
    `Дата формирования: ${new Date().toLocaleString('ru-RU')}`,
    `==================================================`,
    ``
  ];

  for (let i = 0; i < sorted.length; i++) {
    const g = sorted[i];
    lines.push(`${i + 1}. Название: ${g.subject}`);
    lines.push(`Участников: ${g.size}`);
    lines.push(`Статус: ${g.status}`);
    lines.push(`Ссылка: ${g.link}`);
    lines.push(`--------------------------------------------------`);
  }

  return lines.join('\n');
}

async function sendCollectorTxtFile(chatId, captionPrefix) {
  const id = Number(chatId);
  const c = getUserCollector(id);
  if (!c.collected.length) {
    return bot.sendMessage(id, '📭 Список пока пуст — ещё не найдено ни одной подходящей группы.').catch(() => {});
  }

  const exportPath = getExportPath(id);
  const txt = buildCollectorTxtContent(id);
  fs.writeFileSync(exportPath, txt, 'utf-8');

  await bot.sendDocument(id, exportPath, {
    caption: `${captionPrefix}\n✅ Всего групп в файле: ${c.collected.length} шт.`
  }).catch((e) => console.error('sendCollectorTxtFile error:', e.message));

  try { fs.unlinkSync(exportPath); } catch (_) {}
}

function enqueueInviteCodesForUser(chatId, text) {
  const c = getUserCollector(chatId);
  if (!text || !c.isCollecting) return;

  if (c.startTime > 0 && Date.now() - c.startTime >= COLLECTOR_MAX_DURATION_MS) {
    c.isCollecting = false;
    saveUserCollector(chatId);
    updateCollectorUi(chatId, true);
    sendCollectorTxtFile(chatId, `⏰ Время сканирования (24 часа) истекло! Собрано ${c.collected.length} групп.`);
    return;
  }

  INVITE_REGEX.lastIndex = 0;
  let match;
  let added = false;

  while ((match = INVITE_REGEX.exec(text)) !== null) {
    const code = match[1].trim();
    if (code.length >= 20 && !c.checkedCodes.has(code) && !c.pendingQueue.includes(code)) {
      c.pendingQueue.push(code);
      added = true;
    }
  }

  if (added) {
    processUserCollectorQueue(chatId);
  }
}

async function processUserCollectorQueue(chatId) {
  const id = Number(chatId);
  const c = getUserCollector(id);
  if (c.processingQueue) return;
  c.processingQueue = true;

  try {
    while (c.pendingQueue.length > 0 && c.isCollecting) {
      if (c.startTime > 0 && Date.now() - c.startTime >= COLLECTOR_MAX_DURATION_MS) {
        c.isCollecting = false;
        saveUserCollector(id);
        await updateCollectorUi(id, true);
        await sendCollectorTxtFile(id, `⏰ Время сканирования (24 часа) истекло! Собрано ${c.collected.length} групп.`);
        break;
      }

      const s = sessions.get(id);
      if (!s || !s.isConnected || !s.sock) break;

      const code = c.pendingQueue.shift();
      if (!code || c.checkedCodes.has(code)) continue;

      c.checkedCodes.add(code);

      try {
        const info = await s.sock.groupGetInviteInfo(code);
        if (info && info.id) {
          const gid = String(info.id);

          if (c.myGroupJids.has(gid)) {
            c.stats.skippedMine++;
            saveUserCollector(id);
            await updateCollectorUi(id, false);
            await sleep(COLLECTOR_CHECK_DELAY_MS);
            continue;
          }

          if (c.collected.some((item) => item.id === gid)) {
            saveUserCollector(id);
            await sleep(COLLECTOR_CHECK_DELAY_MS);
            continue;
          }

          const check = isTargetTradeGroup(info);
          if (!check.ok) {
            if (check.reason === 'closed') c.stats.skippedClosed++;
            else c.stats.skippedOffTopic++;
            saveUserCollector(id);
            await updateCollectorUi(id, false);
            await sleep(COLLECTOR_CHECK_DELAY_MS);
            continue;
          }

          const subject = String(info.subject || 'Без названия').replace(/[\r\n\t]+/g, ' ').trim();
          const size = Number(info.size || info.participants?.length || 0);

          c.collected.push({
            code,
            id: gid,
            subject,
            size,
            status: check.status,
            link: `https://chat.whatsapp.com/${code}`
          });

          saveUserCollector(id);
          await updateCollectorUi(id, false);

          if (c.collected.length >= COLLECTOR_TARGET_LIMIT) {
            c.isCollecting = false;
            saveUserCollector(id);
            await updateCollectorUi(id, true);
            await sendCollectorTxtFile(id, `🎯 Задание выполнено! Собрано ровно ${c.collected.length} групп (лимит 1000 достигнут).`);
            break;
          }
        }
      } catch (_) {
        c.stats.skippedDead++;
        saveUserCollector(id);
        await updateCollectorUi(id, false);
      }

      await sleep(COLLECTOR_CHECK_DELAY_MS);
    }
  } finally {
    c.processingQueue = false;
  }
}

// ==================== СЕССИИ ПОЛЬЗОВАТЕЛЕЙ ====================
function getUserSession(chatId) {
  const id = Number(chatId);
  if (!sessions.has(id)) {
    const meta = usersMeta.get(id) || {};
    const s = {
      sock: null,
      isConnected: false,
      wasEverConnected: false,
      isConnecting: false,
      isStopped: false,
      isBroadcasting: false,
      stopBroadcast: false,
      pairingSent: false,
      pairAttempts: 0,
      lastPairingCode: '',
      phoneNumber: null,
      forceQr: false,
      qrCount: 0,
      groupsCache: [],
      excludedGroups: new Set(),
      step: 'IDLE',
      exclState: { mode: 'm', onlyExcl: false, query: '', page: 0, msgId: null },
      draft: { type: 'text', text: '', fileId: null },
      reconnectTimer: null,
      name: meta.name || '',
      username: meta.username || '',
      notifiedOwner: Boolean(meta.notifiedOwner)
    };
    loadExcluded(id, s);
    sessions.set(id, s);
  }
  return sessions.get(id);
}

function updateUserInfo(msg) {
  if (!msg?.from) return;
  const id = Number(msg.chat.id);
  const s = getUserSession(id);
  const name = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || 'Без имени';
  const username = msg.from.username ? `@${msg.from.username}` : '';
  if (s.name !== name || s.username !== username) {
    s.name = name;
    s.username = username;
    usersMeta.set(id, { name, username, notifiedOwner: s.notifiedOwner });
    saveUsersMeta();
  }
}

function countConnectedClients() {
  let c = 0;
  for (const [id, s] of sessions.entries()) {
    if (!isOwner(id) && !isSubAdmin(id) && s.isConnected) c++;
  }
  return c;
}

// ==================== EXPRESS & TELEGRAM ====================
const app = express();
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', clients: countConnectedClients(), max: MAX_USERS });
});
const server = app.listen(PORT, '0.0.0.0', () => {});

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: { autoStart: false, params: { timeout: 30 } } });
let pollTimer = null;

async function startPolling() {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    await bot.startPolling();
  } catch (e) {
    console.error('startPolling', e.message);
  }
}

bot.on('polling_error', async (err) => {
  const m = err?.message || '';
  if ((m.includes('409') || m.includes('EFATAL') || m.includes('ETIMEDOUT')) && !pollTimer) {
    try { await bot.stopPolling(); } catch (_) {}
    pollTimer = setTimeout(() => { pollTimer = null; startPolling(); }, 4000);
  }
});

process.on('SIGTERM', () => { bot.stopPolling().catch(() => {}); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { bot.stopPolling().catch(() => {}); server.close(() => process.exit(0)); });

// ==================== МЕНЮ И КЛАВИАТУРЫ ====================
const MENU_BUTTONS = new Set([
  'Войти в аккаунт', 'Список групп', 'Обновить список групп',
  'Список исключение', 'Список исключений', '📦 Выгрузить мои группы',
  '🔍 Сканировать ссылки (24ч)', 'Выйти из ватсап', '👑 Админ-панель'
]);

function getMainMenuKeyboard(chatId) {
  const kb = [
    [{ text: 'Войти в аккаунт' }, { text: 'Список групп' }],
    [{ text: '🔍 Сканировать ссылки (24ч)' }, { text: '📦 Выгрузить мои группы' }],
    [{ text: 'Обновить список групп' }, { text: 'Выйти из ватсап' }]
  ];
  if (isAdmin(chatId)) {
    kb.push([{ text: '👑 Админ-панель' }]);
  }
  return { reply_markup: { keyboard: kb, resize_keyboard: true } };
}

function getBroadcastMenuKeyboard(s) {
  if (s && s.isBroadcasting) {
    return { inline_keyboard: [[{ text: '🛑 Остановить рассылку', callback_data: 'b_stop' }]] };
  }
  return {
    inline_keyboard: [
      [{ text: '🎯 Отправить в 1 группу', callback_data: 'b_one_page:0' }],
      [{ text: '🎲 Отправить в 10 групп (случайно)', callback_data: 'b_rand10' }],
      [{ text: '📢 Отправить во все кроме исключенных', callback_data: 'b_all' }],
      [{ text: '🚫 Настроить исключения', callback_data: 'excl_open:b' }]
    ]
  };
}

function getVisibleUserIds(viewerId) {
  const viewer = Number(viewerId);
  const all = new Set([...sessions.keys(), ...bannedUsers, ...usersMeta.keys(), ...SUB_ADMINS]);
  all.delete(OWNER_ID);
  all.delete(viewer);
  if (!isOwner(viewer)) SUB_ADMINS.forEach((id) => all.delete(id));
  return [...all].sort((a, b) => a - b);
}

function buildAdminView(viewerId, page = 0) {
  const ids = getVisibleUserIds(viewerId);
  const pages = Math.max(1, Math.ceil(ids.length / ADMIN_PAGE_SIZE));
  const cur = Math.min(Math.max(0, page), pages - 1);
  const slice = ids.slice(cur * ADMIN_PAGE_SIZE, (cur + 1) * ADMIN_PAGE_SIZE);
  const vs = sessions.get(Number(viewerId));

  let t = `👑 Панель (${isOwner(viewerId) ? 'Главный Создатель' : 'Админ'})\n`;
  t += `Твой WA: ${vs?.isConnected ? `🟢 (${vs.groupsCache.length} гр.)` : '🔴'}\n`;
  t += `Слоты клиентов: ${countConnectedClients()}/${MAX_USERS}\n`;
  t += `Пользователей: ${ids.length} | Стр. ${cur + 1}/${pages}\n\n`;
  if (!ids.length) t += 'Пользователей пока нет.';

  const rows = [];
  for (const id of slice) {
    const s = sessions.get(id), m = usersMeta.get(id) || {};
    const banned = bannedUsers.has(id), conn = Boolean(s?.isConnected);
    const st = banned ? '🚫 БАН' : conn ? `🟢 (${s.groupsCache.length} гр.)${s.isBroadcasting ? ' 📤' : ''}` : '🔴 Офф';
    t += `• ${isSubAdmin(id) ? '⭐️ ' : ''}${safeTitle(s?.name || m.name || 'Без имени', 18)} ${s?.username || m.username || ''} [${id}] — ${st}\n`;

    const name = safeTitle(s?.name || m.name || `ID:${id}`, 15);
    rows.push([{ text: `${banned ? '🚫' : conn ? '🟢' : '🔴'} ${isSubAdmin(id) ? '⭐️ ' : ''}${name} (${id})`, callback_data: 'noop' }]);
    const act = [];
    if (banned) {
      act.push({ text: '✅ Разбан', callback_data: `adm_unban:${id}:${cur}` });
    } else {
      if (conn) act.push({ text: '🔌 Кик WA', callback_data: `adm_kick:${id}:${cur}` });
      if (s?.isBroadcasting) act.push({ text: '🛑 Стоп рассылки', callback_data: `adm_stopbc:${id}:${cur}` });
      act.push({ text: '🔨 Бан', callback_data: `adm_ban:${id}:${cur}` }, { text: '🔄 Сброс', callback_data: `adm_reset:${id}:${cur}` });
    }
    act.push({ text: '🗑 Удалить', callback_data: `adm_del:${id}:${cur}` });
    rows.push(act);
  }

  if (pages > 1) {
    const nav = [];
    if (cur > 0) nav.push({ text: '⬅️', callback_data: `adm_pg:${cur - 1}` });
    nav.push({ text: `${cur + 1}/${pages}`, callback_data: 'noop' });
    if (cur < pages - 1) nav.push({ text: '➡️', callback_data: `adm_pg:${cur + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: '📢 Написать всем', callback_data: 'adm_msg_all' }, { text: '🔄 Обновить', callback_data: `adm_pg:${cur}` }]);
  return { text: t.slice(0, 4000), reply_markup: { inline_keyboard: rows } };
}

function buildSingleGroupKeyboard(s, page = 0) {
  const avail = s.groupsCache.filter((g) => !s.excludedGroups.has(String(g.id)));
  const pages = Math.max(1, Math.ceil(avail.length / PAGE_SIZE));
  const cur = Math.min(Math.max(0, page), pages - 1);
  const rows = avail.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE).map((g) => [
    { text: `${g.closed ? '🔒' : '💬'} ${safeTitle(g.subject, 28)} · ${g.size}`, callback_data: `send_one:${shortId(g.id)}` }
  ]);
  const nav = [];
  if (cur > 0) nav.push({ text: '⏮ 1', callback_data: 'b_one_page:0' });
  if (cur > 0) nav.push({ text: '⏪ -5', callback_data: `b_one_page:${Math.max(0, cur - 5)}` });
  if (cur > 0) nav.push({ text: '⬅️', callback_data: `b_one_page:${cur - 1}` });
  nav.push({ text: `${cur + 1}/${pages}`, callback_data: 'noop' });
  if (cur < pages - 1) nav.push({ text: '➡️', callback_data: `b_one_page:${cur + 1}` });
  if (cur < pages - 1) nav.push({ text: '+5 ⏩', callback_data: `b_one_page:${Math.min(pages - 1, cur + 5)}` });
  if (cur < pages - 1) nav.push({ text: `⏭ ${pages}`, callback_data: `b_one_page:${pages - 1}` });
  rows.push(nav, [{ text: '🔙 Назад', callback_data: 'b_back' }]);
  return { inline_keyboard: rows };
}

async function renderExclusionsMenu(chatId, s, patch = {}) {
  const st = { ...s.exclState, ...patch };
  st.query = String(st.query || '').trim().toLowerCase();
  st.onlyExcl = Boolean(st.onlyExcl);

  let filtered = s.groupsCache;
  if (st.query) filtered = filtered.filter((g) => g.subject.toLowerCase().includes(st.query));
  if (st.onlyExcl) filtered = filtered.filter((g) => s.excludedGroups.has(String(g.id)));

  const totalAll = s.groupsCache.length;
  const exclCount = s.groupsCache.filter((g) => s.excludedGroups.has(String(g.id))).length;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const cur = Math.min(Math.max(0, Number(st.page) || 0), pages - 1);
  st.page = cur;
  s.exclState = st;

  const slice = filtered.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE);
  const rows = slice.map((g) => {
    const ex = s.excludedGroups.has(String(g.id));
    return [{
      text: `${ex ? '🚫' : '✅'} ${safeTitle(g.subject, 26)} · ${g.size}`,
      callback_data: `excl_tog:${shortId(g.id)}`
    }];
  });

  if (pages > 1) {
    const nav = [];
    if (cur > 0) nav.push({ text: '⏮ 1', callback_data: 'excl_pg:0' });
    if (cur > 0) nav.push({ text: '⏪ -5', callback_data: `excl_pg:${Math.max(0, cur - 5)}` });
    if (cur > 0) nav.push({ text: '⬅️', callback_data: `excl_pg:${cur - 1}` });
    nav.push({ text: `${cur + 1}/${pages}`, callback_data: 'noop' });
    if (cur < pages - 1) nav.push({ text: '➡️', callback_data: `excl_pg:${cur + 1}` });
    if (cur < pages - 1) nav.push({ text: '+5 ⏩', callback_data: `excl_pg:${Math.min(pages - 1, cur + 5)}` });
    if (cur < pages - 1) nav.push({ text: `⏭ ${pages}`, callback_data: `excl_pg:${pages - 1}` });
    rows.push(nav);
  }

  const toolsRow = [{ text: '🔍 Поиск группы', callback_data: 'excl_search' }];
  if (st.query) toolsRow.push({ text: '❌ Сбросить поиск', callback_data: 'excl_rq' });
  rows.push(toolsRow);
  rows.push([{
    text: st.onlyExcl ? '📋 Показать все' : `🚫 Только исключённые (${exclCount})`,
    callback_data: `excl_flt:${st.onlyExcl ? 0 : 1}`
  }]);
  if (exclCount > 0) rows.push([{ text: `🗑 Очистить все исключения (${exclCount})`, callback_data: 'excl_clear' }]);
  if (st.mode === 'b') rows.push([{ text: '🔙 Назад к рассылке', callback_data: 'b_back' }]);

  let header = `🚫 Настройка исключений\nВсего групп: ${totalAll} | В исключениях: ${exclCount}`;
  if (st.query) header += `\n🔍 Поиск: «${safeTitle(st.query, 25)}» (найдено: ${filtered.length})`;
  if (st.onlyExcl) header += `\n📋 Показаны только исключённые`;
  header += `\nСтраница: ${cur + 1} из ${pages}\n✅ — получит рассылку, 🚫 — исключена. Нажми на группу, чтобы переключить.`;

  const reply_markup = { inline_keyboard: rows };

  if (st.msgId) {
    try {
      await bot.editMessageText(header, { chat_id: chatId, message_id: st.msgId, reply_markup });
      return;
    } catch (err) {
      if (String(err?.message || '').includes('not modified')) return;
    }
  }
  const sent = await bot.sendMessage(chatId, header, { reply_markup }).catch(() => null);
  if (sent) s.exclState.msgId = sent.message_id;
}

// ==================== СОКЕТЫ WHATSAPP ====================
function destroySocket(s) {
  if (!s) return;
  s.isStopped = true;
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  if (s.sock) { try { s.sock.ev.removeAllListeners(); s.sock.ws.close(); } catch (_) {} s.sock = null; }
  s.isConnected = false;
  s.isConnecting = false;
}

function clearUserAuthFolder(id) {
  try {
    const d = getUserAuthDir(id);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  } catch (_) {}
}

const normJid = (j) => String(j || '').split(':')[0].split('@')[0];

async function refreshGroupsCache(s, chatId = null) {
  if (!s.sock || !s.isConnected) throw new Error('WA не подключен');
  const p = await s.sock.groupFetchAllParticipating();
  const u = s.sock.user || {};
  const mine = new Set([u.id, u.lid, u.phoneNumber, u.jid].filter(Boolean).map(normJid));

  const rawGroups = Object.values(p);
  const resolved = [];

  if (chatId) {
    const c = getUserCollector(chatId);
    c.myGroupJids = new Set(rawGroups.map((g) => String(g.id)));
  }

  for (const g of rawGroups) {
    const jid = String(g.id);
    let subject = (g.subject || '').trim();
    let parts = Array.isArray(g.participants) ? g.participants : [];
    let size = Number(g.size) || parts.length || 0;
    let onlyAdminsWrite = Boolean(g.announce || g.isCommunityAnnounce);

    if (!subject) {
      try {
        const meta = await s.sock.groupMetadata(jid);
        if (meta) {
          subject = (meta.subject || '').trim();
          if (Array.isArray(meta.participants) && meta.participants.length) parts = meta.participants;
          size = Number(meta.size) || parts.length || size;
          onlyAdminsWrite = Boolean(meta.announce || meta.isCommunityAnnounce);
        }
      } catch (_) {}
    }

    const me = parts.find((x) => [x.id, x.lid, x.phoneNumber, x.jid].some((v) => v && mine.has(normJid(v))));
    const iAmAdmin = Boolean(me && (me.admin === 'admin' || me.admin === 'superadmin' || me.admin === true));

    resolved.push({
      id: jid,
      subject: subject || `Группа (${shortId(jid).slice(-6)})`,
      size,
      iAmAdmin,
      closed: onlyAdminsWrite && Boolean(me) && !iAmAdmin,
      onlyAdminsWrite
    });
  }

  s.groupsCache = resolved.sort((a, b) => (b.size - a.size) || a.subject.localeCompare(b.subject, 'ru'));
  return s.groupsCache;
}

async function ensureGroupsLoaded(id, s) {
  if (!s.excludedGroups.size) loadExcluded(id, s);
  if (!s.groupsCache.length && s.isConnected) {
    try { await refreshGroupsCache(s, id); } catch (e) { console.error('ensureGroupsLoaded', e.message); }
  }
}

async function exportUserGroupsReport(chatId, s) {
  if (!s.sock || !s.isConnected) {
    return bot.sendMessage(chatId, '❌ Сначала подключите WhatsApp.').catch(() => {});
  }

  const waitMsg = await bot.sendMessage(chatId, '⏳ Собираю актуальный список ваших групп...').catch(() => null);

  try {
    await refreshGroupsCache(s, chatId);
    if (!s.groupsCache.length) {
      if (waitMsg) await bot.editMessageText('📭 У вас нет активных групп.', { chat_id: chatId, message_id: waitMsg.message_id }).catch(() => {});
      return;
    }

    const clientLabel = `${s.name || 'Пользователь'} ${s.username || ''} [${chatId}]`.trim();
    const lines = [
      `📊 Отчет по группам аккаунта`,
      `Клиент: ${clientLabel}`,
      `Всего групп: ${s.groupsCache.length}`,
      `Дата: ${new Date().toLocaleString('ru-RU')}`,
      `==================================================`,
      ``
    ];

    for (let i = 0; i < s.groupsCache.length; i++) {
      const g = s.groupsCache[i];
      let title = g.subject;
      let linkInfo = '';

      try {
        const code = await s.sock.groupInviteCode(g.id);
        if (code) linkInfo = `https://chat.whatsapp.com/${code}`;
      } catch (err) {
        linkInfo = `Недоступна (JID: ${g.id})`;
      }

      const statusText = g.closed ? '🔒 ЗАКРЫТАЯ' : '🟢 ОТКРЫТАЯ';

      lines.push(`${i + 1}. ${title}`);
      lines.push(`Участников: ${g.size}`);
      lines.push(`Статус: ${statusText}`);
      lines.push(`Ссылка: ${linkInfo}`);
      lines.push(`--------------------------------------------------`);
      await sleep(100);
    }

    const filePath = path.join(__dirname, `groups_${chatId}.txt`);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

    if (waitMsg) await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    await bot.sendDocument(chatId, filePath, { caption: `✅ Выгружено групп: ${s.groupsCache.length} шт.` });
    try { fs.unlinkSync(filePath); } catch (_) {}
  } catch (e) {
    if (waitMsg) await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: waitMsg.message_id }).catch(() => {});
  }
}

async function sendQrCode(id, qr, caption) {
  try {
    const buf = await QRCode.toBuffer(qr, { scale: 8, margin: 2 });
    await bot.sendPhoto(id, buf, { caption });
  } catch (e) { console.error('sendQrCode', e.message); }
}

async function sendPairingCodeMessage(id, s, rawCode) {
  const cleanCode = String(rawCode || '').replace(/[^a-zA-Z0-9]/g, '');
  s.lastPairingCode = cleanCode;
  const htmlText =
    `🔐 <b>Код для входа в WhatsApp:</b>\n\n` +
    `👉 <code>${cleanCode}</code> 👈\n\n` +
    `1. Откройте WhatsApp -> <b>Связанные устройства</b> -> <b>Привязка устройства</b>.\n` +
    `2. Введите этот код.`;

  await bot.sendMessage(id, htmlText, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Скопировать код', copy_text: { text: cleanCode } }],
        [{ text: '📷 Войти по QR-коду', callback_data: 'force_qr' }]
      ]
    }
  }).catch(() => {});
}

async function startWhatsAppSession(chatId, opts = {}) {
  const id = Number(chatId);
  const s = getUserSession(id);
  if (opts.reset) {
    destroySocket(s);
    clearUserAuthFolder(id);
    s.pairingSent = false;
    s.pairAttempts = 0;
    s.qrCount = 0;
    s.phoneNumber = opts.phoneNumber || null;
    s.forceQr = Boolean(opts.forceQr);
  }
  if (s.isConnecting) return;
  s.isConnecting = true;
  s.isStopped = false;

  try {
    if (s.sock) { try { s.sock.ev.removeAllListeners(); s.sock.ws.close(); } catch (_) {} s.sock = null; }

    const { state, saveCreds } = await useMultiFileAuthState(getUserAuthDir(id));
    let version = [2, 3000, 1015901307];
    try { const l = await fetchLatestBaileysVersion(); if (l?.version) version = l.version; } catch (_) {}

    const sock = makeWASocket({
      version,
      logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      markOnlineOnConnect: false,
      syncFullHistory: true, // Включаем синхронизацию истории для поиска ссылок у всех
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined
    });

    s.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    // Подключаем сканер ссылок для каждого зашедшего участника
    sock.ev.on('messaging-history.set', ({ messages }) => {
      const c = getUserCollector(id);
      if (!c.isCollecting || !Array.isArray(messages)) return;
      for (const m of messages) {
        const txt = extractTextFromWaMessage(m);
        if (txt) enqueueInviteCodesForUser(id, txt);
      }
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      const c = getUserCollector(id);
      if (!c.isCollecting || !Array.isArray(messages)) return;
      for (const m of messages) {
        const txt = extractTextFromWaMessage(m);
        if (txt) enqueueInviteCodesForUser(id, txt);
      }
    });

    sock.ev.on('groups.upsert', (newGroups) => {
      const c = getUserCollector(id);
      if (Array.isArray(newGroups)) {
        for (const g of newGroups) {
          if (g?.id) c.myGroupJids.add(String(g.id));
        }
      }
    });

    sock.ev.on('connection.update', async (upd) => {
      if (s.isStopped || s.sock !== sock) return;
      const { connection, lastDisconnect, qr } = upd;

      if (qr && !state.creds.registered) {
        if (s.phoneNumber && !s.forceQr) {
          if (!s.pairingSent) {
            s.pairingSent = true;
            try {
              await sleep(1000);
              const raw = await sock.requestPairingCode(s.phoneNumber);
              await sendPairingCodeMessage(id, s, raw);
            } catch (e) {
              s.forceQr = true;
              await sendQrCode(id, qr, '⚠️ QR-код:');
            }
          }
        } else {
          s.qrCount++;
          if (s.qrCount <= 3) await sendQrCode(id, qr, `📷 QR-код (${s.qrCount}/3):`);
        }
      }

      if (connection === 'open') {
        s.isConnected = true;
        s.wasEverConnected = true;
        s.isConnecting = false;
        s.pairingSent = false;
        s.pairAttempts = 0;
        s.phoneNumber = null;
        s.qrCount = 0;
        loadExcluded(id, s);

        try { await refreshGroupsCache(s, id); } catch (_) {}

        await bot.sendMessage(id, `✅ WhatsApp подключен! Групп: ${s.groupsCache.length}`, getMainMenuKeyboard(id)).catch(() => {});

        const c = getUserCollector(id);
        if (c.isCollecting) {
          c.statusMsgId = null;
          await updateCollectorUi(id, true);
          if (c.pendingQueue.length > 0) processUserCollectorQueue(id);
        }
      }

      if (connection === 'close') {
        const wasConn = s.wasEverConnected;
        s.isConnected = false;
        s.isConnecting = false;
        if (s.isStopped) return;
        const code = lastDisconnect?.error?.output?.statusCode;
        const msg = String(lastDisconnect?.error?.message || '');

        if (code === DisconnectReason.loggedOut || code === 401 || code === 403 || msg.includes('Bad MAC')) {
          destroySocket(s);
          clearUserAuthFolder(id);
          s.groupsCache = [];
          if (wasConn) await bot.sendMessage(id, '🔴 Сессия WhatsApp завершена.', getMainMenuKeyboard(id)).catch(() => {});
          return;
        }

        const registered = Boolean(state?.creds?.registered);
        if (registered || code === DisconnectReason.restartRequired || code === 515) {
          s.reconnectTimer = setTimeout(() => {
            if (!s.isStopped) startWhatsAppSession(id, { reset: false });
          }, 4000);
        } else {
          destroySocket(s);
          clearUserAuthFolder(id);
          if (!wasConn) await bot.sendMessage(id, '⚠️ Не удалось войти. Нажми «Войти в аккаунт».', getMainMenuKeyboard(id)).catch(() => {});
        }
      }
    });
  } catch (e) {
    s.isConnecting = false;
    console.error('startWhatsAppSession', e);
  }
}

// ==================== РАССЫЛКА ====================
function shortErr(e) {
  return String(e?.output?.payload?.message || e?.message || e || 'unknown').replace(/\s+/g, ' ').slice(0, 70);
}

async function waitConnected(s, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (s.stopBroadcast) return false;
    if (s.isConnected && s.sock) return true;
    if (s.isStopped) return false;
    await sleep(1000);
  }
  return Boolean(s.isConnected && s.sock);
}

async function interruptibleSleep(s, ms) {
  const steps = Math.ceil(ms / 1000);
  for (let w = 0; w < steps; w++) {
    if (s.stopBroadcast) return;
    await sleep(1000);
  }
}

function buildWaContent(draft, buf) {
  const caption = draft.text && draft.text.trim() ? draft.text : undefined;
  if (draft.type === 'photo') return { image: buf, caption };
  if (draft.type === 'video') {
    const c = { video: buf, caption, mimetype: draft.mime || 'video/mp4' };
    if (draft.gif) c.gifPlayback = true;
    return c;
  }
  return { text: draft.text };
}

async function sendToGroup(s, jid, content) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await waitConnected(s, 90000))) throw new Error('WhatsApp отключён');
    try {
      return await s.sock.sendMessage(jid, content);
    } catch (e) {
      lastErr = e;
      const m = shortErr(e);
      if (!/rate-overlimit|timeout|connection closed/i.test(m) || attempt === 1) break;
      await interruptibleSleep(s, 30000);
      if (s.stopBroadcast) break;
    }
  }
  throw lastErr;
}

async function broadcastMessage(chatId, s, target) {
  if (!s.sock || !s.isConnected) return bot.sendMessage(chatId, '❌ WhatsApp не подключен.').catch(() => {});
  if (s.isBroadcasting) return bot.sendMessage(chatId, '⏳ Рассылка уже идёт!').catch(() => {});

  const draft = { ...s.draft };
  if (draft.type === 'text' && (!draft.text || !draft.text.trim())) return bot.sendMessage(chatId, '⚠️ Пустой текст.').catch(() => {});

  s.isBroadcasting = true;
  s.stopBroadcast = false;
  const stopKb = { inline_keyboard: [[{ text: '🛑 Остановить рассылку', callback_data: 'b_stop' }]] };
  let ok = 0, fail = 0, closedCount = 0;
  let statusMsg = null;

  try {
    try { await refreshGroupsCache(s, chatId); } catch (_) {}
    let pool = s.groupsCache;
    if (target.mode === 'one') pool = pool.filter((g) => shortId(g.id) === target.sid);
    else pool = pool.filter((g) => !s.excludedGroups.has(String(g.id)));

    if (!pool.length) return await bot.sendMessage(chatId, '⚠️ Нет групп для рассылки.').catch(() => {});

    let open = pool.filter((g) => !g.closed);
    closedCount = pool.length - open.length;

    if (target.mode === 'rand') {
      for (let i = open.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [open[i], open[j]] = [open[j], open[i]]; }
      open = open.slice(0, target.n || 10);
    }

    if (!open.length) return await bot.sendMessage(chatId, '⚠️ Нет открытых для отправки групп.').catch(() => {});

    statusMsg = await bot.sendMessage(chatId, `⏳ Начинаю рассылку: ${open.length} групп...`, { reply_markup: stopKb }).catch(() => null);

    let buf = null;
    if (draft.type === 'photo' || draft.type === 'video') {
      const link = await bot.getFileLink(draft.fileId);
      buf = await downloadBuffer(link);
    }
    const content = buildWaContent(draft, buf);

    for (let i = 0; i < open.length; i++) {
      if (s.stopBroadcast) break;
      const g = open[i];
      try {
        await sendToGroup(s, g.id, content);
        ok++;
      } catch (e) {
        fail++;
      }
      if (statusMsg) {
        bot.editMessageText(`📤 Рассылка: ${i + 1}/${open.length}\n✅ Успешно: ${ok} | ❌ Ошибок: ${fail}`, {
          chat_id: chatId, message_id: statusMsg.message_id, reply_markup: stopKb
        }).catch(() => {});
      }
      if (i < open.length - 1 && !s.stopBroadcast) await interruptibleSleep(s, BROADCAST_DELAY_MS);
    }

    await bot.sendMessage(chatId, `✅ Рассылка завершена!\nУспешно: ${ok} | Ошибок: ${fail}`).catch(() => {});
  } finally {
    s.isBroadcasting = false;
    s.stopBroadcast = false;
  }
}

async function sendDraftPreview(chatId, s, msgId = null) {
  const txt = `📝 Сообщение сохранено.\n\n👇 Выберите режим рассылки:`;
  if (msgId) return bot.editMessageText(txt, { chat_id: chatId, message_id: msgId, reply_markup: getBroadcastMenuKeyboard(s) }).catch(() => {});
  return bot.sendMessage(chatId, txt, { reply_markup: getBroadcastMenuKeyboard(s) }).catch(() => {});
}

// ==================== TELEGRAM HANDLERS ====================
bot.onText(/^\/start/, async (msg) => {
  const id = Number(msg.chat.id);
  updateUserInfo(msg);
  if (bannedUsers.has(id) && !isOwner(id)) return bot.sendMessage(id, '⛔ Доступ закрыт.').catch(() => {});
  const s = getUserSession(id);
  s.step = 'IDLE';
  await ensureGroupsLoaded(id, s);

  if (!isOwner(id) && !s.notifiedOwner) {
    s.notifiedOwner = true;
    usersMeta.set(id, { name: s.name, username: s.username, notifiedOwner: true });
    saveUsersMeta();
    bot.sendMessage(OWNER_ID, `🔔 Новый участник вошел в бота: ${s.name} ${s.username} [${id}]`).catch(() => {});
  }

  let t = `👋 Добро пожаловать!\n\n` +
          `Статус WA: ${s.isConnected ? '🟢 Подключен' : '🔴 Не подключен'}\n` +
          `Групп найдено: ${s.groupsCache.length}\n\n` +
          `🔍 Нажмите <b>«🔍 Сканировать ссылки (24ч)»</b>, чтобы запустить поиск открытых групп (купи-продай, авито, комиссионки, ссылочные).\n\n` +
          `Или отправьте текст, фото/видео для рассылки:`;

  await bot.sendMessage(id, t, { parse_mode: 'HTML', ...getMainMenuKeyboard(id) }).catch(() => {});
});

bot.on('message', async (msg) => {
  try {
    const id = Number(msg.chat.id);
    const text = msg.text ? msg.text.trim() : '';
    if (text.startsWith('/start')) return;
    updateUserInfo(msg);
    if (bannedUsers.has(id) && !isOwner(id)) return bot.sendMessage(id, '⛔ Доступ закрыт.').catch(() => {});

    const s = getUserSession(id);
    if (MENU_BUTTONS.has(text)) s.step = 'IDLE';

    if (text === '🔍 Сканировать ссылки (24ч)') {
      const c = getUserCollector(id);
      c.statusMsgId = null;
      return updateCollectorUi(id, true);
    }

    if (text === '👑 Админ-панель') {
      if (!isAdmin(id)) return;
      const v = buildAdminView(id, 0);
      return bot.sendMessage(id, v.text, { reply_markup: v.reply_markup }).catch(() => {});
    }

    if (text === '📦 Выгрузить мои группы') {
      if (!s.isConnected) return bot.sendMessage(id, '🔴 Сначала подключите WhatsApp.').catch(() => {});
      return exportUserGroupsReport(id, s);
    }

    if (text === 'Войти в аккаунт') {
      if (s.isConnected) return bot.sendMessage(id, '🟢 Уже подключен!', getMainMenuKeyboard(id)).catch(() => {});
      s.step = 'AWAITING_PHONE';
      return bot.sendMessage(id, '📱 Введите номер телефона WhatsApp начиная с 7 (например: 79298892099):', {
        reply_markup: { inline_keyboard: [[{ text: '📷 Войти по QR-коду', callback_data: 'force_qr' }]] }
      }).catch(() => {});
    }

    if (text === 'Список групп') {
      if (!s.isConnected) return bot.sendMessage(id, '🔴 WhatsApp не подключен.').catch(() => {});
      await ensureGroupsLoaded(id, s);
      if (!s.groupsCache.length) return bot.sendMessage(id, '📭 Групп нет.').catch(() => {});
      let chunk = `📋 Ваши группы (${s.groupsCache.length}):\n\n`;
      for (let i = 0; i < s.groupsCache.length; i++) {
        const g = s.groupsCache[i];
        const line = `${i + 1}. ${g.subject} (${g.size})\n`;
        if ((chunk + line).length > 3800) { await bot.sendMessage(id, chunk).catch(() => {}); chunk = ''; }
        chunk += line;
      }
      if (chunk) await bot.sendMessage(id, chunk).catch(() => {});
      return;
    }

    if (text === 'Обновить список групп') {
      if (!s.isConnected) return bot.sendMessage(id, '🔴 WhatsApp не подключен.').catch(() => {});
      try {
        await refreshGroupsCache(s, id);
        await bot.sendMessage(id, `✅ Обновлено! Групп: ${s.groupsCache.length}`).catch(() => {});
      } catch (e) {
        await bot.sendMessage(id, `❌ Ошибка: ${e.message}`).catch(() => {});
      }
      return;
    }

    if (text === 'Список исключение' || text === 'Список исключений') {
      if (!s.isConnected) return bot.sendMessage(id, '🔴 Сначала подключите WhatsApp.').catch(() => {});
      await ensureGroupsLoaded(id, s);
      return renderExclusionsMenu(id, s, { mode: 'm', onlyExcl: false, query: '', page: 0, msgId: null });
    }

    if (text === 'Выйти из ватсап') {
      s.stopBroadcast = true;
      s.wasEverConnected = false;
      const c = getUserCollector(id);
      c.isCollecting = false;
      saveUserCollector(id);
      if (s.sock) { try { await s.sock.logout().catch(() => {}); } catch (_) {} }
      destroySocket(s);
      clearUserAuthFolder(id);
      s.groupsCache = [];
      return bot.sendMessage(id, '👋 Сессия удалена.', getMainMenuKeyboard(id)).catch(() => {});
    }

    if (s.step === 'AWAITING_PHONE' && text) {
      let ph = text.replace(/\D/g, '');
      if (ph.length === 11 && ph.startsWith('8')) ph = '7' + ph.slice(1);
      s.step = 'IDLE';
      await bot.sendMessage(id, `⏳ Запрашиваю код для +${ph}...`).catch(() => {});
      return startWhatsAppSession(id, { reset: true, phoneNumber: ph, forceQr: false });
    }

    if (text && text.includes('chat.whatsapp.com')) {
      const c = getUserCollector(id);
      c.isCollecting = true;
      if (!c.startTime) c.startTime = Date.now();
      saveUserCollector(id);
      enqueueInviteCodesForUser(id, text);
      await bot.sendMessage(id, `📥 Ссылки добавлены в очередь (в очереди: ${c.pendingQueue.length}).`).catch(() => {});
      return updateCollectorUi(id, true);
    }

    let draft = null;
    let fileSize = 0;
    if (msg.photo?.length) {
      const ph = msg.photo[msg.photo.length - 1];
      draft = { type: 'photo', fileId: ph.file_id, text: msg.caption || '' };
      fileSize = ph.file_size || 0;
    } else if (msg.video) {
      draft = { type: 'video', fileId: msg.video.file_id, text: msg.caption || '', mime: msg.video.mime_type || 'video/mp4' };
      fileSize = msg.video.file_size || 0;
    } else if (text) {
      draft = { type: 'text', fileId: null, text };
    }
    if (!draft) return;

    if (!s.isConnected) return bot.sendMessage(id, '⚠️ Сначала подключите WhatsApp.', getMainMenuKeyboard(id)).catch(() => {});
    if (fileSize > TG_FILE_LIMIT) return bot.sendMessage(id, '⚠️ Файл больше 20 МБ.').catch(() => {});
    await ensureGroupsLoaded(id, s);
    s.draft = draft;
    return sendDraftPreview(id, s);
  } catch (e) {
    console.error('message handler', e);
  }
});

// ==================== CALLBACK QUERIES ====================
bot.on('callback_query', async (q) => {
  try {
    if (!q.message) return bot.answerCallbackQuery(q.id).catch(() => {});
    const id = Number(q.message.chat.id);
    const msgId = q.message.message_id;
    const data = q.data || '';
    const ack = (opts) => bot.answerCallbackQuery(q.id, opts).catch(() => {});

    if (bannedUsers.has(id) && !isOwner(id)) return ack({ text: 'Доступ закрыт.', show_alert: true });

    const s = getUserSession(id);
    const c = getUserCollector(id);
    if (data === 'noop') return ack();

    // Управление сканером для каждого участника
    if (data.startsWith('col_')) {
      if (data === 'col_stop_send') {
        c.isCollecting = false;
        saveUserCollector(id);
        await ack({ text: '🛑 Сканирование остановлено, формирую файл...' });
        await updateCollectorUi(id, true);
        return sendCollectorTxtFile(id, `🛑 Сканирование остановлено. Найдено групп: ${c.collected.length}`);
      }

      if (data === 'col_start') {
        if (!s.isConnected) return ack({ text: '❌ Сначала подключите свой WhatsApp!', show_alert: true });
        await refreshGroupsCache(s, id).catch(() => {});
        c.isCollecting = true;
        if (!c.startTime) c.startTime = Date.now();
        saveUserCollector(id);
        await ack({ text: '▶️ Сканирование запущено на 24 часа!' });
        await updateCollectorUi(id, true);
        processUserCollectorQueue(id);
        return;
      }

      if (data === 'col_refresh') {
        await ack({ text: `Собрано: ${c.collected.length} из ${COLLECTOR_TARGET_LIMIT}` });
        return updateCollectorUi(id, true);
      }

      if (data === 'col_download') {
        await ack({ text: '📥 Выгружаю .txt файл...' });
        return sendCollectorTxtFile(id, `📋 Текущая база (${c.collected.length} групп)`);
      }

      if (data === 'col_clear') {
        c.collected = [];
        c.pendingQueue = [];
        c.checkedCodes.clear();
        c.startTime = 0;
        c.stats = { skippedMine: 0, skippedClosed: 0, skippedOffTopic: 0, skippedDead: 0 };
        saveUserCollector(id);
        await ack({ text: '🗑 База очищена!' });
        return updateCollectorUi(id, true);
      }
    }

    if (data === 'export_confirm') {
      await ack({ text: 'Запускаю выгрузку...' });
      await bot.deleteMessage(id, msgId).catch(() => {});
      return exportUserGroupsReport(id, s);
    }
    if (data === 'export_cancel') {
      await ack({ text: 'Отменено' });
      return bot.editMessageText('❌ Выгрузка отменена.', { chat_id: id, message_id: msgId }).catch(() => {});
    }

    if (data.startsWith('copy_code:')) {
      const code = data.split(':')[1] || s.lastPairingCode || '';
      await ack({ text: 'Код скопирован' });
      return bot.sendMessage(id, `<code>${code}</code>`, { parse_mode: 'HTML' }).catch(() => {});
    }

    if (data === 'b_stop') {
      if (s.isBroadcasting) {
        s.stopBroadcast = true;
        return ack({ text: '🛑 Останавливаю рассылку...' });
      }
      return ack({ text: 'Рассылка завершена' });
    }

    if (data.startsWith('adm_')) {
      if (!isAdmin(id)) return ack({ text: '⛔ Нет прав!', show_alert: true });
      const show = (page) => {
        const v = buildAdminView(id, page);
        return bot.editMessageText(v.text, { chat_id: id, message_id: msgId, reply_markup: v.reply_markup }).catch(() => {});
      };
      if (data.startsWith('adm_pg:')) {
        await ack();
        return show(parseInt(data.split(':')[1], 10) || 0);
      }
      const [act, tidStr, pageStr] = data.split(':');
      const tid = Number(tidStr);
      const page = parseInt(pageStr, 10) || 0;
      const ts = sessions.get(tid);

      if (act === 'adm_ban') { bannedUsers.add(tid); saveBanned(); if (ts) destroySocket(ts); }
      if (act === 'adm_unban') { bannedUsers.delete(tid); saveBanned(); }
      if (act === 'adm_del') { sessions.delete(tid); bannedUsers.delete(tid); usersMeta.delete(tid); saveBanned(); saveUsersMeta(); }
      await ack({ text: 'Готово' });
      return show(page);
    }

    if (data === 'force_qr') {
      s.step = 'IDLE';
      await ack();
      return startWhatsAppSession(id, { reset: true, phoneNumber: null, forceQr: true });
    }

    await ensureGroupsLoaded(id, s);

    if (data === 'b_back') {
      await ack();
      return sendDraftPreview(id, s, msgId);
    }
    if (data.startsWith('b_one_page:')) {
      const p = parseInt(data.split(':')[1], 10) || 0;
      await ack();
      return bot.editMessageText(`🎯 Выберите группу (Стр. ${p + 1}):`, {
        chat_id: id, message_id: msgId, reply_markup: buildSingleGroupKeyboard(s, p)
      }).catch(() => {});
    }
    if (data.startsWith('send_one:')) {
      const sid = data.slice('send_one:'.length);
      if (!findGroupByShort(s, sid)) return ack({ text: 'Группа не найдена', show_alert: true });
      await ack();
      return broadcastMessage(id, s, { mode: 'one', sid });
    }
    if (data === 'b_rand10') {
      await ack();
      return broadcastMessage(id, s, { mode: 'rand', n: 10 });
    }
    if (data === 'b_all') {
      await ack();
      return broadcastMessage(id, s, { mode: 'all' });
    }

    return ack();
  } catch (e) {
    console.error('callback handler', e);
  }
});

// ==================== СТАРТ СЕССИЙ ====================
(async () => {
  await startPolling();
  try {
    for (const f of fs.readdirSync(__dirname)) {
      if (!f.startsWith('auth_info_')) continue;
      const id = Number(f.replace('auth_info_', ''));
      const cf = path.join(__dirname, f, 'creds.json');
      if (id && (!bannedUsers.has(id) || isOwner(id)) && fs.existsSync(cf)) {
        try {
          if (JSON.parse(fs.readFileSync(cf, 'utf-8'))?.registered) {
            startWhatsAppSession(id, { reset: false });
            await sleep(1500);
          } else clearUserAuthFolder(id);
        } catch (_) { clearUserAuthFolder(id); }
      }
    }
  } catch (e) { console.error('restore sessions', e.message); }
})();
