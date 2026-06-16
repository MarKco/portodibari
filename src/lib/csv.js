'use strict';

/** Recursively flatten nested objects into `prefix_key` columns (arrays kept as-is). */
function flattenObject(obj, prefix) {
  const result = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(result, flattenObject(v, key));
    } else {
      result[key] = v;
    }
  }
  return result;
}

/**
 * Quote a CSV field if it contains a comma, quote, or newline. Also defuses
 * spreadsheet formula injection: a field that begins with =, +, -, @ (or a
 * leading tab/CR) is prefixed with a single quote so Excel/Sheets treat it as
 * text, not a formula — ship names/destinations come from untrusted AIS data.
 */
function csvEscape(val) {
  let s = String(val);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

module.exports = { flattenObject, csvEscape };
