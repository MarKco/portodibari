'use strict';

// GLOBAL COVERAGE HEATMAP — "mappa delle zone coperte".
//
// A single AISStream WebSocket subscribed to the whole globe. Every position
// report's lat/lon is mapped to a fixed grid cell (floor(coord / GRID_DEG)) and
// that cell's in-memory counter is bumped, batch-flushed to the SEPARATE heatmap
// database (heatmap-db.js) every FLUSH_MS — NEVER one write per message: a
// worldwide subscription is a firehose (~100–300 msg/s, ~200–400 MB/h), so the
// hot path does only parse → increment-a-counter. We store NO vessel identity or
// position — only per-cell message counts + a last-seen timestamp.
//
// VISIBILITY: the map (current cells) is readable by ALL authenticated users.
// COLLECTION is an admin-only background task: an admin presses Start, the
// firehose runs in the BACKGROUND until an admin presses Stop — independent of
// who has the page open. The desired on/off state is persisted in the main DB
// `meta` table (key 'heatmap_collecting') and auto-resumes on server restart.
// Viewers (admins holding the live-stats SSE) only receive stats; they do NOT
// start or stop the firehose.
//
// The key (HEATMAP_AIS_API_KEY) must be from a SEPARATE AISStream account: the
// connection limit is per-account, so a key on the same account as AIS_API_KEY
// is rejected (and would starve area monitoring).

const WebSocket = require('ws');

const db = require('../db');
const heatmapDb = require('../heatmap-db');
const appLog = require('./app-log');
const { broadcastLog } = require('../realtime');
const { HEATMAP_API_KEY, HEATMAP, AIS_URL, RECONNECT_DELAY_MS } = require('../config');

const GRID = HEATMAP.GRID_DEG;
const META_KEY = 'heatmap_collecting';

// Pending per-cell deltas, keyed "latIdx:lonIdx". Drained to SQLite by the flush timer.
const cells = new Map();

// Open stats-SSE responses (admins viewing). Stats-only — NOT a collection trigger.
const viewers = new Set();

const s = {
  wsClient: null,
  active: false, // desired: we want a live connection
  reconnectTimer: null,
  heartbeatTimer: null,
  flushTimer: null,
  statsTimer: null,
  connectedAt: null,
  reconnectCount: 0,
  isFirstConnect: true,
  // Consecutive connections that closed having received ZERO messages — the
  // signature of a key on an already-connected account (per-account limit) or an
  // invalid key (opens, then 1006 with no error frame). Drives exponential
  // backoff + a clear diagnosis so a bad key can't hammer AISStream every 5s.
  consecutiveFailures: 0,
  bytesReceived: 0,
  msgReceived: 0,
  lastError: null,
  lastErrorAt: null,
  lastSample: null, // { t, bytes, msgs } rolling sample for instantaneous rate
};

function isEnabled() {
  return !!HEATMAP_API_KEY;
}

/** Desired collection state persisted across restarts (main DB meta). */
function isCollectingDesired() {
  return db.getMeta(META_KEY) === '1';
}

// ── Connection ───────────────────────────────────────────────────────────────

function connect() {
  if (s.wsClient || !isEnabled()) return;
  s.active = true;
  s.wsClient = new WebSocket(AIS_URL);

  s.wsClient.on('open', () => {
    console.log('[AIS:heatmap] Stream globale connesso');
    s.connectedAt = Date.now();
    s.bytesReceived = 0;
    s.msgReceived = 0;
    s.lastSample = { t: Date.now(), bytes: 0, msgs: 0 };
    if (s.isFirstConnect) s.isFirstConnect = false;
    else s.reconnectCount++;

    const sub = {
      APIKey: HEATMAP_API_KEY,
      BoundingBoxes: [HEATMAP.WORLD_BOX],
      FilterMessageTypes: HEATMAP.MSG_TYPES,
    };
    s.wsClient.send(JSON.stringify(sub));
    appLog.warn('HEATMAP', 'Mappa zone coperte: stream AISStream worldwide AVVIATO', {
      riconnessione: s.reconnectCount,
    });
    broadcastLog(
      db.insertLog({
        method: 'AIS',
        path: '/ais/heatmap/connect',
        status: 200,
        duration_ms: 0,
        response_body: '[heatmap] Connesso ad AISStream.io | bounding box: mondiale | tipi: ' + HEATMAP.MSG_TYPES.join(','),
      })
    );

    s.heartbeatTimer = setInterval(() => {
      const upSec = Math.round((Date.now() - s.connectedAt) / 1000);
      broadcastLog(
        db.insertLog({
          method: 'AIS',
          path: '/ais/heatmap/heartbeat',
          status: s.msgReceived > 0 ? 200 : 204,
          duration_ms: 0,
          response_body: `[heatmap] Connesso da ${upSec}s | messaggi: ${s.msgReceived} | MB: ${(s.bytesReceived / 1e6).toFixed(1)} | celle pending: ${cells.size}`,
        })
      );
    }, 60000);
  });

  s.wsClient.on('message', (data) => {
    s.bytesReceived += data.length || 0;
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (parsed.error) {
      s.lastError = String(parsed.error);
      s.lastErrorAt = new Date().toISOString();
      appLog.error('HEATMAP', 'Errore API AISStream (heatmap)', { error: s.lastError });
      broadcastLog(
        db.insertLog({ method: 'AIS', path: '/ais/heatmap/api-error', status: 401, duration_ms: 0, response_body: s.lastError })
      );
      return;
    }
    const lat = parsed.MetaData?.latitude;
    const lon = parsed.MetaData?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return;
    }
    const latIdx = Math.floor(lat / GRID);
    const lonIdx = Math.floor(lon / GRID);
    const key = latIdx + ':' + lonIdx;
    const cell = cells.get(key);
    if (cell) cell.count++;
    else cells.set(key, { latIdx, lonIdx, count: 1 });
    s.msgReceived++;
  });

  s.wsClient.on('close', (code) => {
    console.log(`[AIS:heatmap] Connessione chiusa (${code})`);
    clearInterval(s.heartbeatTimer);
    s.heartbeatTimer = null;
    const upSec = s.connectedAt ? Math.round((Date.now() - s.connectedAt) / 1000) : 0;
    broadcastLog(
      db.insertLog({
        method: 'AIS',
        path: '/ais/heatmap/disconnect',
        status: code || 0,
        duration_ms: 0,
        response_body: `[heatmap] Connessione chiusa (code ${code}) dopo ${upSec}s${s.active ? ' — riconnessione' : ''}`,
      })
    );
    s.wsClient = null;
    if (s.active) {
      if (s.msgReceived === 0) s.consecutiveFailures++;
      else s.consecutiveFailures = 0;
      const delay = Math.min(RECONNECT_DELAY_MS * 2 ** Math.min(s.consecutiveFailures, 6), 5 * 60 * 1000);
      if (s.consecutiveFailures === 3) {
        s.lastError =
          'Connessione chiusa subito senza dati ripetutamente: la chiave è probabilmente su un account ' +
          'AISStream già connesso (limite di connessioni per-account) oppure non è valida. ' +
          'Usa la chiave di un account separato.';
        s.lastErrorAt = new Date().toISOString();
        appLog.error('HEATMAP', s.lastError, { tentativi: s.consecutiveFailures });
      }
      s.reconnectTimer = setTimeout(connect, delay);
    }
  });

  s.wsClient.on('error', (err) => {
    console.error('[AIS:heatmap] WS error:', err.message);
    s.lastError = err.message;
    s.lastErrorAt = new Date().toISOString();
    appLog.error('HEATMAP', 'Errore WebSocket (heatmap)', { error: err.message });
    broadcastLog(
      db.insertLog({ method: 'AIS', path: '/ais/heatmap/ws-error', status: 500, duration_ms: 0, response_body: err.message })
    );
    s.wsClient?.terminate();
    s.wsClient = null;
  });
}

// ── Flush ──────────────────────────────────────────────────────────────────────

function flush() {
  if (!cells.size) return;
  const now = new Date().toISOString();
  const batch = [];
  for (const c of cells.values()) batch.push({ latIdx: c.latIdx, lonIdx: c.lonIdx, count: c.count, lastSeen: now });
  cells.clear();
  try {
    heatmapDb.bumpCells(batch);
  } catch (e) {
    appLog.error('HEATMAP', 'Flush celle heatmap fallito', { error: e.message });
  }
}

// ── Collection control (admin) ──────────────────────────────────────────────────

/** Start background collection and persist the desired state. */
function startCollection() {
  if (!isEnabled()) return { ok: false, error: 'Chiave AISStream heatmap non configurata' };
  db.setMeta(META_KEY, '1');
  s.consecutiveFailures = 0;
  s.lastError = null;
  if (!s.flushTimer) s.flushTimer = setInterval(flush, HEATMAP.FLUSH_MS);
  if (!s.wsClient && !s.reconnectTimer) connect();
  return { ok: true };
}

/** Stop collection, persist the desired state, tear the firehose down + final flush. */
function stopCollection() {
  db.setMeta(META_KEY, '0');
  s.active = false;
  clearTimeout(s.reconnectTimer);
  clearInterval(s.heartbeatTimer);
  s.reconnectTimer = null;
  s.heartbeatTimer = null;
  if (s.wsClient) {
    try { s.wsClient.terminate(); } catch { /* already gone */ }
    s.wsClient = null;
  }
  clearInterval(s.flushTimer);
  s.flushTimer = null;
  flush();
  if (s.connectedAt) appLog.info('HEATMAP', 'Mappa zone coperte: stream FERMATO', { messaggi: s.msgReceived });
  s.connectedAt = null;
  return { ok: true };
}

/**
 * Safety sweep (run periodically): if NO user has been active within `windowMs`,
 * make sure the firehose is off — turn it off if it's still running. Prevents a
 * background collection left on from streaming forever when nobody is using the
 * app at all. Uses the same "online" signal as the admin page (a session touched
 * within the window). No-op when not collecting.
 */
function autoStopIfNoUsers(windowMs) {
  if (!(s.wsClient && s.active)) return;
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const online = db.getOnlineUserIds(cutoff);
  if (!online.length) {
    appLog.warn('HEATMAP', 'Nessun utente attivo: raccolta mappa zone coperte spenta automaticamente');
    stopCollection();
  }
}

/** Boot hook: resume collection if it was on (and the key is present). */
function resumeIfDesired() {
  if (isEnabled() && isCollectingDesired()) {
    appLog.info('HEATMAP', 'Mappa zone coperte: ripresa raccolta dopo riavvio');
    startCollection();
  }
}

// ── Viewers (stats SSE — admin only, stats-only) ─────────────────────────────────

function liveRates() {
  const now = Date.now();
  const prev = s.lastSample;
  let bps = 0;
  let mps = 0;
  if (prev) {
    const dt = (now - prev.t) / 1000;
    if (dt > 0) {
      bps = Math.max(0, (s.bytesReceived - prev.bytes) / dt);
      mps = Math.max(0, (s.msgReceived - prev.msgs) / dt);
    }
  }
  s.lastSample = { t: now, bytes: s.bytesReceived, msgs: s.msgReceived };
  return { bytesPerSec: bps, msgPerSec: mps };
}

function getLiveStats() {
  const rates = liveRates();
  const dbStats = heatmapDb.getStats();
  return {
    enabled: isEnabled(),
    collecting: !!s.wsClient && s.active,
    desired: isCollectingDesired(),
    viewers: viewers.size,
    uptimeSec: s.connectedAt ? Math.round((Date.now() - s.connectedAt) / 1000) : 0,
    reconnectCount: s.reconnectCount,
    consecutiveFailures: s.consecutiveFailures,
    gridDeg: GRID,
    bytesReceived: s.bytesReceived,
    msgReceived: s.msgReceived,
    pendingCells: cells.size,
    bytesPerSec: Math.round(rates.bytesPerSec),
    msgPerSec: Math.round(rates.msgPerSec),
    lastError: s.lastError,
    lastErrorAt: s.lastErrorAt,
    storedCells: dbStats.cells,
    totalMessages: dbStats.total,
    maxCellCount: dbStats.maxCount,
    firstSeen: dbStats.firstSeen,
    lastSeen: dbStats.lastSeen,
  };
}

function pushStats() {
  if (!viewers.size) return;
  const payload = 'data: ' + JSON.stringify(getLiveStats()) + '\n\n';
  for (const res of viewers) {
    try { res.write(payload); } catch { /* dead client; close handler drops it */ }
  }
}

function addViewer(res) {
  viewers.add(res);
  if (!s.statsTimer) s.statsTimer = setInterval(pushStats, HEATMAP.STATS_MS);
  try { res.write('data: ' + JSON.stringify(getLiveStats()) + '\n\n'); } catch { /* ignore */ }
}

function removeViewer(res) {
  viewers.delete(res);
  if (!viewers.size) {
    clearInterval(s.statsTimer);
    s.statsTimer = null;
  }
}

/** Wipe all computed data (pending deltas + persisted cells). */
function reset() {
  cells.clear();
  const n = heatmapDb.clear();
  appLog.warn('HEATMAP', 'Dati mappa zone coperte azzerati', { celle: n });
  return n;
}

module.exports = {
  isEnabled,
  isCollectingDesired,
  startCollection,
  stopCollection,
  resumeIfDesired,
  autoStopIfNoUsers,
  addViewer,
  removeViewer,
  getLiveStats,
  getCells: () => heatmapDb.getCells(),
  reset,
};
