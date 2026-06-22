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
  areaForPoint,
} = require('../config');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
  if (!ships.length) return null;
  const h = FOLLOW_BOX_HALF_DEG;
  const boxes = ships.map((sh) => [
    [clamp(sh.lat - h, -90, 90), clamp(sh.lon - h, -180, 180)],
    [clamp(sh.lat + h, -90, 90), clamp(sh.lon + h, -180, 180)],
  ]);
  return {
    APIKey: API_KEY,
    BoundingBoxes: boxes,
    FilterMessageTypes: MSG_TYPES,
    FiltersShipMMSI: ships.map((sh) => String(sh.mmsi)),
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
  if (!positions.length) {
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

function getStatus() {
  return { active: s.active, connected: !!s.wsClient, followedCount: s.followedCount, totalReceived: s.totalReceived };
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

module.exports = { init, refresh, stop, getStatus, getHealth };
