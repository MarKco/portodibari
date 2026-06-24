'use strict';

// Dedicated AISstream connection that "follows" individual ships across the open
// sea. Unlike the per-area streams (see ais-stream.js), this keeps a single
// connection whose subscription is a set of small bounding boxes — one per
// followed ship, centred on its last known position — plus a FiltersShipMMSI
// allow-list so we only receive those vessels. As ships move, the boxes are
// rebuilt and re-sent every FOLLOW_REFRESH_MS. A ship silent for
// FOLLOW_STALE_HOURS is auto-unfollowed and drops to the "passate" history.

const WebSocket = require('ws');

const db = require('../db');
const { invalidateRiskCache } = require('./risk-score');
const appLog = require('./app-log');
const telegram = require('./telegram');
const { broadcastLog } = require('../realtime');
const {
  API_KEY,
  AIS_URL,
  MSG_TYPES,
  MAX_BODY,
  RECONNECT_DELAY_MS,
  FOLLOW_BOX_HALF_DEG,
  FOLLOW_REFRESH_MS,
  FOLLOW_STALE_HOURS,
  SEARCH_LOOKUP_TIMEOUT_MS,
  areaForPoint,
} = require('../config');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Whole-globe bounding box. Used for "search lookups" (see addLookup): a ship the
// user searched for whose position we don't know yet. AISstream applies
// FiltersShipMMSI server-side, so a worldwide box filtered to a single MMSI costs
// only that vessel's frames — it lets us recover the live position of any
// transmitting ship anywhere, without knowing where it is first.
const WORLD_BOX = [[-90, -180], [90, 180]];

// Transient position lookups keyed by MMSI → Set of onFix callbacks. Unlike a
// real follow (persisted in user_follows), a lookup lives only as long as a
// search session is open: it injects the MMSI into the subscription with a
// worldwide box, fires its callbacks on the first position fix, and is removed
// when the search is cancelled / times out (see routes/ships.js search/recover).
const lookups = new Map();

// Background position re-acquisitions, keyed by MMSI. Triggered when a ship is
// (re)followed without a recent live fix (e.g. re-followed from "passate"): the
// follow is set optimistically, then we run a worldwide lookup for it. On the
// first fix the re-acquire succeeds silently; if none arrives within
// SEARCH_LOOKUP_TIMEOUT_MS the follow is reverted (back to "passate") and the
// user is notified. Value: { users:Set<userId>, name, cb, timer }.
const reacquires = new Map();

const s = {
  wsClient: null,
  active: false, // we want a connection (there are ships to follow)
  reconnectTimer: null,
  heartbeatTimer: null,
  refreshTimer: null,
  totalReceived: 0,
  rawFramesReceived: 0,
  connectedAt: null,
  reconnectCount: 0,
  isFirstConnect: true,
  sessionMessages: 0,
  followedCount: 0,
  lastAisError: null,
  lastAisErrorAt: null,
};

// One bounding box per followed ship, FOLLOW_BOX_HALF_DEG either side of its last
// position. Returns null when there is nothing to follow (AISstream rejects an
// empty BoundingBoxes — so we disconnect instead of subscribing).
function buildSubscription() {
  const ships = db.getAllFollowedPositions();
  s.followedCount = ships.length;
  const h = FOLLOW_BOX_HALF_DEG;
  // Tight box per followed ship around its last known position.
  const boxes = ships.map((sh) => [
    [clamp(sh.lat - h, -90, 90), clamp(sh.lon - h, -180, 180)],
    [clamp(sh.lat + h, -90, 90), clamp(sh.lon + h, -180, 180)],
  ]);
  const mmsis = new Set(ships.map((sh) => String(sh.mmsi)));
  // Pending search lookups: one shared worldwide box catches them anywhere; the
  // server-side MMSI filter keeps the traffic to just those vessels.
  if (lookups.size) {
    boxes.push(WORLD_BOX);
    for (const m of lookups.keys()) mmsis.add(String(m));
  }
  if (!boxes.length) return null; // nothing to follow and nothing to look up
  return {
    APIKey: API_KEY,
    BoundingBoxes: boxes,
    FilterMessageTypes: MSG_TYPES,
    FiltersShipMMSI: [...mmsis],
  };
}

// Send (or re-send) the current subscription on the open socket. If there is
// nothing left to follow, tear the connection down instead.
function sendSubscription() {
  if (!s.wsClient || s.wsClient.readyState !== WebSocket.OPEN) return;
  const sub = buildSubscription();
  if (!sub) {
    stop();
    return;
  }
  s.wsClient.send(JSON.stringify(sub));
  const masked = JSON.stringify(sub).replace(API_KEY, '***masked***');
  broadcastLog(
    db.insertLog({
      method: 'AIS',
      path: '/ais/follow/subscribe',
      status: 200,
      duration_ms: 0,
      response_body: `[follow] Sottoscrizione ${sub.FiltersShipMMSI.length} navi seguite | ${masked}`,
    })
  );
}

function connect() {
  if (s.wsClient) return;
  s.active = true;
  s.wsClient = new WebSocket(AIS_URL);

  s.wsClient.on('open', () => {
    console.log('[AIS:follow] Stream connesso');
    appLog.info('AIS', appLog.t('ais.stream_connected'), { area: 'follow', riconnessione: s.reconnectCount });
    s.rawFramesReceived = 0;
    s.sessionMessages = 0;
    s.connectedAt = Date.now();
    if (s.isFirstConnect) s.isFirstConnect = false;
    else s.reconnectCount++;

    sendSubscription();

    s.heartbeatTimer = setInterval(() => {
      const upSec = Math.round((Date.now() - s.connectedAt) / 1000);
      broadcastLog(
        db.insertLog({
          method: 'AIS',
          path: '/ais/follow/heartbeat',
          status: s.rawFramesReceived > 0 ? 200 : 204,
          duration_ms: 0,
          response_body: `[follow] Connesso da ${upSec}s | frame WS: ${s.rawFramesReceived} | navi seguite: ${s.followedCount}`,
        })
      );
    }, 60000);
  });

  s.wsClient.on('message', (data) => {
    s.rawFramesReceived++;
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.error) {
        console.error('[AIS:follow] Error:', parsed.error);
        appLog.error('AIS', appLog.t('ais.api_error'), { area: 'follow', error: String(parsed.error) });
        s.lastAisError = String(parsed.error);
        s.lastAisErrorAt = new Date().toISOString();
        broadcastLog(
          db.insertLog({ method: 'AIS', path: '/ais/follow/api-error', status: 401, duration_ms: 0, response_body: String(parsed.error) })
        );
        return;
      }
      if (!parsed.MessageType) return;

      const t0 = Date.now();
      const lat = parsed.MetaData?.latitude ?? null;
      const lon = parsed.MetaData?.longitude ?? null;
      const area = lat != null && lon != null ? areaForPoint(lat, lon) || '' : '';
      const mmsi = db.insertFollowPosition(parsed, area);
      // A search lookup is waiting for this MMSI's first position: hand the fix
      // to its callbacks (the SSE search/recover handler streams it to the UI).
      if (mmsi && lat != null && lon != null && lookups.has(mmsi)) {
        const fix = {
          mmsi,
          lat,
          lon,
          name: (parsed.MetaData?.ShipName || '').trim() || null,
          sog: parsed.Message?.[parsed.MessageType]?.Sog ?? null,
          cog: parsed.Message?.[parsed.MessageType]?.Cog ?? null,
          time: parsed.MetaData?.time_utc || null,
        };
        for (const cb of lookups.get(mmsi)) {
          try { cb(fix); } catch { /* a dead SSE client must not break the stream */ }
        }
      }
      if (mmsi) {
        invalidateRiskCache(mmsi);
        s.totalReceived++;
        s.sessionMessages++;
        broadcastLog(
          db.insertLog({
            method: 'DB',
            path: `/ais/follow/${parsed.MessageType}`,
            status: 200,
            duration_ms: Date.now() - t0,
            request_body: JSON.stringify(parsed).slice(0, MAX_BODY),
            response_body: null,
          })
        );
      }
    } catch (e) {
      console.error('[AIS:follow] Parse error:', e.message);
      appLog.error('AIS', appLog.t('ais.parse_error'), { area: 'follow', error: e.message });
      broadcastLog(
        db.insertLog({ method: 'AIS', path: '/ais/follow/parse-error', status: 500, duration_ms: 0, response_body: e.message })
      );
    }
  });

  s.wsClient.on('close', (code) => {
    console.log(`[AIS:follow] Connessione chiusa (${code})`);
    clearInterval(s.heartbeatTimer);
    s.heartbeatTimer = null;
    const upSec = s.connectedAt ? Math.round((Date.now() - s.connectedAt) / 1000) : 0;
    broadcastLog(
      db.insertLog({
        method: 'AIS',
        path: '/ais/follow/disconnect',
        status: code || 0,
        duration_ms: 0,
        response_body: `[follow] Connessione chiusa (code ${code}) dopo ${upSec}s${s.active ? ' — riconnessione in 5s' : ''}`,
      })
    );
    s.wsClient = null;
    if (s.active) {
      appLog.warn('AIS', appLog.t('ais.conn_closed_reconnect', { code }), { area: 'follow', upSec });
      s.reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    } else {
      appLog.info('AIS', appLog.t('ais.conn_closed', { code }), { area: 'follow', upSec });
    }
  });

  s.wsClient.on('error', (err) => {
    console.error('[AIS:follow] WS error:', err.message);
    appLog.error('AIS', appLog.t('ais.ws_error'), { area: 'follow', error: err.message });
    broadcastLog(
      db.insertLog({ method: 'AIS', path: '/ais/follow/ws-error', status: 500, duration_ms: 0, response_body: err.message })
    );
    s.wsClient?.terminate();
    s.wsClient = null;
  });
}

// Tear down the connection and stop reconnecting (used when nothing is followed).
function stop() {
  s.active = false;
  clearTimeout(s.reconnectTimer);
  clearInterval(s.heartbeatTimer);
  s.reconnectTimer = null;
  s.heartbeatTimer = null;
  if (s.wsClient) {
    s.wsClient.terminate();
    s.wsClient = null;
  }
}

// Periodic + on-demand reconciliation: auto-stop stale follows, then connect /
// resubscribe / disconnect to match the current followed set. Called by the
// refresh timer and immediately whenever a ship is followed/unfollowed.
function refresh() {
  const stale = db.autoStopStaleFollowsAll(FOLLOW_STALE_HOURS);
  if (stale.length) {
    const list = stale.map((x) => x.ship_name || x.mmsi).join(', ');
    appLog.info('AIS', `Follow auto-stop dopo ${FOLLOW_STALE_HOURS}h di silenzio: ${list}`, { area: 'follow', navi: stale.length });
  }

  const positions = db.getAllFollowedPositions();
  s.followedCount = positions.length;
  if (!positions.length && !lookups.size) {
    if (s.wsClient || s.active) stop();
    return;
  }
  if (!s.wsClient && !s.reconnectTimer) {
    connect();
  } else {
    sendSubscription();
  }
}

// Start the background refresh loop. Safe to call once at boot.
function init() {
  if (s.refreshTimer) return;
  s.refreshTimer = setInterval(refresh, FOLLOW_REFRESH_MS);
  refresh();
}

// Register a transient position lookup for `mmsi`. `onFix(fix)` is invoked on the
// first (and every subsequent) position frame for that ship until removeLookup is
// called. Multiple concurrent searches for the same MMSI share one subscription.
// Returns the callback so the caller can pass it back to removeLookup.
function addLookup(mmsi, onFix) {
  mmsi = Number(mmsi);
  let set = lookups.get(mmsi);
  if (!set) {
    set = new Set();
    lookups.set(mmsi, set);
  }
  set.add(onFix);
  // (Re)connect or resubscribe so the worldwide box + MMSI take effect now.
  if (!s.wsClient && !s.reconnectTimer) connect();
  else sendSubscription();
  return onFix;
}

// Drop a lookup callback. When the last callback for an MMSI is gone the worldwide
// box is rebuilt without it; if nothing is followed or looked up the connection
// is torn down. Idempotent.
function removeLookup(mmsi, onFix) {
  mmsi = Number(mmsi);
  const set = lookups.get(mmsi);
  if (!set) return;
  set.delete(onFix);
  if (!set.size) lookups.delete(mmsi);
  refresh();
}

// Begin a background re-acquisition for a just-(re)followed ship. Idempotent per
// MMSI: concurrent followers share one worldwide lookup + one timer.
function startReacquire(userId, mmsi, name) {
  mmsi = Number(mmsi);
  const existing = reacquires.get(mmsi);
  if (existing) { existing.users.add(userId); return; }
  const r = { users: new Set([userId]), name: name || null, cb: null, timer: null };
  reacquires.set(mmsi, r);
  r.cb = addLookup(mmsi, () => finishReacquire(mmsi, true));
  r.timer = setTimeout(() => finishReacquire(mmsi, false), SEARCH_LOOKUP_TIMEOUT_MS);
  appLog.info('AIS', `Ri-acquisizione posizione avviata per ${name || mmsi}`, { area: 'follow', mmsi });
}

// Resolve a re-acquisition. `found=true` (a fix arrived) just tears the lookup
// down and rebuilds the tight box around the fresh position. `found=false` (the
// timer fired) reverts every still-pending follower to "passate" and notifies.
function finishReacquire(mmsi, found) {
  mmsi = Number(mmsi);
  const r = reacquires.get(mmsi);
  if (!r) return; // already resolved (first fix wins / cancelled)
  reacquires.delete(mmsi);
  clearTimeout(r.timer);
  if (r.cb) removeLookup(mmsi, r.cb);
  if (found) {
    appLog.info('AIS', `Ri-acquisizione riuscita per ${r.name || mmsi}`, { area: 'follow', mmsi });
    refresh();
    return;
  }
  appLog.warn('AIS', `Ri-acquisizione fallita per ${r.name || mmsi}: nessun segnale entro il timeout`, { area: 'follow', mmsi });
  for (const userId of r.users) {
    if (!db.getUserFollowedMmsis(userId).has(mmsi)) continue; // user unfollowed meanwhile
    db.setUserFollow(userId, mmsi, false);
    db.addNotification({ user_id: userId, type: 'follow_lost', mmsi, ship_name: r.name });
    try { telegram.notifyShipEvent(userId, 'follow_lost', { name: r.name || `MMSI ${mmsi}` }); } catch { /* best-effort */ }
  }
  refresh();
}

// Cancel a pending re-acquisition for one user (e.g. they unfollowed before it
// resolved). Drops the shared lookup/timer when the last follower leaves.
function cancelReacquire(userId, mmsi) {
  mmsi = Number(mmsi);
  const r = reacquires.get(mmsi);
  if (!r) return;
  r.users.delete(userId);
  if (!r.users.size) {
    clearTimeout(r.timer);
    if (r.cb) removeLookup(mmsi, r.cb);
    reacquires.delete(mmsi);
  }
}

function getStatus() {
  return { active: s.active, connected: !!s.wsClient, followedCount: s.followedCount, lookupCount: lookups.size, reacquireCount: reacquires.size, totalReceived: s.totalReceived };
}

function getHealth() {
  const uptimeSec = s.connectedAt ? Math.round((Date.now() - s.connectedAt) / 1000) : 0;
  const msgPerMin = uptimeSec > 0 ? Math.round((s.sessionMessages / uptimeSec) * 60) : null;
  return {
    area: 'follow',
    connected: !!s.wsClient,
    connectedAt: s.connectedAt ? new Date(s.connectedAt).toISOString() : null,
    uptimeSec,
    followedCount: s.followedCount,
    sessionFrames: s.rawFramesReceived,
    sessionMessages: s.sessionMessages,
    msgPerMin,
    reconnectCount: s.reconnectCount,
    lastAisError: s.lastAisError,
    lastAisErrorAt: s.lastAisErrorAt,
  };
}

module.exports = { init, refresh, stop, addLookup, removeLookup, startReacquire, cancelReacquire, getStatus, getHealth };
