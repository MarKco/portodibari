'use strict';

// User-defined risk-weight presets ("profili di rischio").
//
// Mirrors cargo-presets.js: a single built-in preset ("Default", the boot
// weights from app.config.properties) plus operator-saved profiles. User
// presets are one JSON row in the DB `meta` table (key META_KEY); `meta` is in
// BACKUP_TABLES, so they survive the deploy = backup+restore cycle.
//
// db/config are lazy-required inside the functions to avoid a load-time cycle
// (config → this is required by the settings route; db → config).

const META_KEY = 'risk_weight_presets';

function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'preset';
}

const BUILTIN_IDS = new Set(['default']);

function builtinPresets() {
  const { DEFAULT_RISK_WEIGHTS } = require('../config');
  return [{ id: 'default', name: 'Default', builtin: true, weights: { ...DEFAULT_RISK_WEIGHTS } }];
}

function loadUserPresets() {
  const db = require('../db');
  const raw = db.getMeta(META_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => p && typeof p === 'object' && p.id && p.weights && typeof p.weights === 'object')
      .map((p) => ({ id: String(p.id), name: String(p.name || p.id), builtin: false, weights: p.weights }));
  } catch {
    return [];
  }
}

function saveUserPresets(list) {
  const db = require('../db');
  db.setMeta(META_KEY, JSON.stringify(list || []));
}

/** All presets: the built-in Default first, then user ones. */
function listPresets() {
  return [...builtinPresets(), ...loadUserPresets()];
}

function getPreset(id) {
  return listPresets().find((p) => p.id === id) || null;
}

/** Save a weight map under a name as a user preset (normalized via config). */
function savePreset(name, weights) {
  const { normalizeRiskWeights, EDITABLE_RISK_WEIGHTS } = require('../config');
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Nome preset obbligatorio');
  let id = slugify(clean);
  const list = loadUserPresets();
  if (BUILTIN_IDS.has(id)) {
    let n = 2;
    let candidate = `${id}_${n}`;
    while (BUILTIN_IDS.has(candidate) || list.some((p) => p.id === candidate)) candidate = `${id}_${++n}`;
    id = candidate;
  }
  // Store only the editable subset, fully normalized.
  const full = normalizeRiskWeights(weights);
  const clean_weights = Object.fromEntries(EDITABLE_RISK_WEIGHTS.map((k) => [k, full[k]]));
  const entry = { id, name: clean, builtin: false, weights: clean_weights };
  const next = list.filter((p) => p.id !== id);
  next.push(entry);
  saveUserPresets(next);
  return entry;
}

function deletePreset(id) {
  if (BUILTIN_IDS.has(id)) throw new Error('I preset predefiniti non si possono eliminare');
  const list = loadUserPresets();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  saveUserPresets(next);
  return true;
}

module.exports = { META_KEY, listPresets, getPreset, savePreset, deletePreset };
