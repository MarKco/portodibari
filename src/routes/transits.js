'use strict';

// "Ricerca navi per aree di transito" (Navi seguite → Ricerca navi per aree di
// transito). Given two of the user's areas, list the ships that CALLED at both
// (a stop, not a mere crossing — see db.getAreaTransits) with how many legs they
// sailed straight from one to the other and when the last one was. The point is
// discovery: these ships are usually not followed, and their current position
// may be anywhere in the world, which is why the query is driven by port_events
// history rather than by the geographic visibility used elsewhere.

const express = require('express');
const db = require('../db');
const { computeRiskScoreCached, isMilitary } = require('../services/risk-score');
const { TRANSIT } = require('../config');
const { destinationLabel } = require('../services/locode');

const router = express.Router();

// Start of the window for a period preset, or null for the whole history.
function periodStart(period) {
  const now = Date.now();
  switch (period) {
    case '30d': return new Date(now - 30 * 86400000).toISOString();
    case '3m': return new Date(now - 91 * 86400000).toISOString();
    case '6m': return new Date(now - 182 * 86400000).toISOString();
    case '12m': return new Date(now - 365 * 86400000).toISOString();
    default: return null;
  }
}

router.get('/transits', (req, res) => {
  const uid = req.user.id;
  const a = String(req.query.a || '');
  const b = String(req.query.b || '');
  if (!a || !b) return res.status(400).json({ error: 'Aree mancanti' });
  if (a === b) return res.status(400).json({ error: 'Scegli due aree diverse' });

  // Both areas must be monitored by the user (or their group, which mirrors the
  // same user_areas rows) — same ownership rule as the rest of the app.
  const owned = new Set(db.getUserBoxes(uid).map((x) => x.key));
  if (!owned.has(a) || !owned.has(b)) return res.status(403).json({ error: 'Area non monitorata' });

  const period = String(req.query.period || 'all');
  const includeNoLeg = req.query.includeNoLeg === '1';
  const { rows, gate } = db.getAreaTransits(a, b, periodStart(period));

  const kept = includeNoLeg ? rows : rows.filter((r) => r.legs > 0);
  // Most-travelled first, then most recent leg — the ships worth a look are the
  // ones shuttling between the two areas, and the ones that did it lately.
  kept.sort((x, y) =>
    y.legs - x.legs ||
    String(y.lastLeg?.arrivedAt || y.lastStopAt || '').localeCompare(String(x.lastLeg?.arrivedAt || x.lastStopAt || '')) ||
    y.stopsA + y.stopsB - (x.stopsA + x.stopsB)
  );
  const truncated = kept.length > TRANSIT.MAX_ROWS;
  const page = truncated ? kept.slice(0, TRANSIT.MAX_ROWS) : kept;

  // Per-user overlay (flag/seen/follow/mute) + charges, exactly as the ship
  // lists do it: one batch query for the whole page, never one per row.
  const sets = {
    flags: db.getUserFlaggedMmsis(uid),
    follows: db.getUserFollowedMmsis(uid),
    mutes: db.getUserMutedMmsis(uid),
    seen: db.getUserSeenMmsis(uid),
  };
  const charges = db.getChargesForMmsis(page.map((r) => r.mmsi));
  const lang = req.query.lang || 'it';

  const ships = page.map((r) => {
    const s = db.getShip(r.mmsi) || { mmsi: r.mmsi };
    const mil = isMilitary(s);
    return {
      mmsi: r.mmsi,
      ship_name: s.ship_name || null,
      ship_type: s.ship_type ?? null,
      destination: s.destination || null,
      destination_label: destinationLabel(s.destination),
      last_seen_at: s.last_seen_at === db.NEVER_SEEN_AIS ? null : s.last_seen_at || null,
      stopsA: r.stopsA,
      stopsB: r.stopsB,
      legs: r.legs,
      lastLeg: r.lastLeg,
      flagged: mil ? true : sets.flags.has(r.mmsi),
      followed: sets.follows.has(r.mmsi) ? 1 : 0,
      notif_muted: sets.mutes.has(r.mmsi) ? 1 : 0,
      seen: sets.seen.has(r.mmsi) ? 1 : 0,
      is_military: mil,
      risk: s.mmsi ? computeRiskScoreCached(s, lang) : null,
      chargedBy: charges[r.mmsi] || [],
    };
  });

  const areaName = (key) => db.getAllAreas().find((x) => x.key === key)?.name || key;
  res.json({
    ships,
    truncated,
    total: kept.length,
    areaA: { key: a, name: areaName(a) },
    areaB: { key: b, name: areaName(b) },
    period,
    gate,
  });
});

module.exports = router;
