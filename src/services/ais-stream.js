'use strict';

const WebSocket = require('ws');

const db = require('../db');
const enrichment = require('./enrichment');
const userPrefs = require('./user-prefs');
const telegram = require('./telegram');
const webhooks = require('./webhooks');
const berths = require('./berths');
const { computeRiskScore, computeRiskScoreCached, invalidateRiskCache } = require('./risk-score');
const { shouldNotifyShip } = require('./notify-categories');
const appLog = require('./app-log');
const { broadcastLog, pushAlert } = require('../realtime');
const { API_KEY, API_KEY_SOURCE, maskKey, AIS_URL, MSG_TYPES, MAX_BODY, BBOX_PRESETS } = require('../config');
const { destinationLabel } = require('./locode');
const { keyAbuseReason, backoffDelay, closeSocket } = require('./ais-backoff');
const { traceKey } = require('./key-trace');

// Non-secret key fingerprint for logs (which key this stream uses → diagnose 429s).
const KEY_TAG = `${maskKey(API_KEY)} (${API_KEY_SOURCE})`;

// SINGLE shared connection for ALL monitored areas.
//
// AISStream limits concurrent connections PER ACCOUNT, so opening one socket per
// area (the old design) put N connections on the one monitoring account and a
// second area's handshake was refused with 429. A subscription accepts MANY
// bounding boxes at once (the ship-follow stream already relies on this), so we
// hold ONE connection whose BoundingBoxes is the union of every active area's box
// and attribute each incoming message to an area by its position (areaForActive).
// Starting/stopping an area just rebuilds + re-sends the subscription on the live
// socket — no extra connection is ever opened.
const conn = {
  wsClient: null,
  active: false, // desired: at least one area is being monitored
  reconnectTimer: null,
  heartbeatTimer: null,
  healthyTimer: null, // fires after a grace period to reset the backoff ramp
  connectedAt: null,
  reconnectCount: 0,
  isFirstConnect: true,
  connFailCount: 0, // consecutive failed connection attempts (drives backoff)
  was429: false, // last failure was an HTTP 429 handshake rejection
  abuseReason: null, // human reason when the failure is a key over-use problem
  rawFramesReceived: 0,
  sessionMessages: 0,
  lastAisError: null,
  lastAisErrorAt: null,
  disconnectedSince: null, // epoch ms since the last time we lost a HEALTHY connection (null when healthy/inactive) — see getConnTrouble
  reconnectLog: [], // epoch ms of recent reconnect-scheduled events (bounded) — flapping detection, see getConnTrouble
};

// Per-area bookkeeping (the desired-active flag + a lifetime message counter for
// getStatus/getHealth). Holds NO socket — there is only the one shared connection.
const areas = new Map(); // areaKey → { active: bool, totalReceived: number }

function areaMeta(areaKey) {
  let m = areas.get(areaKey);
  if (!m) {
    m = { active: false, totalReceived: 0 };
    areas.set(areaKey, m);
  }
  return m;
}

function activeKeys() {
  const out = [];
  for (const [key, m] of areas) if (m.active && BBOX_PRESETS[key]) out.push(key);
  return out;
}

// Smallest active area whose box contains the point — mirrors config.areaForPoint
// but limited to the areas we're actually subscribed to, so a message is credited
// to the tightest active box covering it. Falls back to the first active area when
// the position is missing/out of every box (a rare boundary artifact: AISStream
// only delivers messages inside the subscribed boxes), so a reading is never
// attributed to an empty area.
function areaForActive(lat, lon) {
  const keys = activeKeys();
  if (!keys.length) return '';
  if (lat == null || lon == null) return keys[0];
  let best = null;
  let bestSize = Infinity;
  for (const key of keys) {
    const [[swLat, swLon], [neLat, neLon]] = BBOX_PRESETS[key].box[0];
    if (lat >= swLat && lat <= neLat && lon >= swLon && lon <= neLon) {
      const size = (neLat - swLat) * (neLon - swLon);
      if (size < bestSize) { bestSize = size; best = key; }
    }
  }
  return best || keys[0];
}

// Epoch ms of the most recent real AIS *ship* message received. The outage monitor
// (services/ais-uptime.js) reads this to tell genuine silence (which warrants a
// service-status cross-check) from a healthy busy stream.
let lastFrameAt = null;

// Arrivals are collected here and flushed as a single log line once a minute
// (rather than one line per ship), so a busy area doesn't drown the log.
let arrivalNames = [];
function bufferArrival(name) {
  arrivalNames.push(String(name));
}
function flushArrivals() {
  if (!arrivalNames.length) return;
  const names = arrivalNames;
  arrivalNames = [];
  appLog.info('PORTO', appLog.t('port.arrivals', { count: names.length, list: names.join(', ') }), { navi: names.length });
}
setInterval(flushArrivals, 60 * 1000);

// Build the subscription covering every active area, or null when nothing is
// active (AISStream rejects an empty BoundingBoxes — we disconnect instead).
function buildSubscription() {
  const keys = activeKeys();
  if (!keys.length) return null;
  // Each preset's `box` is already the [[ [swLat,swLon],[neLat,neLon] ]] shape
  // AISStream wants; the union is just every active area's box concatenated.
  const boxes = keys.flatMap((k) => BBOX_PRESETS[k].box);
  return { sub: { APIKey: API_KEY, BoundingBoxes: boxes, FilterMessageTypes: MSG_TYPES }, keys };
}

// (Re)send the current subscription on the open socket. Tears the connection down
// when nothing is left to monitor.
function sendSubscription() {
  if (!conn.wsClient || conn.wsClient.readyState !== WebSocket.OPEN) return;
  const built = buildSubscription();
  if (!built) {
    teardown();
    return;
  }
  conn.wsClient.send(JSON.stringify(built.sub));
  traceKey(API_KEY, 'monitoring', 'SUBSCRIBE', { aree: built.keys.length });
  const subLog = JSON.stringify(built.sub).replace(API_KEY, '***masked***');
  broadcastLog(
    db.insertLog({
      method: 'AIS',
      path: '/ais/monitoring/connect',
      status: 200,
      duration_ms: 0,
      response_body: `[monitoring] Connesso ad AISStream.io | aree: ${built.keys.join(', ')} | subscription: ${subLog}`,
    })
  );
}

function connect() {
  if (conn.wsClient) return;
  if (!activeKeys().length) return; // nothing to monitor
  conn.active = true;
  traceKey(API_KEY, 'monitoring', 'WS_OPEN', { riconnessione: conn.reconnectCount });
  // Bind every handler to THIS socket instance and guard on it: an error→close
  // sequence on a stale socket must never mutate the shared state of a newer one
  // (that race could open a second connection on the same account → 429 storm).
  const ws = new WebSocket(AIS_URL);
  conn.wsClient = ws;

  ws.on('open', () => {
    if (conn.wsClient !== ws) return;
    traceKey(API_KEY, 'monitoring', 'OPEN_OK');
    console.log('[AIS:monitoring] Stream connesso');
    appLog.info('AIS', appLog.t('ais.stream_connected'), { area: 'monitoring', riconnessione: conn.reconnectCount });
    conn.rawFramesReceived = 0;
    conn.sessionMessages = 0;
    conn.connectedAt = Date.now();
    conn.was429 = false;
    conn.abuseReason = null;
    // Do NOT reset the backoff ramp on 'open': AISStream authenticates only AFTER
    // the handshake (an invalid key/subscription opens the socket, then errors and
    // closes). Resetting here restarted the ramp every cycle → a 5s infinite
    // reconnect loop that never backed off. Reset only once the connection proves
    // healthy — a grace period elapses, or the first real ship message arrives.
    clearTimeout(conn.healthyTimer);
    conn.healthyTimer = setTimeout(() => { if (conn.wsClient === ws) { conn.connFailCount = 0; conn.disconnectedSince = null; } }, 30000);
    if (conn.isFirstConnect) conn.isFirstConnect = false;
    else conn.reconnectCount++;

    sendSubscription();

    conn.heartbeatTimer = setInterval(() => {
      const upSec = Math.round((Date.now() - conn.connectedAt) / 1000);
      broadcastLog(
        db.insertLog({
          method: 'AIS',
          path: '/ais/monitoring/heartbeat',
          status: conn.rawFramesReceived > 0 ? 200 : 204,
          duration_ms: 0,
          response_body: `[monitoring] Connesso da ${upSec}s | frame WS: ${conn.rawFramesReceived} | aree attive: ${activeKeys().length}`,
        })
      );
    }, 60000);
  });

  ws.on('message', (data) => {
    if (conn.wsClient !== ws) return;
    conn.rawFramesReceived++;
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.error) {
        console.error('[AIS:monitoring] Error:', parsed.error);
        const apiAbuse = keyAbuseReason(parsed.error);
        if (apiAbuse) { conn.was429 = true; conn.abuseReason = apiAbuse; }
        traceKey(API_KEY, 'monitoring', 'API_ERROR', { error: String(parsed.error), ...(apiAbuse ? { problema: apiAbuse } : {}) });
        appLog.error('AIS', appLog.t('ais.api_error'), { area: 'monitoring', error: String(parsed.error), key: KEY_TAG, ...(apiAbuse ? { problema: apiAbuse } : {}) });
        conn.lastAisError = String(parsed.error);
        conn.lastAisErrorAt = new Date().toISOString();
        broadcastLog(
          db.insertLog({
            method: 'AIS',
            path: '/ais/monitoring/api-error',
            status: 401,
            duration_ms: 0,
            response_body: String(parsed.error),
          })
        );
        return;
      }
      if (!parsed.MessageType && !parsed.error) {
        broadcastLog(
          db.insertLog({
            method: 'AIS',
            path: '/ais/monitoring/message',
            status: 200,
            duration_ms: 0,
            response_body: JSON.stringify(parsed).slice(0, MAX_BODY),
          })
        );
        return;
      }
      if (parsed.MessageType) {
        lastFrameAt = Date.now(); // a real ship message: the pipe is alive
        conn.connFailCount = 0; // subscription accepted & delivering: healthy
        conn.disconnectedSince = null;
        const t0 = Date.now();
        // Attribute the message to the (tightest) active area covering its
        // position — replaces the old "one socket per area knows its own key".
        const areaKey = areaForActive(parsed.MetaData?.latitude ?? null, parsed.MetaData?.longitude ?? null);
        const { arrivedFlagged, newShip, revisit, areaChange, arrived } = db.insert(parsed, areaKey);
        // New data for this ship → its cached risk score is stale.
        invalidateRiskCache(parsed.MetaData?.MMSI);
        if (newShip) enrichment.enrichNewShip(newShip);
        // Arrivals/departures change the mooring set for this area: mark it for
        // the next dirty-flush recompute so the berth list stays fresh.
        if (arrived) berths.markAreaDirty(areaKey);

        // On any arrival: snapshot the score for the history chart, and fan a
        // notification out to every user who monitors the arrival point and a
        // flagged-arrival toast to those who flagged the ship. Per-user mutes are
        // honored; the system-wide toggles gate the notification *type*.
        if (arrived) {
          const ship = db.getShip(arrived);
          if (ship) {
            // Arrivals are bundled into one per-minute log line (see flushArrivals)
            // instead of one line each, to keep the log readable on busy areas.
            bufferArrival(ship.ship_name || arrived);
            const risk = computeRiskScore(ship, 'it');
            db.recordRiskSnapshot(arrived, risk.score, risk.band);
            const seers = db.getUsersSeeingPoint(ship.last_latitude, ship.last_longitude);

            if (arrivedFlagged) {
              const flaggers = new Set(db.getUsersFlagging(arrived));
              for (const uid of seers) if (flaggers.has(uid)) pushAlert(uid, arrived);
            }

            // High-risk: notify each monitoring user whose PERSONAL prefs enable
            // it, who hasn't muted the ship, and whose ship-category/seen filter
            // (Settings → Notifiche) doesn't exclude it — that filter gates BOTH
            // the in-app row and the Telegram/webhook dispatch below, uniformly.
            if (risk.band === 'high') {
              // Top risk factor (the WHY) in both languages, so each recipient's
              // Telegram caption shows it in their own language. Cached scorer →
              // at most one extra (memoised) compute per language per event.
              const fIt = risk.factors[0] ? risk.factors[0].label : null;
              const fEn = computeRiskScoreCached(ship, 'en').factors[0]?.label || null;
              let any = false;
              for (const uid of seers) {
                if (db.isUserMuted(uid, arrived)) continue;
                const p = userPrefs.get(uid);
                if (!shouldNotifyShip(uid, ship, p)) continue;
                if (p.notificationsEnabled && p.notifyHighRisk) {
                  db.addNotification({ user_id: uid, type: 'high_risk', mmsi: arrived, ship_name: ship.ship_name, area: areaKey, band: risk.band, score: risk.score });
                  any = true;
                }
                // Telegram is gated by its own per-user toggle, independent of the
                // in-app one (so a user can get it on Telegram only, or vice versa).
                const evp = { name: ship.ship_name || arrived, mmsi: arrived, shipType: ship.ship_type, area: areaKey, score: risk.score, lat: ship.last_latitude, lon: ship.last_longitude, sog: ship.last_sog, cog: ship.last_cog, dest: destinationLabel(ship.destination), factorIt: fIt, factorEn: fEn };
                telegram.notifyShipEvent(uid, 'high_risk', evp);
                webhooks.dispatch(uid, 'high_risk', evp);
              }
              if (any) appLog.warn('PORTO', appLog.t('port.high_risk', { name: ship.ship_name || arrived }), { mmsi: arrived, area: areaKey, score: risk.score });
            }
          }
        }
        if (revisit) {
          const ship = db.getShip(revisit);
          if (ship) {
            const risk = computeRiskScore(ship, 'it');
            const fIt = risk.factors[0] ? risk.factors[0].label : null;
            const fEn = computeRiskScoreCached(ship, 'en').factors[0]?.label || null;
            for (const uid of db.getUsersSeeingPoint(ship.last_latitude, ship.last_longitude)) {
              if (db.isUserMuted(uid, revisit)) continue;
              const p = userPrefs.get(uid);
              if (!shouldNotifyShip(uid, ship, p)) continue;
              if (p.notificationsEnabled && p.notifyRevisit) {
                db.addNotification({ user_id: uid, type: 'revisit', mmsi: revisit, ship_name: ship.ship_name, area: areaKey, band: risk.band, score: risk.score });
              }
              const evp = { name: ship.ship_name || revisit, mmsi: revisit, shipType: ship.ship_type, area: areaKey, score: risk.score, lat: ship.last_latitude, lon: ship.last_longitude, sog: ship.last_sog, cog: ship.last_cog, dest: destinationLabel(ship.destination), factorIt: fIt, factorEn: fEn };
              telegram.notifyShipEvent(uid, 'revisit', evp);
              webhooks.dispatch(uid, 'revisit', evp);
            }
          }
        }
        if (areaChange) {
          const ship = db.getShip(areaChange.mmsi);
          if (ship) {
            const risk = computeRiskScore(ship, 'it');
            const fIt = risk.factors[0] ? risk.factors[0].label : null;
            const fEn = computeRiskScoreCached(ship, 'en').factors[0]?.label || null;
            let any = false;
            // Recipients = users who monitor BOTH areaChange.fromArea and
            // .toArea by key (group members included via the mirrored
            // user_areas rows) — not merely whoever's bbox geographically
            // covers the ship's current point, which would also catch users
            // owning only the destination area when one area's bbox contains
            // the other's.
            for (const uid of db.getUsersWithBothAreas(areaChange.fromArea, areaChange.toArea)) {
              if (db.isUserMuted(uid, areaChange.mmsi)) continue;
              const p = userPrefs.get(uid);
              if (!shouldNotifyShip(uid, ship, p)) continue;
              if (p.notificationsEnabled && p.notifyAreaChange) {
                db.addNotification({ user_id: uid, type: 'area_change', mmsi: areaChange.mmsi, ship_name: ship.ship_name, area: areaChange.toArea, from_area: areaChange.fromArea, band: risk.band, score: risk.score });
                any = true;
              }
              const evp = { name: ship.ship_name || areaChange.mmsi, mmsi: areaChange.mmsi, shipType: ship.ship_type, area: areaChange.toArea, fromArea: areaChange.fromArea, score: risk.score, lat: ship.last_latitude, lon: ship.last_longitude, sog: ship.last_sog, cog: ship.last_cog, dest: destinationLabel(ship.destination), factorIt: fIt, factorEn: fEn };
              telegram.notifyShipEvent(uid, 'area_change', evp);
              webhooks.dispatch(uid, 'area_change', evp);
            }
            if (any) appLog.info('PORTO', appLog.t('port.area_change', { name: ship.ship_name || areaChange.mmsi }), { mmsi: areaChange.mmsi, da: areaChange.fromArea, a: areaChange.toArea });
          }
        }
        const m = areas.get(areaKey);
        if (m) m.totalReceived++;
        conn.sessionMessages++;
        broadcastLog(
          db.insertLog({
            method: 'DB',
            path: `/ais/${areaKey || 'monitoring'}/${parsed.MessageType}`,
            status: 200,
            duration_ms: Date.now() - t0,
            request_body: JSON.stringify(parsed).slice(0, MAX_BODY),
            response_body: null,
          })
        );
      }
    } catch (e) {
      console.error('[AIS:monitoring] Parse error:', e.message);
      appLog.error('AIS', appLog.t('ais.parse_error'), { area: 'monitoring', error: e.message });
      broadcastLog(
        db.insertLog({
          method: 'AIS',
          path: '/ais/monitoring/parse-error',
          status: 500,
          duration_ms: 0,
          response_body: e.message,
        })
      );
    }
  });

  ws.on('close', (code) => {
    if (conn.wsClient !== ws) return; // a superseded socket closing; ignore
    traceKey(API_KEY, 'monitoring', `CLOSE(${code})`, conn.abuseReason ? { problema: conn.abuseReason } : undefined);
    console.log(`[AIS:monitoring] Connessione chiusa (${code})`);
    clearInterval(conn.heartbeatTimer);
    conn.heartbeatTimer = null;
    clearTimeout(conn.healthyTimer);
    conn.healthyTimer = null;
    const upSec = conn.connectedAt ? Math.round((Date.now() - conn.connectedAt) / 1000) : 0;
    const delayMs = conn.active ? backoffDelay(conn.connFailCount, conn.was429) : 0;
    const delaySec = Math.round(delayMs / 1000);
    broadcastLog(
      db.insertLog({
        method: 'AIS',
        path: '/ais/monitoring/disconnect',
        status: code || 0,
        duration_ms: 0,
        response_body: `[monitoring] Connessione chiusa (code ${code}) dopo ${upSec}s | frame: ${conn.rawFramesReceived} | key: ${KEY_TAG}${conn.active ? ` — riconnessione in ${delaySec}s${conn.abuseReason ? ` — ${conn.abuseReason}` : ''}` : ''}`,
      })
    );
    conn.wsClient = null;
    if (conn.active && activeKeys().length) {
      if (!conn.disconnectedSince) conn.disconnectedSince = Date.now();
      conn.reconnectLog.push(Date.now());
      if (conn.reconnectLog.length > 20) conn.reconnectLog.shift();
      conn.connFailCount++;
      console.log(`[AIS:monitoring] Riconnessione in ${delaySec}s...`);
      appLog.warn('AIS', appLog.t('ais.conn_closed_reconnect', { code, delaySec }), { area: 'monitoring', upSec, delaySec, key: KEY_TAG, ...(conn.abuseReason ? { problema: conn.abuseReason } : {}) });
      traceKey(API_KEY, 'monitoring', 'RECONNECT', { delaySec });
      conn.reconnectTimer = setTimeout(() => { conn.reconnectTimer = null; connect(); }, delayMs);
    } else {
      conn.active = false;
      appLog.info('AIS', appLog.t('ais.conn_closed', { code }), { area: 'monitoring', upSec, key: KEY_TAG });
    }
  });

  ws.on('error', (err) => {
    if (conn.wsClient !== ws) return;
    const abuse = keyAbuseReason(err.message);
    if (abuse) { conn.was429 = true; conn.abuseReason = abuse; } // raise the reconnect floor (see close handler)
    traceKey(API_KEY, 'monitoring', 'ERROR', { error: err.message, ...(abuse ? { problema: abuse } : {}) });
    console.error('[AIS:monitoring] WS error:', err.message);
    appLog.error('AIS', appLog.t('ais.ws_error'), { area: 'monitoring', error: err.message, key: KEY_TAG, ...(abuse ? { problema: abuse } : {}) });
    broadcastLog(
      db.insertLog({
        method: 'AIS',
        path: '/ais/monitoring/ws-error',
        status: 500,
        duration_ms: 0,
        response_body: err.message,
      })
    );
    // Terminate and let THIS socket's 'close' handler run the single teardown +
    // reconnect path. Do NOT null conn.wsClient here: keeping it set until close
    // blocks a concurrent connect() from opening a second socket in the gap.
    ws.terminate();
  });
}

// Tear the shared connection down and stop reconnecting (no area is active).
function teardown() {
  conn.active = false;
  conn.disconnectedSince = null; // no longer desired-active: not an error state
  conn.reconnectLog = [];
  clearTimeout(conn.reconnectTimer);
  clearInterval(conn.heartbeatTimer);
  clearTimeout(conn.healthyTimer);
  conn.reconnectTimer = null;
  conn.heartbeatTimer = null;
  conn.healthyTimer = null;
  if (conn.wsClient) {
    traceKey(API_KEY, 'monitoring', 'CLOSE_GRACEFUL');
    closeSocket(conn.wsClient); // close frame → free the per-account slot promptly
    conn.wsClient = null;
  }
}

// Reconcile the live connection to the active set: connect/resubscribe when at
// least one area is active, tear down when none is.
function ensureConnection() {
  if (!activeKeys().length) {
    if (conn.wsClient || conn.active) teardown();
    return;
  }
  if (!conn.wsClient && !conn.reconnectTimer) connect();
  else sendSubscription();
}

// Start monitoring an area: flag it active, persist the intent (so a deploy/restart
// or DB restore brings exactly this set back — see db.setAreaActive), then fold its
// box into the single shared subscription. Opens the connection only if it's the
// first active area; otherwise just re-sends the (now larger) subscription.
function startStream(areaKey) {
  if (!BBOX_PRESETS[areaKey]) throw new Error(`Area sconosciuta: ${areaKey}`);
  const m = areaMeta(areaKey);
  if (m.active) { ensureConnection(); return; }
  m.active = true;
  try { db.setAreaActive(areaKey, 1); } catch { /* area row not yet in catalog */ }
  ensureConnection();
}

// Stop monitoring an area: clear its active flag, persist, and rebuild the shared
// subscription without its box (tearing the connection down if it was the last one).
function stopStream(areaKey) {
  const m = areas.get(areaKey);
  if (!m || !m.active) return;
  m.active = false;
  try { db.setAreaActive(areaKey, 0); } catch { /* area row already gone */ }
  ensureConnection();
  console.log(`[AIS:${areaKey}] Monitoraggio fermato`);
  appLog.info('AIS', appLog.t('ais.stream_stopped'), { area: areaKey, navi: m.totalReceived });
}

// Stop an area and forget its bookkeeping entirely (used when the area is deleted
// at runtime, so it no longer shows up in getStatus()).
function removeStream(areaKey) {
  stopStream(areaKey);
  areas.delete(areaKey);
}

function isActive(areaKey) {
  return areas.get(areaKey)?.active || false;
}

/**
 * Snapshot of how long the monitoring connection has been silent. `silentMs` is
 * measured from the last received ship message, falling back to the connection
 * time when none has arrived yet. Returns `{ active:false }` when nothing is
 * monitored — there's nothing to be silent.
 */
function getSilenceInfo() {
  if (!activeKeys().length) return { active: false, silentMs: 0, lastFrameAt };
  const ref = lastFrameAt || conn.connectedAt || Date.now();
  return { active: true, silentMs: Date.now() - ref, lastFrameAt };
}

// Cheap, synchronous connectivity signal for the outage banner (services/ais-uptime.js).
// getSilenceInfo() above is ambiguous on its own — a connected-but-quiet area looks
// identical to a dead pipe, hence the external-monitor cross-check. But a stream that
// can't even hold a connection (repeatedly closes right after connecting, before any
// ship message resets connectedAt) is unambiguous: `disconnectedSince`/`reconnectLog`
// catch that case directly, no cross-check needed — same signal used for follow/heatmap.
function getConnTrouble() {
  return { active: conn.active, connected: !!conn.wsClient, disconnectedSince: conn.disconnectedSince, reconnectLog: conn.reconnectLog };
}

function getStatus() {
  const result = {};
  for (const [key, m] of areas) {
    result[key] = { active: m.active, totalReceived: m.totalReceived };
  }
  return { streams: result, dbCount: db.getTotalCount() };
}

function getHealth(areaKey) {
  const m = areas.get(areaKey);
  if (!m) return { area: areaKey, connected: false, notStarted: true };
  const uptimeSec = conn.connectedAt ? Math.round((Date.now() - conn.connectedAt) / 1000) : 0;
  const msgPerMin = uptimeSec > 0 ? Math.round((conn.sessionMessages / uptimeSec) * 60) : null;
  return {
    area: areaKey,
    keyTag: KEY_TAG,
    keySource: API_KEY_SOURCE,
    connected: !!conn.wsClient,
    connectedAt: conn.connectedAt ? new Date(conn.connectedAt).toISOString() : null,
    uptimeSec,
    sessionFrames: conn.rawFramesReceived,
    sessionMessages: conn.sessionMessages,
    msgPerMin,
    reconnectCount: conn.reconnectCount,
    lastAisError: conn.lastAisError,
    lastAisErrorAt: conn.lastAisErrorAt,
    totalDbCount: db.getTotalCount(),
  };
}

// Reconcile the live connection to the persisted active set (db.getActiveAreaKeys):
// flag the desired areas active, clear the rest, then connect/resubscribe/teardown
// once. Unknown keys (catalog/config drift) are skipped. Returns the keys now
// meant to be active.
function syncActiveStreams() {
  const desired = new Set(db.getActiveAreaKeys().filter((k) => BBOX_PRESETS[k]));
  for (const [key, m] of areas) {
    if (m.active && !desired.has(key)) {
      m.active = false;
      try { db.setAreaActive(key, 0); } catch { /* area row gone */ }
    }
  }
  for (const key of desired) {
    const m = areaMeta(key);
    if (!m.active) {
      m.active = true;
      try { db.setAreaActive(key, 1); } catch { /* area row gone */ }
    }
  }
  ensureConnection();
  return [...desired];
}

// Bring back the monitorings that were active before this restart/restore — and
// only those. Called on boot and after every DB restore. The persisted active set
// rides in backups, so a deploy's auto-restore and a manual restore both land here
// with the right flags. First boot ever (or restoring a pre-feature backup that
// carries no intent): nothing is flagged, so adopt whatever is already active, or
// fall back to `defaultArea` (the preset) so a fresh install still monitors. The
// `streams_bootstrapped` meta marks that the persisted set is now authoritative.
function resumeActiveStreams({ defaultArea = null } = {}) {
  if (!db.getMeta('streams_bootstrapped')) {
    const running = activeKeys();
    const seed = running.length ? running : defaultArea ? [defaultArea] : [];
    for (const key of seed) {
      if (!BBOX_PRESETS[key]) continue;
      try { startStream(key); } catch { /* unknown area */ }
    }
    db.setMeta('streams_bootstrapped', '1');
    return seed;
  }
  return syncActiveStreams();
}

module.exports = {
  startStream,
  stopStream,
  removeStream,
  isActive,
  getStatus,
  getHealth,
  getSilenceInfo,
  getConnTrouble,
  syncActiveStreams,
  resumeActiveStreams,
};
