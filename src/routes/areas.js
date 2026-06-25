'use strict';

const express = require('express');
const db = require('../db');
const stream = require('../services/ais-stream');
const appLog = require('../services/app-log');
const telegram = require('../services/telegram');
const groupSync = require('../services/group-sync');
const { state, BBOX_PRESETS, addArea, removeArea, importAreas, exportAreas } = require('../config');

const router = express.Router();

// Import a set of area definitions (bounding-boxes.json shape) into the global
// catalog, give the importing user membership of each, and start a live stream
// for every newly added area. Returns the merge summary from config.importAreas().
function importAreasAndStart(raw, userId = null) {
  const result = importAreas(raw);
  appLog.info('AREE', appLog.t('areas.imported'), { aggiunte: result.added.length, aggiornate: (result.updated || []).length });
  for (const key of [...result.added, ...(result.updated || [])]) {
    if (userId) {
      db.addUserArea(userId, key);
      groupSync.syncAreaAdd(userId, key); // mirror membership to group co-members
    }
  }
  for (const key of result.added) {
    try {
      stream.startStream(key);
    } catch (e) {
      appLog.warn('AREE', appLog.t('areas.autostart_failed', { key, error: e.message }), { area: key });
    }
  }
  return result;
}

// List the monitoring areas the CURRENT USER owns, with bbox, live stream status
// and stored-history counts (so the UI can warn before a deletion wipes it).
router.get('/areas', (req, res) => {
  const status = stream.getStatus().streams;
  const myKeys = db.getUserAreaKeys(req.user.id);
  const areas = myKeys
    .filter((key) => BBOX_PRESETS[key])
    .map((key) => {
      const v = BBOX_PRESETS[key];
      return {
        key,
        name: v.name,
        keyword: v.keyword,
        bbox: v.box[0],
        active: !!status[key]?.active,
        current: key === state.preset,
        counts: db.getAreaCounts(key),
      };
    });
  // The user's effective "current" area: the global preset if they own it, else
  // their first area.
  const current = myKeys.includes(state.preset) ? state.preset : myKeys[0] || null;
  res.json({ areas, preset: current, minAreas: 0 });
});

// Download the user's area definitions as a portable JSON file (re-importable).
router.get('/areas/export', (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const myKeys = new Set(db.getUserAreaKeys(req.user.id));
  const all = exportAreas();
  const mine = Object.fromEntries(Object.entries(all).filter(([k]) => myKeys.has(k)));
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="tracker-porti-aree-${ts}.json"`);
  res.send(JSON.stringify(mine, null, 2) + '\n');
});

// Import area definitions from an uploaded JSON file into the user's set.
router.post('/areas/import', (req, res) => {
  try {
    const raw = req.body && req.body.areas ? req.body.areas : req.body;
    const result = importAreasAndStart(raw, req.user.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Add a new area to the catalog and give the current user membership.
// Body: { name, sw:[lat,lon], ne:[lat,lon], keyword?, autostart? }
router.post('/areas', (req, res) => {
  try {
    const { name, sw, ne, keyword, autostart } = req.body || {};
    const area = addArea({ name, sw, ne, keyword });
    db.addUserArea(req.user.id, area.key);
    groupSync.syncAreaAdd(req.user.id, area.key); // mirror membership to group co-members
    appLog.info('AREE', appLog.t('areas.added', { name: area.name }), { area: area.key, autostart: autostart !== false });
    if (autostart !== false) stream.startStream(area.key);
    telegram.notifyAreaMonitor(req.user.id, 'start', { area: area.name });
    res.json({ ok: true, area });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Remove an area from the CURRENT USER's set. The area + its collected history +
// live stream are wiped only when no other user still monitors it (last owner).
// The 10s undo grace period lives client-side: this runs once committed.
router.delete('/areas/:key', (req, res) => {
  const { key } = req.params;
  if (!BBOX_PRESETS[key]) return res.status(404).json({ error: 'Area sconosciuta' });
  const myKeys = db.getUserAreaKeys(req.user.id);
  if (!myKeys.includes(key)) return res.status(404).json({ error: 'Area non assegnata' });
  try {
    const areaName = BBOX_PRESETS[key].name;
    db.removeUserArea(req.user.id, key);
    groupSync.syncAreaRemove(req.user.id, key); // drop membership for group co-members too
    telegram.notifyAreaMonitor(req.user.id, 'stop', { area: areaName });
    let purged = false;
    if (db.areaOwnerCount(key) === 0) {
      // Last owner gone → tear down the stream, wipe the data and drop the catalog.
      stream.removeStream(key);
      db.deleteAll(key);
      removeArea(key);
      purged = true;
    }
    appLog.warn('AREE', appLog.t('areas.deleted', { name: areaName }), { area: key, purged });
    res.json({ ok: true, key, purged });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
module.exports.importAreasAndStart = importAreasAndStart;
