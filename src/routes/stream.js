'use strict';

const express = require('express');
const stream = require('../services/ais-stream');
const appLog = require('../services/app-log');
const { state, BBOX_PRESETS } = require('../config');

const router = express.Router();

router.post('/stream/start', (req, res) => {
  const area = req.body?.area || state.preset;
  if (!BBOX_PRESETS[area]) return res.status(400).json({ error: `Area sconosciuta: ${area}` });
  if (stream.isActive(area)) return res.json({ ok: true, message: 'Already running', area });
  appLog.info('AIS', appLog.t('ais.stream_start_manual'), { area });
  stream.startStream(area);
  res.json({ ok: true, area });
});

router.post('/stream/stop', (req, res) => {
  const area = req.body?.area || state.preset;
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
