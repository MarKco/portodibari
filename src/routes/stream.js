'use strict';

const express = require('express');
const stream = require('../services/ais-stream');
const { state, BBOX_PRESETS } = require('../config');

const router = express.Router();

router.post('/stream/start', (req, res) => {
  const area = req.body?.area || state.preset;
  if (!BBOX_PRESETS[area]) return res.status(400).json({ error: `Area sconosciuta: ${area}` });
  if (stream.isActive(area)) return res.json({ ok: true, message: 'Already running', area });
  stream.startStream(area);
  res.json({ ok: true, area });
});

router.post('/stream/stop', (req, res) => {
  const area = req.body?.area || state.preset;
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
