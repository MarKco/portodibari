'use strict';

const express = require('express');
const db = require('../db');
const { computeDirection, isInPort } = require('../services/ship-analysis');
const { computeRiskScore, computeRiskScoreCached, invalidateRiskCache, isMilitary } = require('../services/risk-score');
const { crawlVesselFinder } = require('../services/scrapers/vesselfinder');
const { crawlMarineTraffic } = require('../services/scrapers/marinetraffic');
const { crawlEquasis } = require('../services/scrapers/equasis');
const { crawlGfw } = require('../services/gfw');
const equasisLog = require('../services/equasis-log');
const shipFollow = require('../services/ship-follow');
const appLog = require('../services/app-log');
const { clampLimit, clampOffset } = require('../lib/params');
const { state, currentKeyword, SCRAPE_CACHE_TTL, SCRAPE_NEG_CACHE_DAYS, TRACK_DEFAULT_LIMIT, TRACK_MAX_LIMIT, EQUASIS_USER, EQUASIS_PASSWORD, GFW_TOKEN } = require('../config');

const router = express.Router();

// Geographic scope for the current user: the boxes of the areas they monitor.
// With ?area=KEY, narrow to that single area (only if the user owns it; an
// un-owned key yields an empty scope → no data).
function userScope(req) {
  const all = db.getUserBoxes(req.user.id);
  const area = req.query.area;
  if (area) return all.filter((b) => b.key === area);
  return all;
}

// Overlay the per-user flag/follow/mute state onto a ship row + the usual
// derived fields. `sets` holds the user's flagged/followed/muted MMSI sets.
function decorate(s, sets, lang, withDirection) {
  const mil = isMilitary(s);
  const flagged = mil ? true : sets.flags.has(s.mmsi);
  const base = {
    ...s,
    flagged,
    followed: sets.follows.has(s.mmsi) ? 1 : 0,
    notif_muted: sets.mutes.has(s.mmsi) ? 1 : 0,
    risk: computeRiskScoreCached(s, lang),
    is_military: mil,
  };
  if (withDirection) {
    base.direction = computeDirection(s);
    base.in_port = isInPort(s);
  }
  return base;
}

function userSets(userId) {
  return {
    flags: db.getUserFlaggedMmsis(userId),
    follows: db.getUserFollowedMmsis(userId),
    mutes: db.getUserMutedMmsis(userId),
  };
}

// Flagged-first ordering (the SQL no longer sorts by the legacy global column).
function flaggedFirst(a, b) {
  return (b.flagged ? 1 : 0) - (a.flagged ? 1 : 0);
}

// May the current user open this ship's detail? Visible if it's in one of their
// areas, or they follow/flag it (a followed ship roams outside the areas).
function canSeeShip(req, mmsi) {
  const uid = req.user.id;
  return db.isShipVisible(uid, mmsi) || db.getUserFollowedMmsis(uid).has(mmsi) || db.getUserFlaggedMmsis(uid).has(mmsi);
}

// Reject a non-numeric :mmsi once for every route below, so handlers never bind
// NaN into a query.
router.param('mmsi', (req, res, next, val) => {
  const n = Number(val);
  if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'MMSI non valido' });
  next();
});

// Literal sub-paths must be declared before the `:mmsi` parameter route.
router.get('/ships/active', (req, res) => {
  const lang = req.query.lang || 'it';
  const sets = userSets(req.user.id);
  const ships = db
    .getActiveShips(null, userScope(req))
    .map((s) => decorate(s, sets, lang, true))
    .sort(flaggedFirst);
  res.json({ ships });
});

router.get('/ships/past', (req, res) => {
  const lang = req.query.lang || 'it';
  const sets = userSets(req.user.id);
  const ships = db
    .getPastShips(null, userScope(req))
    .map((s) => decorate(s, sets, lang, false))
    .sort(flaggedFirst);
  res.json({ ships });
});

// Followed ships ("Navi seguite") — now per-user. Currently followed = "presenti";
// ships followed in the past = "passate" (history).
router.get('/ships/followed/active', (req, res) => {
  const lang = req.query.lang || 'it';
  const sets = userSets(req.user.id);
  const ships = db.getUserFollowedShips(req.user.id).map((s) => decorate(s, sets, lang, true)).sort(flaggedFirst);
  res.json({ ships });
});

router.get('/ships/followed/past', (req, res) => {
  const lang = req.query.lang || 'it';
  const sets = userSets(req.user.id);
  const ships = db.getUserPastFollowedShips(req.user.id).map((s) => decorate(s, sets, lang, false)).sort(flaggedFirst);
  res.json({ ships });
});

router.get('/ships/expected', (req, res) => {
  // "Expected" matches by the area keyword; honor the user's selected/owned areas.
  const area = req.query.area;
  const keyword = currentKeyword(area);
  res.json({ ships: db.getExpectedShips(keyword, userScope(req)), keyword });
});

router.get('/ships/:mmsi', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const lang = req.query.lang || 'it';
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  const ship = db.getShip(mmsi);
  if (!ship) return res.status(404).json({ error: 'Not found' });
  const mil = isMilitary(ship);
  const risk = computeRiskScore(ship, lang);
  // Opening the detail view is a natural sampling point for the score history.
  db.recordRiskSnapshot(mmsi, risk.score, risk.band);
  const uid = req.user.id;
  res.json({
    ...ship,
    direction: computeDirection(ship),
    in_port: isInPort(ship),
    risk,
    is_military: mil,
    flagged: mil ? true : db.getUserFlaggedMmsis(uid).has(mmsi),
    followed: db.getUserFollowedMmsis(uid).has(mmsi) ? 1 : 0,
    notif_muted: db.isUserMuted(uid, mmsi) ? 1 : 0,
  });
});

router.get('/ships/:mmsi/risk-history', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  res.json({ history: db.getRiskHistory(mmsi) });
});

router.get('/ships/:mmsi/readings', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  const result = db.getShipReadings(mmsi, clampLimit(req.query.limit), clampOffset(req.query.offset));
  res.json(result);
});

router.get('/ships/:mmsi/track', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  const limit = Math.min(Number(req.query.limit) || TRACK_DEFAULT_LIMIT, TRACK_MAX_LIMIT);
  res.json({ points: db.getShipTrack(mmsi, limit) });
});

router.patch('/ships/:mmsi/flag', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { flagged } = req.body;
  db.setUserFlag(req.user.id, mmsi, !!flagged);
  appLog.info('SHIP', appLog.t('ship.flag', { on: !!flagged }), { mmsi });
  res.json({ ok: true });
});

router.patch('/ships/:mmsi/military', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { is_military } = req.body;
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  db.setMilitary(mmsi, is_military);
  invalidateRiskCache(mmsi); // military status flips the score to 100
  appLog.info('SHIP', appLog.t('ship.military', { on: !!is_military }), { mmsi });
  res.json({ ok: true });
});

router.patch('/ships/:mmsi/follow', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { followed } = req.body;
  db.setUserFollow(req.user.id, mmsi, !!followed);
  // Reconcile the shared follow stream immediately (rebuild boxes / connect /
  // disconnect) instead of waiting for the next periodic refresh.
  shipFollow.refresh();
  appLog.info('SHIP', appLog.t('ship.follow', { on: !!followed }), { mmsi });
  res.json({ ok: true });
});

router.patch('/ships/:mmsi/seen', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { seen } = req.body;
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  db.setSeen(mmsi, seen);
  appLog.info('SHIP', appLog.t('ship.seen', { on: !!seen }), { mmsi });
  res.json({ ok: true });
});

router.patch('/ships/:mmsi/notif-muted', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { notif_muted } = req.body;
  db.setUserMute(req.user.id, mmsi, !!notif_muted);
  appLog.info('SHIP', appLog.t('ship.notif_muted', { on: !!notif_muted }), { mmsi });
  res.json({ ok: true });
});

router.patch('/ships/:mmsi/notes', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { notes } = req.body;
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  db.updateNotes(mmsi, notes);
  appLog.info('SHIP', appLog.t('ship.notes', { on: !!notes }), { mmsi });
  res.json({ ok: true });
});

router.get('/ships/:mmsi/events', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  res.json({ events: db.getShipEvents(mmsi) });
});

router.get('/ships/:mmsi/vfdata', async (req, res) => {
  if (!state.importVfData) return res.json({ enabled: false });
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
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
    appLog.info('SCRAPE', appLog.t('scrape.requested', { source: 'VesselFinder', name: ship.ship_name || mmsi }), { mmsi, id: identifier });
    const data = await crawlVesselFinder(identifier);
    const scraped_at = db.setScrapedData(mmsi, 'vf', data);
    invalidateRiskCache(mmsi); // flag/year/home-port may now contribute
    appLog.info('SCRAPE', appLog.t('scrape.ok', { source: 'VesselFinder', name: ship.ship_name || mmsi }), { mmsi });
    res.json({ enabled: true, data, cached: false, cachedAt: scraped_at });
  } catch (e) {
    appLog.warn('SCRAPE', appLog.t('scrape.failed', { source: 'VesselFinder', name: ship.ship_name || mmsi, error: e.message }), { mmsi });
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
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
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
    appLog.info('SCRAPE', appLog.t('scrape.requested', { source: 'MarineTraffic', name: ship.ship_name || mmsi }), { mmsi });
    const { data, shipId } = await crawlMarineTraffic(ship);
    if (shipId && shipId !== ship.mt_ship_id) db.setMtShipId(mmsi, shipId);
    const scraped_at = db.setScrapedData(mmsi, 'mt', data);
    invalidateRiskCache(mmsi); // flag/year/home-port may now contribute
    appLog.info('SCRAPE', appLog.t('scrape.ok', { source: 'MarineTraffic', name: ship.ship_name || mmsi }), { mmsi, shipId: shipId || null });
    res.json({ enabled: true, data, cached: false, cachedAt: scraped_at, shipId });
  } catch (e) {
    appLog.warn('SCRAPE', appLog.t('scrape.failed', { source: 'MarineTraffic', name: ship.ship_name || mmsi, error: e.message }), { mmsi });
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

// Equasis ownership/management lookup. Unlike VF/MT this never auto-runs and
// never expires: the cached result is served forever once obtained, and a live
// fetch happens only when the client asks (`?fetch=1`, i.e. the detail button).
router.get('/ships/:mmsi/equasis', async (req, res) => {
  if (!state.importEquasis) return res.json({ enabled: false });
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  const ship = db.getShip(mmsi);
  if (!ship) return res.status(404).json({ error: 'Ship not found' });

  const cached = db.getScrapedData(mmsi, 'eq');
  if (cached) {
    return res.json({
      enabled: true,
      data: JSON.parse(cached.data_json),
      cached: true,
      cachedAt: cached.scraped_at,
    });
  }

  // No IMO → Equasis can't be queried. Signalled upfront (even without ?fetch=1)
  // so the client can hide the button and show an explanatory hint instead of
  // letting the user click into a dead-end error. Common for small craft (tugs,
  // pilots, fishing) that never broadcast AIS static data.
  if (!ship.imo_number) {
    return res.json({ enabled: true, data: null, noImo: true });
  }

  // No cache. Only scrape on explicit request from the button.
  if (req.query.fetch !== '1') {
    return res.json({ enabled: true, data: null, needsFetch: true });
  }
  if (!EQUASIS_USER || !EQUASIS_PASSWORD) {
    return res.json({ enabled: true, error: 'Credenziali Equasis mancanti: imposta EQUASIS_USER e EQUASIS_PASSWORD in local.properties' });
  }
  try {
    appLog.info('EQUASIS', appLog.t('scrape.requested', { source: 'Equasis', name: ship.ship_name || mmsi }), { mmsi, imo: ship.imo_number });
    const data = await crawlEquasis(ship.imo_number);
    const scraped_at = db.setScrapedData(mmsi, 'eq', data);
    equasisLog.append({ mmsi, imo: ship.imo_number, name: ship.ship_name, ok: true, data });
    appLog.info('EQUASIS', appLog.t('scrape.ok', { source: 'Equasis', name: ship.ship_name || mmsi }), { mmsi, imo: ship.imo_number });
    res.json({ enabled: true, data, cached: false, cachedAt: scraped_at });
  } catch (e) {
    appLog.warn('EQUASIS', appLog.t('scrape.failed', { source: 'Equasis', name: ship.ship_name || mmsi, error: e.message }), { mmsi, imo: ship.imo_number });
    equasisLog.append({ mmsi, imo: ship.imo_number, name: ship.ship_name, ok: false, error: e.message });
    res.json({ enabled: true, error: e.message });
  }
});

// Global Fishing Watch enrichment (vessel identity + behavioural events). Like
// VF/MT this is proactive (the background enrichment caches it on first sight),
// so the detail view just serves the cache and only triggers a live fetch when
// nothing is cached yet and isn't negative-cached. `notFound` means GFW has no
// record for this vessel (normal for non-fishing/non-carrier ships).
router.get('/ships/:mmsi/gfwdata', async (req, res) => {
  if (!state.importGfw) return res.json({ enabled: false });
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  const ship = db.getShip(mmsi);
  if (!ship) return res.status(404).json({ error: 'Ship not found' });
  if (!GFW_TOKEN) {
    return res.json({ enabled: true, error: 'Token GFW mancante: imposta GLOBAL_FISHING_WATCH_TOKEN in local.properties' });
  }

  const cached = db.getScrapedData(mmsi, 'gfw');
  if (cached && Date.now() - new Date(cached.scraped_at).getTime() < SCRAPE_CACHE_TTL) {
    return res.json({
      enabled: true,
      data: JSON.parse(cached.data_json),
      cached: true,
      cachedAt: cached.scraped_at,
    });
  }
  // A recent "not in GFW" result → don't re-hammer the API; report it as such.
  if (!cached && db.hasRecentScrapeFailure(mmsi, 'gfw', SCRAPE_NEG_CACHE_DAYS)) {
    return res.json({ enabled: true, data: null, notFound: true });
  }
  try {
    appLog.info('GFW', appLog.t('scrape.requested', { source: 'Global Fishing Watch', name: ship.ship_name || mmsi }), { mmsi });
    const data = await crawlGfw(ship);
    if (!data.found) {
      db.setScrapeFailure(mmsi, 'gfw', 'non presente in GFW');
      appLog.info('GFW', appLog.t('gfw.not_found', { name: ship.ship_name || mmsi }), { mmsi });
      return res.json({ enabled: true, data: null, notFound: true });
    }
    const scraped_at = db.setScrapedData(mmsi, 'gfw', data);
    db.clearScrapeFailure(mmsi, 'gfw');
    invalidateRiskCache(mmsi); // GFW events/identity may now contribute to the score
    appLog.info('GFW', appLog.t('scrape.ok', { source: 'Global Fishing Watch', name: ship.ship_name || mmsi }), { mmsi });
    res.json({ enabled: true, data, cached: false, cachedAt: scraped_at });
  } catch (e) {
    appLog.warn('GFW', appLog.t('scrape.failed', { source: 'Global Fishing Watch', name: ship.ship_name || mmsi, error: e.message }), { mmsi });
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

module.exports = router;
