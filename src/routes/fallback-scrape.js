'use strict';

const express = require('express');
const fallbackMode = require('../services/fallback-mode');
const { fallbackScrapeClients } = require('../realtime');
const { requireAdmin } = require('../middleware/session-auth');

const router = express.Router();

// Live scrape-attempt feed for fallback-mode.js's sweep (see the "Log modalità
// fallback" sidebar window) — admin-only, same reasoning as the operational
// log: only relevant to whoever is deciding scope/watching for a ban risk.
router.use('/fallback-scrape', requireAdmin);

// Server-Sent Events stream of live scrape attempts ({ts,source,mmsi,ok}).
router.get('/fallback-scrape/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  fallbackScrapeClients.add(res);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    fallbackScrapeClients.delete(res);
    clearInterval(hb);
  });
});

// Recent attempts (oldest → newest) for backfilling a freshly-opened window.
router.get('/fallback-scrape', (req, res) => {
  res.json({ entries: fallbackMode.getRecentScrapeEvents() });
});

module.exports = router;
