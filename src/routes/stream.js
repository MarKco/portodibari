'use strict';

const express = require('express');
const db = require('../db');
const stream = require('../services/ais-stream');
const shipFollow = require('../services/ship-follow');
const heatmap = require('../services/heatmap-stream');
const aisUptime = require('../services/ais-uptime');
const fallbackMode = require('../services/fallback-mode');
const appLog = require('../services/app-log');
const { state, BBOX_PRESETS } = require('../config');
const { requireAdmin } = require('../middleware/session-auth');

const router = express.Router();

// Manual stream control is restricted to areas the user monitors. (The stream
// itself is shared across users that own the same area.)
function ownsArea(req, area) {
  return !!area && db.getUserAreaKeys(req.user.id).includes(area);
}

router.post('/stream/start', (req, res) => {
  const area = req.body?.area || state.preset;
  if (!BBOX_PRESETS[area]) return res.status(400).json({ error: `Area sconosciuta: ${area}` });
  if (!ownsArea(req, area)) return res.status(403).json({ error: 'Area non assegnata' });
  if (stream.isActive(area)) return res.json({ ok: true, message: 'Already running', area });
  appLog.info('AIS', appLog.t('ais.stream_start_manual'), { area });
  stream.startStream(area);
  res.json({ ok: true, area });
});

router.post('/stream/stop', (req, res) => {
  const area = req.body?.area || state.preset;
  if (!ownsArea(req, area)) return res.status(403).json({ error: 'Area non assegnata' });
  appLog.info('AIS', appLog.t('ais.stream_stop_manual'), { area });
  stream.stopStream(area);
  res.json({ ok: true, area });
});

router.get('/stream/status', (req, res) => {
  const outage = aisUptime.getOutage();
  // Per-area fallback detail (which area, since when) is admin-only — regular
  // users get the general active/since aggregate the outage banner needs
  // (public/js/outage.js) but not the breakdown (surfaced instead on the
  // monitoring page header and the Aree screen, both already admin-gated).
  if (!(req.realUser && req.realUser.role === 'admin') && outage.fallbackMode) {
    outage.fallbackMode = { active: outage.fallbackMode.active, since: outage.fallbackMode.since };
  }
  res.json({ ...stream.getStatus(), outage });
});

// Admin-only: per-area fallback detail included here (fallbackMode/fallbackEstimate)
// is the same data the "pagina monitoraggi" header and Aree screen restrict to
// admins — only ever called from the admin-gated "Diagnostica AIS" tab anyway.
router.get('/stream/health', requireAdmin, (req, res) => {
  const area = req.query.area || state.preset;
  // Three independent AISStream keys/accounts, each its own connection. Report all
  // three so the panel can show per-key health side by side (monitoring, follow,
  // heatmap). Monitoring stays at the top level too for backward compatibility.
  const monitoring = stream.getHealth(area);
  res.json({
    ...monitoring,
    monitoring,
    follow: shipFollow.getHealth(),
    heatmap: heatmap.getHealth(),
    scrapeCounts24h: db.getScrapeCounts24h(),
    fallbackMode: fallbackMode.getStatus(),
    fallbackEstimate: fallbackMode.getEstimate(),
  });
});

module.exports = router;
