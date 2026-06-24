'use strict';

const WebSocket = require('ws');

const db = require('../db');
const enrichment = require('./enrichment');
const userPrefs = require('./user-prefs');
const telegram = require('./telegram');
const berths = require('./berths');
const { computeRiskScore, invalidateRiskCache } = require('./risk-score');
const appLog = require('./app-log');
const { broadcastLog, pushAlert } = require('../realtime');
const { API_KEY, AIS_URL, MSG_TYPES, MAX_BODY, RECONNECT_DELAY_MS, BBOX_PRESETS } = require('../config');

// Map of areaKey → per-stream state object
const streams = new Map();

// Epoch ms of the most recent real AIS *ship* message received across all areas.
// The outage monitor (services/ais-uptime.js) reads this to tell genuine silence
// (which warrants a service-status cross-check) from a healthy busy stream.
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

function createState() {
  return {
    wsClient: null,
    streamActive: false,
    reconnectTimer: null,
    heartbeatTimer: null,
    totalReceived: 0,
    rawFramesReceived: 0,
    connectedAt: null,
    reconnectCount: 0,
    isFirstConnect: true,
    sessionMessages: 0,
    lastAisError: null,
    lastAisErrorAt: null,
  };
}

function startStream(areaKey) {
  if (!BBOX_PRESETS[areaKey]) throw new Error(`Area sconosciuta: ${areaKey}`);

  if (!streams.has(areaKey)) streams.set(areaKey, createState());
  const s = streams.get(areaKey);

  if (s.wsClient) return;

  s.streamActive = true;
  s.wsClient = new WebSocket(AIS_URL);

  s.wsClient.on('open', () => {
    console.log(`[AIS:${areaKey}] Stream connesso`);
    appLog.info('AIS', appLog.t('ais.stream_connected'), { area: areaKey, riconnessione: s.reconnectCount });
    s.rawFramesReceived = 0;
    s.sessionMessages = 0;
    s.connectedAt = Date.now();
    if (s.isFirstConnect) s.isFirstConnect = false;
    else s.reconnectCount++;

    const sub = { APIKey: API_KEY, BoundingBoxes: BBOX_PRESETS[areaKey].box, FilterMessageTypes: MSG_TYPES };
    s.wsClient.send(JSON.stringify(sub));
    const subLog = JSON.stringify(sub).replace(API_KEY, '***masked***');
    broadcastLog(
      db.insertLog({
        method: 'AIS',
        path: `/ais/${areaKey}/connect`,
        status: 200,
        duration_ms: 0,
        response_body: `[${areaKey}] Connesso ad AISStream.io | subscription: ${subLog}`,
      })
    );

    s.heartbeatTimer = setInterval(() => {
      const upSec = Math.round((Date.now() - s.connectedAt) / 1000);
      broadcastLog(
        db.insertLog({
          method: 'AIS',
          path: `/ais/${areaKey}/heartbeat`,
          status: s.rawFramesReceived > 0 ? 200 : 204,
          duration_ms: 0,
          response_body: `[${areaKey}] Connesso da ${upSec}s | frame WS: ${s.rawFramesReceived} | navi: ${s.totalReceived}`,
        })
      );
    }, 60000);
  });

  s.wsClient.on('message', (data) => {
    s.rawFramesReceived++;
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.error) {
        console.error(`[AIS:${areaKey}] Error:`, parsed.error);
        appLog.error('AIS', appLog.t('ais.api_error'), { area: areaKey, error: String(parsed.error) });
        s.lastAisError = String(parsed.error);
        s.lastAisErrorAt = new Date().toISOString();
        broadcastLog(
          db.insertLog({
            method: 'AIS',
            path: `/ais/${areaKey}/api-error`,
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
            path: `/ais/${areaKey}/message`,
            status: 200,
            duration_ms: 0,
            response_body: JSON.stringify(parsed).slice(0, MAX_BODY),
          })
        );
        return;
      }
      if (parsed.MessageType) {
        lastFrameAt = Date.now(); // a real ship message: the pipe is alive
        const t0 = Date.now();
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
            // it and who hasn't muted the ship.
            if (risk.band === 'high') {
              let any = false;
              for (const uid of seers) {
                if (db.isUserMuted(uid, arrived)) continue;
                const p = userPrefs.get(uid);
                if (p.notificationsEnabled && p.notifyHighRisk) {
                  db.addNotification({ user_id: uid, type: 'high_risk', mmsi: arrived, ship_name: ship.ship_name, area: areaKey, band: risk.band, score: risk.score });
                  any = true;
                }
                // Telegram is gated by its own per-user toggle, independent of the
                // in-app one (so a user can get it on Telegram only, or vice versa).
                telegram.notifyShipEvent(uid, 'high_risk', { name: ship.ship_name || arrived, area: areaKey, score: risk.score });
              }
              if (any) appLog.warn('PORTO', appLog.t('port.high_risk', { name: ship.ship_name || arrived }), { mmsi: arrived, area: areaKey, score: risk.score });
            }
          }
        }
        if (revisit) {
          const ship = db.getShip(revisit);
          if (ship) {
            const risk = computeRiskScore(ship, 'it');
            for (const uid of db.getUsersSeeingPoint(ship.last_latitude, ship.last_longitude)) {
              if (db.isUserMuted(uid, revisit)) continue;
              const p = userPrefs.get(uid);
              if (p.notificationsEnabled && p.notifyRevisit) {
                db.addNotification({ user_id: uid, type: 'revisit', mmsi: revisit, ship_name: ship.ship_name, area: areaKey, band: risk.band, score: risk.score });
              }
              telegram.notifyShipEvent(uid, 'revisit', { name: ship.ship_name || revisit, area: areaKey, score: risk.score });
            }
          }
        }
        if (areaChange) {
          const ship = db.getShip(areaChange.mmsi);
          if (ship) {
            const risk = computeRiskScore(ship, 'it');
            let any = false;
            for (const uid of db.getUsersSeeingPoint(ship.last_latitude, ship.last_longitude)) {
              if (db.isUserMuted(uid, areaChange.mmsi)) continue;
              const p = userPrefs.get(uid);
              if (p.notificationsEnabled && p.notifyAreaChange) {
                db.addNotification({ user_id: uid, type: 'area_change', mmsi: areaChange.mmsi, ship_name: ship.ship_name, area: areaChange.toArea, from_area: areaChange.fromArea, band: risk.band, score: risk.score });
                any = true;
              }
              telegram.notifyShipEvent(uid, 'area_change', { name: ship.ship_name || areaChange.mmsi, area: areaChange.toArea, fromArea: areaChange.fromArea, score: risk.score });
            }
            if (any) appLog.info('PORTO', appLog.t('port.area_change', { name: ship.ship_name || areaChange.mmsi }), { mmsi: areaChange.mmsi, da: areaChange.fromArea, a: areaChange.toArea });
          }
        }
        s.totalReceived++;
        s.sessionMessages++;
        broadcastLog(
          db.insertLog({
            method: 'DB',
            path: `/ais/${areaKey}/${parsed.MessageType}`,
            status: 200,
            duration_ms: Date.now() - t0,
            request_body: JSON.stringify(parsed).slice(0, MAX_BODY),
            response_body: null,
          })
        );
      }
    } catch (e) {
      console.error(`[AIS:${areaKey}] Parse error:`, e.message);
      appLog.error('AIS', appLog.t('ais.parse_error'), { area: areaKey, error: e.message });
      broadcastLog(
        db.insertLog({
          method: 'AIS',
          path: `/ais/${areaKey}/parse-error`,
          status: 500,
          duration_ms: 0,
          response_body: e.message,
        })
      );
    }
  });

  s.wsClient.on('close', (code) => {
    console.log(`[AIS:${areaKey}] Connessione chiusa (${code})`);
    clearInterval(s.heartbeatTimer);
    s.heartbeatTimer = null;
    const upSec = s.connectedAt ? Math.round((Date.now() - s.connectedAt) / 1000) : 0;
    broadcastLog(
      db.insertLog({
        method: 'AIS',
        path: `/ais/${areaKey}/disconnect`,
        status: code || 0,
        duration_ms: 0,
        response_body: `[${areaKey}] Connessione chiusa (code ${code}) dopo ${upSec}s | frame: ${s.rawFramesReceived}${s.streamActive ? ' — riconnessione in 5s' : ''}`,
      })
    );
    s.wsClient = null;
    if (s.streamActive) {
      console.log(`[AIS:${areaKey}] Riconnessione in 5s...`);
      appLog.warn('AIS', appLog.t('ais.conn_closed_reconnect', { code }), { area: areaKey, upSec });
      s.reconnectTimer = setTimeout(() => startStream(areaKey), RECONNECT_DELAY_MS);
    } else {
      appLog.info('AIS', appLog.t('ais.conn_closed', { code }), { area: areaKey, upSec });
    }
  });

  s.wsClient.on('error', (err) => {
    console.error(`[AIS:${areaKey}] WS error:`, err.message);
    appLog.error('AIS', appLog.t('ais.ws_error'), { area: areaKey, error: err.message });
    broadcastLog(
      db.insertLog({
        method: 'AIS',
        path: `/ais/${areaKey}/ws-error`,
        status: 500,
        duration_ms: 0,
        response_body: err.message,
      })
    );
    s.wsClient?.terminate();
    s.wsClient = null;
  });
}

function stopStream(areaKey) {
  const s = streams.get(areaKey);
  if (!s) return;
  s.streamActive = false;
  clearTimeout(s.reconnectTimer);
  clearInterval(s.heartbeatTimer);
  if (s.wsClient) {
    s.wsClient.terminate();
    s.wsClient = null;
  }
  console.log(`[AIS:${areaKey}] Stream fermato`);
  appLog.info('AIS', appLog.t('ais.stream_stopped'), { area: areaKey, navi: s.totalReceived });
}

// Stop an area's stream and forget its state entirely (used when the area is
// deleted at runtime, so it no longer shows up in getStatus()).
function removeStream(areaKey) {
  stopStream(areaKey);
  streams.delete(areaKey);
}

function isActive(areaKey) {
  return streams.get(areaKey)?.streamActive || false;
}

/**
 * Snapshot of how long the (collectively) active streams have been silent.
 * `silentMs` is measured from the last received ship message, falling back to
 * the earliest active connection time when none has arrived yet. Returns
 * `{ active:false }` when no stream is running — there's nothing to be silent.
 */
function getSilenceInfo() {
  let anyActive = false;
  let earliestConnected = null;
  for (const s of streams.values()) {
    if (!s.streamActive) continue;
    anyActive = true;
    if (s.connectedAt && (earliestConnected === null || s.connectedAt < earliestConnected)) {
      earliestConnected = s.connectedAt;
    }
  }
  if (!anyActive) return { active: false, silentMs: 0, lastFrameAt };
  const ref = lastFrameAt || earliestConnected || Date.now();
  return { active: true, silentMs: Date.now() - ref, lastFrameAt };
}

function getStatus() {
  const result = {};
  for (const [key, s] of streams) {
    result[key] = { active: s.streamActive, totalReceived: s.totalReceived };
  }
  return { streams: result, dbCount: db.getTotalCount() };
}

function getHealth(areaKey) {
  const s = streams.get(areaKey);
  if (!s) return { area: areaKey, connected: false, notStarted: true };
  const uptimeSec = s.connectedAt ? Math.round((Date.now() - s.connectedAt) / 1000) : 0;
  const msgPerMin = uptimeSec > 0 ? Math.round((s.sessionMessages / uptimeSec) * 60) : null;
  return {
    area: areaKey,
    connected: !!s.wsClient,
    connectedAt: s.connectedAt ? new Date(s.connectedAt).toISOString() : null,
    uptimeSec,
    sessionFrames: s.rawFramesReceived,
    sessionMessages: s.sessionMessages,
    msgPerMin,
    reconnectCount: s.reconnectCount,
    lastAisError: s.lastAisError,
    lastAisErrorAt: s.lastAisErrorAt,
    totalDbCount: db.getTotalCount(),
  };
}

module.exports = { startStream, stopStream, removeStream, isActive, getStatus, getHealth, getSilenceInfo };
