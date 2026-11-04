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
  makeCacheableSignalKeyStore,
  Browsers,
  delay
} = baileys;

// ==================== КОНФИГУРАЦИЯ ====================
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = '9069645701:AAFl6LJQxT4bA1hRLDowJLigUbeIhJR1YcA';
const MAX_USERS = 5;
const PAGE_SIZE = 8;

const logger = pino({ level: 'silent' });

// ==================== ЗАЩИТА ПРОЦЕССА ОТ ПАДЕНИЙ ====================
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err?.message || err);
});

// ==================== HTTP-СЕРВЕР ДЛЯ RENDER ====================
const app = express();

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    activeSessions: sessions.size,
    connectedUsers: countConnectedUsers(),
    uptime: Math.floor(process.uptime())
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP-сервер запущен на порту ${PORT}`);
});

// ==================== УПРАВЛЕНИЕ СЕССИЯМИ ПОЛЬЗОВАТЕЛЕЙ ====================
const sessions = new Map();

function getUserSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      sock: null,
      isConnected: false,
      isConnecting: false,
      pairingSent: false,
      phoneNumber: null,
      forceQr: false,
      qrCount: 0,
      groupsCache: [],
      excludedGroups: new Set(),
      step: 'IDLE',
      draftText: '',
      reconnectTimer: null
    });
  }
  return sessions.get(chatId);
}

function countConnectedUsers() {
  let count = 0;
  for (const s of sessions.values()) {
    if (s.isConnected) count++;
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

// ==================== ЯДРО WHATSAPP (BAILEYS) ====================
function getUserAuthDir(chatId) {
  return path.join(__dirname, `auth_info_${chatId}`);
}

function destroySocket(session) {
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

async function startWhatsAppSession(chatId, options = {}) {
  const session = getUserSession(chatId);

  // Если передан новый вход (по номеру или QR), сбрасываем старый сокет
  if (options.reset) {
    destroySocket(session);
    clearUserAuthFolder(chatId);
    session.pairingSent = false;
    session.qrCount = 0;
    session.phoneNumber = options.phoneNumber || null;
    session.forceQr = Boolean(options.forceQr);
  }

  if (session.isConnecting) return;
  session.isConnecting = true;

  try {
    const authDir = getUserAuthDir(chatId);
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
      // КРИТИЧНО: для работы requestPairingCode нужен именно браузер Chrome (Ubuntu/Linux)
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

      // Обработка авторизации (Pairing Code или QR)
      if (qr && !state.creds.registered) {
        // 1. Вход по номеру телефона (Pairing Code)
        if (session.phoneNumber && !session.forceQr) {
          if (!session.pairingSent) {
            session.pairingSent = true;
            try {
              await delay(1000);
              const rawCode = await sock.requestPairingCode(session.phoneNumber);
              const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;

              await bot.sendMessage(
                chatId,
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
              console.error(`Ошибка requestPairingCode (${chatId}):`, err.message);
              session.forceQr = true;
              await sendQrCode(
                chatId,
                qr,
                '⚠️ WhatsApp отклонил генерацию кода для этого номера. Отсканируйте резервный QR-код:'
              );
            }
          }
        } else {
          // 2. Вход по QR-коду
          session.qrCount++;
          if (session.qrCount <= 3) {
            await sendQrCode(
              chatId,
              qr,
              `📷 Отсканируйте QR-код в WhatsApp (Связанные устройства).\nПопытка ${session.qrCount}/3:`
            );
          } else {
            destroySocket(session);
            clearUserAuthFolder(chatId);
            await bot.sendMessage(
              chatId,
              '⌛ Время ожидания сканирования QR-кода истекло. Нажмите «Войти в аккаунт», чтобы попробовать снова.',
              MAIN_MENU_KEYBOARD
            );
          }
        }
      }

      // Соединение успешно открыто
      if (connection === 'open') {
        session.isConnected = true;
        session.isConnecting = false;
        session.pairingSent = false;
        session.phoneNumber = null;
        session.qrCount = 0;

        console.log(`WhatsApp успешно подключен [${chatId}]`);
        loadExcludedForUser(chatId, session);

        try {
          await refreshGroupsCache(session);
        } catch (err) {
          console.error(`Ошибка первичной загрузки групп [${chatId}]:`, err.message);
        }

        await bot.sendMessage(
          chatId,
          `✅ *WhatsApp успешно подключен!*\n` +
            `Групп загружено: *${session.groupsCache.length}*\n\n` +
            `Теперь просто отправьте любой текст в чат, чтобы сделать рассылку.`,
          { parse_mode: 'Markdown', ...MAIN_MENU_KEYBOARD }
        );
      }

      // Обработка закрытия соединения и перезапусков
      if (connection === 'close') {
        session.isConnected = false;
        session.isConnecting = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMessage = String(lastDisconnect?.error?.message || lastDisconnect?.error || '');
        const isBadMac = errMessage.includes('Bad MAC');
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

        console.log(`Соединение закрыто [${chatId}]. Код: ${statusCode}. Причина: ${errMessage}`);

        if (isLoggedOut || isBadMac) {
          destroySocket(session);
          clearUserAuthFolder(chatId);
          session.groupsCache = [];
          await bot.sendMessage(
            chatId,
            isBadMac
              ? '⚠️ Сбой ключей шифрования (Bad MAC). Сессия автоматически очищена. Нажмите «Войти в аккаунт» для чистого входа.'
              : '🔴 Вы вышли из WhatsApp на телефоне. Сессия удалена. Нажмите «Войти в аккаунт» для повторного входа.',
            MAIN_MENU_KEYBOARD
          );
          return;
        }

        // ВАЖНО: При коде 515 (restartRequired после ввода кода сопряжения) или разрыве сети
        // переподключаем сокет даже если привязка еще в процессе завершения!
        const hasCredsFile = fs.existsSync(path.join(authDir, 'creds.json'));
        if (hasCredsFile || session.pairingSent || statusCode === DisconnectReason.restartRequired || statusCode === 515) {
          const delayMs = statusCode === DisconnectReason.restartRequired || statusCode === 515 ? 1000 : 3500;
          session.reconnectTimer = setTimeout(() => {
            startWhatsAppSession(chatId, { reset: false });
          }, delayMs);
        }
      }
    });
  } catch (err) {
    session.isConnecting = false;
    console.error(`Критическая ошибка старта сессии [${chatId}]:`, err.message);
    await bot.sendMessage(chatId, `❌ Ошибка подключения к WhatsApp: ${err.message}`);
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

// ==================== ФУНКЦИЯ РАССЫЛКИ ====================
async function broadcastMessage(chatId, session, targetGroups, text) {
  if (!session.sock || !session.isConnected) {
    return bot.sendMessage(chatId, '❌ WhatsApp не подключен. Сначала нажмите «Войти в аккаунт».');
  }
  if (targetGroups.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Нет доступных групп для рассылки.');
  }

  let success = 0;
  let fails = 0;

  const statusMsg = await bot.sendMessage(
    chatId,
    `⏳ Начинаю рассылку по *${targetGroups.length}* группам...`,
    { parse_mode: 'Markdown' }
  );

  for (let i = 0; i < targetGroups.length; i++) {
    const group = targetGroups[i];
    try {
      await session.sock.sendMessage(group.id, { text });
      success++;
    } catch (err) {
      console.error(`Ошибка отправки в ${group.id}:`, err.message);
      fails++;
    }

    if (i < targetGroups.length - 1) {
      await delay(1500 + Math.floor(Math.random() * 500));
    }
  }

  try {
    await bot.editMessageText(
      `✅ *Рассылка завершена!*\n\n📤 Успешно: *${success}*\n❌ Ошибок: *${fails}*`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    );
  } catch (_) {
    await bot.sendMessage(chatId, `✅ Рассылка завершена! Успешно: ${success}, Ошибок: ${fails}`);
  }
}

// ==================== ОБРАБОТЧИКИ КОМАНД TELEGRAM ====================
bot.onText(/^\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getUserSession(chatId);
  session.step = 'IDLE';
  loadExcludedForUser(chatId, session);

  await bot.sendMessage(
    chatId,
    `👋 *Панель управления рассылками WhatsApp*\n\n` +
      `Статус вашего аккаунта: ${session.isConnected ? '🟢 Подключен' : '🔴 Не подключен'}\n` +
      `Групп в кэше: *${session.groupsCache.length}*\n` +
      `Активных пользователей: *${countConnectedUsers()}/${MAX_USERS}*\n\n` +
      `Выберите действие в меню ниже:`,
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
      return bot.sendMessage(chatId, '🟢 Ваш WhatsApp уже подключен и готов к работе!', MAIN_MENU_KEYBOARD);
    }

    if (countConnectedUsers() >= MAX_USERS && !fs.existsSync(getUserAuthDir(chatId))) {
      return bot.sendMessage(
        chatId,
        `⚠️ Достигнут лимит (максимум ${MAX_USERS} одновременных аккаунтов).`
      );
    }

    session.step = 'AWAITING_PHONE';
    return bot.sendMessage(
      chatId,
      '📱 *Введите ваш номер телефона WhatsApp в международном формате*\n' +
        '(например: `79281234567` или `+79281234567`):\n\n' +
        '_Либо нажмите кнопку ниже, чтобы войти по QR-коду (если есть второй телефон под рукой):_',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '📷 Войти по QR-коду', callback_data: 'force_qr' }]]
        }
      }
    );
  }

  if (text === 'Список групп') {
    if (!session.isConnected) return bot.sendMessage(chatId, '🔴 WhatsApp не подключен. Нажмите «Войти в аккаунт».');
    if (session.groupsCache.length === 0) {
      try {
        await refreshGroupsCache(session);
      } catch (e) {
        return bot.sendMessage(chatId, `❌ Ошибка получения групп: ${e.message}`);
      }
    }
    if (session.groupsCache.length === 0) return bot.sendMessage(chatId, '📭 В вашем аккаунте нет доступных групп.');

    const lines = session.groupsCache.map((g, idx) => {
      const mark = session.excludedGroups.has(g.id) ? ' 🚫 [Исключена]' : '';
      return `${idx + 1}. ${g.subject}${mark}`;
    });

    let chunk = `📋 *Список ваших групп (${session.groupsCache.length}):*\n\n`;
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
    const excludedList = session.groupsCache.filter((g) => session.excludedGroups.has(g.id));
    if (excludedList.length === 0) return bot.sendMessage(chatId, '✅ Список исключений пуст.');
    return bot.sendMessage(chatId, `🚫 *Группы в исключениях (${excludedList.length}):*\nНажмите на группу, чтобы вернуть её в рассылку:`, {
      parse_mode: 'Markdown',
      reply_markup: buildExcludedListKeyboard(session, 0)
    });
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
      MAIN_MENU_KEYBOARD
    );
  }

  // Ввод номера телефона для получения 8-значного кода
  if (session.step === 'AWAITING_PHONE') {
    let cleanPhone = text.replace(/\D/g, '');
    // Если ввели российский номер через 8 (например 8928...), автоматически меняем 8 на 7
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

  // Сохранение текста рассылки
  if (!session.isConnected) {
    return bot.sendMessage(chatId, '⚠️ Сначала войдите в WhatsApp! Нажмите кнопку «Войти в аккаунт».', MAIN_MENU_KEYBOARD);
  }

  if (session.groupsCache.length === 0) {
    try {
      await refreshGroupsCache(session);
    } catch (_) {}
  }

  session.draftText = text;
  await bot.sendMessage(
    chatId,
    `📝 *Текст для рассылки сохранён:*\n\n${text}\n\n👇 Выберите режим отправки:`,
    {
      parse_mode: 'Markdown',
      reply_markup: getBroadcastMenuKeyboard()
    }
  );
});

// ==================== ОБРАБОТКА INLINE-КНОПОК ====================
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  const session = getUserSession(chatId);

  if (data === 'noop') return bot.answerCallbackQuery(query.id);

  if (data === 'force_qr') {
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

  if (data === 'b_back') {
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText(
      `📝 *Текст для рассылки:*\n\n${session.draftText || '(пусто)'}\n\n👇 Выберите режим отправки:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: getBroadcastMenuKeyboard()
      }
    );
  }

  if (data.startsWith('b_one_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText('🎯 *Выберите группу для отправки:*', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: buildSingleGroupKeyboard(session, page)
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
    const shuffled = [...available];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    await bot.answerCallbackQuery(query.id, { text: 'Запуск рассылки в 10 групп...' });
    await broadcastMessage(chatId, session, shuffled.slice(0, 10), session.draftText);
    return;
  }

  if (data === 'b_all') {
    const available = session.groupsCache.filter((g) => !session.excludedGroups.has(g.id));
    await bot.answerCallbackQuery(query.id, { text: 'Запуск общей рассылки...' });
    await broadcastMessage(chatId, session, available, session.draftText);
    return;
  }

  if (data.startsWith('b_excl_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText('🚫 *Нажмите на группу, чтобы добавить/убрать из исключений:*', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: buildManageExclusionsKeyboard(session, page)
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

    await bot.answerCallbackQuery(query.id, { text: 'Статус обновлён' });
    return bot.editMessageReplyMarkup(buildManageExclusionsKeyboard(session, page), {
      chat_id: chatId,
      message_id: messageId
    });
  }

  if (data.startsWith('excl_list_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageReplyMarkup(buildExcludedListKeyboard(session, page), {
      chat_id: chatId,
      message_id: messageId
    });
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
      return bot.editMessageText('✅ Список исключений пуст.', {
        chat_id: chatId,
        message_id: messageId
      });
    }

    return bot.editMessageText(`🚫 *Группы в исключениях (${remaining.length}):*`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: buildExcludedListKeyboard(session, page)
    });
  }
});

// ==================== АВТОЗАПУСК ====================
(async () => {
  await startTelegramPolling();

  // Восстанавливаем только полностью зарегистрированные сессии
  try {
    const files = fs.readdirSync(__dirname);
    for (const file of files) {
      if (file.startsWith('auth_info_')) {
        const chatId = Number(file.replace('auth_info_', ''));
        const credsFile = path.join(__dirname, file, 'creds.json');
        if (chatId && fs.existsSync(credsFile)) {
          try {
            const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
            if (creds && creds.registered) {
              console.log(`Восстановление активной сессии для ${chatId}...`);
              startWhatsAppSession(chatId, { reset: false });
            } else {
              // Удаляем недопривязанную сессию, чтобы она не мешала новому входу
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
