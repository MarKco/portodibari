'use strict';

// Coverage heatmap ("mappa delle zone coperte") API. The map view itself lives in
// the SPA sidebar (public/index.html + public/js/coverage.js); this only exposes
// data + control endpoints.
//
//   GET  /api/heatmap/cells    → all populated grid cells (ALL authenticated users)
//   GET  /api/heatmap/stats    → live SSE: bandwidth / throughput / DB totals (admin)
//   POST /api/heatmap/start    → start background collection (admin)
//   POST /api/heatmap/stop     → stop collection (admin)
//   POST /api/heatmap/reset    → wipe all computed data (admin)
//   GET  /api/heatmap/export   → download the heatmap database (.db) (admin)
//   POST /api/heatmap/import   → replace heatmap data from an uploaded .db (admin)
//
// /cells is readable by every logged-in user (the global gate already enforces a
// session); everything else is admin-only.

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const heatmap = require('../services/heatmap-stream');
const heatmapDb = require('../heatmap-db');
const appLog = require('../services/app-log');
const { requireAdmin } = require('../middleware/session-auth');
const { MAX_UPLOAD_MB } = require('../config');

const router = express.Router();
const UPLOAD_LIMIT = `${MAX_UPLOAD_MB}mb`;

// Readable by any authenticated user — the map is for everyone.
//   ?level=<deg>                          cell size to aggregate to (snapped server-side)
//   ?minLat&minLon&maxLat&maxLon          restrict to a viewport (fine detail on zoom)
// No bbox = whole world (cached); absent level defaults to a coarse world view so a
// bare request never streams every fine cell on the planet.
router.get('/api/heatmap/cells', (req, res) => {
  const q = req.query;
  const level = q.level !== undefined ? Number(q.level) : 1.0;
  let bbox;
  const keys = ['minLat', 'minLon', 'maxLat', 'maxLon'];
  if (keys.every((k) => q[k] !== undefined)) {
    const b = { minLat: +q.minLat, minLon: +q.minLon, maxLat: +q.maxLat, maxLon: +q.maxLon };
    if (Object.values(b).every(Number.isFinite)) bbox = b;
  }
  const hideSingletons = q.hideSingletons === '1';
  const out = heatmap.getCellsAgg({ level, bbox, hideSingletons });
  res.json({ gridDeg: out.gridDeg, cells: out.cells });
});

// ── Admin-only from here ────────────────────────────────────────────────────────

// Live stats via SSE. Stats-only — does NOT control the firehose.
router.get('/api/heatmap/stats', requireAdmin, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  heatmap.addViewer(res);
  req.on('close', () => heatmap.removeViewer(res));
});

router.post('/api/heatmap/start', requireAdmin, (req, res) => {
  const r = heatmap.startCollection();
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, stats: heatmap.getLiveStats() });
});

router.post('/api/heatmap/stop', requireAdmin, (req, res) => {
  heatmap.stopCollection();
  res.json({ ok: true, stats: heatmap.getLiveStats() });
});

router.post('/api/heatmap/reset', requireAdmin, (req, res) => {
  const removed = heatmap.reset();
  res.json({ ok: true, removed });
});

// Download the heatmap database on its own (separate from the main backup).
router.get('/api/heatmap/export', requireAdmin, (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmp = path.join(os.tmpdir(), `tracker-porti-heatmap-${ts}-${process.pid}.db`);
  try {
    heatmapDb.backupTo(tmp);
  } catch (e) {
    return res.status(500).json({ error: `Esportazione fallita: ${e.message}` });
  }
  res.download(tmp, `tracker-porti-heatmap-${ts}.db`, (err) => {
    fs.unlink(tmp, () => {});
    if (err && !res.headersSent) res.status(500).end();
  });
});

// Replace heatmap data from an uploaded .db (raw body, application/octet-stream).
router.post('/api/heatmap/import', requireAdmin, express.raw({ type: () => true, limit: UPLOAD_LIMIT }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Nessun file ricevuto' });
  if (req.body.slice(0, 15).toString('latin1') !== 'SQLite format 3') {
    return res.status(400).json({ error: 'Il file caricato non è un database SQLite valido' });
  }
  const tmp = path.join(os.tmpdir(), `tracker-porti-heatmap-import-${process.pid}-${req.body.length}.db`);
  try {
    fs.writeFileSync(tmp, req.body);
    const n = heatmapDb.restoreFrom(tmp);
    appLog.info('HEATMAP', 'Dati mappa zone coperte importati', { celle: n });
    res.json({ ok: true, cells: n });
  } catch (e) {
    res.status(400).json({ error: `Importazione fallita: ${e.message}` });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

module.exports = router;
