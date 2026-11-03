const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const makeWASocket = baileys.default?.default || baileys.default || baileys;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  delay
} = baileys;

// ==================== КОНФИГУРАЦИЯ ====================
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

if (!TELEGRAM_TOKEN) {
  console.error('КРИТИЧЕСКАЯ ОШИБКА: Не задана переменная окружения TELEGRAM_TOKEN');
  process.exit(1);
}

const PAGE_SIZE = 8;

// ==================== HTTP-СЕРВЕР ДЛЯ RENDER ====================
const app = express();

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    activeSessions: sessions.size,
    uptime: process.uptime()
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP-сервер запущен на порту ${PORT}`);
});

// ==================== УПРАВЛЕНИЕ СЕССИЯМИ ПОЛЬЗОВАТЕЛЕЙ ====================
// Ключ карты — Telegram chatId каждого нового пользователя
const sessions = new Map();

function getUserSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      sock: null,
      isConnected: false,
      isConnecting: false,
      groupsCache: [],
      excludedGroups: new Set(),
      step: 'IDLE',
      draftText: ''
    });
  }
  return sessions.get(chatId);
}

// ==================== РАБОТА С ИСКЛЮЧЕНИЯМИ (JSON) ====================
function loadExcludedForUser(chatId, session) {
  try {
    const userExclFile = path.join(__dirname, `excluded_${chatId}.json`);
    if (fs.existsSync(userExclFile)) {
      const raw = fs.readFileSync(userExclFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        session.excludedGroups = new Set(parsed);
      }
    }
  } catch (err) {
    console.error(`Ошибка чтения исключений для ${chatId}:`, err.message);
  }
}

function saveExcludedForUser(chatId, session) {
  try {
    const userExclFile = path.join(__dirname, `excluded_${chatId}.json`);
    fs.writeFileSync(userExclFile, JSON.stringify([...session.excludedGroups], null, 2), 'utf-8');
  } catch (err) {
    console.error(`Ошибка записи исключений для ${chatId}:`, err.message);
  }
}

// ==================== ИНИЦИАЛИЗАЦИЯ TELEGRAM-БОТА ====================
const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    autoStart: false,
    params: { timeout: 30 }
  }
});

let pollingRestartTimer = null;

async function startTelegramPolling() {
  try {
    await bot.deleteWebHook();
    await bot.startPolling();
    console.log('Telegram-бот успешно запущен в режиме Long Polling.');
  } catch (err) {
    console.error('Ошибка старта polling:', err.message);
  }
}

bot.on('polling_error', async (err) => {
  const msg = err?.message || '';
  if (msg.includes('409 Conflict')) {
    console.warn('Обнаружен конфликт 409. Ожидание 5 сек...');
    if (pollingRestartTimer) return;
    try {
      await bot.stopPolling();
    } catch (_) {}
    pollingRestartTimer = setTimeout(async () => {
      pollingRestartTimer = null;
      await startTelegramPolling();
    }, 5000);
  } else {
    console.error('Ошибка polling:', msg);
  }
});

async function gracefulShutdown(signal) {
  console.log(`Получен сигнал ${signal}. Завершение работы...`);
  try {
    await bot.stopPolling();
  } catch (_) {}
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ==================== КЛАВИАТУРЫ TELEGRAM ====================
const MAIN_MENU_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: 'Войти в аккаунт' }, { text: 'Список групп' }],
      [{ text: 'Обновить список групп' }, { text: 'Список исключение' }],
      [{ text: 'Выйти из ватсап' }]
    ],
    resize_keyboard: true
  }
};

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

function buildSingleGroupKeyboard(session, page = 0) {
  const available = session.groupsCache
    .map((g, idx) => ({ ...g, idx }))
    .filter((g) => !session.excludedGroups.has(g.id));

  const totalPages = Math.max(1, Math.ceil(available.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = available.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const rows = slice.map((g) => [
    { text: `💬 ${g.subject}`, callback_data: `send_one:${g.idx}` }
  ]);

  const navRow = [];
  if (currentPage > 0) navRow.push({ text: '⬅️ Назад', callback_data: `b_one_page:${currentPage - 1}` });
  navRow.push({ text: `${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages - 1) navRow.push({ text: 'Вперёд ➡️', callback_data: `b_one_page:${currentPage + 1}` });
  rows.push(navRow);
  rows.push([{ text: '🔙 Назад к действиям', callback_data: 'b_back' }]);

  return { inline_keyboard: rows };
}

function buildManageExclusionsKeyboard(session, page = 0) {
  const totalPages = Math.max(1, Math.ceil(session.groupsCache.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const start = currentPage * PAGE_SIZE;
  const slice = session.groupsCache.slice(start, start + PAGE_SIZE);

  const rows = slice.map((g, i) => {
    const globalIdx = start + i;
    const isExcl = session.excludedGroups.has(g.id);
    return [
      { text: `${isExcl ? '🚫 [ИСКЛ]' : '✅'} ${g.subject}`, callback_data: `tog_excl:${globalIdx}:${currentPage}` }
    ];
  });

  const navRow = [];
  if (currentPage > 0) navRow.push({ text: '⬅️ Назад', callback_data: `b_excl_page:${currentPage - 1}` });
  navRow.push({ text: `${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages - 1) navRow.push({ text: 'Вперёд ➡️', callback_data: `b_excl_page:${currentPage + 1}` });
  rows.push(navRow);
  rows.push([{ text: '🔙 Назад к действиям', callback_data: 'b_back' }]);

  return { inline_keyboard: rows };
}

function buildExcludedListKeyboard(session, page = 0) {
  const excludedArray = session.groupsCache
    .map((g, idx) => ({ ...g, idx }))
    .filter((g) => session.excludedGroups.has(g.id));

  if (excludedArray.length === 0) return { inline_keyboard: [] };

  const totalPages = Math.max(1, Math.ceil(excludedArray.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = excludedArray.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const rows = slice.map((g) => [
    { text: `❌ Убрать: ${g.subject}`, callback_data: `rm_excl:${g.idx}:${currentPage}` }
  ]);

  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 0) navRow.push({ text: '⬅️ Назад', callback_data: `excl_list_page:${currentPage - 1}` });
    navRow.push({ text: `${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
    if (currentPage < totalPages - 1) navRow.push({ text: 'Вперёд ➡️', callback_data: `excl_list_page:${currentPage + 1}` });
    rows.push(navRow);
  }

  return { inline_keyboard: rows };
}

// ==================== ЛОГИКА WHATSAPP ДЛЯ ПОЛЬЗОВАТЕЛЯ ====================
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

function clearUserAuthFolder(chatId) {
  try {
    const userAuthDir = path.join(__dirname, `auth_info_${chatId}`);
    if (fs.existsSync(userAuthDir)) {
      fs.rmSync(userAuthDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Ошибка удаления папки сессии для ${chatId}:`, err.message);
  }
}

async function connectToWhatsApp(chatId, phoneNumber = null, forceQr = false) {
  const session = getUserSession(chatId);
  if (session.isConnecting) return;
  session.isConnecting = true;

  try {
    if (session.sock) {
      try {
        session.sock.ev.removeAllListeners();
        session.sock.ws.close();
      } catch (_) {}
      session.sock = null;
    }

    const userAuthDir = path.join(__dirname, `auth_info_${chatId}`);
    const { state, saveCreds } = await useMultiFileAuthState(userAuthDir);
    const { version } = await fetchLatestBaileysVersion();

    session.sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    session.sock.ev.on('creds.update', saveCreds);

    let pairingCodeSent = false;

    session.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !state.creds.registered) {
        if (phoneNumber && !forceQr && !pairingCodeSent) {
          pairingCodeSent = true;
          try {
            await delay(2000);
            const code = await session.sock.requestPairingCode(phoneNumber);
            const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;

            await bot.sendMessage(
              chatId,
              `🔐 *Код сопряжения WhatsApp:*\n\n\`${formattedCode}\`\n\n` +
                `1. Откройте WhatsApp на телефоне.\n` +
                `2. Связанные устройства -> Привязка устройства -> Связать по номеру.`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[{ text: '📷 Получить QR-код (резерв)', callback_data: 'force_qr' }]]
                }
              }
            );
          } catch (err) {
            console.error('Ошибка запроса Pairing Code:', err.message);
            await sendQrToTelegram(chatId, qr, '⚠️ Не удалось запросить код по номеру. Отсканируйте QR-код:');
          }
        } else if (!phoneNumber || forceQr) {
          await sendQrToTelegram(chatId, qr, '📷 Отсканируйте этот QR-код в WhatsApp:');
        }
      }

      if (connection === 'open') {
        session.isConnected = true;
        session.isConnecting = false;
        console.log(`WhatsApp успешно подключен для пользователя ${chatId}!`);

        loadExcludedForUser(chatId, session);

        try {
          await refreshGroupsCache(session);
        } catch (err) {
          console.error('Не удалось загрузить группы:', err.message);
        }

        await bot.sendMessage(
          chatId,
          `✅ *WhatsApp успешно подключен!*\nЗагружено групп: *${session.groupsCache.length}*\n\nОтправьте текст для рассылки.`,
          { parse_mode: 'Markdown', ...MAIN_MENU_KEYBOARD }
        );
      }

      if (connection === 'close') {
        session.isConnected = false;
        session.isConnecting = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (statusCode === DisconnectReason.loggedOut) {
          clearUserAuthFolder(chatId);
          session.groupsCache = [];
          await bot.sendMessage(chatId, '⚠️ Сессия завершена (разлогин).', MAIN_MENU_KEYBOARD);
        } else if (shouldReconnect && fs.existsSync(path.join(userAuthDir, 'creds.json'))) {
          if (state.creds.registered) {
            setTimeout(() => connectToWhatsApp(chatId, null, false), 5000);
          }
        }
      }
    });
  } catch (err) {
    session.isConnecting = false;
    console.error(`Ошибка инициализации WhatsApp для ${chatId}:`, err.message);
    await bot.sendMessage(chatId, `❌ Ошибка инициализации: ${err.message}`);
  }
}

async function sendQrToTelegram(chatId, qrData, captionText) {
  try {
    const qrBuffer = await QRCode.toBuffer(qrData, { scale: 8, margin: 2 });
    await bot.sendPhoto(chatId, qrBuffer, { caption: captionText });
  } catch (err) {
    console.error('Ошибка генерации QR:', err.message);
  }
}

async function broadcastMessage(chatId, session, targetGroups, text) {
  if (!session.sock || !session.isConnected) {
    return bot.sendMessage(chatId, '❌ WhatsApp не подключен. Сначала войдите.');
  }
  if (targetGroups.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Нет доступных групп для рассылки.');
  }

  let sentCount = 0;
  let errorCount = 0;

  const statusMsg = await bot.sendMessage(chatId, `⏳ Рассылка по *${targetGroups.length}* группам...`, { parse_mode: 'Markdown' });

  for (let i = 0; i < targetGroups.length; i++) {
    const group = targetGroups[i];
    try {
      await session.sock.sendMessage(group.id, { text });
      sentCount++;
    } catch (err) {
      errorCount++;
    }

    if (i < targetGroups.length - 1) {
      await delay(Math.floor(1500 + Math.random() * 500));
    }
  }

  try {
    await bot.editMessageText(`✅ *Рассылка завершена!*\n\nУспешно: *${sentCount}*\nОшибок: *${errorCount}*`, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown'
    });
  } catch (_) {
    await bot.sendMessage(chatId, `✅ Рассылка завершена! Успешно: ${sentCount}, Ошибок: ${errorCount}`);
  }
}

// ==================== ОБРАБОТЧИКИ TELEGRAM ====================
bot.onText(/^\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getUserSession(chatId);
  session.step = 'IDLE';
  loadExcludedForUser(chatId, session);

  await bot.sendMessage(
    chatId,
    `👋 *Панель рассылок WhatsApp*\n\n` +
      `Статус вашего WhatsApp: ${session.isConnected ? '🟢 Подключен' : '🔴 Не подключен'}\n` +
      `Ваших групп в кэше: *${session.groupsCache.length}*\n\n` +
      `Выберите действие:`,
    { parse_mode: 'Markdown', ...MAIN_MENU_KEYBOARD }
  );
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/start')) return;

  const session = getUserSession(chatId);

  if (text === 'Войти в аккаунт') {
    if (session.isConnected) {
      return bot.sendMessage(chatId, '🟢 Вы уже авторизованы в своем WhatsApp!', MAIN_MENU_KEYBOARD);
    }
    session.step = 'AWAITING_PHONE';
    return bot.sendMessage(
      chatId,
      '📱 Введите ваш номер телефона WhatsApp в международном формате (например, `79991234567`):',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📷 Войти по QR-коду', callback_data: 'force_qr' }]] } }
    );
  }

  if (text === 'Список групп') {
    if (!session.isConnected) return bot.sendMessage(chatId, '🔴 WhatsApp не подключен.');
    if (session.groupsCache.length === 0) {
      try { await refreshGroupsCache(session); } catch (e) { return bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
    }
    if (session.groupsCache.length === 0) return bot.sendMessage(chatId, '📭 Список групп пуст.');

    const lines = session.groupsCache.map((g, idx) => {
      const mark = session.excludedGroups.has(g.id) ? ' 🚫 [Исключена]' : '';
      return `${idx + 1}. ${g.subject}${mark}`;
    });

    let chunk = `📋 *Ваши группы (${session.groupsCache.length}):*\n\n`;
    for (const line of lines) {
      if ((chunk + line + '\n').length > 3800) {
        await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
        chunk = '';
      }
      chunk += line + '\n';
    }
    if (chunk) await bot.sendMessage(chatId, chunk);
    return;
  }

  if (text === 'Обновить список групп') {
    if (!session.isConnected) return bot.sendMessage(chatId, '🔴 WhatsApp не подключен.');
    const waitMsg = await bot.sendMessage(chatId, '🔄 Обновляю список...');
    try {
      await refreshGroupsCache(session);
      await bot.editMessageText(`✅ Список обновлен! Групп: *${session.groupsCache.length}*`, {
        chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown'
      });
    } catch (err) {
      await bot.editMessageText(`❌ Ошибка: ${err.message}`, { chat_id: chatId, message_id: waitMsg.message_id });
    }
    return;
  }

  if (text === 'Список исключение') {
    const excludedList = session.groupsCache.filter((g) => session.excludedGroups.has(g.id));
    if (excludedList.length === 0) return bot.sendMessage(chatId, '✅ Список исключений пуст.');
    return bot.sendMessage(chatId, `🚫 *Исключения (${excludedList.length}):* Нажмите, чтобы убрать:`, {
      parse_mode: 'Markdown',
      reply_markup: buildExcludedListKeyboard(session, 0)
    });
  }

  if (text === 'Выйти из ватсап') {
    session.step = 'IDLE';
    try {
      if (session.sock) {
        await session.sock.logout().catch(() => {});
        session.sock.ev.removeAllListeners();
        session.sock.ws.close();
        session.sock = null;
      }
    } catch (_) {}

    session.isConnected = false;
    session.groupsCache = [];
    clearUserAuthFolder(chatId);

    return bot.sendMessage(chatId, '👋 Вы вышли из своего аккаунта WhatsApp.', MAIN_MENU_KEYBOARD);
  }

  if (session.step === 'AWAITING_PHONE') {
    const cleanPhone = text.replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return bot.sendMessage(chatId, '⚠️ Некорректный формат номера. Введите от 10 до 15 цифр:');
    }

    session.step = 'IDLE';
    clearUserAuthFolder(chatId);
    await bot.sendMessage(chatId, `⏳ Запрашиваю код для \`+${cleanPhone}\`...`, { parse_mode: 'Markdown' });
    await connectToWhatsApp(chatId, cleanPhone, false);
    return;
  }

  if (!session.isConnected) {
    return bot.sendMessage(chatId, '⚠️ WhatsApp не подключен! Нажмите «Войти в аккаунт».', MAIN_MENU_KEYBOARD);
  }

  if (session.groupsCache.length === 0) {
    try { await refreshGroupsCache(session); } catch (_) {}
  }

  session.draftText = text;
  await bot.sendMessage(chatId, `📝 *Текст сохранен:*\n\n${text}\n\n👇 Выберите действие:`, {
    parse_mode: 'Markdown',
    reply_markup: getBroadcastMenuKeyboard()
  });
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  const session = getUserSession(chatId);

  if (data === 'noop') return bot.answerCallbackQuery(query.id);

  if (data === 'force_qr') {
    session.step = 'IDLE';
    await bot.answerCallbackQuery(query.id, { text: 'Генерация QR...' });
    clearUserAuthFolder(chatId);
    await connectToWhatsApp(chatId, null, true);
    return;
  }

  if (data === 'b_back') {
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText(`📝 *Текст сохранен:*\n\n${session.draftText || '(пусто)'}\n\n👇 Выберите действие:`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBroadcastMenuKeyboard()
    });
  }

  if (data.startsWith('b_one_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText('🎯 *Выберите группу:*', {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: buildSingleGroupKeyboard(session, page)
    });
  }

  if (data.startsWith('send_one:')) {
    const group = session.groupsCache[parseInt(data.split(':')[1], 10)];
    if (!group) return bot.answerCallbackQuery(query.id, { text: 'Не найдено', show_alert: true });
    await bot.answerCallbackQuery(query.id, { text: `Отправка в ${group.subject}...` });
    await broadcastMessage(chatId, session, [group], session.draftText);
    return;
  }

  if (data === 'b_rand10') {
    const available = session.groupsCache.filter((g) => !session.excludedGroups.has(g.id));
    const shuffled = [...available].sort(() => 0.5 - Math.random());
    await bot.answerCallbackQuery(query.id, { text: 'Запуск рассылки...' });
    await broadcastMessage(chatId, session, shuffled.slice(0, 10), session.draftText);
    return;
  }

  if (data === 'b_all') {
    const available = session.groupsCache.filter((g) => !session.excludedGroups.has(g.id));
    await bot.answerCallbackQuery(query.id, { text: 'Запуск рассылки...' });
    await broadcastMessage(chatId, session, available, session.draftText);
    return;
  }

  if (data.startsWith('b_excl_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText('🚫 *Управление исключениями:*', {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: buildManageExclusionsKeyboard(session, page)
    });
  }

  if (data.startsWith('tog_excl:')) {
    const [, idxStr, pageStr] = data.split(':');
    const group = session.groupsCache[parseInt(idxStr, 10)];
    const page = parseInt(pageStr, 10) || 0;

    if (!group) return bot.answerCallbackQuery(query.id);

    if (session.excludedGroups.has(group.id)) {
      session.excludedGroups.delete(group.id);
    } else {
      session.excludedGroups.add(group.id);
    }
    saveExcludedForUser(chatId, session);

    await bot.answerCallbackQuery(query.id, { text: 'Обновлено' });
    return bot.editMessageReplyMarkup(buildManageExclusionsKeyboard(session, page), { chat_id: chatId, message_id: messageId });
  }

  if (data.startsWith('excl_list_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageReplyMarkup(buildExcludedListKeyboard(session, page), { chat_id: chatId, message_id: messageId });
  }

  if (data.startsWith('rm_excl:')) {
    const [, idxStr, pageStr] = data.split(':');
    const group = session.groupsCache[parseInt(idxStr, 10)];
    const page = parseInt(pageStr, 10) || 0;

    if (group && session.excludedGroups.has(group.id)) {
      session.excludedGroups.delete(group.id);
      saveExcludedForUser(chatId, session);
      await bot.answerCallbackQuery(query.id, { text: 'Удалено из исключений' });
    }

    const remaining = session.groupsCache.filter((g) => session.excludedGroups.has(g.id));
    if (remaining.length === 0) {
      return bot.editMessageText('✅ Список исключений пуст.', { chat_id: chatId, message_id: messageId });
    }

    return bot.editMessageText(`🚫 *Исключения (${remaining.length}):*`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: buildExcludedListKeyboard(session, page)
    });
  }
});

// ==================== ЗАПУСК ====================
(async () => {
  await startTelegramPolling();

  // Автоматически поднимаем сессии для всех, кто уже авторизовался ранее
  fs.readdirSync(__dirname).forEach((file) => {
    if (file.startsWith('auth_info_')) {
      const chatId = Number(file.replace('auth_info_', ''));
      if (chatId) {
        console.log(`Обнаружена сохраненная сессия WhatsApp для пользователя ${chatId}. Подключение...`);
        connectToWhatsApp(chatId, null, false);
      }
    }
  });
})();
