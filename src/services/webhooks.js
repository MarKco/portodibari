'use strict';

// ── Outbound webhooks (per-user) ─────────────────────────────────────────────
// Each user can configure outbound webhooks that fire on the same events as
// their in-app/Telegram notifications, but POSTed to an arbitrary URL — for
// Slack, Discord, a SIEM, or any custom receiver. Per-user (like the Telegram
// link): a webhook only fires for events in the user's own areas.
//
// Stored as one JSON array in user_settings (key 'webhooks'), each entry:
//   { id, url, format: 'generic'|'slack'|'discord', events: string[],
//     secret?: string, enabled: boolean }
//
// Delivery is fire-and-forget (bounded timeout, no retry); a per-webhook secret
// adds an `X-Tracker-Signature: sha256=<hmac>` header so receivers can verify.

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { URL } = require('url');
const db = require('../db');
const appLog = require('./app-log');

const SETTING_KEY = 'webhooks';
const EVENT_TYPES = ['high_risk', 'revisit', 'area_change', 'berth_new', 'berth_characterized', 'proximity', 'outage'];
const FORMATS = ['generic', 'slack', 'discord'];
const POST_TIMEOUT_MS = 8000;
const MAX_WEBHOOKS = 10;

// ── Storage ──────────────────────────────────────────────────────────────────
function load(userId) {
  const raw = db.getUserSettings(userId)[SETTING_KEY];
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((w) => w && typeof w === 'object' && w.id && w.url).map(normalize);
  } catch {
    return [];
  }
}
function save(userId, list) {
  db.setUserSetting(userId, SETTING_KEY, JSON.stringify(list || []));
}
function normalize(w) {
  return {
    id: String(w.id),
    url: String(w.url),
    format: FORMATS.includes(w.format) ? w.format : 'generic',
    events: Array.isArray(w.events) ? w.events.filter((e) => EVENT_TYPES.includes(e)) : [...EVENT_TYPES],
    secret: w.secret ? String(w.secret) : '',
    enabled: w.enabled !== false,
  };
}

// True when an IP address points at an internal/private/loopback/link-local
// target (SSRF). Normalizes IPv4-mapped IPv6 and blocks the cloud metadata range.
// This is the real enforcement point — the hostname string check below is only a
// fast UX pre-filter and is trivially bypassable (decimal/hex IPs, DNS rebinding).
function isBlockedIp(ip) {
  if (!ip) return true;
  let addr = String(ip);
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i); // IPv4-mapped IPv6
  if (mapped) addr = mapped[1];
  const fam = net.isIP(addr);
  if (fam === 4) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 0 || a === 127 || a === 10) return true;            // this-host / loopback / private
    if (a === 169 && b === 254) return true;                       // link-local + cloud metadata
    if (a === 192 && b === 168) return true;                       // private
    if (a === 172 && b >= 16 && b <= 31) return true;              // private
    if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT
    if (a >= 224) return true;                                     // multicast / reserved
    return false;
  }
  if (fam === 6) {
    const l = addr.toLowerCase();
    if (l === '::' || l === '::1') return true;                    // unspecified / loopback
    if (l.startsWith('fe80:')) return true;                        // link-local
    if (l.startsWith('fc') || l.startsWith('fd')) return true;    // unique-local
    return false;
  }
  return true; // not a valid IP literal → block
}

// A dns.lookup drop-in for http(s).request that validates EVERY resolved address
// and refuses the connection if any is internal. Because getaddrinfo also resolves
// decimal/hex/octal IP forms, this catches http://2130706433/ etc., and because it
// runs at connect time it defeats DNS rebinding / TOCTOU (the check and the socket
// use the same resolution).
function guardedLookup(hostname, opts, cb) {
  const options = typeof opts === 'object' && opts ? opts : { family: opts || 0 };
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    for (const a of addresses) {
      if (isBlockedIp(a.address)) return cb(new Error('SSRF: indirizzo interno/privato non consentito'));
    }
    if (options.all) return cb(null, addresses);
    const first = addresses[0];
    cb(null, first.address, first.family);
  });
}

// Reject obviously-internal targets to limit SSRF. Fast pre-filter for immediate
// UX feedback; the authoritative check is guardedLookup at request time. http/https only.
function validateUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return 'URL non valido';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Solo http/https';
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // For hostnames the authoritative check is guardedLookup at connect time (it
  // resolves the name and rejects private IPs, defeating rebinding). Here only
  // reject obvious internal names and IP LITERALS that resolve to internal ranges
  // — isBlockedIp on a non-IP string returns true, so gate it on net.isIP(h).
  if (
    h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local') ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd') ||
    (net.isIP(h) && isBlockedIp(h))
  ) {
    return 'Host interno/privato non consentito';
  }
  return null; // ok
}

// ── CRUD (used by the routes) ────────────────────────────────────────────────
function list(userId) {
  // Mask the secret (never echo it back) — report only whether one is set.
  return load(userId).map((w) => ({ id: w.id, url: w.url, format: w.format, events: w.events, enabled: w.enabled, hasSecret: !!w.secret }));
}
function add(userId, { url, format, events, secret, enabled }) {
  const err = validateUrl(url);
  if (err) throw new Error(err);
  const all = load(userId);
  if (all.length >= MAX_WEBHOOKS) throw new Error(`Massimo ${MAX_WEBHOOKS} webhook`);
  const id = crypto.randomBytes(6).toString('hex');
  const w = normalize({ id, url, format, events, secret, enabled });
  all.push(w);
  save(userId, all);
  return { id: w.id };
}
function update(userId, id, patch) {
  const all = load(userId);
  const w = all.find((x) => x.id === id);
  if (!w) return false;
  if (patch.url != null) {
    const err = validateUrl(patch.url);
    if (err) throw new Error(err);
    w.url = String(patch.url);
  }
  if (patch.format != null) w.format = FORMATS.includes(patch.format) ? patch.format : w.format;
  if (Array.isArray(patch.events)) w.events = patch.events.filter((e) => EVENT_TYPES.includes(e));
  if (patch.enabled != null) w.enabled = !!patch.enabled;
  if (patch.secret != null) w.secret = String(patch.secret); // '' clears it
  save(userId, all.map((x) => (x.id === id ? w : x)));
  return true;
}
function remove(userId, id) {
  const all = load(userId);
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return false;
  save(userId, next);
  return true;
}

// ── Payload shaping ──────────────────────────────────────────────────────────
function buildPayload(type, params) {
  // Generic: a flat, machine-friendly event (SIEM/custom). Spreads the same
  // params the in-app/Telegram path uses, plus a stable envelope.
  return { source: 'tracker-porti', event: type, ts: new Date().toISOString(), ...params };
}

function summaryLine(type, p) {
  const who = p.name || p.ship_name || (p.nameA && p.nameB ? `${p.nameA} ↔ ${p.nameB}` : p.mmsi) || '';
  const area = p.area ? ` · area ${p.area}` : '';
  const score = p.score != null ? ` · score ${p.score}` : '';
  const M = {
    high_risk: `🔴 High-risk vessel arriving: ${who}${area}${score}`,
    revisit: `🔁 Ship revisit: ${who}${area}${score}`,
    area_change: `↔️ Area change: ${who} → ${p.area}${p.fromArea ? ` (from ${p.fromArea})` : ''}${score}`,
    berth_new: `🛳️ New berth detected${area}`,
    berth_characterized: `🏷️ Berth characterised${area}${p.band ? ` · ${p.band}` : ''}`,
    proximity: `🚨 At-sea rendezvous: ${who}${area}${p.distM != null ? ` · ${p.distM} m` : ''}${p.durMin != null ? ` · ${p.durMin} min` : ''}`,
    outage: p.phase === 'end' ? '✅ AIS outage cleared' : `⚠️ AIS outage (no signal for ${p.min} min)`,
  };
  return M[type] || `${type}: ${who}${area}`;
}

function bodyFor(format, type, params) {
  if (format === 'slack') return JSON.stringify({ text: summaryLine(type, params) });
  if (format === 'discord') return JSON.stringify({ content: summaryLine(type, params) });
  return JSON.stringify(buildPayload(type, params));
}

// ── Delivery ─────────────────────────────────────────────────────────────────
function post(webhook, type, params) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(webhook.url);
    } catch {
      return resolve(false);
    }
    const body = bodyFor(webhook.format, type, params);
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'tracker-porti-webhook/1.0' };
    if (webhook.secret) {
      headers['X-Tracker-Signature'] = 'sha256=' + crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      u,
      { method: 'POST', headers, timeout: POST_TIMEOUT_MS, lookup: guardedLookup },
      (res) => {
        res.resume(); // drain
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) appLog.warn('WEBHOOK', appLog.t('webhook.bad_status', { url: u.host, status: res.statusCode }));
        resolve(ok);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      appLog.warn('WEBHOOK', appLog.t('webhook.failed', { url: u.host, error: e.message }));
      resolve(false);
    });
    req.end(body);
  });
}

// Fire a user's webhooks subscribed to `type` (fire-and-forget).
function dispatch(userId, type, params) {
  let hooks;
  try {
    hooks = load(userId);
  } catch {
    return;
  }
  for (const w of hooks) {
    if (w.enabled && w.events.includes(type)) post(w, type, params); // no await
  }
}

// Broadcast a global event (e.g. AIS outage) to every user that has webhooks.
function broadcast(type, params) {
  for (const uid of db.getUserIdsWithSetting(SETTING_KEY)) dispatch(uid, type, params);
}

// Send a synthetic test event to one webhook (awaited; drives the UI button).
async function sendTest(userId, id) {
  const w = load(userId).find((x) => x.id === id);
  if (!w) return false;
  return post(w, 'high_risk', { name: 'TEST VESSEL', mmsi: 0, area: 'test', score: 99, band: 'high', test: true });
}

module.exports = { EVENT_TYPES, FORMATS, list, add, update, remove, dispatch, broadcast, sendTest, validateUrl };
