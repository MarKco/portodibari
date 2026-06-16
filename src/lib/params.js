'use strict';

// Helpers to sanitise pagination / id params coming from untrusted query
// strings and route params. Without these, `?limit=99999999` pulls an entire
// table into memory and a non-numeric `:id` binds NaN into a SQL statement.

const MAX_LIMIT = 1000;

/** Positive integer limit, capped at `max`; falls back to `def` on garbage. */
function clampLimit(v, def = 50, max = MAX_LIMIT) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

/** Non-negative integer offset; 0 on garbage. */
function clampOffset(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A clean non-negative integer id/mmsi, or null when the value isn't one. */
function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

module.exports = { clampLimit, clampOffset, parseId, MAX_LIMIT };
