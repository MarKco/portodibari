'use strict';

// Fallback scraping mode: per-area and silent. Each monitored area is
// independently "in fallback" whenever it hasn't received a real AIS message
// in more than AREA_SILENT_THRESHOLD_MIN minutes (or never has) AND its admin
// hasn't disabled it (areas.fallback_enabled, default on) — computed fresh on
// every check from `areas.last_ais_message_at` (stamped by ais-stream.js on
// every real message), never a persisted state machine. This is intentionally
// decoupled from the GLOBAL outage detector (ais-uptime.js): that one only
// notifies admins/users about a service-wide AISStream problem now, it no
// longer switches any scraping on or off. An area can be silently in fallback
// (poor/no AISStream coverage for that specific spot) with zero global outage,
// and vice versa.
//
// While an area is silent, this module:
//   1. Repositions ships already tied to that area (`last_area`) via SF/MST
//      scraping by MMSI (candidatePool/scrapeOne) — same mechanism used for
//      followed ships, which are scraped unconditionally regardless of any
//      area's state (a followed ship isn't tied to one area).
//   2. Discovers ships AIS never reported at all, via the area's resolved
//      port(s) on MyShipTracking (sweepPortDiscovery/crawlPortArrivals) —
//      port-arrivals lookups require no prior MMSI, unlike every other source
//      this app uses. Discovered ships are stubbed + tagged with `last_area`
//      and left for the NEXT sweep's normal reposition pass to get an actual
//      fix — no double budget accounting, no separate scrape path.
//
// Anti-ban precautions (shared across BOTH of the above, and across every
// area at once — one pool of ships, one budget, not one per area): a global
// hourly request budget, oldest-first priority, per-ship source rotation,
// jittered pacing, and a per-source circuit breaker that pauses a source for a
// cooldown once its 403/429s cluster (a likely-blocked signal, not one flaky
// request).
//
// No schema changes needed beyond areas.fallback_enabled/last_ais_message_at
// (see db.js) — no more fallback_mode_active/fallback_mode_since meta keys;
// an older backup simply restores areas with fallback_enabled defaulting on
// and last_ais_message_at null, which correctly reads as "silent until proven
// otherwise", a safe default.

const db = require('../db');
const appLog = require('./app-log');
const { broadcastFallbackScrape } = require('../realtime');
const { invalidateRiskCache } = require('./risk-score');
const { crawlShipfinder } = require('./scrapers/shipfinder');
const { crawlMyshiptracking, crawlPortArrivals } = require('./scrapers/myshiptracking');
const { classifyFailure } = require('./scrapers/http');
const {
  FOLLOW_FRESH_MS,
  SCRAPE_NEG_CACHE_DAYS,
  AREA_SILENT_THRESHOLD_MIN,
  FALLBACK_MAX_REQ_PER_HOUR,
  FALLBACK_CIRCUIT_TRIP_COUNT,
  FALLBACK_CIRCUIT_TRIP_WINDOW_MIN,
  FALLBACK_CIRCUIT_COOLDOWN_MIN,
} = require('../config');

const SOURCES = ['sf', 'mst'];
const SOURCE_LABEL = { sf: 'ShipFinder', mst: 'MyShipTracking' };

// Per-source circuit breaker: distinct-ship (or distinct-port, for discovery
// failures with no ship yet) 403/429 timestamps within the trip window, and
// the open/until state derived from them.
const failureLog = { sf: [], mst: [] }; // [{ mmsi, at }], pruned to the trip window
const circuit = { sf: { open: false, until: 0 }, mst: { open: false, until: 0 } };

// Oldest-scraped-first priority + per-ship source rotation bookkeeping. In-memory
// only — losing it on restart just means the next sweep re-derives priority from
// scratch (no ship is skipped forever).
const lastScrapeAt = new Map(); // mmsi -> epoch ms of last fallback-mode scrape
let cycleCount = 0;
let requestTimestamps = []; // epoch ms of requests made in the trailing hour

// Suspected-block count per source for the current process lifetime, surfaced
// to the admin diagnostics panel as an at-a-glance "problems so far". In-memory
// only, like the circuit breaker itself — a restart just restarts the count,
// never wrongly inflates or persists a stale one. There's no more enter() to
// reset it on, since there's no more single global activation event.
const tripCounters = { sf: 0, mst: 0 };

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
    tripCounters[source]++;
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
  require('./telegram').broadcastAdminAlert('suspected_ban', phase, { source: label }); // lazy: avoids a load-time cycle
}

// A followed ship is "stale" once we haven't heard it for FOLLOW_FRESH_MS.
function isStale(sh, now) {
  return !sh.last_seen_at || now - new Date(sh.last_seen_at).getTime() > FOLLOW_FRESH_MS;
}

// ISO cutoff shared by every "is this area silent" check this sweep makes —
// computed once per sweep, not once per area, so all of them agree on exactly
// the same instant.
function areaSilentCutoffIso() {
  return new Date(Date.now() - AREA_SILENT_THRESHOLD_MIN * 60 * 1000).toISOString();
}

// Area-scope candidates are tagged so scrapeOne() knows to also refresh their
// `ships` master row (see insertScrapedPosition) — followed ships deliberately
// keep the no-touch behavior (worldwide re-acquire box, 6-month auto-stop stay
// keyed to true AIS freshness), but area ships have no such logic to protect,
// and without this they silently age out of ACTIVE_PREDICATE (main map/list)
// even while fresh sf/mst fixes keep arriving.
//
// Followed ships are ALWAYS included, unconditionally — they're not tied to a
// single area's silence state (a followed ship can be anywhere), so this is
// the only place that repositions them (ship-follow.js no longer scrapes; see
// its own comments) and it always has, needing no "is some area silent" gate.
function candidatePool(cutoffIso) {
  const now = Date.now();
  const followed = db.getAllFollowedShips().filter((sh) => isStale(sh, now));
  const areaShips = db.getStaleAreaShips(FOLLOW_FRESH_MS, cutoffIso).map((sh) => ({ ...sh, _areaScope: true }));
  return followed.concat(areaShips);
}

// Rolling in-memory buffer of recent scrape attempts (this module's own, not
// the DB-backed `scrape_log`), for the live "Log modalità fallback" sidebar
// window to backfill on open before live SSE events start arriving. Capped,
// in-memory only — same tradeoff as the circuit breaker above, a restart just
// starts the buffer empty again.
const MAX_SCRAPE_EVENTS = 200;
const recentScrapeEvents = [];

function logScrapeEvent(source, mmsi, ok) {
  const entry = { ts: new Date().toISOString(), source, mmsi, ok };
  recentScrapeEvents.push(entry);
  if (recentScrapeEvents.length > MAX_SCRAPE_EVENTS) recentScrapeEvents.shift();
  broadcastFallbackScrape(entry);
}

async function scrapeOne(source, sh) {
  if (db.hasRecentScrapeFailure(sh.mmsi, source, SCRAPE_NEG_CACHE_DAYS)) return;
  try {
    const { static: staticData, position } =
      source === 'sf' ? await crawlShipfinder(sh.mmsi) : await crawlMyshiptracking(sh.mmsi);
    db.recordScrape(source, true);
    logScrapeEvent(source, sh.mmsi, true);
    if (staticData && Object.keys(staticData).length) db.setScrapedData(sh.mmsi, source, staticData);
    if (position) {
      const stored = db.insertScrapedPosition(
        sh.mmsi,
        { ...position, name: position.name || sh.ship_name },
        source,
        { updateShipRow: !!sh._areaScope }
      );
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
    logScrapeEvent(source, sh.mmsi, false);
    db.setScrapeFailure(sh.mmsi, source, e.message);
    recordFailure(source, sh.mmsi, e);
  }
}

const jitterMs = () => 1500 + Math.random() * 3000;

// Port-arrivals discovery cadence: independent of the main sweep interval
// (server.js fires sweep() every few minutes) — a port's arrival list doesn't
// change that fast, and re-polling it every sweep tick would burn budget for
// no new information. In-memory only, keyed per area+port — a restart just
// makes every port "due" again, harmless (same tradeoff as lastScrapeAt above
// and the circuit breaker: never a per-tick DB write, which is exactly the
// kind of unthrottled write that once starved this app's event loop and
// caused cascading AIS WebSocket disconnects when berth recompute did it on
// every arrival — not repeating that here).
const lastPortPollAt = new Map(); // `${areaKey}:${port_id}` -> epoch ms
const PORT_ARRIVALS_POLL_MS = 30 * 60 * 1000;

// Discover ships AIS never reported, via arrivals/departures at whatever
// port(s) a silent area has resolved on MyShipTracking. Shares the caller's
// budget (maxUnits, itself part of the one global FALLBACK_MAX_REQ_PER_HOUR
// pool) — one crawlPortArrivals call is one unit, same as any per-ship scrape.
// Returns how many units it actually spent, so sweep() can subtract them from
// the budget before running the normal reposition pass.
async function sweepPortDiscovery(cutoffIso, maxUnits) {
  if (maxUnits <= 0 || isCircuitOpen('mst')) return 0;
  const now = Date.now();
  const due = db
    .getPortDiscoveryTargets(cutoffIso)
    .filter((p) => now - (lastPortPollAt.get(`${p.area_key}:${p.port_id}`) || 0) >= PORT_ARRIVALS_POLL_MS);
  if (!due.length) return 0;

  let used = 0;
  for (const port of due) {
    if (used >= maxUnits) break;
    lastPortPollAt.set(`${port.area_key}:${port.port_id}`, Date.now());
    used++;
    requestTimestamps.push(Date.now());
    try {
      const rows = await crawlPortArrivals(port.mst_pid);
      db.recordScrape('mst', true);
      for (const { mmsi, name } of rows) {
        db.ensureShipStub(mmsi, name);
        db.setShipLastArea(mmsi, port.area_key);
      }
      // Awaited (not fire-and-forget) so this sweep's own pacing stays
      // predictable — enrichment's own fan-out has its own internal pacing.
      const enrichment = require('./enrichment'); // lazy: avoids a load-time cycle
      for (const { mmsi } of rows) await enrichment.enrichNewShip(mmsi);
      if (rows.length) {
        appLog.info('SCRAPE', `Scoperta arrivi/partenze porto ${port.name}: ${rows.length} navi`, { area: port.area_key });
      }
    } catch (e) {
      db.recordScrape('mst', false);
      // No ship yet to key the circuit breaker on — a synthetic per-port id
      // still counts toward "distinct failing things", just never inflates
      // past 1 per broken port (a single stale/renamed port shouldn't alone
      // look like a site-wide block).
      recordFailure('mst', `port:${port.port_id}`, e);
    }
    await new Promise((r) => setTimeout(r, jitterMs()));
  }
  return used;
}

// Periodic sweep — always runs (no more global on/off flag to gate it), but is
// a fast no-op whenever no area is silent and no followed ship is stale. Not
// on the same timer as ais-uptime.js's 60s outage check; wired to its own
// interval in server.js.
async function sweep() {
  checkCircuitRecovery();

  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((t) => now - t < 3600 * 1000);
  let budgetLeft = FALLBACK_MAX_REQ_PER_HOUR - requestTimestamps.length;
  if (budgetLeft <= 0) return;

  const cutoffIso = areaSilentCutoffIso();

  budgetLeft -= await sweepPortDiscovery(cutoffIso, budgetLeft);
  if (budgetLeft <= 0) return;

  const __poolT0 = Date.now();
  const candidates = candidatePool(cutoffIso);
  const __poolMs = Date.now() - __poolT0;
  if (__poolMs > 200) appLog.warn('PERF', `fallbackMode.candidatePool lento: ${__poolMs}ms (${candidates.length} navi)`);
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

// Estimate for the admin diagnostics panel: current real candidate counts
// (followed + area-scope, given each area's live silence state right now)
// plus recent real volume. No more "what if I switched scope" comparison —
// there's no single global scope to switch anymore, just per-area toggles.
function getEstimate() {
  const now = Date.now();
  const cutoffIso = areaSilentCutoffIso();
  const followedStale = db.getAllFollowedShips().filter((sh) => isStale(sh, now)).length;
  const areaStale = db.getStaleAreaShips(FOLLOW_FRESH_MS, cutoffIso).length;
  const total = followedStale + areaStale;
  const budget = FALLBACK_MAX_REQ_PER_HOUR;
  const requestsPerHour = Math.min(total, budget);
  return {
    followedStaleCount: followedStale,
    areaStaleCount: areaStale,
    budgetPerHour: budget,
    requestsPerHour,
    avgRevisitHours: total && requestsPerHour ? Math.round((total / requestsPerHour) * 10) / 10 : 0,
    recentHistory: db.getScrapeCountsHourly(48),
  };
}

// Per-area live status for the admin diagnostics panel and the "Aree" screen.
function getAreaStatuses() {
  const cutoffIso = areaSilentCutoffIso();
  return db.getAllAreas().map((a) => {
    const silent = !!a.fallback_enabled && (!a.last_ais_message_at || a.last_ais_message_at < cutoffIso);
    return {
      key: a.key,
      name: a.name,
      fallbackEnabled: !!a.fallback_enabled,
      silent,
      silentSince: silent ? a.last_ais_message_at : null,
    };
  });
}

// Rough project-wide caution flag for callers that don't need per-area
// precision (port-discovery.js: defer its own VF/MST scraping cascade while
// ANY area is silent, since it'd compete for the same anti-ban budget/circuit
// breaker as this module's own scraping — not worth resolving to a specific
// area for a rare, one-off backfill/admin action).
function isAnyAreaSilent() {
  return getAreaStatuses().some((a) => a.silent);
}

function getStatus() {
  const areas = getAreaStatuses();
  const silentAreas = areas.filter((a) => a.silent);
  // `active`/`since` are a derived aggregate (any area silent? earliest one)
  // kept for the general outage banner (public/js/outage.js), which is
  // per-service, not per-area, and shown to every user — it doesn't need to
  // know WHICH area, just "fallback scraping is happening somewhere". The
  // `areas` breakdown itself is admin-only detail (see routes/stream.js,
  // which strips it for non-admins before responding).
  const since = silentAreas.map((a) => a.silentSince).filter(Boolean).sort()[0] || null;
  return {
    active: silentAreas.length > 0,
    since,
    areas,
    circuits: {
      sf: { open: circuit.sf.open, until: circuit.sf.open ? new Date(circuit.sf.until).toISOString() : null },
      mst: { open: circuit.mst.open, until: circuit.mst.open ? new Date(circuit.mst.until).toISOString() : null },
    },
    tripCounts: { sf: tripCounters.sf, mst: tripCounters.mst },
  };
}

function getRecentScrapeEvents() {
  return recentScrapeEvents.slice();
}

module.exports = { sweep, getEstimate, getStatus, getRecentScrapeEvents, isAnyAreaSilent, getAreaStatuses };
