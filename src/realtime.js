'use strict';

// Shared real-time buses used by both the AIS stream and the HTTP layer.
//
// - logClients: open SSE responses subscribed to the live API-log stream.
// - pendingAlerts: MMSIs of flagged ships that just arrived, drained by
//   GET /api/alerts and surfaced as a toast in the UI.

const logClients = new Set();
const pendingAlerts = [];

// Bound the alert backlog: if nothing ever drains it (GET /api/alerts), it would
// otherwise grow without limit. Keep only the most recent MAX_PENDING_ALERTS.
const MAX_PENDING_ALERTS = 1000;

/** Queue a flagged-ship arrival for the next GET /api/alerts, capped. */
function pushAlert(mmsi) {
  pendingAlerts.push(mmsi);
  if (pendingAlerts.length > MAX_PENDING_ALERTS) {
    pendingAlerts.splice(0, pendingAlerts.length - MAX_PENDING_ALERTS);
  }
}

/** Push a log entry to every connected SSE client. */
function broadcastLog(entry) {
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of logClients) res.write(payload);
}

module.exports = { logClients, pendingAlerts, pushAlert, broadcastLog };
