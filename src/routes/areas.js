'use strict';

const express = require('express');
const db = require('../db');
const stream = require('../services/ais-stream');
const { state, BBOX_PRESETS, addArea, removeArea, importAreas, exportAreas } = require('../config');

const router = express.Router();

// Import a set of area definitions (bounding-boxes.json shape), starting a live
// stream for every newly added area. Shared by the /areas/import route and the
// full-bundle import. Returns the merge summary from config.importAreas().
function importAreasAndStart(raw) {
  const result = importAreas(raw);
  for (const key of result.added) {
    try {
      stream.startStream(key);
    } catch (e) {
      console.error(`[AREAS] Autostart fallito per ${key}: ${e.message}`);
    }
  }
  return result;
}

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

// Download every area definition as a portable JSON file (re-importable).
router.get('/areas/export', (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="tracker-porti-aree-${ts}.json"`);
  res.send(JSON.stringify(exportAreas(), null, 2) + '\n');
});

// Import area definitions from an uploaded JSON file (merged by key; new areas
// get a live stream). Body: the bounding-boxes.json shape, or { areas: {...} }.
router.post('/areas/import', (req, res) => {
  try {
    const raw = req.body && req.body.areas ? req.body.areas : req.body;
    const result = importAreasAndStart(raw);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
module.exports.importAreasAndStart = importAreasAndStart;
