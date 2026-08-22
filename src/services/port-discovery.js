'use strict';

const db = require('../db');
const { BBOX_PRESETS } = require('../config');
const { haversineM } = require('./ship-analysis');
const gfw = require('./gfw');
const { searchVesselFinderPorts } = require('./scrapers/vesselfinder-ports');
const mst = require('./scrapers/myshiptracking');
const fallbackMode = require('./fallback-mode');
const appLog = require('./app-log');
const wpi = require('../../data/wpi.json');
const locodeNames = require('../../data/locode.json');
const locodeCoords = require('../../data/locode-coords.json');
const locodePortCodes = new Set(require('../../data/locode-ports.json'));

// Reuses the existing haversineM(lat1, lon1, lat2, lon2) from ship-analysis.js
// (already used by proximity.js for rendezvous detection) instead of a second
// haversine implementation — same formula, don't duplicate it.
const CLUSTER_RADIUS_M = 4000; // 4km

// Same jitter shape/magnitude as fallback-mode.js's `jitterMs`/vesselfinder-ports.js's
// internal jitter (1.5-4.5s) — used here BETWEEN loop iterations that each call an
// external scraper, so consecutive candidates/ports don't fire back-to-back. This is
// on top of (not a replacement for) each scraper's own internal per-request jitter.
const jitterMs = () => 1500 + Math.random() * 3000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Group candidate points from possibly-different sources into clusters when
 *  they're within CLUSTER_RADIUS_M of each other. Each output cluster keeps
 *  the first-seen name/coords and the de-duplicated list of contributing
 *  source tags. */
function clusterCandidates(candidates) {
  const clusters = [];
  for (const c of candidates) {
    const hit = clusters.find((cl) => haversineM(cl.lat, cl.lon, c.lat, c.lon) <= CLUSTER_RADIUS_M);
    if (hit) {
      if (!hit.sources.includes(c.source)) hit.sources.push(c.source);
    } else {
      clusters.push({ name: c.name, lat: c.lat, lon: c.lon, sources: [c.source] });
    }
  }
  return clusters;
}

function bboxOf(areaKey) {
  const [[swLat, swLon], [neLat, neLon]] = BBOX_PRESETS[areaKey].box[0];
  return { swLat, swLon, neLat, neLon };
}
function inBbox(lat, lon, box) {
  return lat >= box.swLat && lat <= box.neLat && lon >= box.swLon && lon <= box.neLon;
}

function localocodeCandidates(box) {
  const out = [];
  for (const code of locodePortCodes) {
    const c = locodeCoords[code];
    if (!c) continue;
    const [lat, lon] = c;
    if (inBbox(lat, lon, box)) out.push({ name: locodeNames[code], lat, lon, source: 'locode' });
  }
  return out;
}

function wpiCandidates(box) {
  return wpi.filter((p) => inBbox(p.lat, p.lon, box)).map((p) => ({ ...p, source: 'wpi' }));
}

/** Discover and persist port candidates for `areaKey`. If the area already
 *  has real observed berth clusters, those ARE the ground truth (no external
 *  source consulted, auto-confirmed). Otherwise runs the 4-source cascade,
 *  clusters by proximity, and persists each cluster at 'confirmed' (>=2
 *  sources) or 'review' (1 source) — see db.upsertAreaPort's admin_reviewed
 *  guard for why re-running this is always safe. */
async function discoverPortsForArea(areaKey) {
  const berths = db.getBerths(areaKey);
  if (berths.length) {
    // A real port is a GROUP of nearby berths, not one berth each — an area with
    // 45 individual mooring clusters is typically 1-2 real ports, not 45. Cluster
    // berths by proximity with the exact same logic used for external-source
    // candidates below, instead of persisting one area_port row per berth.
    // Named berths sort first so an admin-assigned name wins the cluster's
    // display name over a generated fallback when both land in the same cluster.
    const sorted = [...berths].sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0));
    const candidates = sorted.map((b) => ({
      // Unnamed (not-yet-renamed) berths key their fallback name on rounded
      // centroid, NOT on `b.id` — berths are DELETE+INSERT with a fresh
      // AUTOINCREMENT id on every recompute (project-wide gotcha) — but this
      // name is only ever used to seed a cluster before clusterCandidates picks
      // a final display name, so precision here matters less than for the old
      // one-row-per-berth scheme. No language-specific word here on purpose
      // (unlike the old "Porto {lat},{lon}"/"Banchina {lat},{lon}" fallbacks it
      // replaced) — a name baked into the DB can't be run through the client's
      // i18n at display time, so a plain coordinate pair is the only form
      // that's correct in every UI language.
      name: b.name || `${b.centroid_lat.toFixed(2)}, ${b.centroid_lon.toFixed(2)}`,
      lat: b.centroid_lat,
      lon: b.centroid_lon,
      source: 'berths',
    }));
    // Retire this area's previous auto-generated, never-reviewed berth-cluster
    // rows before re-clustering: upsertAreaPort matches by exact name, so a
    // cluster that now picks a different representative (drifted centroid, a
    // berth that gained/lost a neighbour) would otherwise leave the old row
    // behind as an orphaned duplicate instead of replacing it — see
    // deleteUnreviewedBerthPorts's own comment for the exact scope/guard.
    db.deleteUnreviewedBerthPorts(areaKey);
    for (const c of clusterCandidates(candidates)) {
      db.upsertAreaPort({
        area_key: areaKey,
        name: c.name,
        lat: c.lat,
        lon: c.lon,
        sources: c.sources,
        status: 'confirmed',
      });
    }
    return;
  }

  // Fallback mode is now per-area and always-on-when-needed (see
  // fallback-mode.js) rather than a single global emergency switch, but the
  // same caution still applies: while ANY area is silent, its scraping is
  // already competing for the shared anti-ban budget/circuit breaker. Port
  // discovery's cascade below fires VF (and, downstream,
  // resolveMstPidForConfirmedPorts fires MST) — defer the whole run rather than
  // add to that risk. No candidates are persisted this run; a later manual
  // re-run or the next boot backfill picks it up once no area is silent.
  if (fallbackMode.isAnyAreaSilent()) {
    appLog.info('AREE', `Scoperta porti per ${areaKey} rimandata: modalità fallback attiva su almeno un'area.`);
    return;
  }

  const allCands = [];
  await searchExternalCandidates(areaKey, (c) => allCands.push(c));
  const clusters = clusterCandidates(allCands);
  for (const c of clusters) {
    db.upsertAreaPort({
      area_key: areaKey,
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      sources: c.sources,
      status: c.sources.length >= 2 ? 'confirmed' : 'review',
    });
  }
}

/** Run the 4-source external cascade (locode/WPI/GFW/VesselFinder) for
 *  `areaKey` and call `onCandidate(candidate)` as each one is found — locode/
 *  WPI/GFW arrive almost immediately (in-memory lookup / one API call), VF
 *  trickles in over the same paced loop as discoverPortsForArea's own cascade
 *  (up to 20 lookups, jittered). Raw candidates, NOT clustered — used both by
 *  discoverPortsForArea (which clusters+persists them itself) and by the
 *  admin-triggered "search external sources now" SSE endpoint (routes/areas.js),
 *  which streams them live for a side-by-side compare against auto-detected
 *  berths and lets the admin add individual ones — clustering isn't needed
 *  there since a human is already picking which to keep. Caller is
 *  responsible for the same isAnyAreaSilent() gate discoverPortsForArea
 *  applies (this function doesn't re-check it, so it can be reused for a
 *  manual admin action that surfaces the deferral differently). `shouldStop`
 *  is polled between VF lookups (the only slow, multi-request leg) so an
 *  admin closing the SSE stream early — see routes/areas.js — stops burning
 *  anti-ban budget on a search nobody's watching anymore, instead of running
 *  the full ~20-candidate pass into the void. */
async function searchExternalCandidates(areaKey, onCandidate, shouldStop = () => false) {
  const box = bboxOf(areaKey);
  const locodeCands = localocodeCandidates(box);
  const wpiCands = wpiCandidates(box);
  for (const c of [...locodeCands, ...wpiCands]) onCandidate(c);

  let gfwCands = [];
  try {
    gfwCands = (await gfw.getAnchoragesInBbox([box.swLat, box.swLon], [box.neLat, box.neLon]))
      .map((p) => ({ ...p, source: 'gfw' }));
  } catch { /* best-effort source */ }
  for (const c of gfwCands) onCandidate(c);

  const vfLookupCands = [...locodeCands, ...wpiCands].slice(0, 20);
  for (let i = 0; i < vfLookupCands.length; i++) {
    if (shouldStop()) return;
    const cand = vfLookupCands[i];
    try {
      const matches = await searchVesselFinderPorts(cand.name);
      for (const m of matches.filter((mm) => inBbox(mm.lat, mm.lon, box)).map((mm) => ({ ...mm, source: 'vf' }))) {
        onCandidate(m);
      }
    } catch { /* best-effort, one candidate's VF lookup failing doesn't block the rest */ }
    // Pace between candidates (not just within a single VF call's own internal
    // jitter) — a single searchVesselFinderPorts call is already ~10 requests;
    // up to 20 candidates back-to-back would otherwise fire immediately after
    // each other. Skip the sleep after the last iteration.
    if (i < vfLookupCands.length - 1) await sleep(jitterMs());
  }
}

/** Resolve MST's own `pid` for every confirmed port of `areaKey` that doesn't
 *  have one yet — needed only by the companion scrape-recovery plan's
 *  new-arrival discovery. Never runs for 'review'/'rejected' ports (avoids
 *  wasting a request on a candidate that might get rejected). */
async function resolveMstPidForConfirmedPorts(areaKey) {
  const ports = db.getConfirmedAreaPorts(areaKey);
  for (let i = 0; i < ports.length; i++) {
    const port = ports[i];
    // Same anti-ban discipline as the cascade above: skip while any area is
    // silent, and independently respect MST's own per-source circuit breaker
    // (already tripped from unrelated 403/429s) even if no area is silent.
    if (fallbackMode.isAnyAreaSilent() || fallbackMode.getStatus().circuits.mst.open) continue;
    if (!port.mst_pid) {
      try {
        const matches = await mst.searchPort(port.name);
        for (const m of matches) {
          const coords = await mst.getPortCoords(m.name.replace(/ /g, '-'), m.pid);
          if (coords && haversineM(coords.lat, coords.lon, port.lat, port.lon) <= CLUSTER_RADIUS_M) {
            db.setAreaPortMstPid(port.id, m.pid);
            break;
          }
        }
      } catch { /* best-effort; no MST pid means no new-arrival discovery for this port, position refresh unaffected */ }
    }
    // Pace between ports — each iteration does a searchPort + getPortCoords
    // pair (two real requests), same rationale as the VF loop above.
    if (i < ports.length - 1) await sleep(jitterMs());
  }
}

module.exports = { clusterCandidates, discoverPortsForArea, resolveMstPidForConfirmedPorts, searchExternalCandidates };
