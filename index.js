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
  Browsers,
  delay
} = baileys;

// ==================== КОНФИГУРАЦИЯ ====================
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = '9069645701:AAFl6LJQxT4bA1hRLDowJLigUbeIhJR1YcA';
const OWNER_ID = 5846687574; // Главный администратор (вне лимита)
const MAX_USERS = 7;         // Максимум подключенных клиентов (не считая админа)
const PAGE_SIZE = 8;

const logger = pino({ level: 'silent' });

// ==================== ЗАЩИТА ПРОЦЕССА ОТ ПАДЕНИЙ ====================
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err?.message || err);
});

function escapeMd(text = '') {
  return String(text).replace(/([_*`\[])/g, '\\$1');
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const data = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => resolve(Buffer.concat(data)));
    }).on('error', reject);
  });
}

// ==================== HTTP-СЕРВЕР ДЛЯ RENDER ====================
const app = express();

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    activeSessions: sessions.size,
    connectedClients: countConnectedClients(),
    maxClients: MAX_USERS,
    ownerConnected: Boolean(sessions.get(OWNER_ID)?.isConnected),
    uptime: Math.floor(process.uptime())
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP-сервер запущен на порту ${PORT}`);
});

// ==================== БАЗА ДАННЫХ И СЕССИИ ====================
const sessions = new Map();
const bannedUsers = new Set();
const usersMeta = new Map();

const BANNED_FILE = path.join(__dirname, 'banned.json');
const META_FILE = path.join(__dirname, 'users_meta.json');

function loadBanned() {
  try {
    if (fs.existsSync(BANNED_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(BANNED_FILE, 'utf-8'));
      if (Array.isArray(parsed)) {
        parsed.forEach((id) => bannedUsers.add(Number(id)));
      }
    }
  } catch (err) {
    console.error('Ошибка чтения banned.json:', err.message);
  }
}

function saveBanned() {
  try {
    fs.writeFileSync(BANNED_FILE, JSON.stringify([...bannedUsers], null, 2), 'utf-8');
  } catch (err) {
    console.error('Ошибка сохранения banned.json:', err.message);
  }
}

function loadUsersMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        for (const [id, data] of Object.entries(parsed)) {
          usersMeta.set(Number(id), data);
        }
      }
    }
  } catch (err) {
    console.error('Ошибка чтения users_meta.json:', err.message);
  }
}

function saveUsersMeta() {
  try {
    const obj = {};
    for (const [id, data] of usersMeta.entries()) {
      obj[id] = data;
    }
    fs.writeFileSync(META_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.error('Ошибка сохранения users_meta.json:', err.message);
  }
}

loadBanned();
loadUsersMeta();

// ==================== РАБОТА С ИСКЛЮЧЕНИЯМИ (JSON) ====================
function getUserExclPath(chatId) {
  return path.join(__dirname, `excluded_${chatId}.json`);
}

function loadExcludedForUser(chatId, session) {
  try {
    const file = getUserExclPath(chatId);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed)) {
        session.excludedGroups = new Set(parsed);
      }
    }
  } catch (err) {
    console.error(`Ошибка чтения исключений (${chatId}):`, err.message);
  }
}

function saveExcludedForUser(chatId, session) {
  try {
    const file = getUserExclPath(chatId);
    fs.writeFileSync(file, JSON.stringify([...session.excludedGroups], null, 2), 'utf-8');
  } catch (err) {
    console.error(`Ошибка сохранения исключений (${chatId}):`, err.message);
  }
}

function getUserSession(chatId) {
  const numId = Number(chatId);
  if (!sessions.has(numId)) {
    const savedMeta = usersMeta.get(numId) || {};
    const newSession = {
      sock: null,
      isConnected: false,
      isConnecting: false,
      isBroadcasting: false,
      pairingSent: false,
      phoneNumber: null,
      forceQr: false,
      qrCount: 0,
      groupsCache: [],
      excludedGroups: new Set(),
      step: 'IDLE',
      draft: {
        type: 'text', // 'text' | 'photo' | 'video'
        text: '',
        fileId: null
      },
      reconnectTimer: null,
      name: savedMeta.name || '',
      username: savedMeta.username || '',
      notifiedOwner: Boolean(savedMeta.notifiedOwner)
    };
    loadExcludedForUser(numId, newSession);
    sessions.set(numId, newSession);
  }
  return sessions.get(numId);
}

function updateUserInfo(msg) {
  if (!msg || !msg.from) return;
  const chatId = Number(msg.chat.id);
  const session = getUserSession(chatId);
  const first = msg.from.first_name || '';
  const last = msg.from.last_name ? ` ${msg.from.last_name}` : '';
  const newName = `${first}${last}`.trim() || 'Без имени';
  const newUsername = msg.from.username ? `@${msg.from.username}` : '';

  if (session.name !== newName || session.username !== newUsername) {
    session.name = newName;
    session.username = newUsername;
    usersMeta.set(chatId, {
      name: session.name,
      username: session.username,
      notifiedOwner: session.notifiedOwner
    });
    saveUsersMeta();
  }
}

function countConnectedClients() {
  let count = 0;
  for (const [id, s] of sessions.entries()) {
    if (id !== OWNER_ID && s.isConnected) {
      count++;
    }
  }
  return count;
}

// ==================== ИНИЦИАЛИЗАЦИЯ TELEGRAM ====================
const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    autoStart: false,
    params: { timeout: 30 }
  }
});

let pollingRestartTimer = null;

async function startTelegramPolling() {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    await bot.startPolling();
    console.log('Telegram-бот успешно запущен в режиме Long Polling.');
  } catch (err) {
    console.error('Ошибка старта Telegram Polling:', err.message);
  }
}

bot.on('polling_error', async (err) => {
  const msg = err?.message || '';
  if (msg.includes('409 Conflict') || msg.includes('EFATAL') || msg.includes('ETIMEDOUT')) {
    if (pollingRestartTimer) return;
    try {
      await bot.stopPolling();
    } catch (_) {}
    pollingRestartTimer = setTimeout(async () => {
      pollingRestartTimer = null;
      await startTelegramPolling();
    }, 4000);
  }
});

async function gracefulShutdown() {
  try {
    await bot.stopPolling();
  } catch (_) {}
  server.close(() => process.exit(0));
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ==================== КЛАВИАТУРЫ TELEGRAM ====================
function getMainMenuKeyboard(chatId) {
  const keyboard = [
    [{ text: 'Войти в аккаунт' }, { text: 'Список групп' }],
    [{ text: 'Обновить список групп' }, { text: 'Список исключение' }],
    [{ text: 'Выйти из ватсап' }]
  ];
  if (Number(chatId) === OWNER_ID) {
    keyboard.push([{ text: '👑 Админ-панель' }]);
  }
  return {
    reply_markup: {
      keyboard,
      resize_keyboard: true
    }
  };
}

function getBroadcastMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🎯 Отправить в 1 группу', callback_data: 'b_one_page:0' }],
      [{ text: '🎲 Отправить в 10 групп (случайно)', callback_data: 'b_rand10' }],
      [{ text: '📢 Отправить во все группы кроме исключенных', callback_data: 'b_all' }],
      [{ text: '🚫 Добавить в исключения', callback_data: 'b_excl_page:0' }]
    ]
  };
}

// ==================== ПРОДВИНУТАЯ АДМИН-ПАНЕЛЬ ====================
function getAllClientIds() {
  const allIds = new Set([...sessions.keys(), ...bannedUsers, ...usersMeta.keys()]);
  allIds.delete(OWNER_ID);
  return [...allIds];
}

function buildAdminKeyboard() {
  const rows = [];
  const clientIds = getAllClientIds();

  for (const id of clientIds) {
    const s = sessions.get(id);
    const meta = usersMeta.get(id) || {};
    const isBanned = bannedUsers.has(id);
    const isConn = Boolean(s?.isConnected);
    const rawName = s?.name || meta.name || `ID:${id}`;
    const shortName = rawName.length > 14 ? rawName.slice(0, 14) + '…' : rawName;
    const statusDot = isBanned ? '🚫' : isConn ? '🟢' : '🔴';

    rows.push([{ text: `${statusDot} ${shortName} (${id})`, callback_data: 'noop' }]);

    const actionRow = [];
    if (isBanned) {
      actionRow.push({ text: '✅ Разбан', callback_data: `adm_unban:${id}` });
    } else {
      if (isConn) {
        actionRow.push({ text: '🔌 Кик WA', callback_data: `adm_kick:${id}` });
      }
      actionRow.push({ text: '🔨 Бан', callback_data: `adm_ban:${id}` });
      actionRow.push({ text: '🔄 Сброс (Тест)', callback_data: `adm_reset:${id}` });
    }
    actionRow.push({ text: '🗑 Удалить', callback_data: `adm_del:${id}` });
    rows.push(actionRow);
  }

  rows.push([
    { text: '📢 Написать всем клиентам', callback_data: 'adm_msg_all' },
    { text: '🔄 Обновить', callback_data: 'adm_refresh' }
  ]);
  return { inline_keyboard: rows };
}

function buildAdminText() {
  const clientIds = getAllClientIds();
  const ownerSession = sessions.get(OWNER_ID);

  let text = `👑 *Панель управления клиентами*\n\n`;
  text += `👤 *Твой статус WA:* ${ownerSession?.isConnected ? `🟢 Подключен (${ownerSession.groupsCache.length} гр.)` : '🔴 Не подключен'}\n`;
  text += `📊 *Слоты клиентов:* *${countConnectedClients()} из ${MAX_USERS}* (не считая тебя)\n`;
  text += `👥 *Всего в базе:* *${clientIds.length}* чел.\n\n`;

  if (clientIds.length === 0) {
    text += `_Пока ни один клиент не запускал бота._`;
    return text;
  }

  text += `*Список пользователей:*\n`;
  for (const id of clientIds) {
    const s = sessions.get(id);
    const meta = usersMeta.get(id) || {};
    const isBanned = bannedUsers.has(id);

    const status = isBanned
      ? '🚫 ЗАБЛОКИРОВАН'
      : s?.isConnected
      ? `🟢 В сети (Групп: ${s.groupsCache.length})`
      : '🔴 Оффлайн / Не привязан';

    const safeName = escapeMd(s?.name || meta.name || 'Без имени');
    const safeUser = escapeMd(s?.username || meta.username || '');
    text += `• *${safeName}* ${safeUser} (\`${id}\`)\n  Статус: ${status}\n\n`;
  }

  text += `💡 *Кнопки:* \n` +
          `• *Кик WA* — отключить WhatsApp\n` +
          `• *Бан* — заблокировать доступ к боту\n` +
          `• *Сброс (Тест)* — очистить зависшую сессию клиенту\n` +
          `• *Удалить* — стереть человека из списка`;
  return text;
}

// ==================== КЛАВИАТУРЫ ПАГИНАЦИИ И ИСКЛЮЧЕНИЙ ====================
function buildSingleGroupKeyboard(session, page = 0) {
  const available = session.groupsCache
    .map((g, idx) => ({ ...g, idx }))
    .filter((g) => !session.excludedGroups.has(g.id));

  const totalPages = Math.max(1, Math.ceil(available.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = available.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const rows = slice.map((g) => [
    { text: `💬 ${g.subject.slice(0, 45)}`, callback_data: `send_one:${g.idx}` }
  ]);

  const navRow = [];
  if (currentPage > 0) navRow.push({ text: '⬅️ Назад', callback_data: `b_one_page:${currentPage - 1}` });
  navRow.push({ text: `Стр. ${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages - 1) navRow.push({ text: 'Вперёд ➡️', callback_data: `b_one_page:${currentPage + 1}` });
  rows.push(navRow);
  rows.push([{ text: '🔙 Назад к выбору рассылки', callback_data: 'b_back' }]);

  return { inline_keyboard: rows };
}

function buildManageExclusionsKeyboard(session, page = 0, fromMainMenu = false) {
  const totalPages = Math.max(1, Math.ceil(session.groupsCache.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const start = currentPage * PAGE_SIZE;
  const slice = session.groupsCache.slice(start, start + PAGE_SIZE);

  const prefix = fromMainMenu ? 'm' : 'b';

  const rows = slice.map((g, i) => {
    const globalIdx = start + i;
    const isExcl = session.excludedGroups.has(g.id);
    return [
      {
        text: `${isExcl ? '🚫 [ИСКЛ]' : '✅ [АКТИВ]'} ${g.subject.slice(0, 38)}`,
        callback_data: `tog_excl:${globalIdx}:${currentPage}:${prefix}`
      }
    ];
  });

  const navRow = [];
  if (currentPage > 0) {
    navRow.push({ text: '⬅️ Назад', callback_data: `${prefix}_excl_page:${currentPage - 1}` });
  }
  navRow.push({ text: `Стр. ${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages - 1) {
    navRow.push({ text: 'Вперёд ➡️', callback_data: `${prefix}_excl_page:${currentPage + 1}` });
  }
  rows.push(navRow);

  if (fromMainMenu) {
    rows.push([{ text: '📋 Показать только исключенные', callback_data: 'excl_only_page:0' }]);
  } else {
    rows.push([{ text: '🔙 Назад к выбору рассылки', callback_data: 'b_back' }]);
  }

  return { inline_keyboard: rows };
}

function buildExcludedListKeyboard(session, page = 0) {
  const excludedArray = session.groupsCache
    .map((g, idx) => ({ ...g, idx }))
    .filter((g) => session.excludedGroups.has(g.id));

  const rows = [];
  if (excludedArray.length > 0) {
    const totalPages = Math.max(1, Math.ceil(excludedArray.length / PAGE_SIZE));
    const currentPage = Math.min(Math.max(0, page), totalPages - 1);
    const slice = excludedArray.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

    for (const g of slice) {
      rows.push([{ text: `❌ Вернуть: ${g.subject.slice(0, 40)}`, callback_data: `rm_excl:${g.idx}:${currentPage}` }]);
    }

    if (totalPages > 1) {
      const navRow = [];
      if (currentPage > 0) navRow.push({ text: '⬅️ Назад', callback_data: `excl_only_page:${currentPage - 1}` });
      navRow.push({ text: `Стр. ${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
      if (currentPage < totalPages - 1) navRow.push({ text: 'Вперёд ➡️', callback_data: `excl_only_page:${currentPage + 1}` });
      rows.push(navRow);
    }
  }

  rows.push([{ text: '➕ Добавить / убрать группы из всех', callback_data: 'm_excl_page:0' }]);
  return { inline_keyboard: rows };
}

// ==================== ЯДРО WHATSAPP (BAILEYS) ====================
function getUserAuthDir(chatId) {
  return path.join(__dirname, `auth_info_${chatId}`);
}

function destroySocket(session) {
  if (!session) return;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  if (session.sock) {
    try {
      session.sock.ev.removeAllListeners();
      session.sock.ws.close();
    } catch (_) {}
    session.sock = null;
  }
  session.isConnected = false;
  session.isConnecting = false;
}

function clearUserAuthFolder(chatId) {
  try {
    const dir = getUserAuthDir(chatId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Ошибка удаления папки сессии (${chatId}):`, err.message);
  }
}

async function refreshGroupsCache(session) {
  if (!session.sock || !session.isConnected) {
    throw new Error('WhatsApp не подключен.');
  }
  const participating = await session.sock.groupFetchAllParticipating();
  session.groupsCache = Object.values(participating)
    .map((g) => ({ id: g.id, subject: g.subject || 'Без названия' }))
    .sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));
  return session.groupsCache;
}

async function ensureGroupsLoaded(chatId, session) {
  loadExcludedForUser(chatId, session);
  if (session.groupsCache.length === 0 && session.isConnected) {
    try {
      await refreshGroupsCache(session);
    } catch (_) {}
  }
}

async function startWhatsAppSession(chatId, options = {}) {
  const numId = Number(chatId);
  const session = getUserSession(numId);

  if (options.reset) {
    destroySocket(session);
    clearUserAuthFolder(numId);
    session.pairingSent = false;
    session.qrCount = 0;
    session.phoneNumber = options.phoneNumber || null;
    session.forceQr = Boolean(options.forceQr);
  }

  if (session.isConnecting) return;
  session.isConnecting = true;

  try {
    const authDir = getUserAuthDir(numId);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    let version = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) version = latest.version;
    } catch (_) {}

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => ({ conversation: '' })
    });

    session.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !state.creds.registered) {
        if (session.phoneNumber && !session.forceQr) {
          if (!session.pairingSent) {
            session.pairingSent = true;
            try {
              await delay(1000);
              const rawCode = await sock.requestPairingCode(session.phoneNumber);
              const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;

              await bot.sendMessage(
                numId,
                `🔐 *Ваш код сопряжения WhatsApp:*\n\n` +
                  `👉 \`${formattedCode}\` 👈\n\n` +
                  `*Как ввести код:*\n` +
                  `1. Откройте WhatsApp на телефоне.\n` +
                  `2. Перейдите в *Связанные устройства* ➔ *Привязка устройства*.\n` +
                  `3. Нажмите внизу *«Связать по номеру телефона»* и введите код.\n\n` +
                  `⏳ _У вас есть 60 секунд на ввод кода. Не закрывайте бота!_`,
                {
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [[{ text: '📷 Не подходит код? Войти по QR', callback_data: 'force_qr' }]]
                  }
                }
              );
            } catch (err) {
              console.error(`Ошибка requestPairingCode (${numId}):`, err.message);
              session.forceQr = true;
              await sendQrCode(
                numId,
                qr,
                '⚠️ WhatsApp отклонил генерацию кода для этого номера. Отсканируйте резервный QR-код:'
              );
            }
          }
        } else {
          session.qrCount++;
          if (session.qrCount <= 3) {
            await sendQrCode(
              numId,
              qr,
              `📷 Отсканируйте QR-код в WhatsApp (Связанные устройства).\nПопытка ${session.qrCount}/3:`
            );
          } else {
            destroySocket(session);
            clearUserAuthFolder(numId);
            await bot.sendMessage(
              numId,
              '⌛ Время ожидания сканирования QR-кода истекло. Нажмите «Войти в аккаунт», чтобы попробовать снова.',
              getMainMenuKeyboard(numId)
            );
          }
        }
      }

      if (connection === 'open') {
        session.isConnected = true;
        session.isConnecting = false;
        session.pairingSent = false;
        session.phoneNumber = null;
        session.qrCount = 0;

        console.log(`WhatsApp успешно подключен [${numId}]`);
        loadExcludedForUser(numId, session);

        try {
          await refreshGroupsCache(session);
        } catch (err) {
          console.error(`Ошибка первичной загрузки групп [${numId}]:`, err.message);
        }

        await bot.sendMessage(
          numId,
          `✅ *WhatsApp успешно подключен!*\n` +
            `Групп загружено: *${session.groupsCache.length}*\n\n` +
            `Отправьте мне *текст*, *фото* или *видео* с подписью, чтобы сделать рассылку.`,
          { parse_mode: 'Markdown', ...getMainMenuKeyboard(numId) }
        );
      }

      if (connection === 'close') {
        session.isConnected = false;
        session.isConnecting = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMessage = String(lastDisconnect?.error?.message || lastDisconnect?.error || '');
        const isBadMac = errMessage.includes('Bad MAC');
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

        console.log(`Соединение закрыто [${numId}]. Код: ${statusCode}. Причина: ${errMessage}`);

        if (isLoggedOut || isBadMac) {
          destroySocket(session);
          clearUserAuthFolder(numId);
          session.groupsCache = [];
          await bot.sendMessage(
            numId,
            isBadMac
              ? '⚠️ Сбой ключей шифрования (Bad MAC). Сессия автоматически очищена. Нажмите «Войти в аккаунт» для чистого входа.'
              : '🔴 Вы вышли из WhatsApp на телефоне. Сессия удалена. Нажмите «Войти в аккаунт» для повторного входа.',
            getMainMenuKeyboard(numId)
          ).catch(() => {});
          return;
        }

        const hasCredsFile = fs.existsSync(path.join(authDir, 'creds.json'));
        if (hasCredsFile || session.pairingSent || statusCode === DisconnectReason.restartRequired || statusCode === 515) {
          const delayMs = statusCode === DisconnectReason.restartRequired || statusCode === 515 ? 1000 : 3500;
          session.reconnectTimer = setTimeout(() => {
            startWhatsAppSession(numId, { reset: false });
          }, delayMs);
        }
      }
    });
  } catch (err) {
    session.isConnecting = false;
    console.error(`Критическая ошибка старта сессии [${numId}]:`, err.message);
    await bot.sendMessage(numId, `❌ Ошибка подключения к WhatsApp: ${err.message}`).catch(() => {});
  }
}

async function sendQrCode(chatId, qrData, caption) {
  try {
    const buffer = await QRCode.toBuffer(qrData, { scale: 8, margin: 2 });
    await bot.sendPhoto(chatId, buffer, { caption });
  } catch (err) {
    console.error('Ошибка генерации QR:', err.message);
  }
}

// ==================== ФУНКЦИЯ РАССЫЛКИ (ТЕКСТ + ФОТО + ВИДЕО) ====================
async function broadcastMessage(chatId, session, targetGroups) {
  if (!session.sock || !session.isConnected) {
    return bot.sendMessage(chatId, '❌ WhatsApp не подключен. Сначала нажмите «Войти в аккаунт».');
  }
  if (session.isBroadcasting) {
    return bot.sendMessage(chatId, '⏳ Дождитесь завершения текущей рассылки!');
  }
  if (targetGroups.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Нет доступных групп для рассылки (возможно, все группы в исключениях).');
  }

  const { type, text, fileId } = session.draft;
  if (type === 'text' && (!text || !text.trim())) {
    return bot.sendMessage(chatId, '⚠️ Текст рассылки пуст. Отправьте новый текст, фото или видео.');
  }

  session.isBroadcasting = true;
  let success = 0;
  let fails = 0;
  let statusMsg = null;

  try {
    statusMsg = await bot.sendMessage(
      chatId,
      `⏳ Начинаю рассылку по *${targetGroups.length}* группам...`,
      { parse_mode: 'Markdown' }
    );

    let mediaBuffer = null;
    if ((type === 'photo' || type === 'video') && fileId) {
      const fileLink = await bot.getFileLink(fileId);
      mediaBuffer = await downloadBuffer(fileLink);
    }

    for (let i = 0; i < targetGroups.length; i++) {
      if (!session.isConnected || !session.sock) {
        fails += targetGroups.length - i;
        break;
      }
      const group = targetGroups[i];
      try {
        if (type === 'photo' && mediaBuffer) {
          await session.sock.sendMessage(group.id, { image: mediaBuffer, caption: text || '' });
        } else if (type === 'video' && mediaBuffer) {
          await session.sock.sendMessage(group.id, { video: mediaBuffer, caption: text || '' });
        } else {
          await session.sock.sendMessage(group.id, { text: text || '' });
        }
        success++;
      } catch (err) {
        console.error(`Ошибка отправки в ${group.id}:`, err.message);
        fails++;
      }

      if (i < targetGroups.length - 1) {
        await delay(1500 + Math.floor(Math.random() * 500));
      }
    }

    const resultText = `✅ *Рассылка завершена!*\n\n📤 Успешно: *${success}*\n❌ Ошибок: *${fails}*`;
    if (statusMsg) {
      await bot.editMessageText(resultText, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: 'Markdown'
      }).catch(() => {
        bot.sendMessage(chatId, resultText, { parse_mode: 'Markdown' }).catch(() => {});
      });
    }
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Ошибка подготовки рассылки: ${err.message}`).catch(() => {});
  } finally {
    session.isBroadcasting = false;
  }
}

async function sendDraftPreview(chatId, session, messageId = null) {
  const { type, text } = session.draft;
  const header =
    type === 'photo'
      ? '🖼 Фото для рассылки сохранено!'
      : type === 'video'
      ? '🎬 Видео для рассылки сохранено!'
      : '📝 Текст для рассылки сохранён!';

  const safePreview = `${header}\n\n${text || '(без подписи)'}\n\n👇 Выберите режим отправки:`;
  if (messageId) {
    return bot.editMessageText(safePreview, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getBroadcastMenuKeyboard()
    });
  }
  return bot.sendMessage(chatId, safePreview, {
    reply_markup: getBroadcastMenuKeyboard()
  });
}

// ==================== ОБРАБОТЧИКИ КОМАНД TELEGRAM ====================
bot.onText(/^\/start/, async (msg) => {
  const chatId = Number(msg.chat.id);
  updateUserInfo(msg);

  if (bannedUsers.has(chatId) && chatId !== OWNER_ID) {
    return bot.sendMessage(chatId, '⛔ Доступ к боту закрыт администратором.');
  }

  const session = getUserSession(chatId);
  session.step = 'IDLE';
  await ensureGroupsLoaded(chatId, session);

  if (chatId !== OWNER_ID && !session.notifiedOwner) {
    session.notifiedOwner = true;
    usersMeta.set(chatId, {
      name: session.name,
      username: session.username,
      notifiedOwner: true
    });
    saveUsersMeta();

    bot.sendMessage(
      OWNER_ID,
      `🔔 *Новый пользователь запустил бота:*\n` +
        `Имя: ${escapeMd(session.name)} ${escapeMd(session.username)}\n` +
        `ID: \`${chatId}\`\n\n` +
        `Управление доступом: кнопка «👑 Админ-панель».`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  await bot.sendMessage(
    chatId,
    `👋 *Панель управления рассылками WhatsApp*\n\n` +
      `Статус вашего аккаунта: ${session.isConnected ? '🟢 Подключен' : '🔴 Не подключен'}\n` +
      `Групп в кэше: *${session.groupsCache.length}*\n` +
      `В исключениях: *${session.excludedGroups.size}*\n` +
      `Свободных слотов: *${Math.max(0, MAX_USERS - countConnectedClients())}/${MAX_USERS}*\n\n` +
      `Отправьте текст, фото или видео для рассылки, либо выберите действие в меню:`,
    { parse_mode: 'Markdown', ...getMainMenuKeyboard(chatId) }
  );
});

bot.on('message', async (msg) => {
  const chatId = Number(msg.chat.id);
  const text = msg.text;

  if (text && text.startsWith('/start')) return;
  updateUserInfo(msg);

  if (bannedUsers.has(chatId) && chatId !== OWNER_ID) {
    return bot.sendMessage(chatId, '⛔ Доступ к боту закрыт администратором.');
  }

  const session = getUserSession(chatId);

  if (chatId === OWNER_ID && session.step === 'AWAITING_ADMIN_BROADCAST' && text) {
    session.step = 'IDLE';
    if (text === 'Отмена' || text === '👑 Админ-панель') {
      return bot.sendMessage(OWNER_ID, '❌ Рассылка клиентам отменена.', getMainMenuKeyboard(OWNER_ID));
    }
    const clientIds = getAllClientIds();
    let sent = 0;
    for (const id of clientIds) {
      if (!bannedUsers.has(id)) {
        try {
          await bot.sendMessage(id, `📢 *Сообщение от администратора:*\n\n${escapeMd(text)}`, { parse_mode: 'Markdown' });
          sent++;
        } catch (_) {}
      }
    }
    return bot.sendMessage(OWNER_ID, `✅ Сообщение доставлено *${sent}* пользователям.`, {
      parse_mode: 'Markdown',
      ...getMainMenuKeyboard(OWNER_ID)
    });
  }

  if (text === '👑 Админ-панель' && chatId === OWNER_ID) {
    session.step = 'IDLE';
    return bot.sendMessage(OWNER_ID, buildAdminText(), {
      parse_mode: 'Markdown',
      reply_markup: buildAdminKeyboard()
    });
  }

  if (text === 'Войти в аккаунт') {
    if (session.isConnected) {
      return bot.sendMessage(chatId, '🟢 Ваш WhatsApp уже подключен и готов к работе!', getMainMenuKeyboard(chatId));
    }

    if (chatId !== OWNER_ID && countConnectedClients() >= MAX_USERS && !fs.existsSync(getUserAuthDir(chatId))) {
      return bot.sendMessage(
        chatId,
        `⚠️ Все клиентские слоты заняты (максимум ${MAX_USERS} активных аккаунтов). Обратитесь к администратору.`
      );
    }

    session.step = 'AWAITING_PHONE';
    return bot.sendMessage(
      chatId,
      '📱 *Введите ваш номер телефона WhatsApp в международном формате*\n' +
        '(например: `79281234567` или `+79281234567`):\n\n' +
        '_Либо нажмите кнопку ниже, чтобы войти по QR-коду:_',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '📷 Войти по QR-коду', callback_data: 'force_qr' }]]
        }
      }
    );
  }

  if (text === 'Список групп') {
    session.step = 'IDLE';
    if (!session.isConnected) return bot.sendMessage(chatId, '🔴 WhatsApp не подключен. Нажмите «Войти в аккаунт».');
    await ensureGroupsLoaded(chatId, session);
    if (session.groupsCache.length === 0) return bot.sendMessage(chatId, '📭 В вашем аккаунте нет доступных групп.');

    const lines = session.groupsCache.map((g, idx) => {
      const mark = session.excludedGroups.has(g.id) ? ' 🚫 [Исключена]' : '';
      return `${idx + 1}. ${g.subject}${mark}`;
    });

    let chunk = `📋 Список ваших групп (${session.groupsCache.length}):\n\n`;
    for (const line of lines) {
      if ((chunk + line + '\n').length > 3800) {
        await bot.sendMessage(chatId, chunk);
        chunk = '';
      }
      chunk += line + '\n';
    }
    if (chunk) await bot.sendMessage(chatId, chunk);
    return;
  }

  if (text === 'Обновить список групп') {
    session.step = 'IDLE';
    if (!session.isConnected) return bot.sendMessage(chatId, '🔴 WhatsApp не подключен.');
    const waitMsg = await bot.sendMessage(chatId, '🔄 Загружаю актуальный список групп из WhatsApp...');
    try {
      await refreshGroupsCache(session);
      await bot.editMessageText(`✅ Список обновлён! Найдено групп: *${session.groupsCache.length}*`, {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        parse_mode: 'Markdown'
      });
    } catch (err) {
      await bot.editMessageText(`❌ Ошибка обновления: ${err.message}`, {
        chat_id: chatId,
        message_id: waitMsg.message_id
      });
    }
    return;
  }

  if (text === 'Список исключение') {
    session.step = 'IDLE';
    if (!session.isConnected) {
      return bot.sendMessage(chatId, '🔴 Сначала подключите WhatsApp через «Войти в аккаунт», чтобы управлять группами.');
    }
    await ensureGroupsLoaded(chatId, session);
    if (session.groupsCache.length === 0) {
      return bot.sendMessage(chatId, '📭 Группы не найдены.');
    }

    const excludedCount = session.groupsCache.filter((g) => session.excludedGroups.has(g.id)).length;
    return bot.sendMessage(
      chatId,
      `🚫 *Управление исключениями*\n` +
        `Сейчас исключено групп: *${excludedCount}* из *${session.groupsCache.length}*\n\n` +
        `Нажимайте на группы ниже, чтобы исключить их из рассылки (🚫) или вернуть обратно (✅):`,
      {
        parse_mode: 'Markdown',
        reply_markup: buildManageExclusionsKeyboard(session, 0, true)
      }
    );
  }

  if (text === 'Выйти из ватсап') {
    session.step = 'IDLE';
    if (session.sock) {
      try {
        await session.sock.logout().catch(() => {});
      } catch (_) {}
    }
    destroySocket(session);
    clearUserAuthFolder(chatId);
    session.groupsCache = [];

    return bot.sendMessage(
      chatId,
      '👋 Сессия WhatsApp полностью сброшена и удалена. Вы можете привязать аккаунт заново через «Войти в аккаунт».',
      getMainMenuKeyboard(chatId)
    );
  }

  if (session.step === 'AWAITING_PHONE' && text) {
    let cleanPhone = text.replace(/\D/g, '');
    if (cleanPhone.length === 11 && cleanPhone.startsWith('8')) {
      cleanPhone = '7' + cleanPhone.slice(1);
    }

    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return bot.sendMessage(
        chatId,
        '⚠️ Некорректный номер! Введите номер в международном формате через 7 (например: `79281234567`):',
        { parse_mode: 'Markdown' }
      );
    }

    session.step = 'IDLE';
    await bot.sendMessage(
      chatId,
      `⏳ Создаю чистую сессию и запрашиваю код привязки для номера \`+${cleanPhone}\`...\nПодождите 3–5 секунд.`,
      { parse_mode: 'Markdown' }
    );

    await startWhatsAppSession(chatId, {
      reset: true,
      phoneNumber: cleanPhone,
      forceQr: false
    });
    return;
  }

  if (!session.isConnected) {
    return bot.sendMessage(chatId, '⚠️ Сначала войдите в WhatsApp! Нажмите кнопку «Войти в аккаунт».', getMainMenuKeyboard(chatId));
  }

  await ensureGroupsLoaded(chatId, session);

  // Приём ФОТО, ВИДЕО или ТЕКСТА
  if (msg.photo && msg.photo.length > 0) {
    const bestPhoto = msg.photo[msg.photo.length - 1];
    session.draft = {
      type: 'photo',
      fileId: bestPhoto.file_id,
      text: msg.caption || ''
    };
    return sendDraftPreview(chatId, session);
  }

  if (msg.video) {
    session.draft = {
      type: 'video',
      fileId: msg.video.file_id,
      text: msg.caption || ''
    };
    return sendDraftPreview(chatId, session);
  }

  if (text) {
    session.draft = {
      type: 'text',
      fileId: null,
      text
    };
    return sendDraftPreview(chatId, session);
  }
});

// ==================== ОБРАБОТКА INLINE-КНОПОК ====================
bot.on('callback_query', async (query) => {
  if (!query.message) return bot.answerCallbackQuery(query.id);

  const chatId = Number(query.message.chat.id);
  const messageId = query.message.message_id;
  const data = query.data || '';

  if (bannedUsers.has(chatId) && chatId !== OWNER_ID) {
    return bot.answerCallbackQuery(query.id, { text: 'Доступ закрыт администратором.', show_alert: true });
  }

  const session = getUserSession(chatId);

  if (data === 'noop') return bot.answerCallbackQuery(query.id);

  // ==================== ОБРАБОТКА АДМИН-КНОПОК ====================
  if (data.startsWith('adm_') && chatId === OWNER_ID) {
    if (data === 'adm_refresh') {
      await bot.answerCallbackQuery(query.id, { text: 'Панель обновлена' });
      return bot.editMessageText(buildAdminText(), {
        chat_id: OWNER_ID,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: buildAdminKeyboard()
      }).catch(() => {});
    }

    if (data === 'adm_msg_all') {
      session.step = 'AWAITING_ADMIN_BROADCAST';
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(
        OWNER_ID,
        '📢 *Введите текст сообщения для всех пользователей бота*\n(или напишите `Отмена`):',
        { parse_mode: 'Markdown' }
      );
    }

    const [action, targetIdStr] = data.split(':');
    const targetId = Number(targetIdStr);

    if (action === 'adm_kick') {
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        if (targetSession.sock) {
          try { await targetSession.sock.logout().catch(() => {}); } catch (_) {}
        }
        destroySocket(targetSession);
        targetSession.groupsCache = [];
      }
      clearUserAuthFolder(targetId);
      bot.sendMessage(targetId, '⚠️ Ваша сессия WhatsApp была отключена администратором.').catch(() => {});
      await bot.answerCallbackQuery(query.id, { text: `Клиент ${targetId} отключен от WA` });
    }

    if (action === 'adm_ban') {
      bannedUsers.add(targetId);
      saveBanned();
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        if (targetSession.sock) {
          try { await targetSession.sock.logout().catch(() => {}); } catch (_) {}
        }
        destroySocket(targetSession);
        targetSession.groupsCache = [];
      }
      clearUserAuthFolder(targetId);
      bot.sendMessage(targetId, '⛔ Администратор закрыл вам доступ к боту.').catch(() => {});
      await bot.answerCallbackQuery(query.id, { text: `Клиент ${targetId} заблокирован!` });
    }

    if (action === 'adm_unban') {
      bannedUsers.delete(targetId);
      saveBanned();
      bot.sendMessage(targetId, '✅ Администратор открыл вам доступ к боту! Нажмите /start').catch(() => {});
      await bot.answerCallbackQuery(query.id, { text: `Клиент ${targetId} разблокирован!` });
    }

    if (action === 'adm_reset') {
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        destroySocket(targetSession);
        targetSession.groupsCache = [];
      }
      clearUserAuthFolder(targetId);
      bot.sendMessage(targetId, '🔄 Ваша сессия обновлена администратором. Вы можете войти в WhatsApp заново через «Войти в аккаунт».').catch(() => {});
      await bot.answerCallbackQuery(query.id, { text: `Сессия ${targetId} сброшена!` });
    }

    if (action === 'adm_del') {
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        if (targetSession.sock) {
          try { await targetSession.sock.logout().catch(() => {}); } catch (_) {}
        }
        destroySocket(targetSession);
      }
      clearUserAuthFolder(targetId);
      sessions.delete(targetId);
      bannedUsers.delete(targetId);
      usersMeta.delete(targetId);
      saveBanned();
      saveUsersMeta();
      await bot.answerCallbackQuery(query.id, { text: `Клиент ${targetId} удален из базы` });
    }

    return bot.editMessageText(buildAdminText(), {
      chat_id: OWNER_ID,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: buildAdminKeyboard()
    }).catch(() => {});
  }

  // ==================== ОБЫЧНЫЕ КНОПКИ ====================
  if (data === 'force_qr') {
    if (chatId !== OWNER_ID && countConnectedClients() >= MAX_USERS && !fs.existsSync(getUserAuthDir(chatId))) {
      return bot.answerCallbackQuery(query.id, { text: 'Все клиентские слоты заняты!', show_alert: true });
    }
    session.step = 'IDLE';
    await bot.answerCallbackQuery(query.id, { text: 'Генерирую QR-код...' });
    await bot.sendMessage(chatId, '⏳ Подключаюсь к WhatsApp для генерации QR-кода...');
    await startWhatsAppSession(chatId, {
      reset: true,
      phoneNumber: null,
      forceQr: true
    });
    return;
  }

  await ensureGroupsLoaded(chatId, session);

  if (data === 'b_back') {
    await bot.answerCallbackQuery(query.id);
    return sendDraftPreview(chatId, session, messageId).catch(() => {});
  }

  if (data.startsWith('b_one_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText(`🎯 *Выберите группу для отправки (Стр. ${page + 1}):*`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: buildSingleGroupKeyboard(session, page)
    }).catch(() => {});
  }

  if (data.startsWith('send_one:')) {
    const group = session.groupsCache[parseInt(data.split(':')[1], 10)];
    if (!group) return bot.answerCallbackQuery(query.id, { text: 'Группа не найдена', show_alert: true });
    await bot.answerCallbackQuery(query.id, { text: `Отправляю в ${group.subject.slice(0, 20)}...` });
    await broadcastMessage(chatId, session, [group]);
    return;
  }

  if (data === 'b_rand10') {
    const available = session.groupsCache.filter((g) => !session.excludedGroups.has(g.id));
    const shuffled = [...available];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    await bot.answerCallbackQuery(query.id, { text: 'Запуск рассылки в 10 групп...' });
    await broadcastMessage(chatId, session, shuffled.slice(0, 10));
    return;
  }

  if (data === 'b_all') {
    const available = session.groupsCache.filter((g) => !session.excludedGroups.has(g.id));
    await bot.answerCallbackQuery(query.id, { text: 'Запуск общей рассылки...' });
    await broadcastMessage(chatId, session, available);
    return;
  }

  // Перелистывание страниц исключений (из меню рассылки или из главного меню)
  if (data.startsWith('b_excl_page:') || data.startsWith('m_excl_page:')) {
    const isMain = data.startsWith('m_');
    const page = parseInt(data.split(':')[1], 10) || 0;
    const excludedCount = session.groupsCache.filter((g) => session.excludedGroups.has(g.id)).length;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText(
      `🚫 *Управление исключениями (Стр. ${page + 1})*\n` +
        `Исключено групп: *${excludedCount}* из *${session.groupsCache.length}*\n\n` +
        `Нажмите на группу, чтобы добавить или убрать из исключений:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: buildManageExclusionsKeyboard(session, page, isMain)
      }
    ).catch(() => {});
  }

  // Включение / выключение группы в исключениях
  if (data.startsWith('tog_excl:')) {
    const [, idxStr, pageStr, prefix] = data.split(':');
    const isMain = prefix === 'm';
    const group = session.groupsCache[parseInt(idxStr, 10)];
    const page = parseInt(pageStr, 10) || 0;

    if (!group) return bot.answerCallbackQuery(query.id, { text: 'Группа не найдена' });

    if (session.excludedGroups.has(group.id)) {
      session.excludedGroups.delete(group.id);
      await bot.answerCallbackQuery(query.id, { text: '✅ Возвращена в рассылку' });
    } else {
      session.excludedGroups.add(group.id);
      await bot.answerCallbackQuery(query.id, { text: '🚫 Добавлена в исключения' });
    }
    saveExcludedForUser(chatId, session);

    const excludedCount = session.groupsCache.filter((g) => session.excludedGroups.has(g.id)).length;
    return bot.editMessageText(
      `🚫 *Управление исключениями (Стр. ${page + 1})*\n` +
        `Исключено групп: *${excludedCount}* из *${session.groupsCache.length}*\n\n` +
        `Нажмите на группу, чтобы добавить или убрать из исключений:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: buildManageExclusionsKeyboard(session, page, isMain)
      }
    ).catch(() => {});
  }

  // Просмотр только исключенных групп
  if (data.startsWith('excl_only_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    const excludedList = session.groupsCache.filter((g) => session.excludedGroups.has(g.id));
    await bot.answerCallbackQuery(query.id);

    const title =
      excludedList.length === 0
        ? `✅ *Список исключений пуст.*`
        : `🚫 *Группы в исключениях (${excludedList.length}) — Стр. ${page + 1}:*\nНажмите на группу, чтобы вернуть её в рассылку:`;

    return bot.editMessageText(title, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: buildExcludedListKeyboard(session, page)
    }).catch(() => {});
  }

  // Удаление из исключений
  if (data.startsWith('rm_excl:')) {
    const [, idxStr, pageStr] = data.split(':');
    const group = session.groupsCache[parseInt(idxStr, 10)];
    const page = parseInt(pageStr, 10) || 0;

    if (group && session.excludedGroups.has(group.id)) {
      session.excludedGroups.delete(group.id);
      saveExcludedForUser(chatId, session);
      await bot.answerCallbackQuery(query.id, { text: '✅ Группа возвращена в рассылку' });
    } else {
      await bot.answerCallbackQuery(query.id);
    }

    const remaining = session.groupsCache.filter((g) => session.excludedGroups.has(g.id));
    const title =
      remaining.length === 0
        ? `✅ *Список исключений пуст.*`
        : `🚫 *Группы в исключениях (${remaining.length}):*\nНажмите на группу, чтобы вернуть её в рассылку:`;

    return bot.editMessageText(title, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: buildExcludedListKeyboard(session, page)
    }).catch(() => {});
  }
});

// ==================== АВТОЗАПУСК ====================
(async () => {
  await startTelegramPolling();

  try {
    const files = fs.readdirSync(__dirname);
    for (const file of files) {
      if (file.startsWith('auth_info_')) {
        const chatId = Number(file.replace('auth_info_', ''));
        const credsFile = path.join(__dirname, file, 'creds.json');
        if (chatId && (!bannedUsers.has(chatId) || chatId === OWNER_ID) && fs.existsSync(credsFile)) {
          try {
            const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
            if (creds && creds.registered) {
              console.log(`Восстановление активной сессии для ${chatId}...`);
              startWhatsAppSession(chatId, { reset: false });
            } else {
              clearUserAuthFolder(chatId);
            }
          } catch (_) {
            clearUserAuthFolder(chatId);
          }
        }
      }
    }
  } catch (err) {
    console.error('Ошибка при проверке старых сессий:', err.message);
  }
})();
