'use strict';

// Fallback scraping mode: when AISStream has been down long enough (see
// ais-uptime.js, which owns the entry/exit trigger + hysteresis), this module
// takes over re-locating ships via ShipFinder/MyShipTracking scraping instead of
// ship-follow.js's own always-on reacquire sweep — with the anti-ban precautions
// a much heavier scrape volume needs: a global hourly request budget (shared by
// both sources, so widening scope redistributes it over more ships rather than
// multiplying total volume), oldest-first priority, per-ship source rotation,
// jittered pacing, and a per-source circuit breaker that pauses a source for a
// cooldown once its 403/429s cluster (a likely-blocked signal, not one flaky
// request). VF/MT enrichment is paused entirely while active (see enrichment.js)
// — they carry no coordinates and only add risk.
//
// Scope (followed ships only, vs. also ships in monitored areas) is always reset
// to the safe "followed only" default on entry; an admin can widen it at any time
// from the "Modalità fallback" panel (see routes/settings.js), never as a fixed
// startup choice — see enter() below.
//
// State: `fallback_mode_active`/`fallback_mode_since` live in the `meta` table
// (in BACKUP_TABLES) so a restart mid-outage doesn't forget; the per-source
// circuit breaker is in-memory only (a restart clearing it is an acceptable, much
// simpler tradeoff than persisting/expiring it correctly). No schema changes at
// all — an older backup restored here just has no fallback_mode_* meta rows,
// which db.getMeta already treats as "off" by default.

const db = require('../db');
const appLog = require('./app-log');
const telegram = require('./telegram');
const { invalidateRiskCache } = require('./risk-score');
const { crawlShipfinder } = require('./scrapers/shipfinder');
const { crawlMyshiptracking } = require('./scrapers/myshiptracking');
const { classifyFailure } = require('./scrapers/http');
const {
  FOLLOW_FRESH_MS,
  SCRAPE_NEG_CACHE_DAYS,
  FALLBACK_MAX_REQ_PER_HOUR,
  FALLBACK_CIRCUIT_TRIP_COUNT,
  FALLBACK_CIRCUIT_TRIP_WINDOW_MIN,
  FALLBACK_CIRCUIT_COOLDOWN_MIN,
  state,
  setFallbackScopeAreas,
} = require('../config');

const META_ACTIVE = 'fallback_mode_active';
const META_SINCE = 'fallback_mode_since';

const SOURCES = ['sf', 'mst'];
const SOURCE_LABEL = { sf: 'ShipFinder', mst: 'MyShipTracking' };

// Per-source circuit breaker: distinct-ship 403/429 timestamps within the trip
// window, and the open/until state derived from them.
const failureLog = { sf: [], mst: [] }; // [{ mmsi, at }], pruned to the trip window
const circuit = { sf: { open: false, until: 0 }, mst: { open: false, until: 0 } };

// Oldest-scraped-first priority + per-ship source rotation bookkeeping. In-memory
// only — losing it on restart just means the next sweep re-derives priority from
// scratch (no ship is skipped forever).
const lastScrapeAt = new Map(); // mmsi -> epoch ms of last fallback-mode scrape
let cycleCount = 0;
let requestTimestamps = []; // epoch ms of requests made in the trailing hour

function isActive() {
  return db.getMeta(META_ACTIVE) === '1';
}

function enter() {
  if (isActive()) return;
  db.setMeta(META_ACTIVE, '1');
  db.setMeta(META_SINCE, new Date().toISOString());
  // Always the safe default, regardless of what an admin left it at last time.
  setFallbackScopeAreas(false);
  appLog.warn('AIS', 'Modalità fallback attivata: scraping ShipFinder/MyShipTracking per riposizionare le navi seguite.');
}

function exit() {
  if (!isActive()) return;
  db.setMeta(META_ACTIVE, '0');
  db.setMeta(META_SINCE, null);
  appLog.info('AIS', 'Modalità fallback disattivata: AIS tornato stabile.');
}

function isCircuitOpen(source) {
  return circuit[source].open;
}

// Called at the top of every sweep so an expired cooldown is noticed even if no
// new failure would otherwise trigger a check.
function checkCircuitRecovery() {
  const now = Date.now();
  for (const source of SOURCES) {
    const c = circuit[source];
    if (c.open && now >= c.until) {
      c.open = false;
      c.until = 0;
      failureLog[source] = [];
      onCircuitTransition(source, 'end');
    }
  }
}

function recordFailure(source, mmsi, err) {
  const classified = classifyFailure(err);
  if (!classified.isBlocked && !classified.isRateLimited) return;
  const now = Date.now();
  const windowMs = FALLBACK_CIRCUIT_TRIP_WINDOW_MIN * 60 * 1000;
  const log = failureLog[source];
  log.push({ mmsi, at: now });
  while (log.length && now - log[0].at > windowMs) log.shift();
  const distinctShips = new Set(log.map((e) => e.mmsi)).size;
  if (distinctShips >= FALLBACK_CIRCUIT_TRIP_COUNT && !circuit[source].open) {
    circuit[source].open = true;
    circuit[source].until = now + FALLBACK_CIRCUIT_COOLDOWN_MIN * 60 * 1000;
    onCircuitTransition(source, 'start');
  }
}

function onCircuitTransition(source, phase) {
  const label = SOURCE_LABEL[source];
  if (phase === 'start') {
    appLog.warn('SCRAPE', `Sospetto blocco su ${label}: sorgente sospesa per ${FALLBACK_CIRCUIT_COOLDOWN_MIN} min.`);
  } else {
    appLog.info('SCRAPE', `${label}: cooldown terminato, scraping ripreso.`);
  }
  const type = phase === 'start' ? 'suspected_ban' : 'suspected_ban_cleared';
  for (const uid of db.getAdminUserIds()) {
    try {
      db.addNotification({ user_id: uid, type, band: source });
    } catch { /* best-effort */ }
  }
  telegram.broadcastAdminAlert('suspected_ban', phase, { source: label });
}

// A followed ship is "stale" once we haven't heard it for FOLLOW_FRESH_MS — same
// definition ship-follow.js's isStaleFollow uses, duplicated here to avoid a
// circular require (ship-follow.js itself defers to this module while active).
function isStale(sh, now) {
  return !sh.last_seen_at || now - new Date(sh.last_seen_at).getTime() > FOLLOW_FRESH_MS;
}

function candidatePool() {
  const now = Date.now();
  const followed = db.getAllFollowedShips().filter((sh) => isStale(sh, now));
  if (!state.fallbackScopeAreas) return followed;
  return followed.concat(db.getStaleAreaShips(FOLLOW_FRESH_MS));
}

async function scrapeOne(source, sh) {
  if (db.hasRecentScrapeFailure(sh.mmsi, source, SCRAPE_NEG_CACHE_DAYS)) return;
  try {
    const { static: staticData, position } =
      source === 'sf' ? await crawlShipfinder(sh.mmsi) : await crawlMyshiptracking(sh.mmsi);
    db.recordScrape(source, true);
    if (staticData && Object.keys(staticData).length) db.setScrapedData(sh.mmsi, source, staticData);
    if (position) {
      const stored = db.insertScrapedPosition(sh.mmsi, { ...position, name: position.name || sh.ship_name }, source);
      db.clearScrapeFailure(sh.mmsi, source);
      if (stored) {
        invalidateRiskCache(sh.mmsi);
        appLog.info('SCRAPE', `Fallback: posizione ${SOURCE_LABEL[source]} per ${sh.ship_name || sh.mmsi}`, { mmsi: sh.mmsi });
      }
    } else {
      db.setScrapeFailure(sh.mmsi, source, `${SOURCE_LABEL[source]}: nessuna posizione`);
    }
  } catch (e) {
    db.recordScrape(source, false);
    db.setScrapeFailure(sh.mmsi, source, e.message);
    recordFailure(source, sh.mmsi, e);
  }
}

const jitterMs = () => 1500 + Math.random() * 3000;

// Periodic fallback sweep — a no-op unless fallback mode is active. Not on the
// same timer as ais-uptime.js's 60s outage check; wired to its own interval in
// server.js.
async function sweep() {
  if (!isActive()) return;
  checkCircuitRecovery();

  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((t) => now - t < 3600 * 1000);
  let budgetLeft = FALLBACK_MAX_REQ_PER_HOUR - requestTimestamps.length;
  if (budgetLeft <= 0) return;

  const candidates = candidatePool();
  if (!candidates.length) return;
  candidates.sort((a, b) => (lastScrapeAt.get(a.mmsi) || 0) - (lastScrapeAt.get(b.mmsi) || 0));

  cycleCount++;
  for (const sh of candidates) {
    if (budgetLeft <= 0) break;
    const preferred = (cycleCount + sh.mmsi) % 2 === 0 ? 'sf' : 'mst';
    const alternate = preferred === 'sf' ? 'mst' : 'sf';
    const source = !isCircuitOpen(preferred) ? preferred : (!isCircuitOpen(alternate) ? alternate : null);
    if (!source) continue; // both sources currently tripped — skip this ship this sweep

    await scrapeOne(source, sh);
    lastScrapeAt.set(sh.mmsi, Date.now());
    requestTimestamps.push(Date.now());
    budgetLeft--;
    await new Promise((r) => setTimeout(r, jitterMs()));
  }
}

// Estimate for the admin "Modalità fallback" panel: candidate counts for each
// scope option (independent of which one is currently active) plus recent real
// volume, so an admin can compare "what we'd scrape" against "what we scrape
// today" before choosing.
function getEstimate() {
  const now = Date.now();
  const followedStale = db.getAllFollowedShips().filter((sh) => isStale(sh, now)).length;
  const areaStale = db.getStaleAreaShips(FOLLOW_FRESH_MS).length;
  const budget = FALLBACK_MAX_REQ_PER_HOUR;
  const followOnlyPerHour = Math.min(followedStale, budget);
  const fullPerHour = Math.min(followedStale + areaStale, budget);
  return {
    followedStaleCount: followedStale,
    areaStaleCount: areaStale,
    budgetPerHour: budget,
    followOnly: {
      requestsPerHour: followOnlyPerHour,
      avgRevisitHours: followedStale && followOnlyPerHour ? Math.round((followedStale / followOnlyPerHour) * 10) / 10 : 0,
    },
    full: {
      requestsPerHour: fullPerHour,
      avgRevisitHours:
        followedStale + areaStale && fullPerHour ? Math.round(((followedStale + areaStale) / fullPerHour) * 10) / 10 : 0,
    },
    recentHistory: db.getScrapeCountsHourly(48),
  };
}

function getStatus() {
  const active = isActive();
  return {
    active,
    since: active ? db.getMeta(META_SINCE) : null,
    scope: state.fallbackScopeAreas ? 'areas' : 'follow',
    circuits: {
      sf: { open: circuit.sf.open, until: circuit.sf.open ? new Date(circuit.sf.until).toISOString() : null },
      mst: { open: circuit.mst.open, until: circuit.mst.open ? new Date(circuit.mst.until).toISOString() : null },
    },
  };
}

module.exports = { isActive, enter, exit, sweep, getEstimate, getStatus };
