'use strict';

const express = require('express');
const db = require('../db');
const { computeRiskScoreCached } = require('../services/risk-score');
const { drainAlertsForUser } = require('../realtime');
const { clampLimit, clampOffset } = require('../lib/params');

const router = express.Router();

// Area scope for the port_events-based queries (tagged by area key, no coords).
// A specific owned ?area wins; otherwise the user's full set of visible keys.
function eventScope(req) {
  const area = req.query.area;
  const keys = db.getVisibleAreaKeys(req.user.id);
  if (area && keys.includes(area)) return { area, areaKeys: null };
  return { area: null, areaKeys: keys };
}

// Geographic scope (boxes) for ship queries.
function boxScope(req) {
  const all = db.getUserBoxes(req.user.id);
  const area = req.query.area;
  if (area) return all.filter((b) => b.key === area);
  return all;
}

router.get('/events', (req, res) => {
  const sc = eventScope(req);
  res.json(db.getPortEvents(clampLimit(req.query.limit, 100), clampOffset(req.query.offset), sc.area, sc.areaKeys));
});

router.get('/stats', (req, res) => {
  const sc = eventScope(req);
  res.json(db.getStats(sc.area, sc.areaKeys));
});

router.get('/stats/scores', (req, res) => {
  const lang = req.query.lang || 'it';
  const sc = eventScope(req);
  const ships = db.getRecentShips(null, boxScope(req));
  const byBand = { low: 0, med: 0, high: 0 };
  const factorCounts = {};
  const cargoCounts = {};
  const loadCounts = {};
  const scored = ships.map((s) => {
    const risk = computeRiskScoreCached(s, lang);
    byBand[risk.band] = (byBand[risk.band] || 0) + 1;
    (risk.factors || []).forEach((f) => {
      factorCounts[f.label] = (factorCounts[f.label] || 0) + 1;
    });
    const cls = risk.cargo?.class;
    if (cls && cls !== 'unknown' && cls !== 'non_cargo') {
      cargoCounts[cls] = (cargoCounts[cls] || 0) + 1;
    }
    const ld = risk.cargo?.loadState;
    if (ld && ld !== 'unknown') loadCounts[ld] = (loadCounts[ld] || 0) + 1;
    return { mmsi: s.mmsi, ship_name: s.ship_name, score: risk.score, band: risk.band };
  });
  const topShips = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const byFactor = Object.entries(factorCounts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const byCargo = Object.entries(cargoCounts)
    .map(([cls, count]) => ({ cls, count }))
    .sort((a, b) => b.count - a.count);
  const byLoad = ['laden', 'partial', 'ballast'].map((state) => ({ state, count: loadCounts[state] || 0 }));
  const dailyArrivals = db.getDailyArrivals(sc.area, sc.areaKeys);
  res.json({ byBand, topShips, byFactor, byCargo, byLoad, dailyArrivals, total: ships.length });
});

router.get('/alerts', (req, res) => {
  const mmsis = drainAlertsForUser(req.user.id);
  if (!mmsis.length) return res.json({ alerts: [] });
  const alerts = mmsis.map((mmsi) => {
    const ship = db.getShip(mmsi);
    return { mmsi, ship_name: ship?.ship_name || null, ship_type: ship?.ship_type ?? null };
  });
  res.json({ alerts });
});

module.exports = router;
