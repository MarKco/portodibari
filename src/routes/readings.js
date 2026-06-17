'use strict';

const express = require('express');
const db = require('../db');
const appLog = require('../services/app-log');
const { state } = require('../config');
const { pendingAlerts } = require('../realtime');
const { clampLimit, clampOffset, parseId } = require('../lib/params');

const router = express.Router();

router.get('/readings', (req, res) => {
  const { type } = req.query;
  const rows = db.getReadings({ type, limit: clampLimit(req.query.limit), offset: clampOffset(req.query.offset) });
  const total = db.getTotalCount(type || undefined);
  const types = db.getDistinctTypes();
  res.json({ rows, total, types });
});

router.delete('/readings', (req, res) => {
  const area = req.query.area || state.preset;
  db.deleteAll(area);
  pendingAlerts.length = 0;
  appLog.warn('DATA', appLog.t('data.area_cleared'), { area });
  res.json({ ok: true, area });
});

router.get('/readings/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'ID non valido' });
  const row = db.getReading(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

module.exports = router;
