'use strict';

// ── Ship-to-ship proximity (rendezvous) detection ───────────────────────────
// A periodic per-area scan flags pairs of distinct vessels that linger close
// together offshore while both move slowly — the classic ship-to-ship transfer
// (transshipment) signature. It is deliberately conservative:
//
//   • both ships slow            (SOG < PROXIMITY.MAX_SOG_KN)
//   • both NOT moored/anchored   (nav status ≠ 1, 5)
//   • both offshore              (> PROXIMITY.FAR_KM from the area bbox centre)
//   • pair within PROXIMITY.DIST_M
//   • sustained ≥ PROXIMITY.MIN_MINUTES before it alerts
//
// State lives in proximity_events (one row per encounter, canonical mmsi_a <
// mmsi_b). A contact opens when a pair first comes within DIST_M, stays alive
// while within DIST_M × CLOSE_MULT (hysteresis so a single noisy fix doesn't
// flap it shut), and closes when the pair separates or a ship leaves/goes
// stale. On the first scan where an open contact's dwell reaches MIN_MINUTES it
// fires one notification (in-app + Telegram) and feeds the risk score of BOTH
// ships. Always-on but cheap; PROXIMITY.SCAN_MIN = 0 disables the scan.

const db = require('../db');
const appLog = require('./app-log');
const userPrefs = require('./user-prefs');
const { haversineM } = require('./ship-analysis');
const { PROXIMITY, BBOX_PRESETS } = require('../config');

// Canonical pair key + ordering so A↔B and B↔A are the same contact.
function orderPair(p, q) {
  return p.mmsi <= q.mmsi ? [p, q] : [q, p];
}

function areaCenter(area) {
  const preset = BBOX_PRESETS[area];
  if (!preset) return null;
  const box = preset.box[0]; // [[swLat, swLon], [neLat, neLon]]
  return { lat: (box[0][0] + box[1][0]) / 2, lon: (box[0][1] + box[1][1]) / 2 };
}

// Fan out a confirmed rendezvous to the area's owners (in-app + Telegram), then
// invalidate both ships' cached risk scores so the new factor shows at once.
function notifyOwners(area, c) {
  const telegram = require('./telegram'); // lazy: avoids a load-time cycle
  const midLat = (c.latA + c.latB) / 2;
  const midLon = (c.lonA + c.lonB) / 2;
  const label = `${c.nameA || c.mmsiA} ↔ ${c.nameB || c.mmsiB}`;
  for (const uid of db.getAreaOwners(area)) {
    const p = userPrefs.get(uid);
    if (p.notificationsEnabled && p.notifyProximity) {
      db.addNotification({
        user_id: uid, type: 'proximity', mmsi: c.mmsiA, ship_name: label,
        area, berth_lat: midLat, berth_lon: midLon,
      });
    }
    telegram.notifyProximity(uid, {
      area, mmsiA: c.mmsiA, mmsiB: c.mmsiB, nameA: c.nameA, nameB: c.nameB,
      latA: c.latA, lonA: c.lonA, latB: c.latB, lonB: c.lonB,
      lat: midLat, lon: midLon, distM: c.minDistM, durMin: c.durMin,
    });
  }
  try {
    const { invalidateRiskCache } = require('./risk-score');
    invalidateRiskCache(c.mmsiA);
    invalidateRiskCache(c.mmsiB);
  } catch { /* best-effort */ }
}

function scanArea(area) {
  const center = areaCenter(area);
  if (!center) return;
  const now = new Date();
  const nowIso = now.toISOString();
  const freshIso = new Date(now - PROXIMITY.FRESH_MIN * 60 * 1000).toISOString();

  // Gate candidates: recent fix, slow, not moored/anchored, offshore.
  const cand = db.getProximityCandidates(area, freshIso).filter((s) => {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return false;
    if (s.sog == null || s.sog >= PROXIMITY.MAX_SOG_KN) return false;
    if (s.ns === '1' || s.ns === '5') return false; // anchored / moored
    return haversineM(s.lat, s.lon, center.lat, center.lon) / 1000 > PROXIMITY.FAR_KM;
  });

  const open = new Map(); // key → open row
  for (const row of db.getOpenProximity(area)) open.set(`${row.mmsi_a}|${row.mmsi_b}`, row);

  const KEEP = PROXIMITY.DIST_M * PROXIMITY.CLOSE_MULT;
  const seen = new Set();

  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const d = haversineM(cand[i].lat, cand[i].lon, cand[j].lat, cand[j].lon);
      if (d > KEEP) continue;
      const [a, b] = orderPair(cand[i], cand[j]);
      const key = `${a.mmsi}|${b.mmsi}`;
      const row = open.get(key);

      if (row) {
        // Sustaining an existing contact: refresh, then alert once the dwell
        // threshold is crossed.
        seen.add(key);
        const minDist = Math.min(row.min_dist_m == null ? d : row.min_dist_m, d);
        db.updateProximityContact({
          id: row.id, last_seen_at: nowIso, min_dist_m: minDist,
          lat_a: a.lat, lon_a: a.lon, lat_b: b.lat, lon_b: b.lon,
        });
        if (!row.alerted) {
          const durMin = (now - new Date(row.started_at)) / 60000;
          if (durMin >= PROXIMITY.MIN_MINUTES) {
            db.markProximityAlerted(row.id);
            appLog.info('PROXIMITY', appLog.t('proximity.detected', {
              area, a: a.name || a.mmsi, b: b.name || b.mmsi,
              dist: Math.round(minDist), min: Math.round(durMin),
            }), { area, mmsiA: a.mmsi, mmsiB: b.mmsi });
            notifyOwners(area, {
              mmsiA: a.mmsi, mmsiB: b.mmsi, nameA: a.name, nameB: b.name,
              latA: a.lat, lonA: a.lon, latB: b.lat, lonB: b.lon,
              minDistM: Math.round(minDist), durMin: Math.round(durMin),
            });
          }
        }
      } else if (d <= PROXIMITY.DIST_M) {
        // New contact — opens only at the tighter DIST_M, then must dwell.
        seen.add(key);
        db.openProximityContact({
          area, mmsi_a: a.mmsi, mmsi_b: b.mmsi, name_a: a.name, name_b: b.name,
          ts: nowIso, min_dist_m: d,
          lat_a: a.lat, lon_a: a.lon, lat_b: b.lat, lon_b: b.lon,
        });
      }
      // d in (DIST_M, KEEP] with no open row → ignore (not close enough to open).
    }
  }

  // Close every open contact the scan no longer sees (separated / left / stale).
  for (const [key, row] of open) {
    if (!seen.has(key)) db.closeProximityContact(row.id, nowIso);
  }
}

function scanAll() {
  if (!(PROXIMITY.SCAN_MIN > 0)) return;
  for (const area of Object.keys(BBOX_PRESETS)) {
    try {
      scanArea(area);
    } catch (e) {
      appLog.error('PROXIMITY', appLog.t('proximity.scan_failed', { area, error: e.message }), { area });
    }
  }
}

function init() {
  if (!(PROXIMITY.SCAN_MIN > 0)) {
    appLog.info('PROXIMITY', appLog.t('proximity.disabled'));
    return;
  }
  // First sweep shortly after boot, then on the configured cadence.
  setTimeout(scanAll, 30 * 1000);
  setInterval(scanAll, PROXIMITY.SCAN_MIN * 60 * 1000);
}

module.exports = { init, scanAll, scanArea };
