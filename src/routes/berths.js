'use strict';

const express = require('express');
const db = require('../db');
const berths = require('../services/berths');
const appLog = require('../services/app-log');
const { state, BBOX_PRESETS, BERTH } = require('../config');

const router = express.Router();

// Shape a stored berth row for the client: parse geometry/distribution, expose
// the *effective* label (manual override wins over the computed one) and the
// thresholds so the UI can explain why a berth is or isn't characterised.
function serialize(b) {
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
    hazmatPct: b.hazmat_pct,
    updatedAt: b.updated_at,
  };
}

function listPayload(area) {
  return {
    berths: db.getBerths(area).map(serialize),
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
  const area = req.query.area || state.preset;
  res.json(listPayload(area));
});

// Recompute moorings + clusters. With ?area=, just that area; otherwise all.
router.post('/berths/recompute', (req, res) => {
  const area = req.query.area || (req.body && req.body.area);
  try {
    if (area) {
      if (!BBOX_PRESETS[area]) return res.status(404).json({ error: 'Area sconosciuta' });
      appLog.info('BERTHS', appLog.t('berths.recompute_manual'), { area });
      berths.recomputeArea(area);
      res.json({ ok: true, ...listPayload(area) });
    } else {
      appLog.info('BERTHS', appLog.t('berths.recompute_manual_all'));
      const result = berths.recomputeAll();
      res.json({ ok: true, result });
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create a manual berth by drawing a polygon. Membership/characterisation is
// filled by the recompute that follows.
router.post('/berths', (req, res) => {
  const { area, name, polygon, override } = req.body || {};
  if (!area || !BBOX_PRESETS[area])
    return res.status(400).json({ error: 'Area mancante o sconosciuta' });
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
    berths.recomputeArea(area);
    res.json({ ok: true, id, ...listPayload(area) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Edit a berth: rename, set/clear the manual category override, and/or redraw
// the polygon (which locks geometry as manual). Recomputes the owning area so
// membership and characterisation reflect the change.
router.patch('/berths/:id', (req, res) => {
  const id = Number(req.params.id);
  const berth = db.getBerth(id);
  if (!berth) return res.status(404).json({ error: 'Banchina sconosciuta' });
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
    berths.recomputeArea(berth.area);
    res.json({ ok: true, ...listPayload(berth.area) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Merge several berths into a single manual berth covering all their moorings.
router.post('/berths/merge', (req, res) => {
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
    berths.recomputeArea(area);
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
  db.deleteBerth(id);
  appLog.info('BERTHS', appLog.t('berths.deleted', { name: berth.name || null }), { area: berth.area, id });
  res.json({ ok: true, ...listPayload(berth.area) });
});

module.exports = router;
