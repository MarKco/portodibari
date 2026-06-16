'use strict';

// Maps an AIS ship-type code to a broad category used to characterise a berth.
// Mirrors the (finer) labels in public/js/helpers.js but collapses everything
// into a handful of buckets meaningful for "which kind of ship moors here":
// cargo, tanker, passenger, fishing, service (tug/pilot/port), military,
// pleasure, highspeed, other, unknown.
//
// The category key is stored on every mooring and tallied per berth; the
// frontend owns the colour + translated label for each key.

const CATEGORIES = [
  'cargo',
  'tanker',
  'passenger',
  'fishing',
  'service',
  'military',
  'pleasure',
  'highspeed',
  'other',
  'unknown',
];

/** Broad category key for an AIS ship-type code (null/0 → 'unknown'). */
function categoryOf(code) {
  if (code == null) return 'unknown';
  const c = Number(code);
  if (!Number.isFinite(c) || c === 0) return 'unknown';
  if (c >= 70 && c <= 79) return 'cargo';
  if (c >= 80 && c <= 89) return 'tanker';
  if (c >= 60 && c <= 69) return 'passenger';
  if (c >= 40 && c <= 49) return 'highspeed';
  if (c === 30) return 'fishing';
  if (c === 35 || c === 55) return 'military';
  if (c === 36 || c === 37) return 'pleasure';
  // Towing, pilot, tug, port tender, anti-pollution, SAR, medical, special…
  if (c === 31 || c === 32 || c === 33 || c === 34 || (c >= 50 && c <= 59)) return 'service';
  return 'other';
}

// Hazmat-carrying types (cargo/tanker carrying category A–D dangerous goods).
function isHazmat(code) {
  const c = Number(code);
  return (c >= 71 && c <= 74) || (c >= 81 && c <= 84);
}

module.exports = { CATEGORIES, categoryOf, isHazmat };
