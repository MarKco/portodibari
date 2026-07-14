'use strict';

const express = require('express');
const db = require('../db');
const { computeDirection, isInPort } = require('../services/ship-analysis');
const { computeRiskScore, computeRiskScoreCached, invalidateRiskCache, isMilitary } = require('../services/risk-score');
const { crawlVesselFinder } = require('../services/scrapers/vesselfinder');
const { crawlMarineTraffic, searchMt, mtVesselInfo, mtDataFromInfo } = require('../services/scrapers/marinetraffic');
const { crawlShipfinder } = require('../services/scrapers/shipfinder');
const { crawlMyshiptracking } = require('../services/scrapers/myshiptracking');
const { crawlEquasis } = require('../services/scrapers/equasis');
const { crawlGfw } = require('../services/gfw');
const sanctions = require('../services/sanctions');
const psc = require('../services/psc');
const equasisLog = require('../services/equasis-log');
const shipFollow = require('../services/ship-follow');
const groupSync = require('../services/group-sync');
const appLog = require('../services/app-log');
const { clampLimit, clampOffset } = require('../lib/params');
const { state, currentKeyword, SCRAPE_CACHE_TTL, SCRAPE_NEG_CACHE_DAYS, TRACK_DEFAULT_LIMIT, TRACK_MAX_LIMIT, EQUASIS_USER, EQUASIS_PASSWORD, GFW_TOKEN, SEARCH_LOOKUP_TIMEOUT_MS, REPLAY, TESTER_MAX_FOLLOWS, FOLLOW_FRESH_MS } = require('../config');
const { destinationLabel } = require('../services/locode');

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
    destination_label: destinationLabel(s.destination),
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

// Timestamp of the last ShipFinder fix to surface as the "vista su ShipFinder"
// badge, or null. Returns null when SF import is off, when there's no scraped
// fix, OR when AIS has since re-acquired the ship (last_seen_at, AIS-only, is
// newer than the SF fix): the scraped last-known is then stale and the badge
// would be misleading, so we drop it.
// A scraped "last known" badge is meant to show only WHILE the ship is dark on our
// AIS stream. Hide it once AIS has re-acquired the vessel — i.e. the last AIS fix
// is fresh (within FOLLOW_FRESH_MS) or is at least as recent as the scraped fix.
// (The freshness check is also a guard against a bogus scraped timestamp: a fresh
// AIS fix always wins regardless of what the scrape claims.)
function scrapeBadgeAt(scrapedAt, lastSeenAt) {
  if (!scrapedAt) return null;
  if (lastSeenAt) {
    const seen = new Date(lastSeenAt).getTime();
    if (Date.now() - seen < FOLLOW_FRESH_MS) return null; // AIS re-acquired (fresh)
    if (seen >= new Date(scrapedAt).getTime()) return null; // AIS fix newer than scrape
  }
  return scrapedAt;
}

function sfBadgeAt(mmsi, lastSeenAt) {
  if (!state.importSfData) return null;
  return scrapeBadgeAt(db.getLatestScrapedPosition(mmsi, 'sf')?.received_at || null, lastSeenAt);
}

// MyShipTracking counterpart of sfBadgeAt for the "vista su MyShipTracking" badge.
function mstBadgeAt(mmsi, lastSeenAt) {
  if (!state.importMstData) return null;
  return scrapeBadgeAt(db.getLatestScrapedPosition(mmsi, 'mst')?.received_at || null, lastSeenAt);
}

// Position to PLOT on the followed map when AIS has gone dark. Returns the most
// recent scraped fix {lat, lon, at, source} that the badge rule would surface
// (AIS not fresh AND the scrape is newer than the last AIS fix), or null. Lets
// a ship that lost AIS but was re-located via ShipFinder/MyShipTracking still
// show on the map (grey). Fresh AIS always wins (scrapeBadgeAt returns null),
// so the marker snaps back to the AIS position the moment AIS re-acquires.
function scrapeFallbackFix(mmsi, lastSeenAt) {
  const cands = [];
  if (state.importSfData) {
    const f = db.getLatestScrapedPosition(mmsi, 'sf');
    const at = f && scrapeBadgeAt(f.received_at, lastSeenAt);
    if (at && f.lat != null && f.lon != null) cands.push({ lat: f.lat, lon: f.lon, at, source: 'sf' });
  }
  if (state.importMstData) {
    const f = db.getLatestScrapedPosition(mmsi, 'mst');
    const at = f && scrapeBadgeAt(f.received_at, lastSeenAt);
    if (at && f.lat != null && f.lon != null) cands.push({ lat: f.lat, lon: f.lon, at, source: 'mst' });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return cands[0]; // most recent of SF/MST
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

router.get('/ships/past/count', (req, res) => {
  const count = db.getPastShipsCount(null, userScope(req));
  res.json({ count });
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
  const now = Date.now();
  const ships = db.getUserFollowedShips(req.user.id).map((s) => {
    const decorated = decorate(s, sets, lang, true);
    decorated.is_stale = (!s.last_seen_at || now - new Date(s.last_seen_at).getTime() > FOLLOW_FRESH_MS) ? 1 : 0;
    decorated.search_mode = db.getUserFollowSearchMode(req.user.id, s.mmsi);
    decorated.sf_last_at = sfBadgeAt(s.mmsi, s.last_seen_at);
    decorated.mst_last_at = mstBadgeAt(s.mmsi, s.last_seen_at);
    const fb = scrapeFallbackFix(s.mmsi, s.last_seen_at);
    if (fb) {
      decorated.fallback_lat = fb.lat;
      decorated.fallback_lon = fb.lon;
      decorated.fallback_at = fb.at;
      decorated.fallback_source = fb.source;
    }
    // Scrape-only follow (never AIS): hide the epoch sentinel from the UI — the
    // 🔍 "in ricerca" cell + scrape badge already convey its state.
    if (decorated.last_seen_at === db.NEVER_SEEN_AIS) decorated.last_seen_at = null;
    return decorated;
  }).sort(flaggedFirst);
  res.json({ ships });
});

router.get('/ships/followed/past', (req, res) => {
  const lang = req.query.lang || 'it';
  const sets = userSets(req.user.id);
  const ships = db.getUserPastFollowedShips(req.user.id).map((s) => {
    const decorated = decorate(s, sets, lang, false);
    if (decorated.last_seen_at === db.NEVER_SEEN_AIS) decorated.last_seen_at = null;
    return decorated;
  }).sort(flaggedFirst);
  res.json({ ships });
});

router.get('/ships/expected', (req, res) => {
  // "Expected" matches by the area keyword; honor the user's selected/owned areas.
  const area = req.query.area;
  const keyword = currentKeyword(area);
  res.json({ ships: db.getExpectedShips(keyword, userScope(req)), keyword });
});

// ── Ship search ───────────────────────────────────────────────────────────────
// Search a ship by name or MMSI/IMO across the local fleet + MarineTraffic, then
// recover its live position from AISstream and let the user follow it. Two steps:
//   1. /search/candidates — fast JSON list (local DB + MT global_search) to pick
//      from when a name matches several ships.
//   2. /search/recover    — SSE stream that progressively emits identity from each
//      source (VF/MT/GFW) + sanctions/PSC screening, registers an AISstream
//      worldwide-box lookup for the MMSI, and pushes the position the moment a
//      live fix arrives. Closing the stream (Cancel / window close) aborts the
//      lookup; no fix within SEARCH_LOOKUP_TIMEOUT_MS emits a `timeout` event.

router.get('/ships/search/candidates', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ candidates: [], mt: false });
  const map = new Map(); // dedupe key (mmsi | 'mt:'+shipId) → candidate

  for (const r of db.searchShipsByName(q, 25)) {
    map.set(String(r.mmsi), {
      mmsi: r.mmsi,
      name: r.ship_name || null,
      imo: r.imo_number || null,
      ship_type: r.ship_type ?? null,
      flag: null,
      hasLocalPos: r.last_latitude != null && r.last_longitude != null,
      last_seen_at: r.last_seen_at || null,
      sources: ['local'],
    });
  }
  // A bare 9-digit MMSI the local fleet has never seen: still offer it so the
  // user can recover its position via AISstream.
  if (/^\d{9}$/.test(q) && !map.has(q)) {
    map.set(q, { mmsi: Number(q), name: null, imo: null, ship_type: null, flag: null, hasLocalPos: false, sources: ['mmsi'] });
  }

  let mtUsed = false;
  if (state.importMtData) {
    mtUsed = true;
    try {
      for (const c of await searchMt(q)) {
        const key = c.mmsi ? String(c.mmsi) : `mt:${c.shipId}`;
        const existing = map.get(key);
        if (existing) {
          if (!existing.sources.includes('mt')) existing.sources.push('mt');
          existing.name = existing.name || c.name;
          existing.flag = existing.flag || c.flag;
          continue;
        }
        map.set(key, {
          mmsi: c.mmsi || null,
          mtShipId: c.mmsi ? null : c.shipId,
          name: c.name,
          imo: c.imo || null,
          ship_type: null,
          flag: c.flag || null,
          hasLocalPos: false,
          sources: ['mt'],
        });
      }
    } catch (e) {
      appLog.warn('SEARCH', `MarineTraffic search "${q}" fallita: ${e.message}`);
    }
  }
  res.json({ candidates: [...map.values()].slice(0, 30), mt: mtUsed });
});

router.get('/ships/search/recover', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`); } catch { /* client gone */ }
  };
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 25000);

  let mmsi = Number(req.query.mmsi) || null;
  const mtShipId = req.query.mtShipId || null;
  let imo = Number(req.query.imo) || null;
  let name = req.query.name || null;

  let lookupCb = null;
  let timeout = null;
  let positionFound = false;
  let closed = false;
  let mtFetched = false;

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    clearTimeout(timeout);
    if (lookupCb && mmsi) shipFollow.removeLookup(mmsi, lookupCb);
  }
  // The whole point of the SSE lifecycle: closing the connection (Cancel button,
  // window close, navigation) aborts the worldwide AISstream lookup.
  req.on('close', cleanup);

  // Resolve the MMSI from an MT-only candidate (global_search gave us a shipId
  // but no MMSI): vesselInfo carries it. This doubles as the MT identity fetch.
  if (!mmsi && mtShipId) {
    try {
      const info = await mtVesselInfo(mtShipId);
      mmsi = Number(info.mmsi) || null;
      imo = imo || Number(info.imo) || null;
      name = name || info.name || null;
      if (mmsi) {
        const data = mtDataFromInfo(info);
        db.setScrapedData(mmsi, 'mt', data);
        invalidateRiskCache(mmsi);
        mtFetched = true;
        send('source', { source: 'mt', ok: true, data });
      }
    } catch (e) {
      send('source', { source: 'mt', ok: false, error: e.message });
    }
  }
  if (!mmsi) {
    send('error', { message: 'MMSI non risolvibile per questa nave' });
    send('done', {});
    cleanup();
    return res.end();
  }
  appLog.info('SEARCH', `Ricerca posizione nave ${name || mmsi}`, { mmsi });

  const local = db.getShip(mmsi);
  const ship = local || { mmsi, imo_number: imo, ship_name: name, call_sign: null, ship_type: null };
  if (!ship.imo_number && imo) ship.imo_number = imo;

  send('identity', {
    mmsi,
    name: ship.ship_name || name || null,
    imo: ship.imo_number || null,
    ship_type: ship.ship_type ?? null,
    local: !!local,
    risk: local ? computeRiskScore(local, req.query.lang || 'it') : null,
  });

  // A recent local fix means we already know where it is — show it at once and
  // enable Follow. The lookup still runs to refresh it with a live frame.
  if (local && local.last_latitude != null && local.last_longitude != null) {
    positionFound = true;
    send('position', {
      lat: local.last_latitude,
      lon: local.last_longitude,
      name: local.ship_name || null,
      sog: local.last_sog ?? null,
      cog: local.last_cog ?? null,
      time: local.last_seen_at || null,
      cached: true,
    });
  }

  // Screening on the identity we have so far (IMO / name / call sign).
  try {
    const sanc = sanctions.matchShip(ship);
    const banned = psc.matchBanned(ship);
    send('screening', {
      sanctioned: sanc ? { matchedOn: sanc.matchedOn, name: sanc.entry?.name || null, url: sanctions.entityUrl(sanc.entry) } : null,
      banned: banned ? { matchedOn: banned.matchedOn } : null,
    });
  } catch { /* screening is best-effort */ }

  // Live identity enrichment from each enabled source, streamed as it lands.
  const flagFromData = (data) => data && (data['Bandiera'] || data['Flag'] || data['Country'] || null);
  const tasks = [];
  if (state.importVfData) {
    tasks.push((async () => {
      try {
        const data = await crawlVesselFinder(ship.imo_number || mmsi);
        db.setScrapedData(mmsi, 'vf', data);
        invalidateRiskCache(mmsi);
        const flagHit = psc.matchFlag(flagFromData(data));
        send('source', { source: 'vf', ok: true, data, flagPerf: flagHit ? flagHit.perf : null });
      } catch (e) {
        send('source', { source: 'vf', ok: false, error: e.message });
      }
    })());
  }
  if (state.importMtData && !mtFetched) {
    tasks.push((async () => {
      try {
        const { data, shipId } = await crawlMarineTraffic(ship);
        if (shipId) db.setMtShipId(mmsi, shipId);
        db.setScrapedData(mmsi, 'mt', data);
        invalidateRiskCache(mmsi);
        const flagHit = psc.matchFlag(flagFromData(data));
        send('source', { source: 'mt', ok: true, data, flagPerf: flagHit ? flagHit.perf : null });
      } catch (e) {
        send('source', { source: 'mt', ok: false, error: e.message });
      }
    })());
  }
  if (state.importGfw && GFW_TOKEN) {
    tasks.push((async () => {
      try {
        const data = await crawlGfw(ship);
        if (data && data.found) {
          db.setScrapedData(mmsi, 'gfw', data);
          invalidateRiskCache(mmsi);
          send('source', { source: 'gfw', ok: true, data });
        } else {
          send('source', { source: 'gfw', ok: true, notFound: true });
        }
      } catch (e) {
        send('source', { source: 'gfw', ok: false, error: e.message });
      }
    })());
  }
  // ShipFinder / MyShipTracking: enrich identity AND, if AIS has no fix yet, surface
  // a scraped position so the ship can be followed straight from it ("in ricerca").
  // A live AIS frame, if one arrives, supersedes this on the client. Guarded by
  // positionFound so a cached AIS fix or an earlier scrape isn't overridden — AIS
  // is always preferred; the first scrape source to land wins between SF and MST.
  const emitScrapeFix = (position, source) => {
    const stored = db.insertScrapedPosition(mmsi, { ...position, name: position.name || ship.ship_name }, source);
    if (closed || positionFound) return;
    positionFound = true;
    send('position', {
      lat: position.lat,
      lon: position.lon,
      name: position.name || ship.ship_name || null,
      sog: position.sog ?? null,
      cog: position.cog ?? null,
      time: (stored && stored.received_at) || position.reportedAt || null,
      cached: true,
      scrape: true,
      source,
    });
  };
  if (state.importSfData) {
    tasks.push((async () => {
      try {
        const { static: staticData, position } = await crawlShipfinder(mmsi);
        db.recordScrape('sf', true);
        if (staticData && Object.keys(staticData).length) db.setScrapedData(mmsi, 'sf', staticData);
        if (position) { db.clearScrapeFailure(mmsi, 'sf'); emitScrapeFix(position, 'sf'); }
        send('source', { source: 'sf', ok: true, data: staticData, hasPosition: !!position });
      } catch (e) {
        db.recordScrape('sf', false);
        send('source', { source: 'sf', ok: false, error: e.message });
      }
    })());
  }
  if (state.importMstData) {
    tasks.push((async () => {
      try {
        const { static: staticData, position } = await crawlMyshiptracking(mmsi);
        db.recordScrape('mst', true);
        if (staticData && Object.keys(staticData).length) db.setScrapedData(mmsi, 'mst', staticData);
        if (position) { db.clearScrapeFailure(mmsi, 'mst'); emitScrapeFix(position, 'mst'); }
        send('source', { source: 'mst', ok: true, data: staticData, hasPosition: !!position });
      } catch (e) {
        db.recordScrape('mst', false);
        send('source', { source: 'mst', ok: false, error: e.message });
      }
    })());
  }
  Promise.allSettled(tasks).then(() => { if (!closed) send('sources-done', {}); });

  // Register the AISstream worldwide-box lookup for the live position. We do NOT
  // clear the timeout on a fix: the timer is the guaranteed teardown of the
  // worldwide subscription, so it must always fire even after a position arrives
  // (otherwise an idle open SSE would keep the worldwide box alive indefinitely).
  lookupCb = shipFollow.addLookup(mmsi, (fix) => {
    if (closed) return;
    positionFound = true;
    send('position', { ...fix, cached: false });
  });

  // Hard cap on the worldwide subscription: drop it after the timeout whether or
  // not a fix arrived. If none did, the UI offers a retry; a position (live or
  // cached) already enabled Follow and the marker simply stops live-updating.
  timeout = setTimeout(() => {
    if (closed) return;
    if (lookupCb && mmsi) { shipFollow.removeLookup(mmsi, lookupCb); lookupCb = null; }
    send('timeout', { hadPosition: positionFound });
  }, SEARCH_LOOKUP_TIMEOUT_MS);
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
    // A scrape-only follow (never seen via AIS) carries an epoch sentinel; present
    // it as "no AIS fix" rather than a 1970 timestamp. Badges/is_stale above used
    // the real (old) value to decide AIS is absent.
    last_seen_at: ship.last_seen_at === db.NEVER_SEEN_AIS ? null : ship.last_seen_at,
    direction: computeDirection(ship),
    in_port: isInPort(ship),
    risk,
    is_military: mil,
    flagged: mil ? true : db.getUserFlaggedMmsis(uid).has(mmsi),
    followed: db.getUserFollowedMmsis(uid).has(mmsi) ? 1 : 0,
    is_stale: (!ship.last_seen_at || Date.now() - new Date(ship.last_seen_at).getTime() > FOLLOW_FRESH_MS) ? 1 : 0,
    search_mode: db.getUserFollowSearchMode(uid, mmsi),
    sf_last_at: sfBadgeAt(mmsi, ship.last_seen_at),
    mst_last_at: mstBadgeAt(mmsi, ship.last_seen_at),
    notif_muted: db.isUserMuted(uid, mmsi) ? 1 : 0,
    destination_label: destinationLabel(ship.destination),
  });
});

router.get('/ships/:mmsi/risk-history', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  res.json({ history: db.getRiskHistory(mmsi) });
});

// Confirmed ship-to-ship rendezvous involving this vessel (newest first). Drives
// the rendezvous section in the detail view; each row links to the partner ship.
router.get('/ships/:mmsi/rendezvous', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  res.json({ rendezvous: db.getProximityForShip(mmsi, new Date(0).toISOString()) });
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

  // Optionally fold in SF/MST scraped positions (only for enabled integrations,
  // and only when the client keeps the track toggle on with ?scraped=1).
  const extras = [];
  if (state.importSfData) extras.push('sf');
  if (state.importMstData) extras.push('mst');
  const useScraped = req.query.scraped === '1' && extras.length > 0;
  const sources = useScraped ? ['ais', ...extras] : ['ais'];

  let fromIso = null, toIso = null;
  if (req.query.from && req.query.to) {
    fromIso = String(req.query.from);
    toIso   = String(req.query.to);
  } else if (req.query.window && req.query.window !== 'all') {
    const range = db.getShipTrackRange(mmsi, sources);
    if (range && range.hi) {
      const hours = req.query.window === '7d' ? 168 : req.query.window === '24h' ? 24 : 6;
      toIso   = range.hi;
      fromIso = new Date(new Date(range.hi).getTime() - hours * 3600000).toISOString();
    }
  }

  // Per-user, non-destructive track reset: hide movements at-or-before the
  // cutoff by raising the effective lower bound. Never touches the shared data.
  const resetAt = db.getTrackReset(req.user.id, mmsi);
  if (resetAt && (!fromIso || resetAt > fromIso)) fromIso = resetAt;

  const range = db.getShipTrackRange(mmsi, sources);
  // Clamp the reported range start to the cutoff so the picker/labels reflect
  // the visible span (the data before it still exists, just hidden for this user).
  if (range && resetAt && (!range.lo || resetAt > range.lo)) range.lo = resetAt;
  // Whether the ship has any SF/MST fix at all (regardless of toggle) — the
  // client shows the toggle only when there is scraped data to add.
  const extraAvailable = extras.length > 0 && db.hasShipScrapedPositions(mmsi, extras);
  res.json({ points: db.getShipTrack(mmsi, limit, fromIso, toIso, sources), range, extraAvailable, resetAt });
});

// Per-user track reset toggle (non-destructive; see db.user_track_resets).
// POST sets the cutoff to "now"; DELETE clears it (restores full history).
router.post('/ships/:mmsi/track-reset', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  const resetAt = new Date().toISOString();
  db.setTrackReset(req.user.id, mmsi, resetAt);
  res.json({ ok: true, resetAt });
});
router.delete('/ships/:mmsi/track-reset', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  db.clearTrackReset(req.user.id, mmsi);
  res.json({ ok: true, resetAt: null });
});

// Historical replay: all positions inside an area's bbox over a time window,
// grouped by ship, for the time-scrubber on the area map. ?area=KEY scopes to a
// single owned area (else all the user's areas). Window: ?from&to (ISO) or
// ?window=1h|6h|24h|all, anchored to the latest data (not wall-clock, so the
// scrubber always lands on data even after a quiet spell). Risk band per ship is
// the current cached score (the replay is historical; the colour is "now").
router.get('/replay', (req, res) => {
  const boxes = userScope(req);
  const empty = { ships: [], range: null, from: null, to: null, truncated: false };
  if (!boxes.length) return res.json(empty);

  // Enabled scraped position sources (SF/MST). Included in the route only when
  // the client keeps the toggle on (?scraped=1) AND the integration is enabled.
  const extras = [];
  if (state.importSfData) extras.push('sf');
  if (state.importMstData) extras.push('mst');
  const useScraped = req.query.scraped === '1' && extras.length > 0;
  const sources = useScraped ? ['ais', ...extras] : ['ais'];

  const range = db.getAreaReplayRange(boxes, sources);
  if (!range || !range.lo) return res.json({ ...empty, extraAvailable: false });

  let fromIso, toIso;
  if (req.query.from && req.query.to) {
    fromIso = String(req.query.from);
    toIso = String(req.query.to);
  } else if (req.query.window === 'all') {
    fromIso = range.lo;
    toIso = range.hi;
  } else {
    const hours = req.query.window === '6h' ? 6 : req.query.window === '24h' ? 24 : 1;
    toIso = range.hi;
    fromIso = new Date(new Date(range.hi).getTime() - hours * 3600000).toISOString();
  }
  // Clamp into the available range so we never ask for data we don't have.
  if (fromIso < range.lo) fromIso = range.lo;
  if (toIso > range.hi) toIso = range.hi;

  const rows = db.getAreaReplayPositions(boxes, fromIso, toIso, REPLAY.MAX_POINTS, sources);
  const truncated = rows.length >= REPLAY.MAX_POINTS;

  // Whether SF/MST positions exist in this window (regardless of the toggle) —
  // the client shows the toggle only when there is scraped data to add.
  const extraAvailable = extras.length > 0 && db.hasAreaReplayPositions(boxes, fromIso, toIso, extras);

  const lang = req.query.lang || 'it';
  const flaggedSet = db.getUserFlaggedMmsis(req.user.id);
  const byMmsi = new Map();
  for (const r of rows) {
    let g = byMmsi.get(r.mmsi);
    if (!g) {
      g = { mmsi: r.mmsi, name: r.ship_name, type: r.ship_type, fixes: [] };
      byMmsi.set(r.mmsi, g);
    }
    g.fixes.push({ t: r.received_at, lat: r.lat, lon: r.lon, cog: r.cog, sog: r.sog });
  }

  const ships = [];
  for (const g of byMmsi.values()) {
    const shipRow = db.getShip(g.mmsi);
    const mil = shipRow ? isMilitary(shipRow) : false;
    g.band = shipRow ? computeRiskScoreCached(shipRow, lang).band : 'low';
    g.flagged = mil || flaggedSet.has(g.mmsi);
    ships.push(g);
  }

  res.json({ ships, range: { lo: range.lo, hi: range.hi }, from: fromIso, to: toIso, truncated, extraAvailable });
});

router.patch('/ships/:mmsi/flag', (req, res) => {
  const mmsi = Number(req.params.mmsi);
  const { flagged } = req.body;
  db.setUserFlag(req.user.id, mmsi, !!flagged);
  groupSync.syncFlag(req.user.id, mmsi, !!flagged); // mirror to group co-members
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
  const userId = req.user.id;
  if (followed && req.user.role === 'tester') {
    const activeFollows = db.getUserFollowedMmsis(userId).size;
    if (activeFollows >= TESTER_MAX_FOLLOWS) {
      return res.status(403).json({ error: `Account tester: massimo ${TESTER_MAX_FOLLOWS} navi seguite` });
    }
  }
  const { reacquiring } = shipFollow.applyFollow(userId, mmsi, !!followed);
  groupSync.syncFollow(userId, mmsi, !!followed); // mirror to group co-members
  appLog.info('SHIP', appLog.t('ship.follow', { on: !!followed }), { mmsi });
  res.json({ ok: true, reacquiring });
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
  groupSync.syncMute(req.user.id, mmsi, !!notif_muted); // mirror to group co-members
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
  const events = db.getShipEvents(mmsi).map((e) => ({ ...e, destination_label: destinationLabel(e.destination) }));
  res.json({ events });
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
    db.recordScrape('vf', true);
    invalidateRiskCache(mmsi); // flag/year/home-port may now contribute
    appLog.info('SCRAPE', appLog.t('scrape.ok', { source: 'VesselFinder', name: ship.ship_name || mmsi }), { mmsi });
    res.json({ enabled: true, data, cached: false, cachedAt: scraped_at });
  } catch (e) {
    db.recordScrape('vf', false);
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
    db.recordScrape('mt', true);
    invalidateRiskCache(mmsi); // flag/year/home-port may now contribute
    appLog.info('SCRAPE', appLog.t('scrape.ok', { source: 'MarineTraffic', name: ship.ship_name || mmsi }), { mmsi, shipId: shipId || null });
    res.json({ enabled: true, data, cached: false, cachedAt: scraped_at, shipId });
  } catch (e) {
    db.recordScrape('mt', false);
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

// ShipFinder static data + last-known scraped positions. Mirrors vfdata for the
// static fields, and additionally returns the scraped-position breadcrumb (source
// 'sf') so the detail map can drop distinct "last known" markers. Never scrapes a
// fresh position here (that's the manual /sflocate button below or the background
// stale-follow sweep) — only serves cached static + stored positions.
router.get('/ships/:mmsi/sfdata', async (req, res) => {
  if (!state.importSfData) return res.json({ enabled: false });
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  const ship = db.getShip(mmsi);
  if (!ship) return res.status(404).json({ error: 'Ship not found' });
  const positions = db.getScrapedPositions(mmsi, 'sf');
  const cached = db.getScrapedData(mmsi, 'sf');
  if (cached && Date.now() - new Date(cached.scraped_at).getTime() < SCRAPE_CACHE_TTL) {
    return res.json({ enabled: true, data: JSON.parse(cached.data_json), cached: true, cachedAt: cached.scraped_at, positions });
  }
  try {
    appLog.info('SCRAPE', appLog.t('scrape.requested', { source: 'ShipFinder', name: ship.ship_name || mmsi }), { mmsi });
    const { static: staticData, position } = await crawlShipfinder(mmsi);
    const scraped_at = db.setScrapedData(mmsi, 'sf', staticData);
    db.clearScrapeFailure(mmsi, 'sf');
    db.recordScrape('sf', true);
    // A fresh page also carries a live position — store it (cheap, and useful if
    // the ship is currently AIS-dark). insertScrapedPosition de-dupes by report time.
    if (position) db.insertScrapedPosition(mmsi, { ...position, name: position.name || ship.ship_name });
    appLog.info('SCRAPE', appLog.t('scrape.ok', { source: 'ShipFinder', name: ship.ship_name || mmsi }), { mmsi });
    res.json({ enabled: true, data: staticData, cached: false, cachedAt: scraped_at, positions: db.getScrapedPositions(mmsi, 'sf') });
  } catch (e) {
    db.setScrapeFailure(mmsi, 'sf', e.message);
    db.recordScrape('sf', false);
    appLog.warn('SCRAPE', appLog.t('scrape.failed', { source: 'ShipFinder', name: ship.ship_name || mmsi, error: e.message }), { mmsi });
    if (cached) {
      return res.json({ enabled: true, data: JSON.parse(cached.data_json), cached: true, cachedAt: cached.scraped_at, error: e.message, positions });
    }
    res.json({ enabled: true, error: e.message, positions });
  }
});

// Manual "Locate via ShipFinder": force a live position scrape now, store it, and
// return the fix so the UI can drop a marker. Works for any visible ship.
router.post('/ships/:mmsi/sflocate', async (req, res) => {
  if (!state.importSfData) return res.json({ enabled: false });
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  const ship = db.getShip(mmsi);
  if (!ship) return res.status(404).json({ error: 'Ship not found' });
  try {
    appLog.info('SCRAPE', `Localizzazione ShipFinder richiesta: ${ship.ship_name || mmsi}`, { mmsi });
    const { static: staticData, position } = await crawlShipfinder(mmsi);
    if (staticData && Object.keys(staticData).length) db.setScrapedData(mmsi, 'sf', staticData);
    db.clearScrapeFailure(mmsi, 'sf');
    db.recordScrape('sf', true);
    if (!position) return res.json({ enabled: true, position: null });
    const stored = db.insertScrapedPosition(mmsi, { ...position, name: position.name || ship.ship_name });
    invalidateRiskCache(mmsi);
    res.json({ enabled: true, position: stored || { mmsi, ...position, received_at: position.reportedAt }, positions: db.getScrapedPositions(mmsi, 'sf') });
  } catch (e) {
    db.setScrapeFailure(mmsi, 'sf', e.message);
    db.recordScrape('sf', false);
    appLog.warn('SCRAPE', appLog.t('scrape.failed', { source: 'ShipFinder', name: ship.ship_name || mmsi, error: e.message }), { mmsi });
    res.json({ enabled: true, error: e.message });
  }
});

// MyShipTracking static data + last-known scraped positions. Mirror of /sfdata for
// the second position-backup source: serves cached static + stored 'mst' positions,
// scraping fresh static (and any carried position) only when the cache is cold.
router.get('/ships/:mmsi/mstdata', async (req, res) => {
  if (!state.importMstData) return res.json({ enabled: false });
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  const ship = db.getShip(mmsi);
  if (!ship) return res.status(404).json({ error: 'Ship not found' });
  const positions = db.getScrapedPositions(mmsi, 'mst');
  const cached = db.getScrapedData(mmsi, 'mst');
  if (cached && Date.now() - new Date(cached.scraped_at).getTime() < SCRAPE_CACHE_TTL) {
    return res.json({ enabled: true, data: JSON.parse(cached.data_json), cached: true, cachedAt: cached.scraped_at, positions });
  }
  try {
    appLog.info('SCRAPE', appLog.t('scrape.requested', { source: 'MyShipTracking', name: ship.ship_name || mmsi }), { mmsi });
    const { static: staticData, position } = await crawlMyshiptracking(mmsi);
    const scraped_at = db.setScrapedData(mmsi, 'mst', staticData);
    db.clearScrapeFailure(mmsi, 'mst');
    db.recordScrape('mst', true);
    if (position) db.insertScrapedPosition(mmsi, { ...position, name: position.name || ship.ship_name }, 'mst');
    appLog.info('SCRAPE', appLog.t('scrape.ok', { source: 'MyShipTracking', name: ship.ship_name || mmsi }), { mmsi });
    res.json({ enabled: true, data: staticData, cached: false, cachedAt: scraped_at, positions: db.getScrapedPositions(mmsi, 'mst') });
  } catch (e) {
    db.setScrapeFailure(mmsi, 'mst', e.message);
    db.recordScrape('mst', false);
    appLog.warn('SCRAPE', appLog.t('scrape.failed', { source: 'MyShipTracking', name: ship.ship_name || mmsi, error: e.message }), { mmsi });
    if (cached) {
      return res.json({ enabled: true, data: JSON.parse(cached.data_json), cached: true, cachedAt: cached.scraped_at, error: e.message, positions });
    }
    res.json({ enabled: true, error: e.message, positions });
  }
});

// Manual "Locate via MyShipTracking": force a live position scrape now, store it,
// and return the fix so the UI can drop a marker. Mirror of /sflocate.
router.post('/ships/:mmsi/mstlocate', async (req, res) => {
  if (!state.importMstData) return res.json({ enabled: false });
  const mmsi = Number(req.params.mmsi);
  if (!canSeeShip(req, mmsi)) return res.status(404).json({ error: 'Not found' });
  const ship = db.getShip(mmsi);
  if (!ship) return res.status(404).json({ error: 'Ship not found' });
  try {
    appLog.info('SCRAPE', `Localizzazione MyShipTracking richiesta: ${ship.ship_name || mmsi}`, { mmsi });
    const { static: staticData, position } = await crawlMyshiptracking(mmsi);
    if (staticData && Object.keys(staticData).length) db.setScrapedData(mmsi, 'mst', staticData);
    db.clearScrapeFailure(mmsi, 'mst');
    db.recordScrape('mst', true);
    if (!position) return res.json({ enabled: true, position: null });
    const stored = db.insertScrapedPosition(mmsi, { ...position, name: position.name || ship.ship_name }, 'mst');
    invalidateRiskCache(mmsi);
    res.json({ enabled: true, position: stored || { mmsi, ...position, received_at: position.reportedAt }, positions: db.getScrapedPositions(mmsi, 'mst') });
  } catch (e) {
    db.setScrapeFailure(mmsi, 'mst', e.message);
    db.recordScrape('mst', false);
    appLog.warn('SCRAPE', appLog.t('scrape.failed', { source: 'MyShipTracking', name: ship.ship_name || mmsi, error: e.message }), { mmsi });
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
