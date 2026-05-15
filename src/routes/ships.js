'use strict';

const express = require('express');
const db = require('../db');
const { computeDirection, isInPort } = require('../services/ship-analysis');
const { computeRiskScore, isMilitary } = require('../services/risk-score');
const { crawlVesselFinder } = require('../services/scrapers/vesselfinder');
const { crawlMarineTraffic } = require('../services/scrapers/marinetraffic');
const { state, currentKeyword, SCRAPE_CACHE_TTL, TRACK_DEFAULT_LIMIT, TRACK_MAX_LIMIT } = require('../config');

const router = express.Router();

// Literal sub-paths must be declared before the `:mmsi` parameter route.
router.get('/ships/active', (req, res) => {
  const lang = req.query.lang || 'it';
  const area = req.query.area || state.preset;
  const ships = db
    .getActiveShips(area)
    .map((s) => {
      const mil = isMilitary(s);
      return { ...s, direction: computeDirection(s), in_port: isInPort(s), risk: computeRiskScore(s, lang), is_military: mil, flagged: mil ? true : s.flagged };
    });
  res.json({ ships });
});

router.get('/ships/past', (req, res) => {
  const lang = req.query.lang || 'it';
  const area = req.query.area || state.preset;
  const ships = db.getPastShips(area).map((s) => {
    const mil = isMilitary(s);
    return { ...s, risk: computeRiskScore(s, lang), is_military: mil, flagged: mil ? true : s.flagged };
  });
  res.json({ ships });
});

router.get('/ships/expected', (req, res) => {
  const area = req.query.area || state.preset;
  const keyword = currentKeyword(area);
  res.json({ ships: db.getExpectedShips(keyword), keyword });
});

router.get('/ships/:mmsi', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const lang = req.query.lang || 'it';
  const ship = db.getShip(mmsi);
  if (!ship) return res.status(404).json({ error: 'Not found' });
  const mil = isMilitary(ship);
  const risk = computeRiskScore(ship, lang);
  // Opening the detail view is a natural sampling point for the score history.
  db.recordRiskSnapshot(mmsi, risk.score, risk.band);
  res.json({ ...ship, direction: computeDirection(ship), in_port: isInPort(ship), risk, is_military: mil, flagged: mil ? true : ship.flagged });
});

router.get('/ships/:mmsi/risk-history', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  res.json({ history: db.getRiskHistory(mmsi) });
});

router.get('/ships/:mmsi/readings', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { limit = 50, offset = 0 } = req.query;
  const result = db.getShipReadings(mmsi, Number(limit), Number(offset));
  res.json(result);
});

router.get('/ships/:mmsi/track', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const limit = Math.min(Number(req.query.limit) || TRACK_DEFAULT_LIMIT, TRACK_MAX_LIMIT);
  res.json({ points: db.getShipTrack(mmsi, limit) });
});

router.patch('/ships/:mmsi/flag', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { flagged } = req.body;
  db.setFlag(mmsi, flagged);
  res.json({ ok: true });
});

router.patch('/ships/:mmsi/military', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { is_military } = req.body;
  db.setMilitary(mmsi, is_military);
  res.json({ ok: true });
});

router.patch('/ships/:mmsi/seen', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { seen } = req.body;
  db.setSeen(mmsi, seen);
  res.json({ ok: true });
});

router.patch('/ships/:mmsi/notif-muted', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { notif_muted } = req.body;
  db.setNotifMuted(mmsi, notif_muted);
  res.json({ ok: true });
});

router.patch('/ships/:mmsi/notes', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { notes } = req.body;
  db.updateNotes(mmsi, notes);
  res.json({ ok: true });
});

router.get('/ships/:mmsi/events', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  res.json({ events: db.getShipEvents(mmsi) });
});

router.get('/ships/:mmsi/vfdata', async (req, res) => {
  if (!state.importVfData) return res.json({ enabled: false });
  const mmsi = Number(req.params.mmsi);
  const ship = db.getShip(mmsi);
  if (!ship) return res.status(404).json({ error: 'Ship not found' });
  const identifier = ship.imo_number || mmsi;
  const cached = db.getScrapedData(mmsi, 'vf');
  if (cached && Date.now() - new Date(cached.scraped_at).getTime() < SCRAPE_CACHE_TTL) {
    return res.json({
      enabled: true,
      data: JSON.parse(cached.data_json),
      cached: true,
      cachedAt: cached.scraped_at,
    });
  }
  try {
    const data = await crawlVesselFinder(identifier);
    const scraped_at = db.setScrapedData(mmsi, 'vf', data);
    res.json({ enabled: true, data, cached: false, cachedAt: scraped_at });
  } catch (e) {
    console.error('[VF] Crawl error:', e.message);
    if (cached) {
      return res.json({
        enabled: true,
        data: JSON.parse(cached.data_json),
        cached: true,
        cachedAt: cached.scraped_at,
        error: e.message,
      });
    }
    res.json({ enabled: true, error: e.message });
  }
});

router.get('/ships/:mmsi/mtdata', async (req, res) => {
  if (!state.importMtData) return res.json({ enabled: false });
  const mmsi = Number(req.params.mmsi);
  const ship = db.getShip(mmsi);
  if (!ship) return res.status(404).json({ error: 'Ship not found' });
  const cached = db.getScrapedData(mmsi, 'mt');
  if (cached && Date.now() - new Date(cached.scraped_at).getTime() < SCRAPE_CACHE_TTL) {
    return res.json({
      enabled: true,
      data: JSON.parse(cached.data_json),
      cached: true,
      cachedAt: cached.scraped_at,
      shipId: ship.mt_ship_id || null,
    });
  }
  try {
    const { data, shipId } = await crawlMarineTraffic(ship);
    if (shipId && shipId !== ship.mt_ship_id) db.setMtShipId(mmsi, shipId);
    const scraped_at = db.setScrapedData(mmsi, 'mt', data);
    res.json({ enabled: true, data, cached: false, cachedAt: scraped_at, shipId });
  } catch (e) {
    console.error('[MT] Crawl error:', e.message);
    if (cached) {
      return res.json({
        enabled: true,
        data: JSON.parse(cached.data_json),
        cached: true,
        cachedAt: cached.scraped_at,
        error: e.message,
        shipId: ship.mt_ship_id || null,
      });
    }
    res.json({ enabled: true, error: e.message });
  }
});

module.exports = router;
