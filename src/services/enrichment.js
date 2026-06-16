'use strict';

// Proactive ship enrichment from external sources (VesselFinder / MarineTraffic).
// When a brand-new ship is detected on the AIS stream, the enabled sources are
// scraped *once* in the background so the risk score can use their data (flag,
// year built, home port) without waiting for someone to open the detail view.
// Fire-and-forget: failures are logged and never block ingestion.

const db = require('./../db');
const { state } = require('../config');
const { invalidateRiskCache } = require('./risk-score');
const { crawlVesselFinder } = require('./scrapers/vesselfinder');
const { crawlMarineTraffic } = require('./scrapers/marinetraffic');

// Guards against duplicate concurrent fetches for the same ship+source.
const inFlight = new Set();

async function fetchSource(ship, source) {
  const key = `${ship.mmsi}:${source}`;
  if (inFlight.has(key)) return;
  // "Only once": skip if we already have cached data for this source.
  if (db.getScrapedData(ship.mmsi, source)) return;
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
    invalidateRiskCache(ship.mmsi); // newly cached flag/year/home-port may shift the score
  } catch (e) {
    console.error(`[ENRICH:${source}] ${ship.mmsi}: ${e.message}`);
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
  let queued = 0;
  for (const ship of ships) {
    if (db.getScrapedData(ship.mmsi, source)) continue; // already cached
    queued++;
    // stagger requests: 2 s gap between each to avoid hammering scrapers
    await new Promise((r) => setTimeout(r, 2000));
    fetchSource(ship, source); // fire-and-forget per ship
  }
  console.log(`[ENRICH:${source}] Backfill queued ${queued} fetches`);
}

module.exports = { enrichNewShip, enrichAllExisting };
