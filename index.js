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

// Твой полный ID (плюс короткий вариант на случай опечатки)
const ALLOWED_IDS = new Set([5846687574, 584668757]);
const OWNER_ID = 5846687574;

const PAGE_SIZE = 11;
const MIN_PARTICIPANTS = 200; // Вступать только в группы, где 200+ человек

const AUTH_DIR = path.join(__dirname, `auth_info_${OWNER_ID}`);
const EXCLUDED_FILE = path.join(__dirname, `excluded_${OWNER_ID}.json`);
const LINKS_FILE = path.join(__dirname, 'WhatsApp_Groups.txt');
const JOINED_LOG_FILE = path.join(__dirname, 'joined_history.json');

const logger = pino({ level: 'silent' });

function isOwner(chatId) {
  return ALLOWED_IDS.has(Number(chatId));
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

// ==================== СОСТОЯНИЕ БОТА ====================
const state = {
  sock: null,
  isConnected: false,
  wasEverConnected: false,
  isConnecting: false,
  isStopped: false,
  isBroadcasting: false,
  isAutoJoining: false,
  stopAutoJoin: false,
  pairingSent: false,
  phoneNumber: null,
  forceQr: false,
  qrCount: 0,
  groupsCache: [],
  excludedGroups: new Set(),
  processedInvites: new Set(),
  step: 'IDLE',
  draft: {
    type: 'text',
    text: '',
    fileId: null
  },
  reconnectTimer: null
};

// ==================== ЗАГРУЗКА И СОХРАНЕНИЕ ДАННЫХ ====================
function loadExcluded() {
  try {
    if (fs.existsSync(EXCLUDED_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(EXCLUDED_FILE, 'utf-8'));
      if (Array.isArray(parsed)) {
        state.excludedGroups = new Set(parsed.map((item) => String(item)));
      }
    }
  } catch (_) {}
}

function saveExcluded() {
  try {
    fs.writeFileSync(EXCLUDED_FILE, JSON.stringify([...state.excludedGroups], null, 2), 'utf-8');
  } catch (_) {}
}

function loadProcessedInvites() {
  try {
    if (fs.existsSync(JOINED_LOG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(JOINED_LOG_FILE, 'utf-8'));
      if (Array.isArray(parsed)) {
        parsed.forEach((c) => state.processedInvites.add(String(c)));
      }
    }
  } catch (_) {}
}

function saveProcessedInvite(code) {
  state.processedInvites.add(String(code));
  try {
    fs.writeFileSync(JOINED_LOG_FILE, JSON.stringify([...state.processedInvites], null, 2), 'utf-8');
  } catch (_) {}
}

function parseInviteCodesFromFile() {
  if (!fs.existsSync(LINKS_FILE)) return [];
  try {
    const raw = fs.readFileSync(LINKS_FILE, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const codes = [];
    const seen = new Set();

    for (const line of lines) {
      const match = line.match(/chat\.whatsapp\.com\/([0-9A-Za-z_-]{20,24})/);
      if (match && match[1] && !seen.has(match[1])) {
        seen.add(match[1]);
        codes.push(match[1]);
      }
    }
    return codes;
  } catch (_) {
    return [];
  }
}

loadExcluded();
loadProcessedInvites();

// ==================== HTTP-СЕРВЕР ДЛЯ RENDER ====================
const app = express();

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    whatsappConnected: state.isConnected,
    groupsCount: state.groupsCache.length,
    excludedCount: state.excludedGroups.size,
    autoJoining: state.isAutoJoining,
    uptime: Math.floor(process.uptime())
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP-сервер запущен на порту ${PORT}`);
});

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
    console.log('Личный Telegram-бот успешно запущен.');
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
function getMainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: 'Войти в аккаунт' }, { text: 'Список групп' }],
        [{ text: 'Обновить список групп' }, { text: 'Список исключение' }],
        [{ text: '🚀 Авто-вход (200+)' }, { text: 'Выйти из ватсап' }]
      ],
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

function getAutoJoinKeyboard() {
  if (state.isAutoJoining) {
    return {
      inline_keyboard: [
        [{ text: '🛑 Остановить авто-вход', callback_data: 'aj_stop' }],
        [{ text: '🔄 Обновить статус', callback_data: 'aj_menu' }]
      ]
    };
  }
  return {
    inline_keyboard: [
      [
        { text: '▶️ Вступить в 15 групп', callback_data: 'aj_start:15' },
        { text: '▶️ Вступить в 25 групп', callback_data: 'aj_start:25' }
      ],
      [
        { text: '🔥 Вступить в 40 групп', callback_data: 'aj_start:40' }
      ],
      [
        { text: '🔄 Сбросить историю проверенных ссылок', callback_data: 'aj_reset_history' }
      ]
    ]
  };
}

function buildAutoJoinText() {
  const allCodes = parseInviteCodesFromFile();
  const remaining = allCodes.filter((c) => !state.processedInvites.has(c)).length;

  return (
    `🚀 Панель Авто-входа в группы (${MIN_PARTICIPANTS}+ участников)\n\n` +
    `📂 Всего ссылок в WhatsApp_Groups.txt: ${allCodes.length}\n` +
    `✅ Уже проверено/обработано: ${state.processedInvites.size}\n` +
    `⏳ Осталось в очереди: ${remaining}\n` +
    `📊 Статус: ${state.isAutoJoining ? '🟢 В процессе вступления...' : '⚪️ Ожидание запуска'}\n\n` +
    `💡 Бот сам проверяет количество людей в группе: если там меньше ${MIN_PARTICIPANTS} участников, он пропускает её за 3 секунды без бана. Если ${MIN_PARTICIPANTS}+ участников — вступает и ждёт 45–65 секунд.`
  );
}

// ==================== ПАГИНАЦИЯ ГРУПП И ИСКЛЮЧЕНИЙ ====================
function buildSingleGroupKeyboard(page = 0) {
  const available = state.groupsCache
    .map((g, idx) => ({ ...g, idx }))
    .filter((g) => !state.excludedGroups.has(String(g.id)));

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

async function renderExclusionsMenu(chatId, page = 0, mode = 'm', messageId = null) {
  const totalGroups = state.groupsCache.length;
  const totalPages = Math.max(1, Math.ceil(totalGroups / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const start = currentPage * PAGE_SIZE;
  const slice = state.groupsCache.slice(start, start + PAGE_SIZE);

  const excludedCount = state.groupsCache.filter((g) => state.excludedGroups.has(String(g.id))).length;

  const rows = slice.map((g, i) => {
    const globalIdx = start + i;
    const isExcl = state.excludedGroups.has(String(g.id));
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
function destroySocket() {
  state.isStopped = true;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.sock) {
    try {
      state.sock.ev.removeAllListeners();
      state.sock.ws.close();
    } catch (_) {}
    state.sock = null;
  }
  state.isConnected = false;
  state.isConnecting = false;
}

function clearAuthFolder() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  } catch (_) {}
}

async function refreshGroupsCache() {
  if (!state.sock || !state.isConnected) {
    throw new Error('WhatsApp не подключен.');
  }
  const participating = await state.sock.groupFetchAllParticipating();
  state.groupsCache = Object.values(participating)
    .map((g) => ({ id: String(g.id), subject: g.subject || 'Без названия' }))
    .sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));
  return state.groupsCache;
}

async function ensureGroupsLoaded() {
  if (state.excludedGroups.size === 0) {
    loadExcluded();
  }
  if (state.groupsCache.length === 0 && state.isConnected) {
    try {
      await refreshGroupsCache();
    } catch (_) {}
  }
}

async function startWhatsAppSession(chatId = OWNER_ID, options = {}) {
  if (options.reset) {
    destroySocket();
    clearAuthFolder();
    state.pairingSent = false;
    state.qrCount = 0;
    state.phoneNumber = options.phoneNumber || null;
    state.forceQr = Boolean(options.forceQr);
  }

  if (state.isConnecting) return;
  state.isConnecting = true;
  state.isStopped = false;

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) version = latest.version;
    } catch (_) {}

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger)
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

    state.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (state.isStopped) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr && !authState.creds.registered) {
        if (state.phoneNumber && !state.forceQr) {
          if (!state.pairingSent) {
            state.pairingSent = true;
            try {
              await delay(1000);
              const rawCode = await sock.requestPairingCode(state.phoneNumber);
              const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;

              await bot.sendMessage(
                chatId,
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
            } catch (_) {
              state.forceQr = true;
              await sendQrCode(chatId, qr, '⚠️ Отсканируйте резервный QR-код:');
            }
          }
        } else {
          state.qrCount++;
          if (state.qrCount <= 3) {
            await sendQrCode(chatId, qr, `📷 Отсканируйте QR-код (${state.qrCount}/3):`);
          } else {
            destroySocket();
            clearAuthFolder();
            await bot.sendMessage(
              chatId,
              '⌛ Время ожидания QR-кода истекло. Нажмите «Войти в аккаунт» повторно.',
              getMainMenuKeyboard()
            );
          }
        }
      }

      if (connection === 'open') {
        state.isConnected = true;
        state.wasEverConnected = true;
        state.isConnecting = false;
        state.pairingSent = false;
        state.phoneNumber = null;
        state.qrCount = 0;

        loadExcluded();

        try {
          await refreshGroupsCache();
        } catch (_) {}

        await bot.sendMessage(
          chatId,
          `✅ WhatsApp успешно подключен!\n` +
            `Групп загружено: ${state.groupsCache.length}\n\n` +
            `Отправьте текст, фото или видео с подписью для рассылки.`,
          getMainMenuKeyboard()
        );
      }

      if (connection === 'close') {
        const wasConnectedBefore = state.wasEverConnected;
        state.isConnected = false;
        state.isConnecting = false;

        if (state.isStopped) return;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMessage = String(lastDisconnect?.error?.message || lastDisconnect?.error || '');
        const isBadMac = errMessage.includes('Bad MAC');
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;

        if (isLoggedOut || isBadMac) {
          destroySocket();
          clearAuthFolder();
          state.groupsCache = [];

          if (wasConnectedBefore) {
            state.wasEverConnected = false;
            await bot.sendMessage(
              chatId,
              '🔴 Сессия WhatsApp завершена. Нажмите «Войти в аккаунт» для повторного подключения.',
              getMainMenuKeyboard()
            ).catch(() => {});
          }
          return;
        }

        const isRegistered = Boolean(authState?.creds?.registered);
        if (isRegistered || state.pairingSent || statusCode === DisconnectReason.restartRequired || statusCode === 515) {
          const delayMs = statusCode === DisconnectReason.restartRequired || statusCode === 515 ? 1200 : 4000;
          state.reconnectTimer = setTimeout(() => {
            if (!state.isStopped) {
              startWhatsAppSession(chatId, { reset: false });
            }
          }, delayMs);
        } else {
          destroySocket();
          clearAuthFolder();
        }
      }
    });
  } catch (err) {
    state.isConnecting = false;
    await bot.sendMessage(chatId, `❌ Ошибка подключения: ${err.message}`).catch(() => {});
  }
}

async function sendQrCode(chatId, qrData, caption) {
  try {
    const buffer = await QRCode.toBuffer(qrData, { scale: 8, margin: 2 });
    await bot.sendPhoto(chatId, buffer, { caption });
  } catch (_) {}
}

// ==================== АВТО-ВСТУПЛЕНИЕ В ГРУППЫ (200+ УЧАСТНИКОВ) ====================
async function runAutoJoiner(chatId, maxToJoin = 25) {
  if (!state.sock || !state.isConnected) {
    return bot.sendMessage(chatId, '❌ Сначала подключи WhatsApp через «Войти в аккаунт».');
  }
  if (state.isAutoJoining) {
    return bot.sendMessage(chatId, '⏳ Авто-вход уже работает!');
  }

  const allCodes = parseInviteCodesFromFile();
  if (allCodes.length === 0) {
    return bot.sendMessage(
      chatId,
      '❌ Файл WhatsApp_Groups.txt не найден на сервере или пуст! Загрузи его в репозиторий GitHub.'
    );
  }

  await ensureGroupsLoaded();
  const queue = allCodes.filter((code) => !state.processedInvites.has(code));

  if (queue.length === 0) {
    return bot.sendMessage(chatId, '🎉 Все ссылки из файла WhatsApp_Groups.txt уже проверены!');
  }

  state.isAutoJoining = true;
  state.stopAutoJoin = false;

  let joinedCount = 0;
  let skippedSmall = 0;
  let invalidCount = 0;

  const statusMsg = await bot.sendMessage(
    chatId,
    `🚀 Запущен авто-вход в группы (${MIN_PARTICIPANTS}+ участников)\n` +
      `В очереди ссылок: ${queue.length}\n` +
      `Цель: вступить в ${maxToJoin} крупных групп.`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: '🛑 Остановить авто-вход', callback_data: 'aj_stop' }]]
      }
    }
  );

  for (let i = 0; i < queue.length; i++) {
    if (state.stopAutoJoin || !state.isConnected || !state.sock) break;
    if (joinedCount >= maxToJoin) break;

    const code = queue[i];

    try {
      const info = await state.sock.groupGetInviteInfo(code);
      const title = info?.subject || 'Без названия';
      const size = Number(info?.size || 0);

      // Если меньше 200 участников — пропускаем без вступления
      if (size < MIN_PARTICIPANTS) {
        skippedSmall++;
        saveProcessedInvite(code);
        await delay(3000);
        continue;
      }

      // Если 200+ участников — вступаем
      await state.sock.groupAcceptInvite(code);
      joinedCount++;
      saveProcessedInvite(code);

      await bot.editMessageText(
        `🟢 Авто-вход работает...\n\n` +
          `✅ Вступили (${MIN_PARTICIPANTS}+ уч.): ${joinedCount} из ${maxToJoin}\n` +
          `⏭ Пропущено мелких (<${MIN_PARTICIPANTS} уч.): ${skippedSmall}\n` +
          `❌ Нерабочих ссылок: ${invalidCount}\n\n` +
          `Последняя: «${title}» (${size} уч.)`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          reply_markup: {
            inline_keyboard: [[{ text: '🛑 Остановить авто-вход', callback_data: 'aj_stop' }]]
          }
        }
      ).catch(() => {});

      if (joinedCount < maxToJoin && !state.stopAutoJoin) {
        // Пауза 45–65 секунд для безопасности аккаунта
        const waitMs = 45000 + Math.floor(Math.random() * 20000);
        await delay(waitMs);
      }
    } catch (_) {
      invalidCount++;
      saveProcessedInvite(code);
      await delay(3000);
    }
  }

  const wasStoppedManually = state.stopAutoJoin;
  state.isAutoJoining = false;
  state.stopAutoJoin = false;

  await refreshGroupsCache().catch(() => {});

  return bot.sendMessage(
    chatId,
    `${wasStoppedManually ? '🛑 Авто-вход остановлен вручную!' : '🏁 Сеанс авто-входа завершен!'}\n\n` +
      `✅ Успешно вошли (${MIN_PARTICIPANTS}+ уч.): ${joinedCount}\n` +
      `⏭ Отсеяно мелких (<${MIN_PARTICIPANTS} уч.): ${skippedSmall}\n` +
      `❌ Битых/закрытых ссылок: ${invalidCount}\n` +
      `📂 Всего групп в твоём WhatsApp: ${state.groupsCache.length}`,
    getMainMenuKeyboard()
  );
}

// ==================== ФУНКЦИЯ РАССЫЛКИ (КД 15 СЕКУНД) ====================
async function broadcastMessage(chatId, targetGroups) {
  if (!state.sock || !state.isConnected) {
    return bot.sendMessage(chatId, '❌ WhatsApp не подключен. Сначала нажмите «Войти в аккаунт».');
  }
  if (state.isBroadcasting) {
    return bot.sendMessage(chatId, '⏳ Дождитесь завершения текущей рассылки!');
  }
  if (targetGroups.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Нет доступных групп для рассылки.');
  }

  const { type, text, fileId } = state.draft;
  if (type === 'text' && (!text || !text.trim())) {
    return bot.sendMessage(chatId, '⚠️ Сообщение пустое. Отправьте новый текст, фото или видео.');
  }

  state.isBroadcasting = true;
  let success = 0;
  let fails = 0;
  let statusMsg = null;

  try {
    statusMsg = await bot.sendMessage(
      chatId,
      `⏳ Начинаю рассылку по ${targetGroups.length} группам (КД 15 сек)...`
    );

    let mediaBuffer = null;
    if ((type === 'photo' || type === 'video') && fileId) {
      const fileLink = await bot.getFileLink(fileId);
      mediaBuffer = await downloadBuffer(fileLink);
    }

    for (let i = 0; i < targetGroups.length; i++) {
      if (!state.isConnected || !state.sock) {
        fails += targetGroups.length - i;
        break;
      }
      const group = targetGroups[i];
      try {
        if (type === 'photo' && mediaBuffer) {
          await state.sock.sendMessage(group.id, { image: mediaBuffer, caption: text || '' });
        } else if (type === 'video' && mediaBuffer) {
          await state.sock.sendMessage(group.id, { video: mediaBuffer, caption: text || '' });
        } else {
          await state.sock.sendMessage(group.id, { text: text || '' });
        }
        success++;
      } catch (_) {
        fails++;
      }

      if (i < targetGroups.length - 1) {
        await delay(15000 + Math.floor(Math.random() * 1000));
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
    state.isBroadcasting = false;
  }
}

async function sendDraftPreview(chatId, messageId = null) {
  const { type, text } = state.draft;
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
  if (!isOwner(chatId)) return; // Полный игнор чужих аккаунтов

  state.step = 'IDLE';
  await ensureGroupsLoaded();

  const allCodes = parseInviteCodesFromFile();
  const remainingLinks = allCodes.filter((c) => !state.processedInvites.has(c)).length;

  await bot.sendMessage(
    chatId,
    `🔥 Твоя Единая Система WhatsApp\n\n` +
      `Статус WA: ${state.isConnected ? '🟢 Подключен' : '🔴 Не подключен'}\n` +
      `Групп в аккаунте: ${state.groupsCache.length}\n` +
      `В исключениях: ${state.excludedGroups.size}\n` +
      `Ссылок в базе для авто-входа: ${remainingLinks} из ${allCodes.length}\n\n` +
      `Отправь текст, фото или видео для рассылки, либо выбери нужное действие внизу:`,
    getMainMenuKeyboard()
  );
});

bot.on('message', async (msg) => {
  const chatId = Number(msg.chat.id);
  if (!isOwner(chatId)) return; // Полный игнор посторонних

  const text = msg.text;
  if (text && text.startsWith('/start')) return;

  // Быстрые текстовые команды для авто-входа
  if (text && text.startsWith('/join')) {
    const limit = parseInt(text.split(' ')[1], 10) || 25;
    runAutoJoiner(chatId, limit);
    return;
  }

  if (text === '/stopjoin') {
    state.stopAutoJoin = true;
    return bot.sendMessage(chatId, '🛑 Останавливаю авто-вход...');
  }

  if (text === '🚀 Авто-вход (200+)') {
    state.step = 'IDLE';
    return bot.sendMessage(chatId, buildAutoJoinText(), {
      reply_markup: getAutoJoinKeyboard()
    });
  }

  if (text === 'Войти в аккаунт') {
    if (state.isConnected) {
      return bot.sendMessage(chatId, '🟢 Твой WhatsApp уже подключен!', getMainMenuKeyboard());
    }

    state.step = 'AWAITING_PHONE';
    return bot.sendMessage(
      chatId,
      '📱 Введи свой номер телефона WhatsApp (например: 79298892099):\n\nИли нажми кнопку ниже для входа по QR-коду:',
      {
        reply_markup: {
          inline_keyboard: [[{ text: '📷 Войти по QR-коду', callback_data: 'force_qr' }]]
        }
      }
    );
  }

  if (text === 'Список групп') {
    state.step = 'IDLE';
    if (!state.isConnected) return bot.sendMessage(chatId, '🔴 WhatsApp не подключен.');
    await ensureGroupsLoaded();
    if (state.groupsCache.length === 0) return bot.sendMessage(chatId, '📭 Группы не найдены.');

    const lines = state.groupsCache.map((g, idx) => {
      const mark = state.excludedGroups.has(String(g.id)) ? ' 🚫 [Исключена]' : '';
      return `${idx + 1}. ${g.subject}${mark}`;
    });

    let chunk = `📋 Список твоих групп (${state.groupsCache.length}):\n\n`;
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
    state.step = 'IDLE';
    if (!state.isConnected) return bot.sendMessage(chatId, '🔴 WhatsApp не подключен.');
    const waitMsg = await bot.sendMessage(chatId, '🔄 Загружаю группы из WhatsApp...');
    try {
      await refreshGroupsCache();
      await bot.editMessageText(`✅ Список обновлён! Групп: ${state.groupsCache.length}`, {
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
    state.step = 'IDLE';
    if (!state.isConnected) {
      return bot.sendMessage(chatId, '🔴 Сначала подключи WhatsApp через «Войти в аккаунт».');
    }
    await ensureGroupsLoaded();
    if (state.groupsCache.length === 0) {
      return bot.sendMessage(chatId, '📭 В твоём WhatsApp нет доступных групп.');
    }

    return renderExclusionsMenu(chatId, 0, 'm', null);
  }

  if (text === 'Выйти из ватсап') {
    state.step = 'IDLE';
    state.wasEverConnected = false;
    if (state.sock) {
      try { await state.sock.logout().catch(() => {}); } catch (_) {}
    }
    destroySocket();
    clearAuthFolder();
    state.groupsCache = [];

    return bot.sendMessage(
      chatId,
      '👋 Сессия WhatsApp удалена. Нажми «Войти в аккаунт» для нового подключения.',
      getMainMenuKeyboard()
    );
  }

  if (state.step === 'AWAITING_PHONE' && text) {
    let cleanPhone = text.replace(/\D/g, '');
    if (cleanPhone.length === 11 && cleanPhone.startsWith('8')) {
      cleanPhone = '7' + cleanPhone.slice(1);
    }

    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return bot.sendMessage(chatId, '⚠️ Введи корректный номер начиная с 7 (например: 79298892099):');
    }

    state.step = 'IDLE';
    await bot.sendMessage(chatId, `⏳ Запрашиваю код для +${cleanPhone}... Подожди 3–5 секунд.`);

    await startWhatsAppSession(chatId, {
      reset: true,
      phoneNumber: cleanPhone,
      forceQr: false
    });
    return;
  }

  if (!state.isConnected) {
    return bot.sendMessage(chatId, '⚠️ Сначала подключи WhatsApp через кнопку «Войти в аккаунт».', getMainMenuKeyboard());
  }

  await ensureGroupsLoaded();

  if (msg.photo && msg.photo.length > 0) {
    const bestPhoto = msg.photo[msg.photo.length - 1];
    state.draft = {
      type: 'photo',
      fileId: bestPhoto.file_id,
      text: msg.caption || ''
    };
    return sendDraftPreview(chatId);
  }

  if (msg.video) {
    state.draft = {
      type: 'video',
      fileId: msg.video.file_id,
      text: msg.caption || ''
    };
    return sendDraftPreview(chatId);
  }

  if (text) {
    state.draft = {
      type: 'text',
      fileId: null,
      text
    };
    return sendDraftPreview(chatId);
  }
});

// ==================== ОБРАБОТКА INLINE-КНОПОК ====================
bot.on('callback_query', async (query) => {
  if (!query.message) return bot.answerCallbackQuery(query.id);

  const chatId = Number(query.message.chat.id);
  if (!isOwner(chatId)) return; // Полный игнор чужих нажатий

  const messageId = query.message.message_id;
  const data = query.data || '';

  if (data === 'noop') return bot.answerCallbackQuery(query.id);

  // Кнопки управления Авто-входом (200+)
  if (data === 'aj_menu') {
    await bot.answerCallbackQuery(query.id, { text: 'Статус обновлён' });
    return bot.editMessageText(buildAutoJoinText(), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getAutoJoinKeyboard()
    }).catch(() => {});
  }

  if (data.startsWith('aj_start:')) {
    const limit = parseInt(data.split(':')[1], 10) || 25;
    await bot.answerCallbackQuery(query.id, { text: `Запускаю вход в ${limit} групп...` });
    runAutoJoiner(chatId, limit);
    return;
  }

  if (data === 'aj_stop') {
    state.stopAutoJoin = true;
    await bot.answerCallbackQuery(query.id, { text: 'Останавливаю авто-вход...' });
    return;
  }

  if (data === 'aj_reset_history') {
    state.processedInvites.clear();
    try {
      if (fs.existsSync(JOINED_LOG_FILE)) fs.unlinkSync(JOINED_LOG_FILE);
    } catch (_) {}
    await bot.answerCallbackQuery(query.id, { text: 'История проверенных ссылок очищена!' });
    return bot.editMessageText(buildAutoJoinText(), {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getAutoJoinKeyboard()
    }).catch(() => {});
  }

  // Вход по QR
  if (data === 'force_qr') {
    state.step = 'IDLE';
    await bot.answerCallbackQuery(query.id, { text: 'Генерирую QR...' });
    await bot.sendMessage(chatId, '⏳ Подключаюсь для создания QR-кода...');
    await startWhatsAppSession(chatId, { reset: true, phoneNumber: null, forceQr: true });
    return;
  }

  await ensureGroupsLoaded();

  if (data === 'b_back') {
    await bot.answerCallbackQuery(query.id);
    return sendDraftPreview(chatId, messageId);
  }

  // Выбор 1 группы
  if (data.startsWith('b_one_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText(`🎯 Выбери группу для отправки (Стр. ${page + 1}):`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildSingleGroupKeyboard(page)
    }).catch(() => {});
  }

  if (data.startsWith('send_one:')) {
    const group = state.groupsCache[parseInt(data.split(':')[1], 10)];
    if (!group) return bot.answerCallbackQuery(query.id, { text: 'Группа не найдена', show_alert: true });
    await bot.answerCallbackQuery(query.id, { text: 'Отправляю...' });
    await broadcastMessage(chatId, [group]);
    return;
  }

  if (data === 'b_rand10') {
    const available = state.groupsCache.filter((g) => !state.excludedGroups.has(String(g.id)));
    const shuffled = [...available];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    await bot.answerCallbackQuery(query.id, { text: 'Запуск рассылки в 10 групп...' });
    await broadcastMessage(chatId, shuffled.slice(0, 10));
    return;
  }

  if (data === 'b_all') {
    const available = state.groupsCache.filter((g) => !state.excludedGroups.has(String(g.id)));
    await bot.answerCallbackQuery(query.id, { text: 'Запуск общей рассылки...' });
    await broadcastMessage(chatId, available);
    return;
  }

  // Управление исключениями
  if (data.startsWith('excl_open:')) {
    const parts = data.split(':');
    const page = parseInt(parts[1], 10) || 0;
    const mode = parts[2] || 'm';
    await bot.answerCallbackQuery(query.id);
    return renderExclusionsMenu(chatId, page, mode, messageId);
  }

  if (data.startsWith('excl_tog:')) {
    const parts = data.split(':');
    const idx = parseInt(parts[1], 10);
    const page = parseInt(parts[2], 10) || 0;
    const mode = parts[3] || 'm';

    const group = state.groupsCache[idx];
    if (!group) {
      return bot.answerCallbackQuery(query.id, { text: 'Группа не найдена, обнови список' });
    }

    const gid = String(group.id);
    if (state.excludedGroups.has(gid)) {
      state.excludedGroups.delete(gid);
      await bot.answerCallbackQuery(query.id, { text: '✅ Возвращена в рассылку' });
    } else {
      state.excludedGroups.add(gid);
      await bot.answerCallbackQuery(query.id, { text: '🚫 Добавлена в исключения' });
    }
    saveExcluded();

    return renderExclusionsMenu(chatId, page, mode, messageId);
  }

  if (data.startsWith('excl_clear:')) {
    const parts = data.split(':');
    const page = parseInt(parts[1], 10) || 0;
    const mode = parts[2] || 'm';

    state.excludedGroups.clear();
    saveExcluded();
    await bot.answerCallbackQuery(query.id, { text: '✅ Все исключения очищены!' });

    return renderExclusionsMenu(chatId, page, mode, messageId);
  }
});

// ==================== АВТОЗАПУСК ====================
(async () => {
  await startTelegramPolling();

  try {
    const credsFile = path.join(AUTH_DIR, 'creds.json');
    if (fs.existsSync(credsFile)) {
      const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
      if (creds && creds.registered) {
        console.log(`Восстановление твоей сессии WhatsApp...`);
        startWhatsAppSession(OWNER_ID, { reset: false });
      } else {
        clearAuthFolder();
      }
    }
  } catch (_) {
    clearAuthFolder();
  }
})();
