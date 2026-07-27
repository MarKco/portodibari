'use strict';

// Ship-category resolver for the per-user notification filter (Settings →
// Notifiche). Independent from `ship-categories.js` (which drives berth/mooring
// stats and must not change): here coastguard (AIS 55) and military (AIS 35 /
// manual flag / name prefix) are kept as two DISTINCT categories on purpose —
// a coastguard vessel is not auto-scored as military by risk-score.js either.
//
// Cargo hulls (AIS 70–79) are split into 'container' vs 'cargo' using the same
// VF/MT-cached subtype cargo-type.js uses for scoring (cargoTypeForShip): a
// cache-only read, safe to call from the hot notification path. A freshly-seen
// cargo ship with no VF/MT data yet falls back to 'cargo' until it's enriched.

const db = require('../db');
const { isMilitary } = require('./risk-score');
const { cargoTypeForShip } = require('./cargo-type');

const CATEGORIES = [
  'cargo',
  'container',
  'tanker',
  'passenger',
  'fishing',
  'highspeed',
  'sailing_pleasure',
  'tug_service',
  'coastguard',
  'military',
  'other',
];

/** Notification category key for a ship row (never null). */
function categoryOf(ship) {
  if (isMilitary(ship)) return 'military';
  const c = Number(ship.ship_type);
  if (!Number.isFinite(c) || c === 0) return 'other';
  if (c === 55) return 'coastguard';
  if (c >= 80 && c <= 89) return 'tanker';
  if (c >= 70 && c <= 79) {
    const { class: cls } = cargoTypeForShip(ship);
    return cls === 'container' ? 'container' : 'cargo';
  }
  if (c >= 60 && c <= 69) return 'passenger';
  if (c === 30) return 'fishing';
  if (c >= 40 && c <= 49) return 'highspeed';
  if (c === 36 || c === 37) return 'sailing_pleasure';
  if (c === 31 || c === 32 || c === 33 || c === 34 || (c >= 50 && c <= 59)) return 'tug_service';
  return 'other';
}

/** True unless the ship's category is in `hidden` (a Set/array of category keys). */
function categoryAllowed(ship, hidden) {
  if (!hidden || (Array.isArray(hidden) ? hidden.length === 0 : hidden.size === 0)) return true;
  const set = hidden instanceof Set ? hidden : new Set(hidden);
  return !set.has(categoryOf(ship));
}

/**
 * Combined per-user gate for a single ship notification: category filter AND
 * the "notify also seen ships" toggle. `prefs` is a user-prefs.get() view.
 * Used for the four per-ship notification types (high_risk/revisit/
 * area_change/proximity) — NOT for berth events, which aren't tied to one ship.
 */
function shouldNotifyShip(userId, ship, prefs) {
  if (!ship) return true;
  if (!categoryAllowed(ship, prefs.notifyShipTypesHidden)) return false;
  if (!prefs.notifyIncludeSeen && db.isUserSeen(userId, ship.mmsi)) return false;
  return true;
}

module.exports = { CATEGORIES, categoryOf, categoryAllowed, shouldNotifyShip };
