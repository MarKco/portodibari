'use strict';

const express = require('express');
const db = require('../db');
const stream = require('../services/ais-stream');
const { state, BBOX_PRESETS, addArea, removeArea } = require('../config');

const router = express.Router();

// List every monitoring area with its bbox, live stream status and the amount
// of stored history (so the UI can warn before a deletion wipes it).
router.get('/areas', (req, res) => {
  const status = stream.getStatus().streams;
  const areas = Object.entries(BBOX_PRESETS).map(([key, v]) => ({
    key,
    name: v.name,
    keyword: v.keyword,
    bbox: v.box[0],
    active: !!status[key]?.active,
    current: key === state.preset,
    counts: db.getAreaCounts(key),
  }));
  res.json({ areas, preset: state.preset, minAreas: 1 });
});

// Add a new area. Body: { name, sw:[lat,lon], ne:[lat,lon], keyword?, autostart? }
router.post('/areas', (req, res) => {
  try {
    const { name, sw, ne, keyword, autostart } = req.body || {};
    const area = addArea({ name, sw, ne, keyword });
    if (autostart !== false) stream.startStream(area.key);
    res.json({ ok: true, area });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete an area together with all its collected history. The 10s undo grace
// period lives client-side: this only runs once the deletion is committed.
router.delete('/areas/:key', (req, res) => {
  const { key } = req.params;
  if (!BBOX_PRESETS[key]) return res.status(404).json({ error: 'Area sconosciuta' });
  if (Object.keys(BBOX_PRESETS).length <= 1) {
    return res.status(400).json({ error: 'Deve restare almeno un\'area' });
  }
  try {
    stream.removeStream(key);
    db.deleteAll(key);
    const { switched } = removeArea(key);
    res.json({ ok: true, key, switched });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
