'use strict';

// Proactive ship enrichment from external sources (VesselFinder / MarineTraffic).
// When a brand-new ship is detected on the AIS stream, the enabled sources are
// scraped *once* in the background so the risk score can use their data (flag,
// year built, home port) without waiting for someone to open the detail view.
// Fire-and-forget: failures are logged and never block ingestion.

const db = require('./../db');
const appLog = require('./app-log');
const { state, SCRAPE_NEG_CACHE_DAYS } = require('../config');
const { invalidateRiskCache } = require('./risk-score');
const { crawlVesselFinder } = require('./scrapers/vesselfinder');
const { crawlMarineTraffic } = require('./scrapers/marinetraffic');

// Guards against duplicate concurrent fetches for the same ship+source.
const inFlight = new Set();

// Skip a ship+source that is already cached OR that failed recently (negative
// cache) — so the backfill doesn't re-hammer VF/MT for vessels they don't know.
function alreadyResolved(mmsi, source) {
  return !!db.getScrapedData(mmsi, source) || db.hasRecentScrapeFailure(mmsi, source, SCRAPE_NEG_CACHE_DAYS);
}

async function fetchSource(ship, source) {
  const key = `${ship.mmsi}:${source}`;
  if (inFlight.has(key)) return;
  if (alreadyResolved(ship.mmsi, source)) return;
  inFlight.add(key);
  try {
    if (source === 'vf') {
      const data = await crawlVesselFinder(ship.imo_number || ship.mmsi);
      db.setScrapedData(ship.mmsi, 'vf', data);
    } else {
      const { data, shipId } = await crawlMarineTraffic(ship);
      if (shipId && shipId !== ship.mt_ship_id) db.setMtShipId(ship.mmsi, shipId);
      db.setScrapedData(ship.mmsi, 'mt', data);
    }
    db.clearScrapeFailure(ship.mmsi, source); // success → drop any stale failure marker
    invalidateRiskCache(ship.mmsi); // newly cached flag/year/home-port may shift the score
    appLog.info('SCRAPE', `${source.toUpperCase()} ok per ${ship.ship_name || ship.mmsi}`, { mmsi: ship.mmsi, imo: ship.imo_number || null });
  } catch (e) {
    // Record the failure so the negative cache skips this ship until it expires.
    db.setScrapeFailure(ship.mmsi, source, e.message);
    console.error(`[ENRICH:${source}] ${ship.mmsi}: ${e.message}`);
    appLog.warn('SCRAPE', `${source.toUpperCase()} fallito per ${ship.mmsi}: ${e.message}`, { mmsi: ship.mmsi });
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Trigger background enrichment for a newly-detected ship. Queries only the
 * sources the user enabled, and only when nothing is cached yet. Returns
 * immediately (fire-and-forget) — the AIS ingestion loop is never blocked.
 */
function enrichNewShip(mmsi) {
  if (!state.importVfData && !state.importMtData) return;
  const ship = db.getShip(mmsi);
  if (!ship) return;
  if (state.importVfData) fetchSource(ship, 'vf');
  if (state.importMtData) fetchSource(ship, 'mt');
}

/**
 * Backfill enrichment for all ships seen in the last 7 days that have no
 * cached data for the given source. Called when the user enables VF or MT
 * after monitoring has already started. Staggered 2 s between fetches to
 * avoid hammering the scraper endpoints. Fire-and-forget.
 */
async function enrichAllExisting(source) {
  const ships = db.getRecentShips();
  console.log(`[ENRICH:${source}] Backfill started — ${ships.length} ships to check`);
  appLog.info('SCRAPE', `Backfill ${source.toUpperCase()} avviato`, { navi: ships.length });
  let queued = 0;
  for (const ship of ships) {
    if (alreadyResolved(ship.mmsi, source)) continue; // cached or recently failed
    queued++;
    // stagger requests: 2 s gap between each to avoid hammering scrapers
    await new Promise((r) => setTimeout(r, 2000));
    fetchSource(ship, source); // fire-and-forget per ship
  }
  console.log(`[ENRICH:${source}] Backfill queued ${queued} fetches`);
}

module.exports = { enrichNewShip, enrichAllExisting };
