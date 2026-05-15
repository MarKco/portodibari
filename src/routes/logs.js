'use strict';

const express = require('express');
const db = require('../db');
const { logClients } = require('../realtime');

const router = express.Router();

// Server-Sent Events stream of live API-log entries.
router.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  logClients.add(res);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    logClients.delete(res);
    clearInterval(hb);
  });
});

router.get('/logs/:id', (req, res) => {
  const row = db.getLog(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.get('/logs', (req, res) => {
  const { limit = 200, offset = 0 } = req.query;
  res.json({ logs: db.getLogs(Number(limit), Number(offset)) });
});

router.delete('/logs', (req, res) => {
  db.clearLogs();
  res.json({ ok: true });
});

module.exports = router;
