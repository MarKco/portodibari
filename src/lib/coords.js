'use strict';

// ShipFinder reports coordinates as degrees + decimal minutes with a hemisphere
// suffix, e.g. "44-35.056 N" / "12-26.993 E". Convert to signed decimal degrees.
// Returns null when the string can't be parsed (empty / malformed).
function parseDdm(s) {
  if (s == null) return null;
  const m = String(s).trim().match(/^(\d+)\D+(\d+(?:\.\d+)?)\s*([NSEW])$/i);
  if (!m) return null;
  const deg = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  let dec = deg + min / 60;
  const hemi = m[3].toUpperCase();
  if (hemi === 'S' || hemi === 'W') dec = -dec;
  if (Math.abs(dec) > 180) return null; // sanity guard against garbage
  return Math.round(dec * 1e6) / 1e6;
}

module.exports = { parseDdm };
