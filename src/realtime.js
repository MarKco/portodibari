'use strict';

// Shared real-time buses used by both the AIS stream and the HTTP layer.
//
// - logClients: open SSE responses subscribed to the live API-log stream.
// - appLogClients: open SSE responses subscribed to the live application-log
//   stream (the human-readable operational log, separate from the API log).
// - pendingAlerts: {userId, mmsi} of flagged ships that just arrived, drained
//   per-user by GET /api/alerts and surfaced as a toast in the UI.

const logClients = new Set();
const appLogClients = new Set();
const fallbackScrapeClients = new Set();
const pendingAlerts = [];

// Bound the alert backlog: if nothing ever drains it (GET /api/alerts), it would
// otherwise grow without limit. Keep only the most recent MAX_PENDING_ALERTS.
const MAX_PENDING_ALERTS = 1000;

/** Queue a flagged-ship arrival for a specific user's next GET /api/alerts. */
function pushAlert(userId, mmsi) {
  pendingAlerts.push({ userId, mmsi });
  if (pendingAlerts.length > MAX_PENDING_ALERTS) {
    pendingAlerts.splice(0, pendingAlerts.length - MAX_PENDING_ALERTS);
  }
}

/** Remove and return the MMSIs queued for `userId` (drains only that user's). */
function drainAlertsForUser(userId) {
  const mine = [];
  for (let i = pendingAlerts.length - 1; i >= 0; i--) {
    if (pendingAlerts[i].userId === userId) {
      mine.push(pendingAlerts[i].mmsi);
      pendingAlerts.splice(i, 1);
    }
  }
  return mine.reverse();
}

/** Push an API-log entry to every connected SSE client. */
function broadcastLog(entry) {
  if (!entry) return; // insertLog returns null when a log write was dropped
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of logClients) res.write(payload);
}

/** Push an application-log entry to every connected SSE client. */
function broadcastAppLog(entry) {
  if (!appLogClients.size) return;
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of appLogClients) res.write(payload);
}

/** Push a fallback-mode scrape attempt ({ts,source,mmsi,ok}) to every
 *  connected SSE client (see services/fallback-mode.js). */
function broadcastFallbackScrape(entry) {
  if (!fallbackScrapeClients.size) return;
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of fallbackScrapeClients) res.write(payload);
}

module.exports = {
  logClients,
  appLogClients,
  fallbackScrapeClients,
  pendingAlerts,
  pushAlert,
  drainAlertsForUser,
  broadcastLog,
  broadcastAppLog,
  broadcastFallbackScrape,
};
