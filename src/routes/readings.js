'use strict';

const express = require('express');
const db = require('../db');
const { state } = require('../config');
const { pendingAlerts } = require('../realtime');

const router = express.Router();

router.get('/readings', (req, res) => {
  const { type, limit = 50, offset = 0 } = req.query;
  const rows = db.getReadings({ type, limit: Number(limit), offset: Number(offset) });
  const total = db.getTotalCount(type || undefined);
  const types = db.getDistinctTypes();
  res.json({ rows, total, types });
});

router.delete('/readings', (req, res) => {
  const area = req.query.area || state.preset;
  db.deleteAll(area);
  pendingAlerts.length = 0;
  res.json({ ok: true, area });
});

router.get('/readings/:id', (req, res) => {
  const row = db.getReading(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

module.exports = router;
