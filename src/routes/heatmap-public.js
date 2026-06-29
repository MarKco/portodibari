'use strict';

// Public (no-auth) heatmap page + data endpoint.
//   GET  /heatmap                  → standalone map page (HTML)
//   GET  /api/heatmap/public-cells → grid cells data (same as /api/heatmap/cells but unauthenticated)

const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const heatmap = require('../services/heatmap-stream');

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const publicHeatmapLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

router.get('/heatmap', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'heatmap.html'));
});

router.get('/api/heatmap/public-cells', publicHeatmapLimit, (req, res) => {
  const q = req.query;
  const level = q.level !== undefined ? Number(q.level) : 1.0;
  let bbox;
  const keys = ['minLat', 'minLon', 'maxLat', 'maxLon'];
  if (keys.every((k) => q[k] !== undefined)) {
    const b = { minLat: +q.minLat, minLon: +q.minLon, maxLat: +q.maxLat, maxLon: +q.maxLon };
    if (Object.values(b).every(Number.isFinite)) bbox = b;
  }
  const out = heatmap.getCellsAgg({ level, bbox });
  res.json({ gridDeg: out.gridDeg, cells: out.cells });
});

module.exports = router;
