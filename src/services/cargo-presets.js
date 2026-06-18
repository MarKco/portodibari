'use strict';

// User-defined cargo-weight presets ("classi di pesi" salvabili).
//
// Built-in presets (Standard, Trasporto armi) live in code
// (services/cargo-type.js → BUILTIN_CARGO_PRESETS). The operator can also save
// the live weights under a name; those user presets are stored as a single JSON
// row in the DB `meta` table (key META_KEY). `meta` is part of BACKUP_TABLES, so
// user presets are included in every backup and come back on restore — exactly
// what the deploy = backup+restore cycle needs.
//
// db/config are lazy-required inside the functions: this module is pulled in by
// the settings route, and requiring db/config at load time would risk a cycle
// (config → cargo-type, db → config).

const META_KEY = 'cargo_weight_presets';

/** Slugify a free-text preset name into a safe id (mirrors config.slugify). */
function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'preset';
}

/** Read the user presets array from the meta table (never throws). */
function loadUserPresets() {
  const db = require('../db');
  const raw = db.getMeta(META_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Defensive normalize: keep only well-formed entries.
    return arr
      .filter((p) => p && typeof p === 'object' && p.id && p.weights && typeof p.weights === 'object')
      .map((p) => ({ id: String(p.id), name: String(p.name || p.id), builtin: false, weights: p.weights }));
  } catch {
    return [];
  }
}

/** Persist the user presets array back to the meta table. */
function saveUserPresets(list) {
  const db = require('../db');
  db.setMeta(META_KEY, JSON.stringify(list || []));
}

/** The id set used by built-ins, so a user preset can never shadow one. */
function builtinIds() {
  const { BUILTIN_CARGO_PRESETS } = require('./cargo-type');
  return new Set(BUILTIN_CARGO_PRESETS.map((p) => p.id));
}

/** All presets: built-ins first (with current default weights), then user ones. */
function listPresets() {
  const { BUILTIN_CARGO_PRESETS } = require('./cargo-type');
  const builtins = BUILTIN_CARGO_PRESETS.map((p) => ({ ...p, weights: { ...p.weights } }));
  return [...builtins, ...loadUserPresets()];
}

/** Look up one preset (built-in or user) by id, or null. */
function getPreset(id) {
  return listPresets().find((p) => p.id === id) || null;
}

/**
 * Save a weight map under a name as a user preset. If a user preset with the
 * same id already exists it is overwritten (rename → new id). Built-in ids are
 * never overwritten — a collision gets a numeric suffix. Returns the saved
 * preset descriptor. `weights` is normalized via config so only known classes
 * with non-negative values are stored.
 */
function savePreset(name, weights) {
  const { normalizeCargoWeights } = require('../config');
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Nome preset obbligatorio');
  const reserved = builtinIds();
  let id = slugify(clean);
  const list = loadUserPresets();
  // Avoid clashing with a built-in id; if it clashes with an existing *user*
  // preset we overwrite that one (same name → update in place).
  if (reserved.has(id)) {
    let n = 2;
    let candidate = `${id}_${n}`;
    while (reserved.has(candidate) || list.some((p) => p.id === candidate)) candidate = `${id}_${++n}`;
    id = candidate;
  }
  const entry = { id, name: clean, builtin: false, weights: normalizeCargoWeights(weights) };
  const next = list.filter((p) => p.id !== id);
  next.push(entry);
  saveUserPresets(next);
  return entry;
}

/** Delete a user preset by id. Built-ins can't be deleted. Returns true if removed. */
function deletePreset(id) {
  if (builtinIds().has(id)) throw new Error('I preset predefiniti non si possono eliminare');
  const list = loadUserPresets();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  saveUserPresets(next);
  return true;
}

module.exports = {
  META_KEY,
  listPresets,
  getPreset,
  savePreset,
  deletePreset,
};
