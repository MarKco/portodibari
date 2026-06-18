'use strict';

const express = require('express');
const db = require('../db');
const { computeRiskScoreCached } = require('../services/risk-score');
const { pendingAlerts } = require('../realtime');
const { clampLimit, clampOffset } = require('../lib/params');

const router = express.Router();

const { state } = require('../config');

router.get('/events', (req, res) => {
  const { area } = req.query;
  res.json(db.getPortEvents(clampLimit(req.query.limit, 100), clampOffset(req.query.offset), area || state.preset));
});

router.get('/stats', (req, res) => {
  const area = req.query.area || state.preset;
  res.json(db.getStats(area));
});

router.get('/stats/scores', (req, res) => {
  const lang = req.query.lang || 'it';
  const area = req.query.area || state.preset;
  const ships = db.getRecentShips(area);
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
  const dailyArrivals = db.getDailyArrivals(area);
  res.json({ byBand, topShips, byFactor, byCargo, byLoad, dailyArrivals, total: ships.length });
});

router.get('/alerts', (req, res) => {
  if (!pendingAlerts.length) return res.json({ alerts: [] });
  const mmsis = pendingAlerts.splice(0);
  const alerts = mmsis.map((mmsi) => {
    const ship = db.getShip(mmsi);
    return { mmsi, ship_name: ship?.ship_name || null, ship_type: ship?.ship_type ?? null };
  });
  res.json({ alerts });
});

module.exports = router;
