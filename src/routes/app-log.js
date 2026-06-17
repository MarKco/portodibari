'use strict';

const express = require('express');
const appLog = require('../services/app-log');
const { appLogClients } = require('../realtime');
const { state, setAppLogEnabled } = require('../config');
const { clampLimit } = require('../lib/params');

const router = express.Router();

// Server-Sent Events stream of live application-log entries.
router.get('/app-log/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  appLogClients.add(res);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    appLogClients.delete(res);
    clearInterval(hb);
  });
});

// Recent entries (oldest → newest) for backfilling a freshly-opened viewer.
router.get('/app-log', (req, res) => {
  res.json({ entries: appLog.tail(clampLimit(req.query.limit, 1000)), enabled: appLog.isEnabled() });
});

// Wipe the on-disk log.
router.delete('/app-log', (req, res) => {
  appLog.clear();
  appLog.info('LOG', 'Log applicazione cancellato');
  res.json({ ok: true });
});

// Toggle logging on/off (persisted). Default is on.
router.post('/app-log/enabled', (req, res) => {
  const enabled = !!req.body.enabled;
  setAppLogEnabled(enabled);
  appLog.setEnabled(enabled);
  appLog.info('LOG', `Logging applicazione ${enabled ? 'attivato' : 'disattivato'}`);
  res.json({ ok: true, enabled: state.appLogEnabled });
});

module.exports = router;
