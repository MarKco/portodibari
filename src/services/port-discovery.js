'use strict';

const db = require('../db');
const { BBOX_PRESETS } = require('../config');
const { haversineM } = require('./ship-analysis');
const gfw = require('./gfw');
const { searchVesselFinderPorts } = require('./scrapers/vesselfinder-ports');
const mst = require('./scrapers/myshiptracking');
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
    for (const b of berths) {
      db.upsertAreaPort({
        area_key: areaKey,
        name: b.name || `Banchina #${b.id}`,
        lat: b.centroid_lat,
        lon: b.centroid_lon,
        sources: ['berths'],
        status: 'confirmed',
      });
    }
    return;
  }

  const box = bboxOf(areaKey);
  const locodeCands = localocodeCandidates(box);
  const wpiCands = wpiCandidates(box);

  let gfwCands = [];
  try {
    gfwCands = (await gfw.getAnchoragesInBbox([box.swLat, box.swLon], [box.neLat, box.neLon]))
      .map((p) => ({ ...p, source: 'gfw' }));
  } catch { /* best-effort source */ }

  const vfCands = [];
  const vfLookupCands = [...locodeCands, ...wpiCands].slice(0, 20);
  for (let i = 0; i < vfLookupCands.length; i++) {
    const cand = vfLookupCands[i];
    try {
      const matches = await searchVesselFinderPorts(cand.name);
      vfCands.push(...matches.filter((m) => inBbox(m.lat, m.lon, box)).map((m) => ({ ...m, source: 'vf' })));
    } catch { /* best-effort, one candidate's VF lookup failing doesn't block the rest */ }
    // Pace between candidates (not just within a single VF call's own internal
    // jitter) — a single searchVesselFinderPorts call is already ~10 requests;
    // up to 20 candidates back-to-back would otherwise fire immediately after
    // each other. Skip the sleep after the last iteration.
    if (i < vfLookupCands.length - 1) await sleep(jitterMs());
  }

  const clusters = clusterCandidates([...gfwCands, ...wpiCands, ...locodeCands, ...vfCands]);
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

/** Resolve MST's own `pid` for every confirmed port of `areaKey` that doesn't
 *  have one yet — needed only by the companion scrape-recovery plan's
 *  new-arrival discovery. Never runs for 'review'/'rejected' ports (avoids
 *  wasting a request on a candidate that might get rejected). */
async function resolveMstPidForConfirmedPorts(areaKey) {
  const ports = db.getConfirmedAreaPorts(areaKey);
  for (let i = 0; i < ports.length; i++) {
    const port = ports[i];
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

module.exports = { clusterCandidates, discoverPortsForArea, resolveMstPidForConfirmedPorts };
