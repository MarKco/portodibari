'use strict';

const express = require('express');
const db = require('../db');
const { logClients } = require('../realtime');
const { clampLimit, clampOffset, parseId } = require('../lib/params');

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
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'ID non valido' });
  const row = db.getLog(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.get('/logs', (req, res) => {
  res.json({ logs: db.getLogs(clampLimit(req.query.limit, 200), clampOffset(req.query.offset)) });
});

router.delete('/logs', (req, res) => {
  db.clearLogs();
  res.json({ ok: true });
});

module.exports = router;
