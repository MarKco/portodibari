'use strict';

const express = require('express');
const db = require('../db');
const stream = require('../services/ais-stream');
const appLog = require('../services/app-log');
const telegram = require('../services/telegram');
const groupSync = require('../services/group-sync');
const portDiscovery = require('../services/port-discovery');
const fallbackMode = require('../services/fallback-mode');
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
// Port readiness for fallback discovery, tri-state (see routes/areas.js GET /areas):
//   'ready'      — at least one confirmed port resolved on MyShipTracking
//   'unresolved' — confirmed port(s) exist, but resolveMstPidForConfirmedPorts
//                  hasn't matched one yet (worth retrying discovery)
//   'none'       — no confirmed port at all for this area (nothing to resolve —
//                  retrying discovery won't help unless real port data changes)
function portDiscoveryStatus(key) {
  const confirmed = db.getConfirmedAreaPorts(key);
  if (!confirmed.length) return 'none';
  return confirmed.some((p) => p.mst_pid) ? 'ready' : 'unresolved';
}

router.get('/areas', (req, res) => {
  const status = stream.getStatus().streams;
  const myKeys = db.getUserAreaKeys(req.user.id);
  const isAdmin = req.user.role === 'admin';
  // One query for every area's live silent-fallback state, reused per row below
  // instead of recomputing it per-key.
  const areaStatuses = isAdmin ? new Map(fallbackMode.getAreaStatuses().map((a) => [a.key, a])) : null;
  const areas = myKeys
    .filter((key) => BBOX_PRESETS[key])
    .map((key) => {
      const v = BBOX_PRESETS[key];
      const entry = {
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
      // Silent fallback (services/fallback-mode.js) config/status: admin-only,
      // same restriction as the "pagina monitoraggi" indicator and the
      // Diagnostica AIS panel — a regular user doesn't manage or need to see it.
      if (isAdmin) {
        const live = areaStatuses.get(key);
        entry.fallbackEnabled = !!live?.fallbackEnabled;
        entry.fallbackForced = !!live?.fallbackForced;
        entry.fallbackSilent = !!live?.silent;
        entry.fallbackSilentSince = live?.silentSince || null;
        entry.portStatus = portDiscoveryStatus(key);
      }
      return entry;
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
      .then(() => {
        // Tell the creating admin right away rather than leaving them to
        // notice the ⚠ badge later on the Aree screen: with zero confirmed
        // ports, fallback mode's ship-discovery-via-port-arrivals has nothing
        // to work with for this area (repositioning already-known ships is
        // unaffected — this only concerns discovering ones AIS never saw).
        if (portDiscoveryStatus(area.key) === 'none') {
          db.addNotification({ user_id: req.user.id, type: 'area_no_port', area: area.key });
        }
      })
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

// Enable/disable this area's silent fallback (services/fallback-mode.js), and/or
// force it (treat as silent even while AIS keeps arriving, for a bbox an admin
// knows has thin real coverage) — both admin-only decisions (unlike the general
// area edit above, which any co-owner can do), per the feature's design: which
// areas get scraping-based coverage is an operational/cost choice, not a
// per-user preference. Defaults are enabled/not-forced (see the ALTER TABLE
// defaults in db.js) — this only needs calling to change either from default.
router.patch('/areas/:key/fallback', requireAdmin, (req, res) => {
  const { key } = req.params;
  if (!BBOX_PRESETS[key]) return res.status(404).json({ error: 'Area sconosciuta' });
  const { enabled, forced } = req.body || {};
  const out = { ok: true, key };
  if (enabled !== undefined) {
    db.setAreaFallbackEnabled(key, !!enabled);
    appLog.info('AREE', `Modalità fallback per ${BBOX_PRESETS[key].name}: ${enabled ? 'attivata' : 'disattivata'}`, { area: key });
    out.fallbackEnabled = !!enabled;
  }
  if (forced !== undefined) {
    db.setAreaFallbackForced(key, !!forced);
    appLog.info('AREE', `Modalità fallback forzata per ${BBOX_PRESETS[key].name}: ${forced ? 'attivata' : 'disattivata'}`, { area: key });
    out.fallbackForced = !!forced;
  }
  res.json(out);
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

// Compare pane for the ports panel: always runs the external cascade
// (locode/WPI/GFW/VesselFinder), regardless of whether the area already has
// berths — unlike discoverPortsForArea's own berths-short-circuit — so an
// admin can see external candidates side by side with auto-detected berths
// and decide what to add. Streams each raw (unclustered) candidate as SSE the
// moment it's found: locode/WPI/GFW arrive almost instantly, VesselFinder
// trickles in over its own paced loop (same anti-ban jitter as
// discoverPortsForArea's cascade) — streaming avoids making the admin stare
// at a blank panel for the ~1-2min a fresh area's full VF pass can take.
router.get('/areas/:key/ports/search-external/stream', requireAdmin, (req, res) => {
  const { key } = req.params;
  if (!BBOX_PRESETS[key]) return res.status(404).json({ error: 'Area sconosciuta' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // No isAnyAreaSilent() gate here, unlike discoverPortsForArea: THAT gate
  // exists because its own flow also calls resolveMstPidForConfirmedPorts
  // right after, which fires MST — the source fallback-mode.js's shared
  // budget/circuit breaker (SOURCES = ['sf','mst']) actually protects.
  // searchExternalCandidates never touches SF or MST (locode/WPI are local
  // lookups, GFW is its own separately-tokened API, VesselFinder has its own
  // independent pacing/negative-cache and is never gated on area silence
  // anywhere else in the app — see enrichment.js's VF enrichment). Gating it
  // here too would just block this feature globally the moment ANY one area
  // is silent or force-fallback'd, for a resource it doesn't actually share.
  let closed = false;
  req.on('close', () => { closed = true; });

  portDiscovery
    .searchExternalCandidates(
      key,
      (c) => {
        if (!closed) res.write(`data: ${JSON.stringify({ type: 'candidate', candidate: c })}\n\n`);
      },
      () => closed
    )
    .then(() => {
      if (!closed) {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      }
    })
    .catch((e) => {
      if (closed) return;
      res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
      res.end();
    });
});

// Add one or more external-source candidates (from the stream above) as real
// area ports, straight to 'confirmed' — the admin picking a specific
// candidate off the map/list IS the review, unlike discoverPortsForArea's own
// auto-persisted candidates which still need a confirm/reject. Capped batch
// size is a generous ceiling against a malformed/abusive request, not a real
// UX limit — no realistic candidate list from the cascade above gets close.
const MAX_CANDIDATES_PER_ADD = 200;
router.post('/areas/:key/ports/candidates', requireAdmin, (req, res) => {
  const { key } = req.params;
  if (!BBOX_PRESETS[key]) return res.status(404).json({ error: 'Area sconosciuta' });
  const list = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
  if (!list.length) return res.status(400).json({ error: 'Nessun candidato' });
  if (list.length > MAX_CANDIDATES_PER_ADD) return res.status(400).json({ error: 'Troppi candidati in una volta sola' });
  let added = 0;
  for (const c of list) {
    const lat = Number(c?.lat);
    const lon = Number(c?.lon);
    const name = c?.name && String(c.name).trim();
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    db.addManualAreaPort({ area_key: key, name, lat, lon, source: c.source ? String(c.source) : 'manual' });
    added++;
  }
  appLog.info('AREE', `${added} porto/i aggiunto/i manualmente per ${BBOX_PRESETS[key].name} da sorgenti esterne`, { area: key });
  res.json({ ok: true, added, ports: db.getAreaPorts(key) });
});

module.exports = router;
module.exports.importAreasAndStart = importAreasAndStart;
