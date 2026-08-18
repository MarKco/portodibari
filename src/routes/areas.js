'use strict';

const express = require('express');
const db = require('../db');
const stream = require('../services/ais-stream');
const appLog = require('../services/app-log');
const telegram = require('../services/telegram');
const groupSync = require('../services/group-sync');
const portDiscovery = require('../services/port-discovery');
const { requireAdmin } = require('../middleware/session-auth');
const { state, BBOX_PRESETS, addArea, updateArea, removeArea, importAreas, exportAreas, TESTER_MAX_AREAS, TESTER_MAX_AREA_KM2, bboxAreaKm2 } = require('../config');

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
        // How many OTHER users monitor this same catalog area — the client warns
        // (twice) before an edit that would move it for them too.
        sharedWith: Math.max(0, db.areaOwnerCount(key) - 1),
      };
    });
  // The user's effective "current" area: the global preset if they own it, else
  // their first area.
  const current = myKeys.includes(state.preset) ? state.preset : myKeys[0] || null;
  const testerLimits = req.user.role === 'tester'
    ? { maxAreas: TESTER_MAX_AREAS, maxAreaKm2: TESTER_MAX_AREA_KM2 }
    : null;
  res.json({ areas, preset: current, minAreas: 0, testerLimits });
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
    if (req.user.role === 'tester') {
      const ok = (c) => Array.isArray(c) && c.length === 2 && c.every((n) => Number.isFinite(Number(n)));
      const incoming = Object.entries(raw || {}).filter(([k, v]) => !k.startsWith('_') && v && ok(v.sw) && ok(v.ne));
      const newKeys = incoming.filter(([k]) => !BBOX_PRESETS[k]);
      const currentCount = db.getUserAreaKeys(req.user.id).length;
      if (currentCount + newKeys.length > TESTER_MAX_AREAS) {
        return res.status(403).json({ error: `Account tester: l'importazione supererebbe il limite di ${TESTER_MAX_AREAS} aree` });
      }
      for (const [, v] of incoming) {
        const swLat = Math.min(Number(v.sw[0]), Number(v.ne[0]));
        const neLat = Math.max(Number(v.sw[0]), Number(v.ne[0]));
        const swLon = Math.min(Number(v.sw[1]), Number(v.ne[1]));
        const neLon = Math.max(Number(v.sw[1]), Number(v.ne[1]));
        if (bboxAreaKm2(swLat, neLat, swLon, neLon) > TESTER_MAX_AREA_KM2) {
          return res.status(403).json({ error: `Account tester: una o più aree superano il limite di ${TESTER_MAX_AREA_KM2} km²` });
        }
      }
    }
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
    if (req.user.role === 'tester') {
      const currentCount = db.getUserAreaKeys(req.user.id).length;
      if (currentCount >= TESTER_MAX_AREAS) {
        return res.status(403).json({ error: `Account tester: massimo ${TESTER_MAX_AREAS} aree consentite` });
      }
      const ok = (c) => Array.isArray(c) && c.length === 2 && c.every((n) => Number.isFinite(Number(n)));
      if (ok(sw) && ok(ne)) {
        const swLat = Math.min(Number(sw[0]), Number(ne[0]));
        const neLat = Math.max(Number(sw[0]), Number(ne[0]));
        const swLon = Math.min(Number(sw[1]), Number(ne[1]));
        const neLon = Math.max(Number(sw[1]), Number(ne[1]));
        const areaKm2 = bboxAreaKm2(swLat, neLat, swLon, neLon);
        if (areaKm2 > TESTER_MAX_AREA_KM2) {
          return res.status(403).json({ error: `Account tester: area troppo grande (${Math.round(areaKm2)} km², max ${TESTER_MAX_AREA_KM2} km²)` });
        }
      }
    }
    const area = addArea({ name, sw, ne, keyword });
    db.addUserArea(req.user.id, area.key);
    groupSync.syncAreaAdd(req.user.id, area.key); // mirror membership to group co-members
    appLog.info('AREE', appLog.t('areas.added', { name: area.name }), { area: area.key, autostart: autostart !== false });
    if (autostart !== false) stream.startStream(area.key);
    portDiscovery.discoverPortsForArea(area.key)
      .then(() => portDiscovery.resolveMstPidForConfirmedPorts(area.key))
      .catch((e) => appLog.warn('AREE', `Scoperta porti fallita per ${area.key}: ${e.message}`));
    telegram.notifyAreaMonitor(req.user.id, 'start', { area: area.name });
    res.json({ ok: true, area });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Edit an area the current user owns: name, keyword and/or corners.
// Body: { name?, keyword?, sw?:[lat,lon], ne?:[lat,lon] }
// The catalog is GLOBAL: editing a SHARED area moves it for every user who
// monitors it, so they all get a "group activity" notification (the double
// confirmation before that happens lives client-side). The key is preserved, so
// the history collected so far stays attached — readings taken outside the new
// box are kept, not pruned.
router.patch('/areas/:key', (req, res) => {
  const { key } = req.params;
  if (!BBOX_PRESETS[key]) return res.status(404).json({ error: 'Area sconosciuta' });
  if (!db.getUserAreaKeys(req.user.id).includes(key)) return res.status(404).json({ error: 'Area non assegnata' });
  const { name, keyword, sw, ne } = req.body || {};
  try {
    if (req.user.role === 'tester' && sw !== undefined && ne !== undefined) {
      const ok = (c) => Array.isArray(c) && c.length === 2 && c.every((n) => Number.isFinite(Number(n)));
      if (ok(sw) && ok(ne)) {
        const swLat = Math.min(Number(sw[0]), Number(ne[0]));
        const neLat = Math.max(Number(sw[0]), Number(ne[0]));
        const swLon = Math.min(Number(sw[1]), Number(ne[1]));
        const neLon = Math.max(Number(sw[1]), Number(ne[1]));
        const areaKm2 = bboxAreaKm2(swLat, neLat, swLon, neLon);
        if (areaKm2 > TESTER_MAX_AREA_KM2) {
          return res.status(403).json({ error: `Account tester: area troppo grande (${Math.round(areaKm2)} km², max ${TESTER_MAX_AREA_KM2} km²)` });
        }
      }
    }
    const area = updateArea(key, { name, keyword, sw, ne });
    // A moved box must reach AISStream: startStream on an already-active area
    // just re-sends the (now different) shared subscription.
    if (area.boxChanged && stream.isActive(key)) stream.startStream(key);
    groupSync.notifyAreaEdit(req.user.id, key); // tell every other owner of this area
    appLog.info('AREE', `Area modificata: ${area.name}`, { area: key, boxChanged: area.boxChanged });
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

// List discovered port candidates for an area (any status: confirmed/review/rejected).
router.get('/areas/:key/ports', requireAdmin, (req, res) => {
  res.json({ ports: db.getAreaPorts(req.params.key) });
});

// Re-run port discovery for an area on demand. Fire-and-forget: the cascade can
// take minutes (up to 20 candidates, each VesselFinder lookup itself ~10 requests
// with its own jitter) on a fresh area with no berths yet — the exact case an
// admin is most likely to trigger this for. Respond immediately; the client
// re-fetches via GET /areas/:key/ports once discovery finishes in the background.
router.post('/areas/:key/discover-ports', requireAdmin, (req, res) => {
  const { key } = req.params;
  portDiscovery.discoverPortsForArea(key)
    .then(() => portDiscovery.resolveMstPidForConfirmedPorts(key))
    .catch((e) => appLog.warn('AREE', `Scoperta porti fallita per ${key}: ${e.message}`));
  res.json({ ok: true });
});

// Admin review decisions on a discovered port candidate.
router.post('/areas/:key/ports/:id/confirm', requireAdmin, (req, res) => {
  db.setAreaPortDecision(Number(req.params.id), 'confirmed');
  res.json({ ok: true });
});

router.post('/areas/:key/ports/:id/reject', requireAdmin, (req, res) => {
  db.setAreaPortDecision(Number(req.params.id), 'rejected');
  res.json({ ok: true });
});

module.exports = router;
module.exports.importAreasAndStart = importAreasAndStart;
