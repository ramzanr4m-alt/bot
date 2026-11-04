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
const TELEGRAM_TOKEN = '9069645701:AAFl6LJQxT4bA1hRLDowJLigUbeIhJR1YcA';
const MAX_USERS = 5;
const PAGE_SIZE = 8;

// ==================== ЗАЩИТА ПРОЦЕССА ОТ КРАШЕЙ ====================
process.on('unhandledRejection', (reason) => {
  console.error('Перехвачена ошибка (unhandledRejection):', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('Критическая ошибка (uncaughtException):', err?.message || err);
});

// ==================== HTTP-СЕРВЕР ДЛЯ RENDER ====================
const app = express();

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    activeSessions: sessions.size,
    maxUsers: MAX_USERS,
    uptime: process.uptime()
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP-сервер слушает порт ${PORT}`);
});

// ==================== УПРАВЛЕНИЕ СЕССИЯМИ ====================
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

function countConnectedUsers() {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.isConnected) count++;
  }
  return count;
}

// ==================== РАБОТА С ИСКЛЮЧЕНИЯМИ (JSON) ====================
function getUserExclPath(chatId) {
  return path.join(__dirname, `excluded_${chatId}.json`);
}

function loadExcludedForUser(chatId, session) {
  try {
    const file = getUserExclPath(chatId);
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw);
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
    console.error(`Ошибка записи исключений (${chatId}):`, err.message);
  }
}

// ==================== ТЕЛЕГРАМ БОТ ====================
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
    console.log('Telegram-бот запущен в режиме Long Polling.');
  } catch (err) {
    console.error('Ошибка старта Telegram Polling:', err.message);
  }
}

bot.on('polling_error', async (err) => {
  const msg = err?.message || '';
  if (msg.includes('409 Conflict') || msg.includes('EFATAL')) {
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

// ==================== СЕРВИС WHATSAPP ====================
function getUserAuthDir(chatId) {
  return path.join(__dirname, `auth_info_${chatId}`);
}

function clearUserAuthFolder(chatId) {
  try {
    const dir = getUserAuthDir(chatId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Ошибка очистки auth_info (${chatId}):`, err.message);
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

    const authDir = getUserAuthDir(chatId);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    session.sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    session.sock.ev.on('creds.update', saveCreds);

    let pairingRequested = false;

    session.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !state.creds.registered) {
        if (phoneNumber && !forceQr && !pairingRequested) {
          pairingRequested = true;
          try {
            await delay(2500);
            const code = await session.sock.requestPairingCode(phoneNumber);
            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;

            await bot.sendMessage(
              chatId,
              `🔐 *Код привязки WhatsApp:*\n\n\`${formatted}\`\n\n` +
                `1. Откройте WhatsApp на телефоне.\n` +
                `2. Нажмите: *Связанные устройства* ➔ *Привязка устройства* ➔ *Связать по номеру телефона*.\n\n` +
                `_Если код не принимается, нажмите кнопку ниже для входа по QR-коду._`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[{ text: '📷 Вход по QR-коду (резерв)', callback_data: 'force_qr' }]]
                }
              }
            );
          } catch (err) {
            console.error(`Ошибка сопряжения (${chatId}):`, err.message);
            await sendQrCode(chatId, qr, '⚠️ Ошибка запроса кода. Отсканируйте резервный QR-код:');
          }
        } else if (!phoneNumber || forceQr) {
          await sendQrCode(chatId, qr, '📷 Отсканируйте этот QR-код в WhatsApp (Связанные устройства):');
        }
      }

      if (connection === 'open') {
        session.isConnected = true;
        session.isConnecting = false;
        console.log(`WhatsApp подключен для пользователя ${chatId}`);

        loadExcludedForUser(chatId, session);
        try {
          await refreshGroupsCache(session);
        } catch (_) {}

        await bot.sendMessage(
          chatId,
          `✅ *WhatsApp успешно подключен!*\nЗагружено групп: *${session.groupsCache.length}*\n\nОтправьте текст сообщения для рассылки.`,
          { parse_mode: 'Markdown', ...MAIN_MENU_KEYBOARD }
        );
      }

      if (connection === 'close') {
        session.isConnected = false;
        session.isConnecting = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errString = String(lastDisconnect?.error || '');
        const isBadMac = errString.includes('Bad MAC');
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !isBadMac;

        console.log(`WhatsApp закрыт (${chatId}). Код: ${statusCode}, BadMAC: ${isBadMac}`);

        if (statusCode === DisconnectReason.loggedOut || isBadMac) {
          clearUserAuthFolder(chatId);
          session.groupsCache = [];
          await bot.sendMessage(
            chatId,
            isBadMac
              ? '⚠️ Сессия повреждена (Bad MAC). Авторизация сброшена. Нажмите «Войти в аккаунт» заново.'
              : '⚠️ Сессия завершена. Нажмите «Войти в аккаунт».',
            MAIN_MENU_KEYBOARD
          );
        } else if (shouldReconnect && fs.existsSync(path.join(authDir, 'creds.json'))) {
          if (state.creds.registered) {
            setTimeout(() => connectToWhatsApp(chatId, null, false), 5000);
          }
        }
      }
    });
  } catch (err) {
    session.isConnecting = false;
    console.error(`Ошибка запуска WhatsApp (${chatId}):`, err.message);
    await bot.sendMessage(chatId, `❌ Ошибка подключения: ${err.message}`);
  }
}

async function sendQrCode(chatId, qrData, caption) {
  try {
    const buffer = await QRCode.toBuffer(qrData, { scale: 8, margin: 2 });
    await bot.sendPhoto(chatId, buffer, { caption });
  } catch (err) {
    console.error('Ошибка создания QR:', err.message);
  }
}

async function broadcastMessage(chatId, session, targetGroups, text) {
  if (!session.sock || !session.isConnected) {
    return bot.sendMessage(chatId, '❌ WhatsApp не подключен. Сначала выполните вход.');
  }
  if (targetGroups.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Нет доступных групп для рассылки.');
  }

  let success = 0;
  let fails = 0;

  const status = await bot.sendMessage(
    chatId,
    `⏳ Рассылка по *${targetGroups.length}* группам началась...`,
    { parse_mode: 'Markdown' }
  );

  for (let i = 0; i < targetGroups.length; i++) {
    const group = targetGroups[i];
    try {
      await session.sock.sendMessage(group.id, { text });
      success++;
    } catch (_) {
      fails++;
    }

    if (i < targetGroups.length - 1) {
      await delay(1500 + Math.floor(Math.random() * 500));
    }
  }

  try {
    await bot.editMessageText(
      `✅ *Рассылка завершена!*\n\nУспешно отправлено: *${success}*\nОшибок: *${fails}*`,
      { chat_id: chatId, message_id: status.message_id, parse_mode: 'Markdown' }
    );
  } catch (_) {
    await bot.sendMessage(chatId, `✅ Рассылка завершена! Успешно: ${success}, Ошибок: ${fails}`);
  }
}

// ==================== ОБРАБОТКА КОМАНД TELEGRAM ====================
bot.onText(/^\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getUserSession(chatId);
  session.step = 'IDLE';
  loadExcludedForUser(chatId, session);

  await bot.sendMessage(
    chatId,
    `👋 *Панель управления рассылками WhatsApp*\n\n` +
      `Статус вашего аккаунта: ${session.isConnected ? '🟢 Подключен' : '🔴 Не подключен'}\n` +
      `Групп в вашем кэше: *${session.groupsCache.length}*\n` +
      `Активных пользователей в системе: *${countConnectedUsers()}/${MAX_USERS}*\n\n` +
      `Выберите пункт меню:`,
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
      return bot.sendMessage(chatId, '🟢 Вы уже вошли в свой WhatsApp!', MAIN_MENU_KEYBOARD);
    }

    if (countConnectedUsers() >= MAX_USERS && !fs.existsSync(getUserAuthDir(chatId))) {
      return bot.sendMessage(
        chatId,
        `⚠️ Достигнут лимит системы (максимум ${MAX_USERS} активных пользователей). Попробуйте позже.`
      );
    }

    session.step = 'AWAITING_PHONE';
    return bot.sendMessage(
      chatId,
      '📱 Отправьте ваш номер WhatsApp (международный формат без пробелов, например `79991234567`):\n\n' +
        '_Или нажмите кнопку ниже для моментального входа по QR:_',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '📷 Войти по QR-коду', callback_data: 'force_qr' }]]
        }
      }
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
    const waitMsg = await bot.sendMessage(chatId, '🔄 Обновляю список групп...');
    try {
      await refreshGroupsCache(session);
      await bot.editMessageText(`✅ Список обновлен! Групп: *${session.groupsCache.length}*`, {
        chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'Markdown'
      });
    } catch (err) {
      await bot.editMessageText(`❌ Ошибка обновления: ${err.message}`, { chat_id: chatId, message_id: waitMsg.message_id });
    }
    return;
  }

  if (text === 'Список исключение') {
    const excludedList = session.groupsCache.filter((g) => session.excludedGroups.has(g.id));
    if (excludedList.length === 0) return bot.sendMessage(chatId, '✅ Список исключений пуст.');
    return bot.sendMessage(chatId, `🚫 *Исключения (${excludedList.length}):* Нажмите, чтобы удалить:`, {
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

    return bot.sendMessage(chatId, '👋 Вы вышли из своего аккаунта WhatsApp. Данные очищены.', MAIN_MENU_KEYBOARD);
  }

  if (session.step === 'AWAITING_PHONE') {
    const cleanPhone = text.replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return bot.sendMessage(chatId, '⚠️ Введите корректный номер (от 10 до 15 цифр):');
    }

    session.step = 'IDLE';
    clearUserAuthFolder(chatId);
    await bot.sendMessage(chatId, `⏳ Запрашиваю код привязки для \`+${cleanPhone}\`...`, { parse_mode: 'Markdown' });
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
  await bot.sendMessage(chatId, `📝 *Текст для рассылки:*\n\n${text}\n\n👇 Выберите вариант отправки:`, {
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
    return bot.editMessageText(`📝 *Текст для рассылки:*\n\n${session.draftText || '(пусто)'}\n\n👇 Выберите вариант:`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getBroadcastMenuKeyboard()
    });
  }

  if (data.startsWith('b_one_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText('🎯 *Выберите целевую группу:*', {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: buildSingleGroupKeyboard(session, page)
    });
  }

  if (data.startsWith('send_one:')) {
    const group = session.groupsCache[parseInt(data.split(':')[1], 10)];
    if (!group) return bot.answerCallbackQuery(query.id, { text: 'Группа не найдена', show_alert: true });
    await bot.answerCallbackQuery(query.id, { text: `Отправляю в ${group.subject}...` });
    await broadcastMessage(chatId, session, [group], session.draftText);
    return;
  }

  if (data === 'b_rand10') {
    const available = session.groupsCache.filter((g) => !session.excludedGroups.has(g.id));
    const shuffled = [...available].sort(() => 0.5 - Math.random());
    await bot.answerCallbackQuery(query.id, { text: 'Рассылка в 10 случайных...' });
    await broadcastMessage(chatId, session, shuffled.slice(0, 10), session.draftText);
    return;
  }

  if (data === 'b_all') {
    const available = session.groupsCache.filter((g) => !session.excludedGroups.has(g.id));
    await bot.answerCallbackQuery(query.id, { text: 'Рассылка во все группы...' });
    await broadcastMessage(chatId, session, available, session.draftText);
    return;
  }

  if (data.startsWith('b_excl_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText('🚫 *Управление исключениями (нажмите для переключения):*', {
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

    await bot.answerCallbackQuery(query.id, { text: 'Статус изменен' });
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
      await bot.answerCallbackQuery(query.id, { text: 'Удалено' });
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

// ==================== СТАРТ ПРИЛОЖЕНИЯ ====================
(async () => {
  await startTelegramPolling();

  try {
    const files = fs.readdirSync(__dirname);
    for (const file of files) {
      if (file.startsWith('auth_info_')) {
        const chatId = Number(file.replace('auth_info_', ''));
        const credsPath = path.join(__dirname, file, 'creds.json');
        if (chatId && fs.existsSync(credsPath)) {
          console.log(`Восстановление сессии для ${chatId}...`);
          connectToWhatsApp(chatId, null, false);
        }
      }
    }
  } catch (err) {
    console.error('Ошибка восстановления сессий:', err.message);
  }
})();
