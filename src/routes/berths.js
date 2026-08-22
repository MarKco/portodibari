'use strict';

const express = require('express');
const db = require('../db');
const berths = require('../services/berths');
const appLog = require('../services/app-log');
const { cargoTypeForShip } = require('../services/cargo-type');
const { state, BBOX_PRESETS, BERTH } = require('../config');

const router = express.Router();

// Berths/moorings are shared per-area data, but a user only sees/edits areas they
// monitor. Ownership = membership in the area catalog.
function owns(req, area) {
  return !!area && db.getUserAreaKeys(req.user.id).includes(area);
}

// Shape a stored berth row for the client: parse geometry/distribution, expose
// the *effective* label (manual override wins over the computed one) and the
// thresholds so the UI can explain why a berth is or isn't characterised.
// `cargoDist` is computed at read time (not stored) — see cargoDistByBerth.
function serialize(b, cargoDist = []) {
  let polygon = [];
  let dist = [];
  try {
    polygon = JSON.parse(b.polygon_json);
  } catch {
    /* keep [] */
  }
  try {
    dist = JSON.parse(b.dist_json || '[]');
  } catch {
    /* keep [] */
  }
  return {
    id: b.id,
    area: b.area,
    name: b.name,
    polygon,
    centroid: [b.centroid_lat, b.centroid_lon],
    manual: !!b.manual_geom,
    label: b.char_override || b.char_label || null,
    autoLabel: b.char_label || null,
    override: b.char_override || null,
    count: b.mooring_count,
    dist,
    cargoDist,
    hazmatPct: b.hazmat_pct,
    updatedAt: b.updated_at,
  };
}

// Cargo-class distribution per berth, derived live from the area's moorings
// (no stored column — keeps the DB schema and backups unchanged). Each mooring
// is classified by its ship; the class is memoised per MMSI so the repeated
// scrape-cache reads cost once per vessel, not once per visit. Counting is
// per-mooring, matching the existing category `dist`.
function cargoDistByBerth(area) {
  const byMmsi = new Map();
  const tallies = new Map(); // berth_id → { class: count }
  for (const m of db.getMoorings(area)) {
    if (m.berth_id == null) continue;
    let cls = byMmsi.get(m.mmsi);
    if (cls === undefined) {
      cls = cargoTypeForShip({ mmsi: m.mmsi, ship_type: m.ship_type }).class;
      byMmsi.set(m.mmsi, cls);
    }
    if (!tallies.has(m.berth_id)) tallies.set(m.berth_id, {});
    const t = tallies.get(m.berth_id);
    t[cls] = (t[cls] || 0) + 1;
  }
  const out = new Map();
  for (const [bid, tally] of tallies) {
    const total = Object.values(tally).reduce((a, n) => a + n, 0);
    out.set(
      bid,
      Object.entries(tally)
        .map(([cls, n]) => ({ class: cls, n, pct: Math.round((n / total) * 100) }))
        .sort((a, n) => n.n - a.n)
    );
  }
  return out;
}

function listPayload(area) {
  const cargo = cargoDistByBerth(area);
  return {
    berths: db.getBerths(area).map((b) => serialize(b, cargo.get(b.id) || [])),
    minMoorings: BERTH.MIN_MOORINGS,
    dominantPct: BERTH.DOMINANT_PCT,
  };
}

// Validate a polygon body: array of ≥3 [lat,lon] numeric pairs in range.
function parsePolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    throw new Error('Poligono non valido: servono almeno 3 vertici [lat, lon]');
  }
  const ring = polygon.map((p) => {
    if (!Array.isArray(p) || p.length !== 2) throw new Error('Vertice non valido: usa [lat, lon]');
    const lat = Number(p[0]);
    const lon = Number(p[1]);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      throw new Error('Coordinate vertice fuori range');
    }
    return [lat, lon];
  });
  const centroid = ring
    .reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0])
    .map((v) => v / ring.length);
  return { ring, centroid };
}

// List berths for an area (defaults to the current view preset).
router.get('/berths', (req, res) => {
  const myKeys = db.getUserAreaKeys(req.user.id);
  const area = req.query.area || (myKeys.includes(state.preset) ? state.preset : myKeys[0]);
  if (!area || !myKeys.includes(area)) {
    return res.json({ berths: [], minMoorings: BERTH.MIN_MOORINGS, dominantPct: BERTH.DOMINANT_PCT });
  }
  res.json(listPayload(area));
});

// Recompute moorings + clusters. With ?area=, just that area; otherwise all.
router.post('/berths/recompute', async (req, res) => {
  const area = req.query.area || (req.body && req.body.area);
  try {
    if (area) {
      if (!BBOX_PRESETS[area]) return res.status(404).json({ error: 'Area sconosciuta' });
      if (!owns(req, area)) return res.status(403).json({ error: 'Area non assegnata' });
      appLog.info('BERTHS', appLog.t('berths.recompute_manual'), { area });
      await berths.recomputeArea(area, { full: true });
      res.json({ ok: true, ...listPayload(area) });
    } else {
      // No area → recompute only the user's own areas (not the whole catalog).
      appLog.info('BERTHS', appLog.t('berths.recompute_manual_all'));
      for (const k of db.getUserAreaKeys(req.user.id)) await berths.recomputeArea(k, { full: true });
      res.json({ ok: true });
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create a manual berth by drawing a polygon. Membership/characterisation is
// filled by the recompute that follows.
router.post('/berths', async (req, res) => {
  const { area, name, polygon, override } = req.body || {};
  if (!area || !BBOX_PRESETS[area])
    return res.status(400).json({ error: 'Area mancante o sconosciuta' });
  if (!owns(req, area)) return res.status(403).json({ error: 'Area non assegnata' });
  try {
    const { ring, centroid } = parsePolygon(polygon);
    const id = db.insertBerth({
      area,
      name: name ? String(name).trim() : null,
      polygon_json: JSON.stringify(ring),
      centroid_lat: centroid[0],
      centroid_lon: centroid[1],
      manual_geom: 1,
      char_override: override || null,
    });
    appLog.info('BERTHS', appLog.t('berths.created', { name: name ? String(name).trim() : null }), { area, id });
    await berths.recomputeArea(area, { full: true });
    res.json({ ok: true, id, ...listPayload(area) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Edit a berth: rename, set/clear the manual category override, and/or redraw
// the polygon (which locks geometry as manual). Recomputes the owning area so
// membership and characterisation reflect the change.
router.patch('/berths/:id', async (req, res) => {
  const id = Number(req.params.id);
  const berth = db.getBerth(id);
  if (!berth) return res.status(404).json({ error: 'Banchina sconosciuta' });
  if (!owns(req, berth.area)) return res.status(403).json({ error: 'Area non assegnata' });
  const fields = {};
  const body = req.body || {};
  try {
    if ('name' in body) fields.name = body.name ? String(body.name).trim() : null;
    if ('override' in body)
      fields.char_override = body.override ? String(body.override).trim() : null;
    if ('polygon' in body && body.polygon != null) {
      const { ring, centroid } = parsePolygon(body.polygon);
      fields.polygon_json = JSON.stringify(ring);
      fields.centroid_lat = centroid[0];
      fields.centroid_lon = centroid[1];
    }
    db.updateBerthManual(id, fields);
    appLog.info('BERTHS', appLog.t('berths.modified', { name: berth.name || null }), { area: berth.area, id, campi: Object.keys(fields) });
    await berths.recomputeArea(berth.area, { full: true });
    res.json({ ok: true, ...listPayload(berth.area) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Merge several berths into a single manual berth covering all their moorings.
router.post('/berths/merge', async (req, res) => {
  const { ids, name } = req.body || {};
  if (!Array.isArray(ids) || ids.length < 2) {
    return res.status(400).json({ error: 'Servono almeno due banchine da unire' });
  }
  const targets = ids.map((id) => db.getBerth(Number(id))).filter(Boolean);
  if (targets.length < 2) return res.status(404).json({ error: 'Banchine non trovate' });
  const area = targets[0].area;
  if (targets.some((b) => b.area !== area)) {
    return res.status(400).json({ error: 'Le banchine appartengono ad aree diverse' });
  }
  if (!owns(req, area)) return res.status(403).json({ error: 'Area non assegnata' });
  try {
    // Union of all member moorings → convex hull = the merged geometry.
    const points = db.getMoorings(area).filter((m) => ids.map(Number).includes(m.berth_id));
    const hull = berths.convexHull(
      points.length ? points : targets.map((b) => ({ lat: b.centroid_lat, lon: b.centroid_lon }))
    );
    const centroid = hull
      .reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0])
      .map((v) => v / hull.length);
    const mergedId = db.insertBerth({
      area,
      name: name ? String(name).trim() : targets.find((b) => b.name)?.name || null,
      polygon_json: JSON.stringify(hull),
      centroid_lat: centroid[0],
      centroid_lon: centroid[1],
      manual_geom: 1,
      char_override: targets.find((b) => b.char_override)?.char_override || null,
    });
    for (const b of targets) db.deleteBerth(b.id);
    appLog.info('BERTHS', appLog.t('berths.merged', { count: targets.length }), { area, id: mergedId });
    await berths.recomputeArea(area, { full: true });
    res.json({ ok: true, id: mergedId, ...listPayload(area) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete a berth (its moorings are freed; a later recompute may re-cluster them).
router.delete('/berths/:id', (req, res) => {
  const id = Number(req.params.id);
  const berth = db.getBerth(id);
  if (!berth) return res.status(404).json({ error: 'Banchina sconosciuta' });
  if (!owns(req, berth.area)) return res.status(403).json({ error: 'Area non assegnata' });
  db.deleteBerth(id);
  appLog.info('BERTHS', appLog.t('berths.deleted', { name: berth.name || null }), { area: berth.area, id });
  res.json({ ok: true, ...listPayload(berth.area) });
});

module.exports = router;
