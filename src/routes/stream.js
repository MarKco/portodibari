'use strict';

const express = require('express');
const db = require('../db');
const stream = require('../services/ais-stream');
const appLog = require('../services/app-log');
const { state, BBOX_PRESETS } = require('../config');

const router = express.Router();

// Manual stream control is restricted to areas the user monitors. (The stream
// itself is shared across users that own the same area.)
function ownsArea(req, area) {
  return !!area && db.getUserAreaKeys(req.user.id).includes(area);
}

router.post('/stream/start', (req, res) => {
  const area = req.body?.area || state.preset;
  if (!BBOX_PRESETS[area]) return res.status(400).json({ error: `Area sconosciuta: ${area}` });
  if (!ownsArea(req, area)) return res.status(403).json({ error: 'Area non assegnata' });
  if (stream.isActive(area)) return res.json({ ok: true, message: 'Already running', area });
  appLog.info('AIS', appLog.t('ais.stream_start_manual'), { area });
  stream.startStream(area);
  res.json({ ok: true, area });
});

router.post('/stream/stop', (req, res) => {
  const area = req.body?.area || state.preset;
  if (!ownsArea(req, area)) return res.status(403).json({ error: 'Area non assegnata' });
  appLog.info('AIS', appLog.t('ais.stream_stop_manual'), { area });
  stream.stopStream(area);
  res.json({ ok: true, area });
});

router.get('/stream/status', (req, res) => {
  res.json(stream.getStatus());
});

router.get('/stream/health', (req, res) => {
  const area = req.query.area || state.preset;
  res.json(stream.getHealth(area));
});

module.exports = router;
