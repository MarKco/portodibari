'use strict';

const path = require('path');
const fs = require('fs');

let _lookup = null;

function getLookup() {
  if (!_lookup) {
    const f = path.join(__dirname, '../../data/locode.json');
    _lookup = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  return _lookup;
}

// Normalize raw AIS destination to a 5-char LOCODE, or null if it doesn't match.
// Handles both "ITTAR" and "IT TAR" formats.
function normalizeCode(raw) {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (/^[A-Z]{2}[A-Z0-9]{3}$/.test(s)) return s;
  if (/^[A-Z]{2} [A-Z0-9]{3}$/.test(s)) return s.replace(' ', '');
  return null;
}

/**
 * Resolve an AIS destination string to a human-readable port name.
 * Returns the port name string, or null if the code is not a known LOCODE.
 */
function resolveLocode(raw) {
  const code = normalizeCode(raw);
  if (!code) return null;
  return getLookup()[code] || null;
}

/**
 * Return the best display label for a destination: resolved name if LOCODE,
 * otherwise the raw string. Returns null if input is null/empty.
 */
function destinationLabel(raw) {
  if (!raw) return null;
  return resolveLocode(raw) || raw.trim();
}

// Coordinate lookup (CODE → [lat, lon]), built by scripts/build-locode.js from
// the UN/LOCODE Coordinates column. Present for ~75% of codes (degrees+minutes
// precision, ≈1–2 km — a locality centroid). Loaded lazily, like the names.
let _coords = null;
function getCoords() {
  if (!_coords) {
    const f = path.join(__dirname, '../../data/locode-coords.json');
    _coords = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  return _coords;
}

/**
 * Resolve an AIS destination string to [lat, lon] (decimal degrees), or null
 * when it isn't a known LOCODE or has no coordinates in the dataset.
 */
function resolveLocodeCoords(raw) {
  const code = normalizeCode(raw);
  if (!code) return null;
  return getCoords()[code] || null;
}

module.exports = { resolveLocode, resolveLocodeCoords, destinationLabel, normalizeCode };
