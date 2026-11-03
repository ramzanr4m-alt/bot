const TelegramBot = require('node-telegram-bot-api');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const fs = require('fs');

// === НАСТРОЙКИ ===
const TOKEN = process.env.BOT_TOKEN || '9069645701:AAFl6LJQxT4bA1hRLDowJLigUbeIhJR1YcA';
const PORT = process.env.PORT || 3000;
const AUTH_DIR = './auth_info';
const EXCLUDED_FILE = './excluded.json';

// Веб-сервер для Render (чтобы сервис проходил проверку порта)
const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

// Инициализация Telegram-бота
const bot = new TelegramBot(TOKEN, { polling: true });

// Глобальные состояния
let waSock = null;
let isConnected = false;
let groupsCache = []; // [{ id, subject }]
let excludedGroups = new Set();
const waitingForPhone = new Map(); // chatId -> boolean
const pendingMessages = new Map(); // chatId -> text

// Загрузка списка исключений из файла
if (fs.existsSync(EXCLUDED_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(EXCLUDED_FILE, 'utf-8'));
    excludedGroups = new Set(data);
  } catch (e) {
    console.error('Ошибка чтения файла исключений:', e);
  }
}

function saveExcluded() {
  fs.writeFileSync(EXCLUDED_FILE, JSON.stringify([...excludedGroups]), 'utf-8');
}

// Главное меню при /start
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

// Меню выбора действия для сообщения
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

// Генерация кнопок со списком групп (с пагинацией по 10 штук)
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

// Обновление кэша групп из WhatsApp
async function updateGroupsList() {
  if (!waSock || !isConnected) return [];
  const participating = await waSock.groupFetchAllParticipating();
  groupsCache = Object.values(participating).map(g => ({
    id: g.id,
    subject: g.subject || 'Без названия'
  }));
  return groupsCache;
}

// Подключение к WhatsApp
async function connectToWhatsApp(chatId = null, phoneNumber = null) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  waSock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome')
  });

  waSock.ev.on('creds.update', saveCreds);

  // Запрос кода сопряжения, если передан номер телефона
  if (phoneNumber && !waSock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const cleanPhone = phoneNumber.replace(/\D/g, '');
        const code = await waSock.requestPairingCode(cleanPhone);
        const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
        if (chatId) {
          bot.sendMessage(
            chatId,
            `🔑 Ваш код для входа в WhatsApp:\n\n*${formattedCode}*\n\nОткройте WhatsApp -> Связанные устройства -> Привязка устройства -> Вход по номеру телефона.`,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (err) {
        if (chatId) {
          bot.sendMessage(chatId, `❌ Ошибка получения кода: ${err.message}. Проверьте правильность номера.`);
        }
      }
    }, 3000);
  }

  waSock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      isConnected = true;
      await updateGroupsList();
      if (chatId) {
        bot.sendMessage(chatId, `✅ Успешный вход в WhatsApp! Найдено групп: ${groupsCache.length}`, mainMenuKeyboard);
      }
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect && !phoneNumber) {
        connectToWhatsApp(chatId);
      } else if (statusCode === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        if (chatId) bot.sendMessage(chatId, '🚪 Вы вышли из аккаунта WhatsApp.');
      }
    }
  });
}

// Если сессия уже сохранена, пробуем подключиться при старте
if (fs.existsSync(AUTH_DIR)) {
  connectToWhatsApp();
}

// Задержка между отправками
const delay = ms => new Promise(res => setTimeout(res, ms));

// === ОБРАБОТКА КОМАНД И СООБЩЕНИЙ TELEGRAM ===

bot.onText(/\/start/, msg => {
  waitingForPhone.delete(msg.chat.id);
  bot.sendMessage(
    msg.chat.id,
    'Привет! Выберите нужное действие на клавиатуре ниже. Чтобы сделать рассылку, просто напишите текст сообщения в чат (после входа в аккаунт).',
    mainMenuKeyboard
  );
});

bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  // 1. Вход в аккаунт
  if (text === 'Войти в аккаунт') {
    if (isConnected) {
      return bot.sendMessage(chatId, '✅ Вы уже вошли в аккаунт WhatsApp!');
    }
    waitingForPhone.set(chatId, true);
    return bot.sendMessage(
      chatId,
      '📱 Введите ваш номер телефона для WhatsApp в международном формате без плюса и пробелов (например: `79991234567`):',
      { parse_mode: 'Markdown' }
    );
  }

  // 2. Список исключений
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
    return bot.sendMessage(chatId, '🚫 Группы в исключениях (нажмите, чтобы убрать из исключений):', {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  // 3. Список групп
  if (text === 'Список групп') {
    waitingForPhone.delete(chatId);
    if (!isConnected) return bot.sendMessage(chatId, '⚠️ Сначала войдите в аккаунт WhatsApp.');
    if (groupsCache.length === 0) await updateGroupsList();
    if (groupsCache.length === 0) return bot.sendMessage(chatId, 'Группы не найдены.');

    const listText = groupsCache
      .map((g, i) => `${i + 1}. ${g.subject} ${excludedGroups.has(g.id) ? '(🚫 в искл.)' : ''}`)
      .join('\n');

    return bot.sendMessage(chatId, `📋 Список ваших групп (${groupsCache.length}):\n\n${listText.slice(0, 4000)}`);
  }

  // 4. Обновить список групп
  if (text === 'Обновить список групп') {
    waitingForPhone.delete(chatId);
    if (!isConnected) return bot.sendMessage(chatId, '⚠️ Сначала войдите в аккаунт WhatsApp.');
    await bot.sendMessage(chatId, '🔄 Обновляю список групп...');
    await updateGroupsList();
    return bot.sendMessage(chatId, `✅ Список групп обновлен! Всего групп: ${groupsCache.length}`);
  }

  // 5. Выйти из ватсап
  if (text === 'Выйти из ватсап') {
    waitingForPhone.delete(chatId);
    try {
      if (waSock) await waSock.logout();
    } catch (e) {}
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    isConnected = false;
    waSock = null;
    groupsCache = [];
    return bot.sendMessage(chatId, '🚪 Вы успешно вышли из аккаунта WhatsApp.');
  }

  // Если ожидаем ввод номера телефона для кода сопряжения
  if (waitingForPhone.get(chatId)) {
    const cleanPhone = text.replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return bot.sendMessage(chatId, '❌ Некорректный формат. Введите только цифры (например: 79991234567):');
    }
    waitingForPhone.delete(chatId);
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    bot.sendMessage(chatId, '⏳ Генерирую код для входа, подождите 3-5 секунд...');
    return connectToWhatsApp(chatId, cleanPhone);
  }

  // Любой другой текст воспринимается как сообщение для рассылки
  if (!isConnected) {
    return bot.sendMessage(chatId, '⚠️ Вы не вошли в WhatsApp. Нажмите «Войти в аккаунт».');
  }

  pendingMessages.set(chatId, text);
  return bot.sendMessage(chatId, `📝 Текст сообщения сохранен:\n"${text}"\n\nВыберите действие:`, {
    reply_markup: getMessageActionsKeyboard()
  });
});

// === ОБРАБОТКА INLINE-КНОПОК ===

bot.on('callback_query', async query => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});

  // Возврат к 4 пунктам меню сообщения
  if (data === 'back_to_actions') {
    const msgText = pendingMessages.get(chatId) || '';
    return bot.editMessageText(`📝 Текст сообщения:\n"${msgText}"\n\nВыберите действие:`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getMessageActionsKeyboard()
    });
  }

  // Убрать группу из исключений (из меню "Список исключение")
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

  if (groupsCache.length === 0) {
    await updateGroupsList();
  }

  // Пагинация списков групп
  if (data.startsWith('pg_')) {
    const [, prefix, pageStr] = data.split('_');
    const page = parseInt(pageStr, 10);
    const filterExcluded = prefix === 's1';
    return bot.editMessageReplyMarkup(buildGroupsInlineKeyboard(prefix, page, filterExcluded), {
      chat_id: chatId,
      message_id: messageId
    });
  }

  // 1. Отправить в 1 группу -> выбор группы
  if (data === 'act_send_1') {
    const available = groupsCache.filter(g => !excludedGroups.has(g.id));
    if (available.length === 0) {
      return bot.sendMessage(chatId, '❌ Нет доступных групп (все в исключениях или список пуст).');
    }
    return bot.editMessageText('Выберите группу для отправки сообщения:', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildGroupsInlineKeyboard('s1', 0, true)
    });
  }

  // Нажатие на конкретную группу для отправки в 1 группу
  if (data.startsWith('s1_')) {
    const idx = parseInt(data.split('_')[1], 10);
    const group = groupsCache[idx];
    const textToSend = pendingMessages.get(chatId);

    if (!group || !textToSend) {
      return bot.sendMessage(chatId, '❌ Сообщение или группа не найдены. Напишите сообщение заново.');
    }

    try {
      await waSock.sendMessage(group.id, { text: textToSend });
      return bot.editMessageText(`✅ Сообщение отправлено в группу «${group.subject}»!`, {
        chat_id: chatId,
        message_id: messageId
      });
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Ошибка при отправке: ${err.message}`);
    }
  }

  // 2. Отправить в 10 групп (случайно)
  if (data === 'act_send_10') {
    const textToSend = pendingMessages.get(chatId);
    if (!textToSend) return bot.sendMessage(chatId, '❌ Напишите текст сообщения заново.');

    const available = groupsCache.filter(g => !excludedGroups.has(g.id));
    if (available.length === 0) {
      return bot.sendMessage(chatId, '❌ Нет доступных групп (все в исключениях).');
    }

    // Перемешиваем и берем до 10 случайных групп
    const shuffled = [...available].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, 10);

    await bot.editMessageText(`⏳ Отправляю в ${selected.length} случайных групп...`, {
      chat_id: chatId,
      message_id: messageId
    });

    let sent = 0;
    for (const grp of selected) {
      try {
        await waSock.sendMessage(grp.id, { text: textToSend });
        sent++;
        await delay(1500);
      } catch (e) {}
    }

    return bot.sendMessage(chatId, `✅ Рассылка завершена! Успешно отправлено в ${sent} из ${selected.length} групп.`);
  }

  // 3. Отправить во все группы кроме исключенных
  if (data === 'act_send_all') {
    const textToSend = pendingMessages.get(chatId);
    if (!textToSend) return bot.sendMessage(chatId, '❌ Напишите текст сообщения заново.');

    const available = groupsCache.filter(g => !excludedGroups.has(g.id));
    if (available.length === 0) {
      return bot.sendMessage(chatId, '❌ Нет доступных групп для рассылки.');
    }

    await bot.editMessageText(`⏳ Начинаю рассылку во все доступные группы (${available.length} шт.)...`, {
      chat_id: chatId,
      message_id: messageId
    });

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

  // 4. Добавить в исключения -> выбор группы
  if (data === 'act_exclude') {
    if (groupsCache.length === 0) {
      return bot.sendMessage(chatId, '❌ Список групп пуст.');
    }
    return bot.editMessageText('Выберите группу, чтобы добавить или убрать её из исключений:', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildGroupsInlineKeyboard('ex', 0, false)
    });
  }

  // Нажатие на группу для добавления/удаления из исключений
  if (data.startsWith('ex_')) {
    const idx = parseInt(data.split('_')[1], 10);
    const group = groupsCache[idx];
    if (!group) return;

    if (excludedGroups.has(group.id)) {
      excludedGroups.delete(group.id);
      saveExcluded();
      await bot.sendMessage(chatId, `✅ Группа «${group.subject}» убрана из исключений.`);
    } else {
      excludedGroups.add(group.id);
      saveExcluded();
      await bot.sendMessage(chatId, `🚫 Группа «${group.subject}» добавлена в исключения. Туда сообщения отправляться не будут.`);
    }

    return bot.editMessageReplyMarkup(buildGroupsInlineKeyboard('ex', 0, false), {
      chat_id: chatId,
      message_id: messageId
    });
  }
});
