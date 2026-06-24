'use strict';

// Telegram bot integration.
//
// A single bot serves every user. We receive updates by LONG-POLLING the Bot
// API's getUpdates method (no public URL / webhook / TLS cert needed), so it
// runs happily behind NAT alongside the other long-lived streams.
//
// Account linking (a bot can't message a user first): the user generates a
// one-time code in Settings, sends "/start <code>" to the bot, and we map that
// code → user_id and store their chat id (user_settings.telegramChatId). From
// then on we send to that chat id.
//
// Telegram notification toggles are INDEPENDENT of the in-app sidebar toggles —
// the per-category gating lives entirely in sendToUser() against the user's
// telegram* prefs. Messages are rendered in each recipient's own language.

const https = require('https');
const crypto = require('crypto');
const db = require('../db');
const userPrefs = require('./user-prefs');
const appLog = require('./app-log');
const staticMap = require('./static-map');
const { TELEGRAM_BOT_TOKEN } = require('../config');

const POLL_TIMEOUT_S = 50; // getUpdates long-poll window
const HTTP_TIMEOUT_MS = (POLL_TIMEOUT_S + 15) * 1000; // must outlast the long poll
const RETRY_DELAY_MS = 3000; // back-off after a polling error (avoid a tight loop)

let botInfo = null; // { id, username } from getMe (resolved lazily at init)
let polling = false;
let offset = 0; // getUpdates offset: last processed update_id + 1

function isConfigured() {
  return !!TELEGRAM_BOT_TOKEN;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Low-level Bot API call (HTTPS POST, JSON in/out) ─────────────────────────
function call(method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
    const body = JSON.stringify(params);
    const req = https.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(data);
          } catch (e) {
            return reject(new Error(`Telegram ${method}: bad response`));
          }
          if (!json.ok) return reject(new Error(json.description || `Telegram ${method} failed`));
          resolve(json.result);
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── sendPhoto (multipart/form-data, for uploading a rendered PNG buffer) ──────
// The Bot API can't fetch a photo from our NAT'd box, so we upload the bytes.
function sendPhoto({ chat_id, photo, caption, parse_mode }, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const boundary = '----tgp' + crypto.randomBytes(12).toString('hex');
    const head = [];
    const field = (name, val) =>
      head.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`);
    field('chat_id', String(chat_id));
    if (caption) field('caption', caption);
    if (parse_mode) field('parse_mode', parse_mode);
    const fileHead =
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="map.png"\r\n` +
      'Content-Type: image/png\r\n\r\n';
    const body = Buffer.concat([
      Buffer.from(head.join('') + fileHead),
      photo,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
    const req = https.request(
      url,
      { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(data);
          } catch (e) {
            return reject(new Error('Telegram sendPhoto: bad response'));
          }
          if (!json.ok) return reject(new Error(json.description || 'Telegram sendPhoto failed'));
          resolve(json.result);
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── A — render once per event + reuse Telegram file_id across recipients ──────
// Notifications fan out per-user, so the SAME map (same coords) is asked for
// once per recipient in a tight synchronous burst. A bot's file_id is reusable
// to send the same photo to any chat, so the first recipient uploads the bytes
// (with their own caption) and we cache the returned file_id; every other
// recipient sends that file_id (with their own caption) — no re-render, no
// re-upload. The cache value is the in-flight Promise<file_id>, set
// synchronously before the first await, so concurrent calls in the same burst
// dedupe onto one upload. Keyed by rounded coords+zoom (caption is NOT part of
// the key — the photo bytes don't depend on language).
const FILEID_TTL_MS = 60 * 60 * 1000;
const FILEID_CACHE_MAX = 256;
const fileIdCache = new Map(); // key → { promise: Promise<string|null>, exp }

function fileIdKey(lat, lon, zoom, seamark) {
  return `${lat.toFixed(4)},${lon.toFixed(4)},${zoom},${seamark ? 1 : 0}`;
}
function getFileIdEntry(key) {
  const e = fileIdCache.get(key);
  if (!e) return null;
  if (e.exp <= Date.now()) {
    fileIdCache.delete(key);
    return null;
  }
  return e;
}
function setFileIdEntry(key, promise) {
  fileIdCache.set(key, { promise, exp: Date.now() + FILEID_TTL_MS });
  while (fileIdCache.size > FILEID_CACHE_MAX) fileIdCache.delete(fileIdCache.keys().next().value);
}
function extractFileId(result) {
  // sendPhoto returns the message; result.photo is an array of size variants.
  const sizes = result && result.photo;
  return Array.isArray(sizes) && sizes.length ? sizes[sizes.length - 1].file_id : null;
}

// Send the map photo to `chatId` with `caption`. Uploads the rendered bytes the
// first time a given map is needed (and caches the file_id), reuses the file_id
// afterwards. Returns true if a photo was delivered, false if the caller should
// fall back to a plain text message.
async function sendMapPhoto(chatId, caption, lat, lon, zoom, seamark) {
  const key = fileIdKey(lat, lon, zoom, seamark);
  const existing = getFileIdEntry(key);
  if (existing) {
    const fileId = await existing.promise.catch(() => null);
    if (fileId) {
      await sendPhoto({ chat_id: chatId, photo: fileId, caption, parse_mode: 'HTML' });
      return true;
    }
    // Shared upload failed → fall through and try to render ourselves.
  }
  // Become the uploader: publish the in-flight promise synchronously (before any
  // await) so siblings in the same burst dedupe onto it.
  let resolveFileId;
  const promise = new Promise((r) => (resolveFileId = r));
  setFileIdEntry(key, promise);
  let buf = null;
  try {
    buf = await staticMap.render(lat, lon, { zoom, seamark });
  } catch { /* render failed */ }
  if (!buf) {
    resolveFileId(null);
    fileIdCache.delete(key);
    return false;
  }
  try {
    const result = await sendPhoto({ chat_id: chatId, photo: buf, caption, parse_mode: 'HTML' });
    resolveFileId(extractFileId(result));
    return true;
  } catch (e) {
    resolveFileId(null);
    fileIdCache.delete(key);
    throw e; // surface to sendToUser's catch (handles blocked-chat cleanup)
  }
}

// ── Message catalogue (per-language). Values are functions of a params object.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const scoreLine = { it: (p) => `\nArea: <b>${esc(p.area)}</b> · Score: <b>${p.score}</b>`, en: (p) => `\nArea: <b>${esc(p.area)}</b> · Score: <b>${p.score}</b>` };

const MSG = {
  high_risk: {
    it: (p) => `🔴 <b>Nave ad alto rischio in arrivo</b>\n${esc(p.name)}${scoreLine.it(p)}`,
    en: (p) => `🔴 <b>High-risk vessel arriving</b>\n${esc(p.name)}${scoreLine.en(p)}`,
  },
  revisit: {
    it: (p) => `🔁 <b>Rientro nave</b>\n${esc(p.name)} è tornata in un'area già visitata${scoreLine.it(p)}`,
    en: (p) => `🔁 <b>Ship revisit</b>\n${esc(p.name)} returned to a previously visited area${scoreLine.en(p)}`,
  },
  area_change: {
    it: (p) => `↔️ <b>Cambio area</b>\n${esc(p.name)}: da <b>${esc(p.fromArea)}</b> a <b>${esc(p.area)}</b> · Score: <b>${p.score}</b>`,
    en: (p) => `↔️ <b>Area change</b>\n${esc(p.name)}: from <b>${esc(p.fromArea)}</b> to <b>${esc(p.area)}</b> · Score: <b>${p.score}</b>`,
  },
  follow_lost: {
    it: (p) => `📭 <b>Nave non trovata</b>\n${esc(p.name)} non sta trasmettendo: rimossa dalle navi seguite.`,
    en: (p) => `📭 <b>Ship not found</b>\n${esc(p.name)} is not transmitting: removed from followed ships.`,
  },
  berth_new: {
    it: (p) => `🛳️ <b>Nuova banchina rilevata</b>\nArea: <b>${esc(p.area)}</b>`,
    en: (p) => `🛳️ <b>New berth detected</b>\nArea: <b>${esc(p.area)}</b>`,
  },
  berth_characterized: {
    it: (p) => `🏷️ <b>Banchina caratterizzata</b>\nArea: <b>${esc(p.area)}</b>${p.band ? ` · Categoria: <b>${esc(p.band)}</b>` : ''}`,
    en: (p) => `🏷️ <b>Berth characterised</b>\nArea: <b>${esc(p.area)}</b>${p.band ? ` · Category: <b>${esc(p.band)}</b>` : ''}`,
  },
  outage_start: {
    it: (p) => `⚠️ <b>Disservizio AIS</b>\nLo stream AISStream risulta non disponibile (nessun segnale da ${p.min} min).`,
    en: (p) => `⚠️ <b>AIS outage</b>\nThe AISStream feed appears unavailable (no signal for ${p.min} min).`,
  },
  outage_end: {
    it: () => `✅ <b>Disservizio AIS rientrato</b>\nI segnali AIS vengono nuovamente ricevuti.`,
    en: () => `✅ <b>AIS outage cleared</b>\nAIS signals are being received again.`,
  },
  area_start: {
    it: (p) => `📡 <b>Monitoraggio avviato</b>\nArea: <b>${esc(p.area)}</b>`,
    en: (p) => `📡 <b>Monitoring started</b>\nArea: <b>${esc(p.area)}</b>`,
  },
  area_stop: {
    it: (p) => `🛑 <b>Monitoraggio fermato</b>\nArea: <b>${esc(p.area)}</b>`,
    en: (p) => `🛑 <b>Monitoring stopped</b>\nArea: <b>${esc(p.area)}</b>`,
  },
  linked: {
    it: () => `✅ <b>Account collegato</b>\nRiceverai qui le notifiche del tuo utente. Usa /stop per scollegare.`,
    en: () => `✅ <b>Account linked</b>\nYou will receive your notifications here. Use /stop to unlink.`,
  },
  unlinked: {
    it: () => `🔌 <b>Account scollegato</b>\nNon riceverai più notifiche. Ricollega dalle impostazioni del sito.`,
    en: () => `🔌 <b>Account unlinked</b>\nYou will no longer receive notifications. Re-link from the site settings.`,
  },
  bad_code: {
    it: () => `❌ Codice non valido o scaduto. Genera un nuovo codice dalle impostazioni del sito.`,
    en: () => `❌ Invalid or expired code. Generate a new code from the site settings.`,
  },
  need_code: {
    it: () => `👋 Per collegare il tuo account, genera un codice nelle impostazioni del sito e invialo qui come «/start <codice>».`,
    en: () => `👋 To link your account, generate a code in the site settings and send it here as “/start <code>”.`,
  },
  test: {
    it: () => `🔔 <b>Notifica di prova</b>\nIl bot Telegram è collegato e funzionante.`,
    en: () => `🔔 <b>Test notification</b>\nThe Telegram bot is linked and working.`,
  },
};

// Notification type → the user-pref toggle that gates it on Telegram.
const PREF_KEY = {
  high_risk: 'telegramNotifyHighRisk',
  revisit: 'telegramNotifyRevisit',
  area_change: 'telegramNotifyAreaChange',
  berth_new: 'telegramNotifyBerthNew',
  berth_characterized: 'telegramNotifyBerthChar',
  outage: 'telegramNotifyOutage',
  area_monitor: 'telegramNotifyAreaMonitor',
};

function render(msgKey, lang, params) {
  const m = MSG[msgKey];
  if (!m) return null;
  const fn = m[lang] || m.it;
  return typeof fn === 'function' ? fn(params || {}) : fn;
}

// ── Sending ──────────────────────────────────────────────────────────────────
// Core gate: resolve the chat, check the master + per-category toggle, render in
// the recipient's language, send. `type` selects the gating toggle; `msgKey`
// (defaults to type) selects the message template. Fire-and-forget by callers.
async function sendToUser(userId, type, msgKey, params) {
  if (!isConfigured()) return;
  const chatId = db.getUserSettings(userId).telegramChatId;
  if (!chatId) return;
  const p = userPrefs.get(userId);
  if (!p.telegramEnabled) return;
  const prefKey = PREF_KEY[type];
  if (prefKey && !p[prefKey]) return;
  const lang = p.lang === 'en' ? 'en' : 'it';
  const text = render(msgKey || type, lang, params);
  if (!text) return;
  // When the event carries coordinates and the user wants maps, send a rendered
  // static map (caption = the message) plus a native location pin, instead of a
  // plain text message. Falls back to text if rendering fails.
  const lat = params ? Number(params.lat) : NaN;
  const lon = params ? Number(params.lon) : NaN;
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lon);
  const MAP_ZOOM = 15;
  try {
    if (hasGeo && p.telegramSendMap !== false) {
      // Photo (caption = the message). Renders/uploads once per map, reuses the
      // file_id for the rest of the fan-out; falls back to text if it can't.
      const sent = await sendMapPhoto(chatId, text, lat, lon, MAP_ZOOM, true);
      if (!sent) {
        await call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
      }
      // Option A: a native, tappable map pin (venue if we have a title/address).
      await sendGeo(chatId, lat, lon, params.venueTitle, params.venueAddress);
      return;
    }
    await call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) {
    appLog.warn('TELEGRAM', appLog.t('telegram.send_failed', { error: e.message }));
    // The user blocked the bot or deleted the chat → drop the binding so we stop
    // hammering a dead chat. They can re-link from Settings.
    if (/403|blocked|chat not found|deactivated/i.test(e.message)) {
      db.setUserSetting(userId, 'telegramChatId', null);
    }
  }
}

// Native map pin (Option A). A venue shows a titled marker; a bare location is
// just a pin. Best-effort — a failure here must not break the main message.
async function sendGeo(chatId, lat, lon, title, address) {
  try {
    if (title) {
      await call('sendVenue', { chat_id: chatId, latitude: lat, longitude: lon, title, address: address || title });
    } else {
      await call('sendLocation', { chat_id: chatId, latitude: lat, longitude: lon });
    }
  } catch { /* best-effort */ }
}

// ── Public notify helpers (called from the event sources) ────────────────────
function notifyShipEvent(userId, type, params) {
  sendToUser(userId, type, type, params);
}
function notifyBerth(userId, type, params) {
  sendToUser(userId, type, type, params);
}
function notifyAreaMonitor(userId, action, params) {
  sendToUser(userId, 'area_monitor', action === 'stop' ? 'area_stop' : 'area_start', params);
}
/** Outage is a global event: fan out to every linked user whose outage toggle is
 *  on. `phase` is 'start' | 'end'. */
function broadcastOutage(phase, params) {
  if (!isConfigured()) return;
  for (const uid of db.getTelegramLinkedUserIds()) {
    sendToUser(uid, 'outage', phase === 'end' ? 'outage_end' : 'outage_start', params || {});
  }
}

// ── Linking flow ─────────────────────────────────────────────────────────────
/** Generate (and persist) a fresh one-time link code for a user. Returns the
 *  code and the t.me deep link if the bot username is known. */
function createLinkCode(userId) {
  const code = crypto.randomBytes(8).toString('hex');
  db.setUserSetting(userId, 'telegramLinkCode', code);
  const username = botInfo && botInfo.username;
  return { code, deepLink: username ? `https://t.me/${username}?start=${code}` : null, botUsername: username || null };
}

/** Per-user link state for the Settings UI. */
function linkStatus(userId) {
  const s = db.getUserSettings(userId);
  return { configured: isConfigured(), botUsername: botInfo ? botInfo.username : null, linked: !!s.telegramChatId };
}

function unlink(userId) {
  db.setUserSetting(userId, 'telegramChatId', null);
  db.setUserSetting(userId, 'telegramLinkCode', null);
}

/** Send a test message to a user (used by the Settings "test" button). Returns
 *  true if a message was dispatched. */
async function sendTest(userId) {
  const chatId = db.getUserSettings(userId).telegramChatId;
  if (!isConfigured() || !chatId) return false;
  const lang = userPrefs.get(userId).lang === 'en' ? 'en' : 'it';
  await call('sendMessage', { chat_id: chatId, text: render('test', lang, {}), parse_mode: 'HTML' });
  return true;
}

// ── Incoming updates ─────────────────────────────────────────────────────────
async function reply(chatId, msgKey, lang) {
  try {
    await call('sendMessage', { chat_id: chatId, text: render(msgKey, lang, {}), parse_mode: 'HTML' });
  } catch { /* best-effort */ }
}

async function handleUpdate(u) {
  const msg = u.message;
  if (!msg || typeof msg.text !== 'string') return;
  const chatId = msg.chat && msg.chat.id;
  if (chatId == null) return;
  const text = msg.text.trim();
  // The Telegram client's UI language is a reasonable default for replies before
  // we know which site user this is.
  const tgLang = (msg.from && msg.from.language_code || '').startsWith('en') ? 'en' : 'it';

  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1];
    if (!code) return reply(chatId, 'need_code', tgLang);
    const userId = db.findUserIdBySetting('telegramLinkCode', code);
    if (!userId) return reply(chatId, 'bad_code', tgLang);
    db.setUserSetting(userId, 'telegramChatId', String(chatId));
    db.setUserSetting(userId, 'telegramLinkCode', null);
    appLog.info('TELEGRAM', appLog.t('telegram.linked', { user: userId }));
    const lang = userPrefs.get(userId).lang === 'en' ? 'en' : 'it';
    return reply(chatId, 'linked', lang);
  }

  if (text.startsWith('/stop')) {
    const userId = db.findUserIdBySetting('telegramChatId', String(chatId));
    const lang = userId ? (userPrefs.get(userId).lang === 'en' ? 'en' : 'it') : tgLang;
    if (userId) {
      db.setUserSetting(userId, 'telegramChatId', null);
      appLog.info('TELEGRAM', appLog.t('telegram.unlinked', { user: userId }));
    }
    return reply(chatId, 'unlinked', lang);
  }

  // Any other text: nudge toward the linking flow.
  return reply(chatId, 'need_code', tgLang);
}

async function pollLoop() {
  while (polling) {
    try {
      const updates = await call(
        'getUpdates',
        { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
        HTTP_TIMEOUT_MS
      );
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          await handleUpdate(u);
        } catch (e) {
          appLog.warn('TELEGRAM', appLog.t('telegram.update_failed', { error: e.message }));
        }
      }
    } catch (e) {
      // Network blip / API hiccup — back off briefly so we never tight-loop.
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/** Start the bot: resolve its username (for deep links) and begin long-polling.
 *  No-op when no token is configured. */
function init() {
  if (!isConfigured()) {
    appLog.info('TELEGRAM', appLog.t('telegram.disabled'));
    return;
  }
  if (polling) return;
  polling = true;
  call('getMe')
    .then((me) => {
      botInfo = { id: me.id, username: me.username };
      appLog.info('TELEGRAM', appLog.t('telegram.started', { username: me.username }));
    })
    .catch((e) => appLog.warn('TELEGRAM', appLog.t('telegram.getme_failed', { error: e.message })));
  pollLoop();
}

module.exports = {
  init,
  isConfigured,
  createLinkCode,
  linkStatus,
  unlink,
  sendTest,
  notifyShipEvent,
  notifyBerth,
  notifyAreaMonitor,
  broadcastOutage,
};
