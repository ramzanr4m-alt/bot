const TelegramBot = require('node-telegram-bot-api');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const fs = require('fs');

// === НАСТРОЙКИ ===
const TOKEN = process.env.BOT_TOKEN || '9069645701:AAFl6LJQxT4bA1hRLDowJLigUbeIhJR1YcA';
const PORT = process.env.PORT || 3000;
const AUTH_DIR = './auth_info';
const EXCLUDED_FILE = './excluded.json';

// Сервер для Render
const app = express();
app.get('/', (req, res) => res.send('Bot is online!'));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

const bot = new TelegramBot(TOKEN, { polling: true });

let waSock = null;
let isConnected = false;
let groupsCache = [];
let excludedGroups = new Set();
const waitingForPhone = new Map();
const pendingMessages = new Map();
let currentPairingPhone = null;
let currentChatId = null;

// Чтение исключений
if (fs.existsSync(EXCLUDED_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(EXCLUDED_FILE, 'utf-8'));
    excludedGroups = new Set(data);
  } catch (e) {}
}

function saveExcluded() {
  fs.writeFileSync(EXCLUDED_FILE, JSON.stringify([...excludedGroups]), 'utf-8');
}

const mainMenuKeyboard = {
  reply_markup: {
    keyboard: [
      ['Войти в аккаунт', 'Выйти из ватсап'],
      ['Список групп', 'Обновить список групп'],
      ['Список исключение']
    ],
    resize_keyboard: true
  }
};

function getMessageActionsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Отправить в 1 группу', callback_data: 'act_send_1' }],
      [{ text: 'Отправить в 10 групп (случайно)', callback_data: 'act_send_10' }],
      [{ text: 'Отправить во все группы кроме исключенных', callback_data: 'act_send_all' }],
      [{ text: 'Добавить в исключения', callback_data: 'act_exclude' }]
    ]
  };
}

function buildGroupsInlineKeyboard(prefix, page = 0, filterExcluded = false) {
  const list = groupsCache
    .map((g, idx) => ({ ...g, idx }))
    .filter(g => (filterExcluded ? !excludedGroups.has(g.id) : true));

  const pageSize = 10;
  const totalPages = Math.ceil(list.length / pageSize) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = list.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  const buttons = slice.map(g => {
    const isExcl = excludedGroups.has(g.id);
    const mark = prefix === 'ex' && isExcl ? '🚫 ' : '';
    return [{ text: `${mark}${g.subject}`, callback_data: `${prefix}_${g.idx}` }];
  });

  const navRow = [];
  if (currentPage > 0) {
    navRow.push({ text: '⬅️ Назад', callback_data: `pg_${prefix}_${currentPage - 1}` });
  }
  if (currentPage < totalPages - 1) {
    navRow.push({ text: 'Вперед ➡️', callback_data: `pg_${prefix}_${currentPage + 1}` });
  }
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([{ text: '🔙 Назад к действиям', callback_data: 'back_to_actions' }]);
  return { inline_keyboard: buttons };
}

async function updateGroupsList() {
  if (!waSock || !isConnected) return [];
  try {
    const participating = await waSock.groupFetchAllParticipating();
    groupsCache = Object.values(participating).map(g => ({
      id: g.id,
      subject: g.subject || 'Без названия'
    }));
  } catch (e) {
    console.error('Ошибка обновления групп:', e);
  }
  return groupsCache;
}

const delay = ms => new Promise(res => setTimeout(res, ms));

// Инициализация соединения с WhatsApp
async function connectToWhatsApp() {
  if (waSock) {
    try { waSock.end(); } catch (e) {}
    waSock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  waSock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
    },
    printQRInTerminal: false,
    logger: pino({ level: 'fatal' }),
    browser: Browsers.macOS('Desktop'),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 15000,
    markOnlineOnConnect: false
  });

  waSock.ev.on('creds.update', saveCreds);

  let codeRequested = false;

  waSock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    // Срабатывает в момент, когда WhatsApp полностью готов к сопряжению
    if (qr && !waSock.authState.creds.registered && !codeRequested) {
      if (currentPairingPhone && currentChatId) {
        codeRequested = true;
        const targetChat = currentChatId;
        const targetPhone = currentPairingPhone;

        try {
          await delay(1500); // пауза на фиксацию соединения
          const code = await waSock.requestPairingCode(targetPhone);
          const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
          bot.sendMessage(
            targetChat,
            `🔑 Ваш код для входа:\n\n*${formattedCode}*\n\nОткройте WhatsApp -> Связанные устройства -> Привязка устройства -> Вход по номеру телефона.`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          console.error('Ошибка requestPairingCode:', err);
          // Страховка: если сервер WhatsApp сбросил запрос кода, шлем QR-код картинкой
          bot.sendMessage(targetChat, '⚠️ WhatsApp отклонил код по номеру из-за защиты сервера. Войдите через QR-код ниже:');
          const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&margin=10&data=${encodeURIComponent(qr)}`;
          bot.sendPhoto(targetChat, qrUrl, { caption: '📷 Отсканируйте этот QR-код через WhatsApp -> Связанные устройства' });
        }
      }
    }

    if (connection === 'open') {
      isConnected = true;
      currentPairingPhone = null;
      await updateGroupsList();
      if (currentChatId) {
        bot.sendMessage(currentChatId, `✅ Успешный вход в WhatsApp! Найдено групп: ${groupsCache.length}`, mainMenuKeyboard);
      }
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
        if (currentChatId) bot.sendMessage(currentChatId, '🚪 Вы вышли из аккаунта WhatsApp.');
      } else if (waSock?.authState?.creds?.registered) {
        setTimeout(connectToWhatsApp, 3000);
      }
    }
  });
}

if (fs.existsSync(AUTH_DIR)) {
  connectToWhatsApp();
}

// === TELEGRAM ОБРАБОТЧИКИ ===

bot.onText(/\/start/, msg => {
  waitingForPhone.delete(msg.chat.id);
  bot.sendMessage(
    msg.chat.id,
    'Привет! Выберите действие на клавиатуре. Для рассылки напишите текст сообщения в чат (после входа в WhatsApp).',
    mainMenuKeyboard
  );
});

bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  if (text === 'Войти в аккаунт') {
    if (isConnected) {
      return bot.sendMessage(chatId, '✅ Вы уже вошли в аккаунт WhatsApp!');
    }
    waitingForPhone.set(chatId, true);
    return bot.sendMessage(
      chatId,
      '📱 Введите номер телефона в международном формате без знака + (например: `79991234567`):',
      { parse_mode: 'Markdown' }
    );
  }

  if (text === 'Список исключение' || text === 'Список исключений') {
    waitingForPhone.delete(chatId);
    const excludedList = groupsCache.filter(g => excludedGroups.has(g.id));
    if (excludedList.length === 0) {
      return bot.sendMessage(chatId, '📂 Список исключений пуст.');
    }
    const buttons = excludedList.map(g => {
      const idx = groupsCache.findIndex(item => item.id === g.id);
      return [{ text: `❌ Убрать: ${g.subject}`, callback_data: `unex_${idx}` }];
    });
    return bot.sendMessage(chatId, '🚫 Группы в исключениях (нажмите, чтобы убрать):', {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (text === 'Список групп') {
    waitingForPhone.delete(chatId);
    if (!isConnected) return bot.sendMessage(chatId, '⚠️ Сначала войдите в аккаунт WhatsApp.');
    if (groupsCache.length === 0) await updateGroupsList();
    if (groupsCache.length === 0) return bot.sendMessage(chatId, 'Группы не найдены.');

    const listText = groupsCache
      .map((g, i) => `${i + 1}. ${g.subject} ${excludedGroups.has(g.id) ? '(🚫 в искл.)' : ''}`)
      .join('\n');

    return bot.sendMessage(chatId, `📋 Список групп (${groupsCache.length}):\n\n${listText.slice(0, 4000)}`);
  }

  if (text === 'Обновить список групп') {
    waitingForPhone.delete(chatId);
    if (!isConnected) return bot.sendMessage(chatId, '⚠️ Сначала войдите в аккаунт WhatsApp.');
    await bot.sendMessage(chatId, '🔄 Обновляю список...');
    await updateGroupsList();
    return bot.sendMessage(chatId, `✅ Список обновлен! Всего групп: ${groupsCache.length}`);
  }

  if (text === 'Выйти из ватсап') {
    waitingForPhone.delete(chatId);
    try {
      if (waSock) await waSock.logout();
    } catch (e) {}
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
    isConnected = false;
    waSock = null;
    groupsCache = [];
    currentPairingPhone = null;
    return bot.sendMessage(chatId, '🚪 Вы вышли из аккаунта WhatsApp.');
  }

  if (waitingForPhone.get(chatId)) {
    const cleanPhone = text.replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return bot.sendMessage(chatId, '❌ Некорректный номер. Введите только цифры (например: 79991234567):');
    }
    waitingForPhone.delete(chatId);
    currentChatId = chatId;
    currentPairingPhone = cleanPhone;

    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
    bot.sendMessage(chatId, '⏳ Подключаюсь к серверу WhatsApp...');
    return connectToWhatsApp();
  }

  if (!isConnected) {
    return bot.sendMessage(chatId, '⚠️ Сначала войдите в аккаунт WhatsApp.');
  }

  pendingMessages.set(chatId, text);
  return bot.sendMessage(chatId, `📝 Сообщение сохранено:\n"${text}"\n\nВыберите действие:`, {
    reply_markup: getMessageActionsKeyboard()
  });
});

// === ОБРАБОТКА ДЕЙСТВИЙ РАССЫЛКИ ===

bot.on('callback_query', async query => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === 'back_to_actions') {
    const msgText = pendingMessages.get(chatId) || '';
    return bot.editMessageText(`📝 Текст сообщения:\n"${msgText}"\n\nВыберите действие:`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getMessageActionsKeyboard()
    });
  }

  if (data.startsWith('unex_')) {
    const idx = parseInt(data.split('_')[1], 10);
    const group = groupsCache[idx];
    if (group) {
      excludedGroups.delete(group.id);
      saveExcluded();
      bot.sendMessage(chatId, `✅ Группа «${group.subject}» удалена из исключений.`);
    }
    return;
  }

  if (!isConnected) {
    return bot.sendMessage(chatId, '⚠️ Сначала войдите в аккаунт WhatsApp.');
  }

  if (groupsCache.length === 0) await updateGroupsList();

  if (data.startsWith('pg_')) {
    const [, prefix, pageStr] = data.split('_');
    const page = parseInt(pageStr, 10);
    return bot.editMessageReplyMarkup(buildGroupsInlineKeyboard(prefix, page, prefix === 's1'), {
      chat_id: chatId,
      message_id: messageId
    });
  }

  if (data === 'act_send_1') {
    const available = groupsCache.filter(g => !excludedGroups.has(g.id));
    if (available.length === 0) return bot.sendMessage(chatId, '❌ Нет доступных групп.');
    return bot.editMessageText('Выберите группу для отправки:', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildGroupsInlineKeyboard('s1', 0, true)
    });
  }

  if (data.startsWith('s1_')) {
    const idx = parseInt(data.split('_')[1], 10);
    const group = groupsCache[idx];
    const textToSend = pendingMessages.get(chatId);
    if (!group || !textToSend) return bot.sendMessage(chatId, '❌ Напишите текст заново.');

    try {
      await waSock.sendMessage(group.id, { text: textToSend });
      return bot.editMessageText(`✅ Отправлено в «${group.subject}»!`, { chat_id: chatId, message_id: messageId });
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
    }
  }

  if (data === 'act_send_10') {
    const textToSend = pendingMessages.get(chatId);
    if (!textToSend) return bot.sendMessage(chatId, '❌ Напишите текст заново.');
    const available = groupsCache.filter(g => !excludedGroups.has(g.id));
    if (available.length === 0) return bot.sendMessage(chatId, '❌ Нет доступных групп.');

    const selected = [...available].sort(() => 0.5 - Math.random()).slice(0, 10);
    await bot.editMessageText(`⏳ Отправляю в ${selected.length} групп...`, { chat_id: chatId, message_id: messageId });

    let sent = 0;
    for (const grp of selected) {
      try {
        await waSock.sendMessage(grp.id, { text: textToSend });
        sent++;
        await delay(1500);
      } catch (e) {}
    }
    return bot.sendMessage(chatId, `✅ Готово! Отправлено в ${sent} из ${selected.length} групп.`);
  }

  if (data === 'act_send_all') {
    const textToSend = pendingMessages.get(chatId);
    if (!textToSend) return bot.sendMessage(chatId, '❌ Напишите текст заново.');
    const available = groupsCache.filter(g => !excludedGroups.has(g.id));
    if (available.length === 0) return bot.sendMessage(chatId, '❌ Нет доступных групп.');

    await bot.editMessageText(`⏳ Рассылка во все группы (${available.length} шт.)...`, { chat_id: chatId, message_id: messageId });

    let sent = 0;
    for (const grp of available) {
      try {
        await waSock.sendMessage(grp.id, { text: textToSend });
        sent++;
        await delay(1500);
      } catch (e) {}
    }
    return bot.sendMessage(chatId, `✅ Рассылка завершена! Отправлено в ${sent} из ${available.length} групп.`);
  }

  if (data === 'act_exclude') {
    if (groupsCache.length === 0) return bot.sendMessage(chatId, '❌ Список групп пуст.');
    return bot.editMessageText('Нажмите на группу, чтобы добавить/убрать из исключений:', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildGroupsInlineKeyboard('ex', 0, false)
    });
  }

  if (data.startsWith('ex_')) {
    const idx = parseInt(data.split('_')[1], 10);
    const group = groupsCache[idx];
    if (!group) return;

    if (excludedGroups.has(group.id)) {
      excludedGroups.delete(group.id);
      saveExcluded();
      await bot.sendMessage(chatId, `✅ «${group.subject}» убрана из исключений.`);
    } else {
      excludedGroups.add(group.id);
      saveExcluded();
      await bot.sendMessage(chatId, `🚫 «${group.subject}» добавлена в исключения.`);
    }

    return bot.editMessageReplyMarkup(buildGroupsInlineKeyboard('ex', 0, false), {
      chat_id: chatId,
      message_id: messageId
    });
  }
});
