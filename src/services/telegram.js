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
const { flagEmoji, shipTypeLabel } = require('./vessel-format');
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
function sendPhoto({ chat_id, photo, caption, parse_mode, reply_markup }, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const boundary = '----tgp' + crypto.randomBytes(12).toString('hex');
    const head = [];
    const field = (name, val) =>
      head.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`);
    field('chat_id', String(chat_id));
    if (caption) field('caption', caption);
    if (parse_mode) field('parse_mode', parse_mode);
    if (reply_markup) field('reply_markup', JSON.stringify(reply_markup));
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

function fileIdKey(lat, lon, zoom, seamark, points) {
  const pts = points && points.length ? ':' + points.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join('|') : '';
  return `${lat.toFixed(4)},${lon.toFixed(4)},${zoom},${seamark ? 1 : 0}${pts}`;
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
async function sendMapPhoto(chatId, caption, lat, lon, zoom, seamark, reply_markup, points) {
  const key = fileIdKey(lat, lon, zoom, seamark, points);
  const existing = getFileIdEntry(key);
  if (existing) {
    const fileId = await existing.promise.catch(() => null);
    if (fileId) {
      await sendPhoto({ chat_id: chatId, photo: fileId, caption, parse_mode: 'HTML', reply_markup });
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
    buf = await staticMap.render(lat, lon, { zoom, seamark, points, connect: !!(points && points.length) });
  } catch { /* render failed */ }
  if (!buf) {
    resolveFileId(null);
    fileIdCache.delete(key);
    return false;
  }
  try {
    const result = await sendPhoto({ chat_id: chatId, photo: buf, caption, parse_mode: 'HTML', reply_markup });
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
const clip = (s, n) => { const v = String(s == null ? '' : s).trim(); return v.length > n ? v.slice(0, n - 1) + '…' : v; };
const scoreLine = { it: (p) => `\nArea: <b>${esc(p.area)}</b> · Score: <b>${p.score}</b>`, en: (p) => `\nArea: <b>${esc(p.area)}</b> · Score: <b>${p.score}</b>` };

// Ship identity line: flag emoji (from MMSI MID) + name + short type. Compact —
// folds three fields into one line so captions stay small.
function nameLine(p, lang) {
  const type = shipTypeLabel(p.shipType, lang);
  return `${flagEmoji(p.mmsi)}<b>${esc(clip(p.name, 40))}</b>${type ? ` · ${esc(type)}` : ''}`;
}

// Two optional extra lines appended to ship notifications, each emitted only when
// its data is present (no empty rows = no bloat):
//   ⚠️  the top risk factor (WHY the score is high)
//   🧭  live kinematics + declared destination
function shipExtras(p, lang) {
  let out = '';
  const factor = lang === 'en' ? p.factorEn : p.factorIt;
  if (factor) out += `\n⚠️ ${esc(clip(factor, 64))}`;
  const parts = [];
  const sog = Number(p.sog);
  const cog = Number(p.cog);
  if (Number.isFinite(sog) && sog > 0) parts.push(`${sog.toFixed(1)} kn`);
  if (Number.isFinite(cog)) parts.push(`${Math.round(cog)}°`);
  if (p.dest) parts.push(`→ ${esc(clip(p.dest, 28))}`);
  if (parts.length) out += `\n🧭 ${parts.join(' · ')}`;
  return out;
}

const MSG = {
  high_risk: {
    it: (p) => `🔴 <b>Nave ad alto rischio in arrivo</b>\n${nameLine(p, 'it')}${scoreLine.it(p)}${shipExtras(p, 'it')}`,
    en: (p) => `🔴 <b>High-risk vessel arriving</b>\n${nameLine(p, 'en')}${scoreLine.en(p)}${shipExtras(p, 'en')}`,
  },
  revisit: {
    it: (p) => `🔁 <b>Rientro nave</b>\n${nameLine(p, 'it')} · area già visitata${scoreLine.it(p)}${shipExtras(p, 'it')}`,
    en: (p) => `🔁 <b>Ship revisit</b>\n${nameLine(p, 'en')} · previously visited area${scoreLine.en(p)}${shipExtras(p, 'en')}`,
  },
  area_change: {
    it: (p) => `↔️ <b>Cambio area</b>\n${nameLine(p, 'it')}\nDa <b>${esc(p.fromArea)}</b> a <b>${esc(p.area)}</b> · Score: <b>${p.score}</b>${shipExtras(p, 'it')}`,
    en: (p) => `↔️ <b>Area change</b>\n${nameLine(p, 'en')}\nFrom <b>${esc(p.fromArea)}</b> to <b>${esc(p.area)}</b> · Score: <b>${p.score}</b>${shipExtras(p, 'en')}`,
  },
  follow_searching: {
    it: (p) => `🔍 <b>Nave in ricerca</b>\n${esc(p.name)} non sta trasmettendo. La cerco in tutto il mondo — verrò avvisato quando riprende.`,
    en: (p) => `🔍 <b>Searching for ship</b>\n${esc(p.name)} is not transmitting. Searching worldwide — you'll be notified when it reappears.`,
  },
  follow_found: {
    it: (p) => `✅ <b>Nave ritrovata</b>\n${esc(p.name)} ha ripreso a trasmettere.`,
    en: (p) => `✅ <b>Ship found again</b>\n${esc(p.name)} is transmitting again.`,
  },
  follow_lost: {
    it: (p) => `📭 <b>Nave rimossa dai seguiti</b>\n${esc(p.name)} non ha trasmesso per 6 mesi: rimossa dalle navi seguite.`,
    en: (p) => `📭 <b>Ship removed from followed</b>\n${esc(p.name)} has not transmitted for 6 months: removed from followed ships.`,
  },
  berth_new: {
    it: (p) => `🛳️ <b>Nuova banchina rilevata</b>\nArea: <b>${esc(p.area)}</b>`,
    en: (p) => `🛳️ <b>New berth detected</b>\nArea: <b>${esc(p.area)}</b>`,
  },
  proximity: {
    it: (p) => `🚨 <b>Rendezvous in mare</b>\n${flagEmoji(p.mmsiA)}<b>${esc(clip(p.nameA || p.mmsiA, 28))}</b> ↔ ${flagEmoji(p.mmsiB)}<b>${esc(clip(p.nameB || p.mmsiB, 28))}</b>\nArea: <b>${esc(p.area)}</b> · ${p.distM} m · ${p.durMin} min`,
    en: (p) => `🚨 <b>At-sea rendezvous</b>\n${flagEmoji(p.mmsiA)}<b>${esc(clip(p.nameA || p.mmsiA, 28))}</b> ↔ ${flagEmoji(p.mmsiB)}<b>${esc(clip(p.nameB || p.mmsiB, 28))}</b>\nArea: <b>${esc(p.area)}</b> · ${p.distM} m · ${p.durMin} min`,
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
  // ── Group activity (see group-sync.js notifyGroupActivity) ──────────────────
  group_area_add: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha aggiunto l'area <b>${esc(p.area)}</b> al monitoraggio del gruppo.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> added area <b>${esc(p.area)}</b> to the group's monitoring.`,
  },
  group_area_remove: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha rimosso l'area <b>${esc(p.area)}</b> dal monitoraggio del gruppo.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> removed area <b>${esc(p.area)}</b> from the group's monitoring.`,
  },
  group_area_edit: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha modificato l'area <b>${esc(p.area)}</b> che stai monitorando.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> edited area <b>${esc(p.area)}</b>, which you are monitoring.`,
  },
  group_follow_on: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha iniziato a seguire <b>${esc(p.ship_name || p.mmsi)}</b>.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> started following <b>${esc(p.ship_name || p.mmsi)}</b>.`,
  },
  group_follow_off: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha smesso di seguire <b>${esc(p.ship_name || p.mmsi)}</b>.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> stopped following <b>${esc(p.ship_name || p.mmsi)}</b>.`,
  },
  group_flag_on: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha segnalato come sospetta <b>${esc(p.ship_name || p.mmsi)}</b>.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> flagged <b>${esc(p.ship_name || p.mmsi)}</b> as suspicious.`,
  },
  group_flag_off: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha rimosso la segnalazione da <b>${esc(p.ship_name || p.mmsi)}</b>.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> removed the flag from <b>${esc(p.ship_name || p.mmsi)}</b>.`,
  },
  group_mute_on: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha silenziato le notifiche per <b>${esc(p.ship_name || p.mmsi)}</b>.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> muted notifications for <b>${esc(p.ship_name || p.mmsi)}</b>.`,
  },
  group_mute_off: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha riattivato le notifiche per <b>${esc(p.ship_name || p.mmsi)}</b>.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> unmuted notifications for <b>${esc(p.ship_name || p.mmsi)}</b>.`,
  },
  group_seen_on: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha segnato come vista <b>${esc(p.ship_name || p.mmsi)}</b>.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> marked <b>${esc(p.ship_name || p.mmsi)}</b> as seen.`,
  },
  group_seen_off: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha segnato <b>${esc(p.ship_name || p.mmsi)}</b> come da rivedere.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> marked <b>${esc(p.ship_name || p.mmsi)}</b> as unseen again.`,
  },
  group_charge_on: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha preso in carico <b>${esc(p.ship_name || p.mmsi)}</b>.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> took charge of <b>${esc(p.ship_name || p.mmsi)}</b>.`,
  },
  group_charge_off: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha rilasciato la presa in carico di <b>${esc(p.ship_name || p.mmsi)}</b>.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> released charge of <b>${esc(p.ship_name || p.mmsi)}</b>.`,
  },
  group_charge_assign: {
    it: (p) => `👥 <b>${esc(p.actorName)}</b> ha assegnato <b>${esc(p.ship_name || p.mmsi)}</b> a un membro del gruppo.`,
    en: (p) => `👥 <b>${esc(p.actorName)}</b> assigned <b>${esc(p.ship_name || p.mmsi)}</b> to a group member.`,
  },
};

// Notification type → the user-pref toggle that gates it on Telegram.
const PREF_KEY = {
  high_risk: 'telegramNotifyHighRisk',
  revisit: 'telegramNotifyRevisit',
  area_change: 'telegramNotifyAreaChange',
  berth_new: 'telegramNotifyBerthNew',
  berth_characterized: 'telegramNotifyBerthChar',
  proximity: 'telegramNotifyProximity',
  outage: 'telegramNotifyOutage',
  area_monitor: 'telegramNotifyAreaMonitor',
  group_area_add: 'telegramNotifyGroupArea',
  group_area_remove: 'telegramNotifyGroupArea',
  group_area_edit: 'telegramNotifyGroupArea',
  group_follow_on: 'telegramNotifyGroupFollow',
  group_follow_off: 'telegramNotifyGroupFollow',
  group_flag_on: 'telegramNotifyGroupFlag',
  group_flag_off: 'telegramNotifyGroupFlag',
  group_mute_on: 'telegramNotifyGroupMute',
  group_mute_off: 'telegramNotifyGroupMute',
  group_seen_on: 'telegramNotifyGroupSeen',
  group_seen_off: 'telegramNotifyGroupSeen',
  group_charge_on: 'telegramNotifyGroupCharge',
  group_charge_off: 'telegramNotifyGroupCharge',
  group_charge_assign: 'telegramNotifyGroupCharge',
};

function render(msgKey, lang, params) {
  const m = MSG[msgKey];
  if (!m) return null;
  const fn = m[lang] || m.it;
  return typeof fn === 'function' ? fn(params || {}) : fn;
}

// ── Inline buttons on ship notifications ─────────────────────────────────────
// Notifications about a specific ship carry two one-tap actions: «Segui» (adds it
// to the user's followed ships, like the in-app follow) and «Segnala» (flags it,
// like the list's star). Both are one-way (add only). callback_data encodes the
// action + MMSI ("f:<mmsi>" / "s:<mmsi>") — compact, well under the 64-byte cap.
// Only these event types get buttons (they reference a live, followable ship);
// follow_lost is excluded (the ship is gone and re-acquisition already failed).
const SHIP_BTN_TYPES = new Set(['high_risk', 'revisit', 'area_change']);

const BTN = {
  it: { follow: '🛰️ Segui', followed: '✅ Seguita', flag: '⭐ Segnala', flagged: '⭐ Segnalata' },
  en: { follow: '🛰️ Follow', followed: '✅ Following', flag: '⭐ Flag', flagged: '⭐ Flagged' },
};

// Build the two-button inline keyboard, reflecting the user's current state so a
// ship they already follow/flag shows the "done" label rather than the action.
function shipKeyboard(mmsi, lang, followed, flagged) {
  const L = BTN[lang] || BTN.it;
  return {
    inline_keyboard: [[
      { text: followed ? L.followed : L.follow, callback_data: `f:${mmsi}` },
      { text: flagged ? L.flagged : L.flag, callback_data: `s:${mmsi}` },
    ]],
  };
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
  // A compact, tappable "open in map" link folded into the message — replaces the
  // bulky native location/venue pin (a second large map widget, redundant with
  // the attached screenshot) while keeping one-tap navigation.
  const body = hasGeo ? `${text}${mapLink(lat, lon, lang)}` : text;
  // Ship-event messages get the «Segui»/«Segnala» inline buttons, labelled to
  // reflect whether the user already follows/flags this ship.
  let reply_markup;
  const mmsi = params ? Number(params.mmsi) : NaN;
  if (SHIP_BTN_TYPES.has(type) && Number.isFinite(mmsi)) {
    const followed = db.getUserFollowedMmsis(userId).has(mmsi);
    const flagged = db.getUserFlaggedMmsis(userId).has(mmsi);
    reply_markup = shipKeyboard(mmsi, lang, followed, flagged);
  }
  try {
    if (hasGeo && p.telegramSendMap !== false) {
      // Photo (caption = the message). Renders/uploads once per map, reuses the
      // file_id for the rest of the fan-out; falls back to text if it can't.
      // `mapPoints` (e.g. a rendezvous pair) draws multiple pins + a link line.
      // OpenSeaMap seamark overlay is OFF in the screenshots: its symbols clutter
      // a small notification map (the live UI map can still show it per user pref).
      const mapPoints = Array.isArray(params && params.mapPoints) ? params.mapPoints : null;
      const sent = await sendMapPhoto(chatId, body, lat, lon, MAP_ZOOM, false, reply_markup, mapPoints);
      if (!sent) {
        await call('sendMessage', { chat_id: chatId, text: body, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup });
      }
      return;
    }
    await call('sendMessage', { chat_id: chatId, text: body, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup });
  } catch (e) {
    appLog.warn('TELEGRAM', appLog.t('telegram.send_failed', { error: e.message }));
    // The user blocked the bot or deleted the chat → drop the binding so we stop
    // hammering a dead chat. They can re-link from Settings.
    if (/403|blocked|chat not found|deactivated/i.test(e.message)) {
      db.setUserSetting(userId, 'telegramChatId', null);
    }
  }
}

// Compact tappable "open in map" link (replaces the native pin). Telegram makes
// the https URL tappable and hands off to the device's maps app; 5 decimals ≈ 1m.
function mapLink(lat, lon, lang) {
  const url = `https://www.google.com/maps?q=${lat.toFixed(5)},${lon.toFixed(5)}`;
  const label = lang === 'en' ? 'Open in map' : 'Apri in mappa';
  return `\n📍 <a href="${url}">${label}</a>`;
}

// ── Public notify helpers (called from the event sources) ────────────────────
// All fire-and-forget: callers never await these. sendToUser's own try/catch
// (above) only covers the network call — a synchronous throw before it (e.g.
// SQLITE_BUSY from one of the DB reads) still rejects the returned promise, and
// on Node 22 an unhandled rejection kills the whole process. `.catch()` here is
// the backstop; a caller-side `try { } catch { }` around a fire-and-forget async
// call cannot substitute for it (it can't catch a rejection that arrives later).
function onTelegramSendError(e) {
  appLog.warn('TELEGRAM', appLog.t('telegram.send_failed', { error: e.message }));
}
function notifyShipEvent(userId, type, params) {
  return sendToUser(userId, type, type, params).catch(onTelegramSendError);
}
function notifyBerth(userId, type, params) {
  return sendToUser(userId, type, type, params).catch(onTelegramSendError);
}
// Ship-to-ship rendezvous: two pins + a connecting line, centred on the midpoint.
function notifyProximity(userId, params) {
  const mapPoints = [
    { lat: params.latA, lon: params.lonA },
    { lat: params.latB, lon: params.lonB },
  ];
  return sendToUser(userId, 'proximity', 'proximity', { ...params, mapPoints }).catch(onTelegramSendError);
}
function notifyAreaMonitor(userId, action, params) {
  return sendToUser(userId, 'area_monitor', action === 'stop' ? 'area_stop' : 'area_start', params).catch(onTelegramSendError);
}
// Group activity (see group-sync.js notifyGroupActivity): no coordinates, plain text.
function notifyGroupActivity(userId, type, params) {
  return sendToUser(userId, type, type, params).catch(onTelegramSendError);
}
/** Outage is a global event: fan out to every linked user whose outage toggle is
 *  on. `phase` is 'start' | 'end'. */
function broadcastOutage(phase, params) {
  if (!isConfigured()) return;
  for (const uid of db.getTelegramLinkedUserIds()) {
    sendToUser(uid, 'outage', phase === 'end' ? 'outage_end' : 'outage_start', params || {}).catch(onTelegramSendError);
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

// Toast text (answerCallbackQuery) for the inline-button actions.
const CB_TOAST = {
  it: { followed: 'Aggiunta alle navi seguite', reacquiring: 'Seguita · ricerca posizione in corso…', already_followed: 'Già tra le navi seguite', flagged: 'Nave segnalata ⭐', already_flagged: 'Già segnalata' },
  en: { followed: 'Added to followed ships', reacquiring: 'Following · locating the ship…', already_followed: 'Already followed', flagged: 'Ship flagged ⭐', already_flagged: 'Already flagged' },
};

// Acknowledge a callback query (stops the client's spinner; optional toast).
function ack(callbackId, text) {
  return call('answerCallbackQuery', { callback_query_id: callbackId, text: text || '', show_alert: false }).catch(() => {});
}

// Handle a tap on a «Segui»/«Segnala» button. Resolves the site user from the
// chat, applies the (one-way) action, shows a toast, and refreshes the keyboard
// so the pressed button flips to its "done" label.
async function handleCallback(cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  const m = /^([fs]):(\d+)$/.exec(cq.data || '');
  if (chatId == null || !m) return ack(cq.id);
  const action = m[1];
  const mmsi = Number(m[2]);
  const userId = db.findUserIdBySetting('telegramChatId', String(chatId));
  if (!userId) return ack(cq.id);
  const lang = userPrefs.get(userId).lang === 'en' ? 'en' : 'it';
  const T = CB_TOAST[lang] || CB_TOAST.it;

  let toast;
  try {
    if (action === 'f') {
      if (db.getUserFollowedMmsis(userId).has(mmsi)) {
        toast = T.already_followed;
      } else {
        // Lazy require breaks the ship-follow ⇆ telegram require cycle.
        const { reacquiring } = require('./ship-follow').applyFollow(userId, mmsi, true);
        toast = reacquiring ? T.reacquiring : T.followed;
        appLog.info('SHIP', appLog.t('ship.follow', { on: true }), { mmsi });
      }
    } else {
      if (db.getUserFlaggedMmsis(userId).has(mmsi)) {
        toast = T.already_flagged;
      } else {
        db.setUserFlag(userId, mmsi, true);
        toast = T.flagged;
        appLog.info('SHIP', appLog.t('ship.flag', { on: true }), { mmsi });
      }
    }
  } catch (e) {
    appLog.warn('TELEGRAM', appLog.t('telegram.update_failed', { error: e.message }));
  }
  await ack(cq.id, toast);

  // Refresh the inline keyboard to reflect the new state.
  try {
    const followed = db.getUserFollowedMmsis(userId).has(mmsi);
    const flagged = db.getUserFlaggedMmsis(userId).has(mmsi);
    await call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: shipKeyboard(mmsi, lang, followed, flagged) });
  } catch { /* markup unchanged / message too old — ignore */ }
}

async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query);
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
        { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] },
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
  notifyProximity,
  notifyAreaMonitor,
  notifyGroupActivity,
  broadcastOutage,
};
