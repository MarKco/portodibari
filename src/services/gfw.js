'use strict';

// ── Global Fishing Watch (GFW) API client ─────────────────────────────────────
// GFW publishes AIS-derived vessel identity and *behavioural events* (encounters,
// loitering, port visits, AIS-off "gaps") for fishing, carrier and support
// vessels. Unlike VesselFinder/MarineTraffic (HTML scrapers), this is a proper
// JSON API, so it's a client — not a scraper — but it slots into the same
// enrichment/cache machinery (source code 'gfw' in ship_scrape_cache).
//
// Why it matters for the risk score: the local risk-score heuristics infer
// "loitering" / "dark activity" from raw position readings, which is noisy. GFW
// publishes the *same* signals already classified from the global AIS feed:
//   • encounter   → two vessels meeting at sea (ship-to-ship transfer signature)
//   • gap         → AIS deliberately switched off while underway ("going dark")
//   • loitering   → prolonged stop in open water
//   • port_visit  → confirmed port calls (matched against high-risk ports)
// These are authoritative confirmations of the behavioural factors, so they feed
// the score directly (see risk-score.js).
//
// Auth: a long-lived Bearer API token from the GFW API portal
// (https://globalfishingwatch.org/our-apis/) set as GLOBAL_FISHING_WATCH_TOKEN.
// This is NOT the website username/password. Free tier is non-commercial only.
//
// API: v3, gateway.api.globalfishingwatch.org. Flow:
//   1. GET /vessels/search?query=<IMO|MMSI> → resolve the GFW vesselId
//   2. GET /events?vessels[0]=<vesselId>&datasets[0]=<event dataset> per type
// Field names follow the documented v3 shapes but are read defensively (optional
// chaining + fallbacks) so a minor upstream rename degrades gracefully instead
// of throwing.

const https = require('https');
const { GFW_TOKEN } = require('../config');

const GATEWAY = 'https://gateway.api.globalfishingwatch.org/v3';
const VESSEL_DATASET = 'public-global-vessel-identity:latest';
const EVENT_DATASETS = {
  encounters: 'public-global-encounters-events:latest',
  loitering: 'public-global-loitering-events:latest',
  portVisits: 'public-global-port-visits-events:latest',
  gaps: 'public-global-gaps-events:latest',
};

// How far back to ask for events, and a cap per event type so a very active
// vessel can't return thousands of rows into the cache.
const EVENT_WINDOW_DAYS = 365;
const EVENT_PAGE_SIZE = 50;
const EVENT_MAX_TOTAL = 500;

// GFW reports the flag as an ISO-3166 alpha-3 code (e.g. "PAN"). The risk score
// matches embargo / flag-of-convenience registries by country *name*, so map the
// risk-relevant codes (plus a few common Mediterranean flags for display) onto
// the names risk-score.js expects. Unknown codes fall through unchanged.
const ISO3_TO_NAME = {
  RUS: 'Russia', PRK: 'North Korea', SYR: 'Syria', IRN: 'Iran', LBY: 'Libya',
  PAN: 'Panama', LBR: 'Liberia', MHL: 'Marshall Islands', COM: 'Comoros',
  TGO: 'Togo', TZA: 'Tanzania', COK: 'Cook Islands', SLE: 'Sierra Leone',
  MDA: 'Moldova', KHM: 'Cambodia', PLW: 'Palau', MNG: 'Mongolia', CIV: 'Ivory Coast',
  ITA: 'Italy', GRC: 'Greece', HRV: 'Croatia', MLT: 'Malta', TUR: 'Turkey',
  ALB: 'Albania', MNE: 'Montenegro', CYP: 'Cyprus', ESP: 'Spain', FRA: 'France',
};

const flagName = (iso3) => (iso3 ? ISO3_TO_NAME[iso3.toUpperCase()] || iso3 : null);

/** GET a GFW endpoint with the Bearer token, following redirects, parsing JSON.
 *  Rejects with a clear message on 401 (bad/expired token), 429 (rate limit) and
 *  other non-2xx statuses. */
function getJson(url, depth = 0) {
  if (depth > 4) return Promise.reject(new Error('Troppi redirect'));
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${GFW_TOKEN}`,
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
        },
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          getJson(new URL(res.headers.location, url).href, depth + 1).then(resolve).catch(reject);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new Error('Token GFW non valido o scaduto (HTTP ' + res.statusCode + ')'));
          }
          if (res.statusCode === 429) {
            return reject(new Error('Limite di richieste GFW superato (HTTP 429)'));
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`GFW HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Risposta GFW non in formato JSON'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout GFW'));
    });
    req.end();
  });
}

const qs = (params) =>
  Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

const isoDate = (d) => d.toISOString().slice(0, 10);

/** Resolve the GFW vesselId + identity for a ship, searching by IMO first
 *  (precise) then MMSI. Returns { vesselId, identity } or null when GFW has no
 *  record (common for merchant vessels — GFW tracks mainly fishing/carriers). */
async function searchVessel(ship) {
  const queries = [];
  if (ship.imo_number) queries.push(String(ship.imo_number));
  if (ship.mmsi) queries.push(String(ship.mmsi));
  for (const query of queries) {
    const url = `${GATEWAY}/vessels/search?${qs({
      query,
      'datasets[0]': VESSEL_DATASET,
      limit: 5,
    })}`;
    const res = await getJson(url);
    const entries = res?.entries || [];
    if (!entries.length) continue;
    // Each entry carries one or more selfReportedInfo records (per AIS identity).
    // Prefer the record whose MMSI matches; otherwise the first / most-reported.
    let best = null;
    for (const entry of entries) {
      const infos = entry?.selfReportedInfo || [];
      const match = infos.find((i) => String(i.ssvid) === String(ship.mmsi)) || infos[0];
      if (!match) continue;
      if (!best) best = match;
      if (String(match.ssvid) === String(ship.mmsi)) {
        best = match;
        break;
      }
    }
    if (!best) continue;
    const identity = {
      mmsi: best.ssvid || null,
      imo: best.imo || null,
      shipname: best.shipname || best.nShipname || null,
      flag: flagName(best.flag),
      flagIso3: best.flag || null,
      callsign: best.callsign || null,
      type: best.vesselType || best.geartypes?.[0] || best.geartype || null,
      year: best.yearBuilt || null,
      transmissionFrom: best.transmissionDateFrom || null,
      transmissionTo: best.transmissionDateTo || null,
    };
    return { vesselId: best.id, identity };
  }
  return null;
}

const hoursBetween = (start, end) =>
  start && end ? Math.max(0, (new Date(end) - new Date(start)) / 3.6e6) : null;

/** Fetch one event dataset for a vesselId over the window, following GFW's
 *  `nextOffset` until exhausted (capped at EVENT_MAX_TOTAL so a very active
 *  vessel can't return thousands of rows into the cache). GFW returns entries
 *  oldest-first with no `sort` param available, so stopping at the first page
 *  (the old behaviour) silently dropped every event *more recent* than the
 *  page boundary — exactly the events that matter for the risk score. Returns
 *  raw entries (may be empty). A per-type failure is swallowed (returns
 *  whatever was accumulated so far) so one missing dataset doesn't sink the
 *  whole enrichment. */
async function fetchEvents(vesselId, dataset, startDate, endDate) {
  const entries = [];
  let offset = 0;
  try {
    for (;;) {
      const url = `${GATEWAY}/events?${qs({
        'datasets[0]': dataset,
        'vessels[0]': vesselId,
        'start-date': startDate,
        'end-date': endDate,
        limit: EVENT_PAGE_SIZE,
        offset,
      })}`;
      const res = await getJson(url);
      const page = res?.entries || [];
      entries.push(...page);
      if (page.length < EVENT_PAGE_SIZE || entries.length >= EVENT_MAX_TOTAL) break;
      if (res?.nextOffset == null) break;
      offset = res.nextOffset;
    }
  } catch (e) {
    // A token/rate error must surface (it affects every call); a per-dataset 4xx
    // (e.g. dataset unavailable for this vessel) is non-fatal.
    if (/Token GFW|429/.test(e.message)) throw e;
  }
  return entries.slice(0, EVENT_MAX_TOTAL);
}

function normEncounter(e) {
  const enc = e.encounter || {};
  const other = enc.vessel || enc.encounteredVessel || {};
  return {
    start: e.start || null,
    end: e.end || null,
    durationH: hoursBetween(e.start, e.end),
    lat: e.position?.lat ?? null,
    lon: e.position?.lon ?? null,
    withName: other.name || other.shipname || null,
    withMmsi: other.ssvid || null,
    medianDistanceKm: enc.medianDistanceKilometers ?? null,
  };
}

function normLoitering(e) {
  return {
    start: e.start || null,
    end: e.end || null,
    durationH: hoursBetween(e.start, e.end),
    lat: e.position?.lat ?? null,
    lon: e.position?.lon ?? null,
  };
}

function normPortVisit(e) {
  const pv = e.port_visit || e.portVisit || {};
  // A port visit carries up to three anchorages (start/intermediate/end). Prefer
  // whichever has a human-readable name; the bare anchorageId hash is noise, so
  // it's not used as a port label (the country still comes through).
  const anchorages = [pv.startAnchorage, pv.endAnchorage, pv.intermediateAnchorage].filter(Boolean);
  const named = anchorages.find((a) => a.name || a.portLabel);
  const withFlag = anchorages.find((a) => a.flag);
  return {
    start: e.start || null,
    end: e.end || null,
    port: named ? named.name || named.portLabel : null,
    country: withFlag ? flagName(withFlag.flag) || withFlag.flag : null,
  };
}

function normGap(e) {
  const gap = e.gap || {};
  return {
    start: e.start || null,
    end: e.end || null,
    durationH: hoursBetween(e.start, e.end),
    lat: e.position?.lat ?? null,
    lon: e.position?.lon ?? null,
    distanceKm: gap.distanceKm ?? null,
  };
}

/**
 * Look up a ship on Global Fishing Watch and return its identity + recent
 * behavioural events. Shape:
 *   {
 *     vesselId,
 *     identity:  { mmsi, imo, shipname, flag, flagIso3, callsign, type, year, ... },
 *     events:    { encounters[], loitering[], portVisits[], gaps[] },
 *     counts:    { encounters, loitering, portVisits, gaps },
 *   }
 * Returns { found: false } when GFW has no record for the vessel (NOT an error —
 * most non-fishing vessels are simply absent). Throws on missing token, auth
 * failure, rate limit, or transport error.
 */
async function crawlGfw(ship) {
  if (!GFW_TOKEN) {
    throw new Error('Token GFW mancante: imposta GLOBAL_FISHING_WATCH_TOKEN in local.properties');
  }
  const hit = await searchVessel(ship);
  if (!hit) return { found: false };

  const end = new Date();
  const start = new Date(end.getTime() - EVENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [enc, loi, prt, gap] = await Promise.all([
    fetchEvents(hit.vesselId, EVENT_DATASETS.encounters, isoDate(start), isoDate(end)),
    fetchEvents(hit.vesselId, EVENT_DATASETS.loitering, isoDate(start), isoDate(end)),
    fetchEvents(hit.vesselId, EVENT_DATASETS.portVisits, isoDate(start), isoDate(end)),
    fetchEvents(hit.vesselId, EVENT_DATASETS.gaps, isoDate(start), isoDate(end)),
  ]);

  const events = {
    encounters: enc.map(normEncounter),
    loitering: loi.map(normLoitering),
    portVisits: prt.map(normPortVisit),
    gaps: gap.map(normGap),
  };
  return {
    found: true,
    vesselId: hit.vesselId,
    identity: hit.identity,
    events,
    counts: {
      encounters: events.encounters.length,
      loitering: events.loitering.length,
      portVisits: events.portVisits.length,
      gaps: events.gaps.length,
    },
  };
}

module.exports = { crawlGfw };
