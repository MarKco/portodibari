'use strict';

// Shared real-time buses used by both the AIS stream and the HTTP layer.
//
// - logClients: open SSE responses subscribed to the live API-log stream.
// - pendingAlerts: MMSIs of flagged ships that just arrived, drained by
//   GET /api/alerts and surfaced as a toast in the UI.

const logClients = new Set();
const pendingAlerts = [];

/** Push a log entry to every connected SSE client. */
function broadcastLog(entry) {
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of logClients) res.write(payload);
}

module.exports = { logClients, pendingAlerts, broadcastLog };
