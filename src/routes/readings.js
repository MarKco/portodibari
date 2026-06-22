'use strict';

const express = require('express');
const db = require('../db');
const appLog = require('../services/app-log');
const { pendingAlerts } = require('../realtime');
const { clampLimit, clampOffset, parseId } = require('../lib/params');

const router = express.Router();

router.get('/readings', (req, res) => {
  const { type } = req.query;
  const boxes = db.getUserBoxes(req.user.id);
  const rows = db.getReadings({ type, limit: clampLimit(req.query.limit), offset: clampOffset(req.query.offset), boxes });
  const total = db.getTotalCount(type || undefined, boxes);
  const types = db.getDistinctTypes();
  res.json({ rows, total, types });
});

router.delete('/readings', (req, res) => {
  const area = req.query.area;
  if (!area || !db.getUserAreaKeys(req.user.id).includes(area)) {
    return res.status(403).json({ error: 'Area non assegnata' });
  }
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
  // Visibility: a positioned reading must fall in one of the user's areas.
  if (row.latitude != null && row.longitude != null) {
    const boxes = db.getUserBoxes(req.user.id);
    const visible = boxes.some(
      (b) => row.latitude >= b.sw_lat && row.latitude <= b.ne_lat && row.longitude >= b.sw_lon && row.longitude <= b.ne_lon
    );
    if (!visible) return res.status(404).json({ error: 'Not found' });
  }
  res.json(row);
});

module.exports = router;
