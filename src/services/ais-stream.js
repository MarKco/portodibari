'use strict';

const WebSocket = require('ws');

const db = require('../db');
const enrichment = require('./enrichment');
const { computeRiskScore } = require('./risk-score');
const { broadcastLog, pendingAlerts } = require('../realtime');
const { API_KEY, AIS_URL, MSG_TYPES, MAX_BODY, RECONNECT_DELAY_MS, BBOX_PRESETS, state } = require('../config');

// Map of areaKey → per-stream state object
const streams = new Map();

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
        const t0 = Date.now();
        const { arrivedFlagged, newShip, revisit, areaChange, arrived } = db.insert(parsed, areaKey);
        if (arrivedFlagged) pendingAlerts.push(arrivedFlagged);
        if (newShip) enrichment.enrichNewShip(newShip);

        // On any arrival: snapshot the score for the history chart, and notify
        // when the ship is in the high-risk band (independent toggle).
        if (arrived) {
          const ship = db.getShip(arrived);
          if (ship) {
            const risk = computeRiskScore(ship, 'it');
            db.recordRiskSnapshot(arrived, risk.score, risk.band);
            if (
              risk.band === 'high' &&
              state.notificationsEnabled &&
              state.notifyHighRisk &&
              !ship.notif_muted
            ) {
              db.addNotification({
                type: 'high_risk',
                mmsi: arrived,
                ship_name: ship.ship_name,
                area: areaKey,
                band: risk.band,
                score: risk.score,
              });
            }
          }
        }
        if (revisit && state.notificationsEnabled && state.notifyRevisit) {
          const ship = db.getShip(revisit);
          if (ship && !ship.notif_muted) {
            const risk = computeRiskScore(ship, 'it');
            db.addNotification({
              type: 'revisit',
              mmsi: revisit,
              ship_name: ship.ship_name,
              area: areaKey,
              band: risk.band,
              score: risk.score,
            });
          }
        }
        if (areaChange && state.notificationsEnabled && state.notifyAreaChange) {
          const ship = db.getShip(areaChange.mmsi);
          if (ship && !ship.notif_muted) {
            const risk = computeRiskScore(ship, 'it');
            db.addNotification({
              type: 'area_change',
              mmsi: areaChange.mmsi,
              ship_name: ship.ship_name,
              area: areaChange.toArea,
              from_area: areaChange.fromArea,
              band: risk.band,
              score: risk.score,
            });
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
      s.reconnectTimer = setTimeout(() => startStream(areaKey), RECONNECT_DELAY_MS);
    }
  });

  s.wsClient.on('error', (err) => {
    console.error(`[AIS:${areaKey}] WS error:`, err.message);
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

module.exports = { startStream, stopStream, removeStream, isActive, getStatus, getHealth };
