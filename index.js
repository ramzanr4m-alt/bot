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
const OWNER_ID = 5846687574;            // Главный создатель (неприкасаемый)
const SUB_ADMINS = new Set([8264531154]); // Младшие админы (ты можешь их банить, они тебя — нет)
const MAX_USERS = 25;                   // Максимум подключенных клиентов
const PAGE_SIZE = 26;

const logger = pino({ level: 'silent' });

// Проверка прав: главный админ всегда прав, младший админ — только если не в бане
function isOwner(chatId) {
  return Number(chatId) === OWNER_ID;
}

function isSubAdmin(chatId) {
  return SUB_ADMINS.has(Number(chatId));
}

function isAdmin(chatId) {
  const numId = Number(chatId);
  if (numId === OWNER_ID) return true;
  if (SUB_ADMINS.has(numId) && !bannedUsers.has(numId)) return true;
  return false;
}

// ==================== ЗАЩИТА ОТ ПАДЕНИЙ ====================
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err?.message || err);
});

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
  } catch (_) {}
}

function saveBanned() {
  try {
    fs.writeFileSync(BANNED_FILE, JSON.stringify([...bannedUsers], null, 2), 'utf-8');
  } catch (_) {}
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
  } catch (_) {}
}

function saveUsersMeta() {
  try {
    const obj = {};
    for (const [id, data] of usersMeta.entries()) {
      obj[id] = data;
    }
    fs.writeFileSync(META_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (_) {}
}

loadBanned();
loadUsersMeta();

// ==================== РАБОТА С ИСКЛЮЧЕНИЯМИ ====================
function getUserExclPath(chatId) {
  return path.join(__dirname, `excluded_${chatId}.json`);
}

function loadExcludedForUser(chatId, session) {
  try {
    const file = getUserExclPath(chatId);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed)) {
        session.excludedGroups = new Set(parsed.map((item) => String(item)));
      }
    }
  } catch (_) {}
}

function saveExcludedForUser(chatId, session) {
  try {
    const file = getUserExclPath(chatId);
    fs.writeFileSync(file, JSON.stringify([...session.excludedGroups], null, 2), 'utf-8');
  } catch (_) {}
}

function getUserSession(chatId) {
  const numId = Number(chatId);
  if (!sessions.has(numId)) {
    const savedMeta = usersMeta.get(numId) || {};
    const newSession = {
      sock: null,
      isConnected: false,
      wasEverConnected: false,
      isConnecting: false,
      isStopped: false,
      isBroadcasting: false,
      pairingSent: false,
      phoneNumber: null,
      forceQr: false,
      qrCount: 0,
      groupsCache: [],
      excludedGroups: new Set(),
      step: 'IDLE',
      draft: {
        type: 'text',
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

// Считаем только обычных клиентов (ты и младший админ слоты не занимаете)
function countConnectedClients() {
  let count = 0;
  for (const [id, s] of sessions.entries()) {
    if (!isOwner(id) && !isSubAdmin(id) && s.isConnected) {
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
    console.log('Telegram-бот успешно запущен.');
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

// ==================== КЛАВИАТУРЫ ====================
function getMainMenuKeyboard(chatId) {
  const keyboard = [
    [{ text: 'Войти в аккаунт' }, { text: 'Список групп' }],
    [{ text: 'Обновить список групп' }, { text: 'Список исключение' }],
    [{ text: 'Выйти из ватсап' }]
  ];
  if (isAdmin(chatId)) {
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
      [{ text: '🚫 Настроить исключения', callback_data: 'excl_open:0:b' }]
    ]
  };
}

// ==================== АДМИН-ПАНЕЛЬ С ИЕРАРХИЕЙ ====================
function getVisibleUserIds(viewerId) {
  const allIds = new Set([...sessions.keys(), ...bannedUsers, ...usersMeta.keys(), ...SUB_ADMINS]);
  // Главного создателя (OWNER_ID) никогда нет в списке на кик/бан
  allIds.delete(OWNER_ID);

  // Если панель открыл младший админ — убираем из списка его самого и других младших админов
  if (!isOwner(viewerId)) {
    for (const subId of SUB_ADMINS) {
      allIds.delete(subId);
    }
  }
  return [...allIds];
}

function buildAdminKeyboard(viewerId) {
  const rows = [];
  const clientIds = getVisibleUserIds(viewerId);

  for (const id of clientIds) {
    const s = sessions.get(id);
    const meta = usersMeta.get(id) || {};
    const isBanned = bannedUsers.has(id);
    const isConn = Boolean(s?.isConnected);
    const roleTag = isSubAdmin(id) ? '⭐️ [АДМИН] ' : '';
    const rawName = s?.name || meta.name || `ID:${id}`;
    const shortName = rawName.length > 12 ? rawName.slice(0, 12) + '…' : rawName;
    const statusDot = isBanned ? '🚫' : isConn ? '🟢' : '🔴';

    rows.push([{ text: `${statusDot} ${roleTag}${shortName} (${id})`, callback_data: 'noop' }]);

    const actionRow = [];
    if (isBanned) {
      actionRow.push({ text: '✅ Разбан', callback_data: `adm_unban:${id}` });
    } else {
      if (isConn) {
        actionRow.push({ text: '🔌 Кик WA', callback_data: `adm_kick:${id}` });
      }
      actionRow.push({ text: '🔨 Бан', callback_data: `adm_ban:${id}` });
      actionRow.push({ text: '🔄 Сброс', callback_data: `adm_reset:${id}` });
    }
    actionRow.push({ text: '🗑 Удалить', callback_data: `adm_del:${id}` });
    rows.push(actionRow);
  }

  rows.push([
    { text: '📢 Написать всем', callback_data: 'adm_msg_all' },
    { text: '🔄 Обновить', callback_data: 'adm_refresh' }
  ]);
  return { inline_keyboard: rows };
}

function buildAdminText(viewerId) {
  const clientIds = getVisibleUserIds(viewerId);
  const viewerSession = sessions.get(Number(viewerId));
  const roleTitle = isOwner(viewerId) ? 'Главный Создатель' : 'Администратор';

  let text = `👑 Панель управления (${roleTitle})\n\n`;
  text += `👤 Твой статус WA: ${viewerSession?.isConnected ? `🟢 Подключен (${viewerSession.groupsCache.length} гр.)` : '🔴 Не подключен'}\n`;
  text += `📊 Слоты клиентов: ${countConnectedClients()} из ${MAX_USERS}\n`;
  text += `👥 Доступно в списке: ${clientIds.length} чел.\n\n`;

  if (clientIds.length === 0) {
    text += `Пока ни один пользователь не запускал бота.`;
    return text;
  }

  text += `Список пользователей:\n`;
  for (const id of clientIds) {
    const s = sessions.get(id);
    const meta = usersMeta.get(id) || {};
    const isBanned = bannedUsers.has(id);
    const roleTag = isSubAdmin(id) ? '⭐️ [Мл. Админ] ' : '';

    const status = isBanned
      ? '🚫 ЗАБЛОКИРОВАН'
      : s?.isConnected
      ? `🟢 В сети (Групп: ${s.groupsCache.length})`
      : '🔴 Оффлайн';

    const name = s?.name || meta.name || 'Без имени';
    const user = s?.username || meta.username || '';
    text += `• ${roleTag}${name} ${user} [${id}] — ${status}\n`;
  }

  return text;
}

// ==================== КЛАВИАТУРЫ ПАГИНАЦИИ И ИСКЛЮЧЕНИЙ ====================
function buildSingleGroupKeyboard(session, page = 0) {
  const available = session.groupsCache
    .map((g, idx) => ({ ...g, idx }))
    .filter((g) => !session.excludedGroups.has(String(g.id)));

  const totalPages = Math.max(1, Math.ceil(available.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = available.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const rows = slice.map((g) => [
    { text: `💬 ${g.subject.slice(0, 42)}`, callback_data: `send_one:${g.idx}` }
  ]);

  const navRow = [];
  if (currentPage > 0) {
    navRow.push({ text: '⬅️ Назад', callback_data: `b_one_page:${currentPage - 1}` });
  }
  navRow.push({ text: `Стр. ${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages - 1) {
    navRow.push({ text: 'Вперёд ➡️', callback_data: `b_one_page:${currentPage + 1}` });
  }
  rows.push(navRow);
  rows.push([{ text: '🔙 Назад к выбору рассылки', callback_data: 'b_back' }]);

  return { inline_keyboard: rows };
}

async function renderExclusionsMenu(chatId, session, page = 0, mode = 'm', messageId = null) {
  const totalGroups = session.groupsCache.length;
  const totalPages = Math.max(1, Math.ceil(totalGroups / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const start = currentPage * PAGE_SIZE;
  const slice = session.groupsCache.slice(start, start + PAGE_SIZE);

  const excludedCount = session.groupsCache.filter((g) => session.excludedGroups.has(String(g.id))).length;

  const rows = slice.map((g, i) => {
    const globalIdx = start + i;
    const isExcl = session.excludedGroups.has(String(g.id));
    return [
      {
        text: `${isExcl ? '🚫 [ИСКЛ]' : '✅ [АКТИВ]'} ${g.subject.slice(0, 36)}`,
        callback_data: `excl_tog:${globalIdx}:${currentPage}:${mode}`
      }
    ];
  });

  const navRow = [];
  if (currentPage > 0) {
    navRow.push({ text: '⬅️ Назад', callback_data: `excl_open:${currentPage - 1}:${mode}` });
  }
  navRow.push({ text: `Стр. ${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages - 1) {
    navRow.push({ text: 'Вперёд ➡️', callback_data: `excl_open:${currentPage + 1}:${mode}` });
  }
  rows.push(navRow);

  if (excludedCount > 0) {
    rows.push([{ text: `🗑 Очистить все исключения (${excludedCount})`, callback_data: `excl_clear:${currentPage}:${mode}` }]);
  }

  if (mode === 'b') {
    rows.push([{ text: '🔙 Назад к меню рассылки', callback_data: 'b_back' }]);
  }

  const text =
    `🚫 Настройка списка исключений\n` +
    `Всего групп: ${totalGroups} | Исключено: ${excludedCount}\n` +
    `Страница: ${currentPage + 1} из ${totalPages}\n\n` +
    `Нажимайте на группы ниже, чтобы исключить их из рассылки (🚫) или вернуть обратно (✅):`;

  const reply_markup = { inline_keyboard: rows };

  if (messageId) {
    return bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup
    }).catch(() => {});
  }

  return bot.sendMessage(chatId, text, { reply_markup });
}

// ==================== ЯДРО WHATSAPP (BAILEYS) ====================
function getUserAuthDir(chatId) {
  return path.join(__dirname, `auth_info_${chatId}`);
}

function destroySocket(session) {
  if (!session) return;
  session.isStopped = true;
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
  } catch (_) {}
}

async function refreshGroupsCache(session) {
  if (!session.sock || !session.isConnected) {
    throw new Error('WhatsApp не подключен.');
  }
  const participating = await session.sock.groupFetchAllParticipating();
  session.groupsCache = Object.values(participating)
    .map((g) => ({ id: String(g.id), subject: g.subject || 'Без названия' }))
    .sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));
  return session.groupsCache;
}

async function ensureGroupsLoaded(chatId, session) {
  if (session.excludedGroups.size === 0) {
    loadExcludedForUser(chatId, session);
  }
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
  session.isStopped = false;

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
      if (session.isStopped) return;

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
                `🔐 Ваш код сопряжения WhatsApp:\n\n` +
                  `👉 ${formattedCode} 👈\n\n` +
                  `Как ввести код:\n` +
                  `1. Откройте WhatsApp на телефоне.\n` +
                  `2. Перейдите в Связанные устройства -> Привязка устройства.\n` +
                  `3. Нажмите внизу «Связать по номеру телефона» и введите этот код.`,
                {
                  reply_markup: {
                    inline_keyboard: [[{ text: '📷 Войти по QR-коду', callback_data: 'force_qr' }]]
                  }
                }
              );
            } catch (err) {
              session.forceQr = true;
              await sendQrCode(numId, qr, '⚠️ Отсканируйте резервный QR-код:');
            }
          }
        } else {
          session.qrCount++;
          if (session.qrCount <= 3) {
            await sendQrCode(numId, qr, `📷 Отсканируйте QR-код (${session.qrCount}/3):`);
          } else {
            destroySocket(session);
            clearUserAuthFolder(numId);
            await bot.sendMessage(
              numId,
              '⌛ Время ожидания QR-кода истекло. Нажмите «Войти в аккаунт» повторно.',
              getMainMenuKeyboard(numId)
            );
          }
        }
      }

      if (connection === 'open') {
        session.isConnected = true;
        session.wasEverConnected = true;
        session.isConnecting = false;
        session.pairingSent = false;
        session.phoneNumber = null;
        session.qrCount = 0;

        loadExcludedForUser(numId, session);

        try {
          await refreshGroupsCache(session);
        } catch (_) {}

        await bot.sendMessage(
          numId,
          `✅ WhatsApp успешно подключен!\n` +
            `Групп загружено: ${session.groupsCache.length}\n\n` +
            `Отправьте текст, фото или видео с подписью для рассылки.`,
          getMainMenuKeyboard(numId)
        );
      }

      if (connection === 'close') {
        const wasConnectedBefore = session.wasEverConnected;
        session.isConnected = false;
        session.isConnecting = false;

        if (session.isStopped) return;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMessage = String(lastDisconnect?.error?.message || lastDisconnect?.error || '');
        const isBadMac = errMessage.includes('Bad MAC');
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;

        if (isLoggedOut || isBadMac) {
          destroySocket(session);
          clearUserAuthFolder(numId);
          session.groupsCache = [];

          if (wasConnectedBefore) {
            session.wasEverConnected = false;
            await bot.sendMessage(
              numId,
              '🔴 Сессия WhatsApp завершена. Нажмите «Войти в аккаунт» для повторного подключения.',
              getMainMenuKeyboard(numId)
            ).catch(() => {});
          }
          return;
        }

        const isRegistered = Boolean(state?.creds?.registered);
        if (isRegistered || session.pairingSent || statusCode === DisconnectReason.restartRequired || statusCode === 515) {
          const delayMs = statusCode === DisconnectReason.restartRequired || statusCode === 515 ? 1200 : 4000;
          session.reconnectTimer = setTimeout(() => {
            if (!session.isStopped) {
              startWhatsAppSession(numId, { reset: false });
            }
          }, delayMs);
        } else {
          destroySocket(session);
          clearUserAuthFolder(numId);
        }
      }
    });
  } catch (err) {
    session.isConnecting = false;
    await bot.sendMessage(numId, `❌ Ошибка подключения: ${err.message}`).catch(() => {});
  }
}

async function sendQrCode(chatId, qrData, caption) {
  try {
    const buffer = await QRCode.toBuffer(qrData, { scale: 8, margin: 2 });
    await bot.sendPhoto(chatId, buffer, { caption });
  } catch (_) {}
}

// ==================== ФУНКЦИЯ РАССЫЛКИ ====================
async function broadcastMessage(chatId, session, targetGroups) {
  if (!session.sock || !session.isConnected) {
    return bot.sendMessage(chatId, '❌ WhatsApp не подключен. Сначала нажмите «Войти в аккаунт».');
  }
  if (session.isBroadcasting) {
    return bot.sendMessage(chatId, '⏳ Дождитесь завершения текущей рассылки!');
  }
  if (targetGroups.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Нет доступных групп для рассылки.');
  }

  const { type, text, fileId } = session.draft;
  if (type === 'text' && (!text || !text.trim())) {
    return bot.sendMessage(chatId, '⚠️ Сообщение пустое. Отправьте новый текст, фото или видео.');
  }

  session.isBroadcasting = true;
  let success = 0;
  let fails = 0;
  let statusMsg = null;

  try {
    statusMsg = await bot.sendMessage(
      chatId,
      `⏳ Начинаю рассылку по ${targetGroups.length} группам...`
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
      } catch (_) {
        fails++;
      }

      if (i < targetGroups.length - 1) {
        await delay(1500 + Math.floor(Math.random() * 500));
      }
    }

    const resultText = `✅ Рассылка завершена!\n\n📤 Успешно: ${success}\n❌ Ошибок: ${fails}`;
    if (statusMsg) {
      await bot.editMessageText(resultText, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      }).catch(() => {
        bot.sendMessage(chatId, resultText).catch(() => {});
      });
    }
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Ошибка рассылки: ${err.message}`).catch(() => {});
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

  const safePreview = `${header}\n\n${text || '(без подписи)'}\n\n👇 Выберите действие:`;
  if (messageId) {
    return bot.editMessageText(safePreview, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getBroadcastMenuKeyboard()
    }).catch(() => {});
  }
  return bot.sendMessage(chatId, safePreview, {
    reply_markup: getBroadcastMenuKeyboard()
  });
}

// ==================== ОБРАБОТЧИКИ КОМАНД TELEGRAM ====================
bot.onText(/^\/start/, async (msg) => {
  const chatId = Number(msg.chat.id);
  updateUserInfo(msg);

  if (bannedUsers.has(chatId) && !isOwner(chatId)) {
    return bot.sendMessage(chatId, '⛔ Доступ к боту закрыт главным администратором.');
  }

  const session = getUserSession(chatId);
  session.step = 'IDLE';
  await ensureGroupsLoaded(chatId, session);

  if (!isOwner(chatId) && !session.notifiedOwner) {
    session.notifiedOwner = true;
    usersMeta.set(chatId, {
      name: session.name,
      username: session.username,
      notifiedOwner: true
    });
    saveUsersMeta();

    bot.sendMessage(
      OWNER_ID,
      `🔔 Новый пользователь запустил бота:\nИмя: ${session.name} ${session.username}\nID: ${chatId}`
    ).catch(() => {});
  }

  await bot.sendMessage(
    chatId,
    `👋 Панель управления рассылками WhatsApp\n\n` +
      `Статус аккаунта: ${session.isConnected ? '🟢 Подключен' : '🔴 Не подключен'}\n` +
      `Групп загружено: ${session.groupsCache.length}\n` +
      `В исключениях: ${session.excludedGroups.size}\n` +
      `Свободных слотов: ${Math.max(0, MAX_USERS - countConnectedClients())}/${MAX_USERS}\n\n` +
      `Отправьте текст, фото или видео для рассылки, либо выберите кнопку в меню:`,
    getMainMenuKeyboard(chatId)
  );
});

bot.on('message', async (msg) => {
  const chatId = Number(msg.chat.id);
  const text = msg.text;

  if (text && text.startsWith('/start')) return;
  updateUserInfo(msg);

  if (bannedUsers.has(chatId) && !isOwner(chatId)) {
    return bot.sendMessage(chatId, '⛔ Доступ к боту закрыт главным администратором.');
  }

  const session = getUserSession(chatId);

  if (isAdmin(chatId) && session.step === 'AWAITING_ADMIN_BROADCAST' && text) {
    session.step = 'IDLE';
    if (text === 'Отмена' || text === '👑 Админ-панель') {
      return bot.sendMessage(chatId, '❌ Рассылка отменена.', getMainMenuKeyboard(chatId));
    }
    const targetIds = getVisibleUserIds(chatId);
    let sent = 0;
    for (const id of targetIds) {
      if (!bannedUsers.has(id)) {
        try {
          await bot.sendMessage(id, `📢 Сообщение от администратора:\n\n${text}`);
          sent++;
        } catch (_) {}
      }
    }
    return bot.sendMessage(chatId, `✅ Доставлено: ${sent} чел.`, getMainMenuKeyboard(chatId));
  }

  if (text === '👑 Админ-панель' && isAdmin(chatId)) {
    session.step = 'IDLE';
    return bot.sendMessage(chatId, buildAdminText(chatId), {
      reply_markup: buildAdminKeyboard(chatId)
    });
  }

  if (text === 'Войти в аккаунт') {
    if (session.isConnected) {
      return bot.sendMessage(chatId, '🟢 Ваш WhatsApp уже подключен!', getMainMenuKeyboard(chatId));
    }

    if (!isAdmin(chatId) && countConnectedClients() >= MAX_USERS && !fs.existsSync(getUserAuthDir(chatId))) {
      return bot.sendMessage(chatId, `⚠️ Все клиентские слоты заняты (${MAX_USERS}/${MAX_USERS}).`);
    }

    session.step = 'AWAITING_PHONE';
    return bot.sendMessage(
      chatId,
      '📱 Введите ваш номер телефона WhatsApp (например: 79281234567):\n\nИли нажмите кнопку ниже для входа по QR-коду:',
      {
        reply_markup: {
          inline_keyboard: [[{ text: '📷 Войти по QR-коду', callback_data: 'force_qr' }]]
        }
      }
    );
  }

  if (text === 'Список групп') {
    session.step = 'IDLE';
    if (!session.isConnected) return bot.sendMessage(chatId, '🔴 WhatsApp не подключен.');
    await ensureGroupsLoaded(chatId, session);
    if (session.groupsCache.length === 0) return bot.sendMessage(chatId, '📭 Группы не найдены.');

    const lines = session.groupsCache.map((g, idx) => {
      const mark = session.excludedGroups.has(String(g.id)) ? ' 🚫 [Исключена]' : '';
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
    const waitMsg = await bot.sendMessage(chatId, '🔄 Загружаю группы из WhatsApp...');
    try {
      await refreshGroupsCache(session);
      await bot.editMessageText(`✅ Список обновлён! Групп: ${session.groupsCache.length}`, {
        chat_id: chatId,
        message_id: waitMsg.message_id
      });
    } catch (err) {
      await bot.editMessageText(`❌ Ошибка: ${err.message}`, {
        chat_id: chatId,
        message_id: waitMsg.message_id
      });
    }
    return;
  }

  if (text === 'Список исключение' || text === 'Список исключений') {
    session.step = 'IDLE';
    if (!session.isConnected) {
      return bot.sendMessage(chatId, '🔴 Сначала подключите WhatsApp через «Войти в аккаунт».');
    }
    await ensureGroupsLoaded(chatId, session);
    if (session.groupsCache.length === 0) {
      return bot.sendMessage(chatId, '📭 В вашем WhatsApp нет доступных групп.');
    }

    return renderExclusionsMenu(chatId, session, 0, 'm', null);
  }

  if (text === 'Выйти из ватсап') {
    session.step = 'IDLE';
    session.wasEverConnected = false;
    if (session.sock) {
      try { await session.sock.logout().catch(() => {}); } catch (_) {}
    }
    destroySocket(session);
    clearUserAuthFolder(chatId);
    session.groupsCache = [];

    return bot.sendMessage(
      chatId,
      '👋 Сессия WhatsApp удалена. Нажмите «Войти в аккаунт» для нового подключения.',
      getMainMenuKeyboard(chatId)
    );
  }

  if (session.step === 'AWAITING_PHONE' && text) {
    let cleanPhone = text.replace(/\D/g, '');
    if (cleanPhone.length === 11 && cleanPhone.startsWith('8')) {
      cleanPhone = '7' + cleanPhone.slice(1);
    }

    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return bot.sendMessage(chatId, '⚠️ Введите корректный номер начиная с 7 (например: 79281234567):');
    }

    session.step = 'IDLE';
    await bot.sendMessage(chatId, `⏳ Запрашиваю код для +${cleanPhone}... Подождите 3–5 секунд.`);

    await startWhatsAppSession(chatId, {
      reset: true,
      phoneNumber: cleanPhone,
      forceQr: false
    });
    return;
  }

  if (!session.isConnected) {
    return bot.sendMessage(chatId, '⚠️ Сначала подключите WhatsApp через кнопку «Войти в аккаунт».', getMainMenuKeyboard(chatId));
  }

  await ensureGroupsLoaded(chatId, session);

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

  if (bannedUsers.has(chatId) && !isOwner(chatId)) {
    return bot.answerCallbackQuery(query.id, { text: 'Доступ закрыт главным администратором.', show_alert: true });
  }

  const session = getUserSession(chatId);

  if (data === 'noop') return bot.answerCallbackQuery(query.id);

  // Админ-кнопки (доступны тебе и младшему админу, если она не в бане)
  if (data.startsWith('adm_') && isAdmin(chatId)) {
    if (data === 'adm_refresh') {
      await bot.answerCallbackQuery(query.id, { text: 'Обновлено' });
      return bot.editMessageText(buildAdminText(chatId), {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buildAdminKeyboard(chatId)
      }).catch(() => {});
    }

    if (data === 'adm_msg_all') {
      session.step = 'AWAITING_ADMIN_BROADCAST';
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, '📢 Введите текст сообщения для всех клиентов (или напишите Отмена):');
    }

    const [action, targetIdStr] = data.split(':');
    const targetId = Number(targetIdStr);

    // ЖЕСТКАЯ ЗАЩИТА: никто и никогда не может тронуть Главного Создателя (OWNER_ID)
    if (isOwner(targetId)) {
      return bot.answerCallbackQuery(query.id, {
        text: '⛔ Невозможно применить это действие к Главному Создателю!',
        show_alert: true
      });
    }

    // Младший админ не может трогать других младших админов или саму себя
    if (!isOwner(chatId) && isSubAdmin(targetId)) {
      return bot.answerCallbackQuery(query.id, {
        text: '⛔ Управлять администраторами может только Главный Создатель!',
        show_alert: true
      });
    }

    if (action === 'adm_kick') {
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        targetSession.wasEverConnected = false;
        if (targetSession.sock) {
          try { await targetSession.sock.logout().catch(() => {}); } catch (_) {}
        }
        destroySocket(targetSession);
        targetSession.groupsCache = [];
      }
      clearUserAuthFolder(targetId);
      bot.sendMessage(targetId, '⚠️ Ваша сессия WhatsApp отключена администратором.').catch(() => {});
      await bot.answerCallbackQuery(query.id, { text: 'Отключен' });
    }

    if (action === 'adm_ban') {
      bannedUsers.add(targetId);
      saveBanned();
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        targetSession.wasEverConnected = false;
        if (targetSession.sock) {
          try { await targetSession.sock.logout().catch(() => {}); } catch (_) {}
        }
        destroySocket(targetSession);
        targetSession.groupsCache = [];
      }
      clearUserAuthFolder(targetId);
      bot.sendMessage(targetId, '⛔ Доступ к боту закрыт администратором.', getMainMenuKeyboard(targetId)).catch(() => {});
      await bot.answerCallbackQuery(query.id, { text: 'Заблокирован' });
    }

    if (action === 'adm_unban') {
      bannedUsers.delete(targetId);
      saveBanned();
      bot.sendMessage(targetId, '✅ Доступ к боту открыт! Нажмите /start', getMainMenuKeyboard(targetId)).catch(() => {});
      await bot.answerCallbackQuery(query.id, { text: 'Разблокирован' });
    }

    if (action === 'adm_reset') {
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        targetSession.wasEverConnected = false;
        destroySocket(targetSession);
        targetSession.groupsCache = [];
      }
      clearUserAuthFolder(targetId);
      await bot.answerCallbackQuery(query.id, { text: 'Сессия сброшена' });
    }

    if (action === 'adm_del') {
      const targetSession = sessions.get(targetId);
      if (targetSession) {
        targetSession.wasEverConnected = false;
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
      await bot.answerCallbackQuery(query.id, { text: 'Удален' });
    }

    return bot.editMessageText(buildAdminText(chatId), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildAdminKeyboard(chatId)
    }).catch(() => {});
  }

  // Вход по QR
  if (data === 'force_qr') {
    session.step = 'IDLE';
    await bot.answerCallbackQuery(query.id, { text: 'Генерирую QR...' });
    await bot.sendMessage(chatId, '⏳ Подключаюсь для создания QR-кода...');
    await startWhatsAppSession(chatId, { reset: true, phoneNumber: null, forceQr: true });
    return;
  }

  await ensureGroupsLoaded(chatId, session);

  if (data === 'b_back') {
    await bot.answerCallbackQuery(query.id);
    return sendDraftPreview(chatId, session, messageId);
  }

  // Выбор 1 группы
  if (data.startsWith('b_one_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText(`🎯 Выберите группу для отправки (Стр. ${page + 1}):`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildSingleGroupKeyboard(session, page)
    }).catch(() => {});
  }

  if (data.startsWith('send_one:')) {
    const group = session.groupsCache[parseInt(data.split(':')[1], 10)];
    if (!group) return bot.answerCallbackQuery(query.id, { text: 'Группа не найдена', show_alert: true });
    await bot.answerCallbackQuery(query.id, { text: 'Отправляю...' });
    await broadcastMessage(chatId, session, [group]);
    return;
  }

  if (data === 'b_rand10') {
    const available = session.groupsCache.filter((g) => !session.excludedGroups.has(String(g.id)));
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
    const available = session.groupsCache.filter((g) => !session.excludedGroups.has(String(g.id)));
    await bot.answerCallbackQuery(query.id, { text: 'Запуск общей рассылки...' });
    await broadcastMessage(chatId, session, available);
    return;
  }

  // ==================== УПРАВЛЕНИЕ ИСКЛЮЧЕНИЯМИ ====================
  if (data.startsWith('excl_open:') || data.startsWith('b_excl_page:') || data.startsWith('excl_page:')) {
    const parts = data.split(':');
    const page = parseInt(parts[1], 10) || 0;
    const mode = parts[2] || (data.startsWith('b_') ? 'b' : 'm');
    await bot.answerCallbackQuery(query.id);
    return renderExclusionsMenu(chatId, session, page, mode, messageId);
  }

  if (data.startsWith('excl_tog:') || data.startsWith('tog_excl:')) {
    const parts = data.split(':');
    const idx = parseInt(parts[1], 10);
    const page = parseInt(parts[2], 10) || 0;
    const mode = parts[3] || 'm';

    const group = session.groupsCache[idx];
    if (!group) {
      return bot.answerCallbackQuery(query.id, { text: 'Группа не найдена, обновите список' });
    }

    const gid = String(group.id);
    if (session.excludedGroups.has(gid)) {
      session.excludedGroups.delete(gid);
      await bot.answerCallbackQuery(query.id, { text: '✅ Возвращена в рассылку' });
    } else {
      session.excludedGroups.add(gid);
      await bot.answerCallbackQuery(query.id, { text: '🚫 Добавлена в исключения' });
    }
    saveExcludedForUser(chatId, session);

    return renderExclusionsMenu(chatId, session, page, mode, messageId);
  }

  if (data.startsWith('excl_clear:')) {
    const parts = data.split(':');
    const page = parseInt(parts[1], 10) || 0;
    const mode = parts[2] || 'm';

    session.excludedGroups.clear();
    saveExcludedForUser(chatId, session);
    await bot.answerCallbackQuery(query.id, { text: '✅ Все исключения очищены!' });

    return renderExclusionsMenu(chatId, session, page, mode, messageId);
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
        if (chatId && (!bannedUsers.has(chatId) || isOwner(chatId))) {
          if (fs.existsSync(credsFile)) {
            try {
              const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
              if (creds && creds.registered) {
                console.log(`Восстановление сессии для ${chatId}...`);
                startWhatsAppSession(chatId, { reset: false });
              } else {
                clearUserAuthFolder(chatId);
              }
            } catch (_) {
              clearUserAuthFolder(chatId);
            }
          } else {
            clearUserAuthFolder(chatId);
          }
        }
      }
    }
  } catch (err) {
    console.error('Ошибка проверки сессий:', err.message);
  }
})();
