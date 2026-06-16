'use strict';

const path = require('path');
const fs = require('fs');

const PROPERTIES_FILE = path.join(__dirname, '..', 'local.properties');
const APP_CONFIG_FILE = path.join(__dirname, '..', 'app.config.properties');
const BBOX_FILE = path.join(__dirname, '..', 'bounding-boxes.json');

/**
 * Parse a simple `key=value` properties file. Lines starting with `#` (or `//`,
 * used as comments in this project) and blank lines are ignored.
 */
function loadProperties(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
      .map((l) => l.split('=').map((p) => p.trim()))
      .map(([k, ...v]) => [k, v.join('=')])
  );
}

/** Upsert a single `key=value` line in the properties file (created elsewhere). */
function saveProperty(key, value) {
  if (!fs.existsSync(PROPERTIES_FILE)) return;
  let content = fs.readFileSync(PROPERTIES_FILE, 'utf8');
  const re = new RegExp(`^${key}=.*`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(PROPERTIES_FILE, content, 'utf8');
}

/**
 * Upsert a `key=value` line in app.config.properties, preserving comments and
 * layout. These values are read once at startup, so a write only takes effect
 * after a server restart (the Settings UI tells the user so).
 */
function saveAppProperty(key, value) {
  let content = fs.existsSync(APP_CONFIG_FILE) ? fs.readFileSync(APP_CONFIG_FILE, 'utf8') : '';
  const re = new RegExp(`^${key}=.*`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    content += `${content.endsWith('\n') || content === '' ? '' : '\n'}${key}=${value}\n`;
  }
  fs.writeFileSync(APP_CONFIG_FILE, content, 'utf8');
}

const props = loadProperties(PROPERTIES_FILE);
const appCfg = loadProperties(APP_CONFIG_FILE);

/** Parse a numeric app.config value with a fallback default. */
function num(key, def) {
  const v = parseFloat(appCfg[key]);
  return Number.isFinite(v) ? v : def;
}

// ── Secrets / API key ────────────────────────────────────────────────────────
const API_KEY = props.AIS_API_KEY || process.env.AIS_API_KEY;
const API_KEY_SOURCE = props.AIS_API_KEY
  ? 'local.properties'
  : process.env.AIS_API_KEY
    ? 'env'
    : null;
if (!API_KEY) throw new Error('AIS_API_KEY missing: set in local.properties or env');

// ── HTTP Basic Auth (optional) ───────────────────────────────────────────────
// When AUTH_PASSWORD is empty, the auth middleware is a no-op (local-dev
// default). Set a password to gate the whole app behind a browser login.
const AUTH_USER = props.AUTH_USER || process.env.AUTH_USER || 'admin';
const AUTH_PASSWORD = props.AUTH_PASSWORD || process.env.AUTH_PASSWORD || '';

// ── Equasis credentials (optional) ───────────────────────────────────────────
// Needed only for the on-demand Equasis ownership lookup. The feature stays
// hidden/unusable until both are set.
const EQUASIS_USER = props.EQUASIS_USER || process.env.EQUASIS_USER || '';
const EQUASIS_PASSWORD = props.EQUASIS_PASSWORD || process.env.EQUASIS_PASSWORD || '';

// ── Bounding-box presets ─────────────────────────────────────────────────────
// Loaded from `bounding-boxes.json` so users can add/edit monitoring areas
// without touching code. Each entry: { name, keyword, sw: [lat,lon], ne: [lat,lon] }.
// The internal `box` shape `[[[lat,lon],[lat,lon]]]` is what AISStream expects.
function loadBboxPresets(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Impossibile leggere ${path.basename(file)}: ${err.message}`);
  }
  const presets = {};
  for (const [key, v] of Object.entries(raw)) {
    if (key.startsWith('_')) continue; // skip `_comment` and other meta keys
    if (!Array.isArray(v.sw) || !Array.isArray(v.ne)) {
      throw new Error(`Preset "${key}" in ${path.basename(file)}: 'sw' e 'ne' devono essere [lat, lon]`);
    }
    presets[key] = { box: [[v.sw, v.ne]], name: v.name || key, keyword: v.keyword || null };
  }
  if (!Object.keys(presets).length) {
    throw new Error(`Nessun preset valido in ${path.basename(file)}`);
  }
  return presets;
}

const BBOX_PRESETS = loadBboxPresets(BBOX_FILE);

const INITIAL_PRESET = props.BBOX_PRESET || process.env.BBOX_PRESET || 'bari';
if (!BBOX_PRESETS[INITIAL_PRESET]) {
  throw new Error(
    `Unknown BBOX_PRESET "${INITIAL_PRESET}". Valid: ${Object.keys(BBOX_PRESETS).join(', ')}`
  );
}

// ── Constants ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const AIS_URL = 'wss://stream.aisstream.io/v0/stream';
const MSG_TYPES = [
  'PositionReport',
  'ShipStaticData',
  'ExtendedClassBPositionReport',
  'StandardClassBPositionReport',
];

// ── App parameters (from app.config.properties) ──────────────────────────────
const SOG_FERMA = num('SOG_FERMA_KN', 0.5);
const STILL_RADIUS_M = num('STILL_RADIUS_M', 100);
const ACTIVE_WINDOW_HOURS = num('ACTIVE_WINDOW_HOURS', 6);
const PORT_WINDOW_HOURS = num('PORT_WINDOW_HOURS', 24);
const SCRAPE_CACHE_TTL = num('SCRAPE_CACHE_TTL_HOURS', 6) * 60 * 60 * 1000;
const RECONNECT_DELAY_MS = num('RECONNECT_DELAY_MS', 5000);
const MAX_READINGS_PER_TYPE = num('MAX_READINGS_PER_TYPE', 10000);
const MAX_API_LOG_RECORDS = num('MAX_API_LOG_RECORDS', 20000);
const POLL_INTERVAL_MS = num('POLL_INTERVAL_MS', 300000);
const TRACK_MERGE_RADIUS_M = num('TRACK_MERGE_RADIUS_M', 100);
const TRACK_DEFAULT_LIMIT = num('TRACK_DEFAULT_LIMIT', 500);
const TRACK_MAX_LIMIT = num('TRACK_MAX_LIMIT', 2000);
const MAX_BODY = num('MAX_BODY_BYTES', 8192);
const NOTIF_DELETE_UNDO_SECONDS = num('NOTIF_DELETE_UNDO_SECONDS', 5);

// Interval (minutes) between automatic on-disk backups. Default 2 hours.
const BACKUP_INTERVAL_MIN = num('BACKUP_INTERVAL_MIN', 120);

// If the database file is missing at startup (e.g. wiped by a deploy) and at
// least one auto-backup exists on disk, restore the most recent one. Defaults
// on; set to 'false' to disable. Only triggers when the .db file was ABSENT
// before this process started — never when the DB merely has no rows (so
// "Clear data" + restart does not resurrect data).
const AUTO_RESTORE_ON_DEPLOY = (appCfg.AUTO_RESTORE_ON_DEPLOY ?? 'true') !== 'false';

// ── Berth (mooring characterization) parameters ──────────────────────────────
const BERTH = {
  CLUSTER_EPS_M: num('BERTH_CLUSTER_EPS_M', 80),
  MIN_PTS: num('BERTH_MIN_PTS', 3),
  MIN_MOORINGS: num('BERTH_MIN_MOORINGS', 10),
  DOMINANT_PCT: num('BERTH_DOMINANT_PCT', 60),
  RECOMPUTE_MIN: num('BERTH_RECOMPUTE_MIN', 30),
};

// ── Risk score weights (from app.config.properties) ──────────────────────────
const RISK = {
  DARK_MAX:          num('RISK_DARK_MAX', 25),
  DARK_MIN_H:        num('RISK_DARK_MIN_H', 2),
  DARK_MAX_H:        num('RISK_DARK_MAX_H', 6),
  DARK_PARTIAL_MIN:  num('RISK_DARK_PARTIAL_MIN', 8),
  SPOOF_MAX:         num('RISK_SPOOFING_MAX', 20),
  SPOOF_ANOM_PTS:    num('RISK_SPOOF_ANOMALOUS_POINTS', 12),
  SPOOF_IMPOSSIBLE:  num('RISK_SPOOF_IMPOSSIBLE_KN', 80),
  SPOOF_ANOMALOUS:   num('RISK_SPOOF_ANOMALOUS_KN', 50),
  LOITER_MAX:        num('RISK_LOITERING_MAX', 15),
  LOITER_PARTIAL:    num('RISK_LOITERING_PARTIAL', 7),
  LOITER_MIN_POS:    num('RISK_LOITERING_MIN_POSITIONS', 3),
  LOITER_FAR_KM:     num('RISK_LOITERING_FAR_KM', 10),
  DRAUGHT_MAX:       num('RISK_DRAUGHT_MAX', 20),
  DRAUGHT_FACTOR:    num('RISK_DRAUGHT_FACTOR', 12),
  DRAUGHT_MIN_DELTA: num('RISK_DRAUGHT_MIN_DELTA_M', 0.5),
  DEST_MAX:          num('RISK_DEST_MAX', 10),
  DEST_PER_CHANGE:   num('RISK_DEST_PER_CHANGE', 4),
  HAZMAT:            num('RISK_HAZMAT_POINTS', 8),
  CARGO:             num('RISK_CARGO_POINTS', 5),
  NAME_HOP:          num('RISK_NAME_HOPPING_POINTS', 8),
  EMBARGO_FLAG:      num('RISK_EMBARGO_FLAG_POINTS', 12),
  FOC_FLAG:          num('RISK_FOC_FLAG_POINTS', 5),
  OLD_VESSEL:        num('RISK_OLD_VESSEL_POINTS', 6),
  HIGH_RISK_PORT:    num('RISK_HIGH_RISK_HOMEPORT_POINTS', 8),
  SANCTION_MATCH:    num('RISK_SANCTION_MATCH_POINTS', 60),
  PSC_BLACK_FLAG:    num('RISK_PSC_BLACK_FLAG_POINTS', 12),
  PSC_GREY_FLAG:     num('RISK_PSC_GREY_FLAG_POINTS', 5),
  PSC_BANNED:        num('RISK_PSC_BANNED_POINTS', 40),
  OLD_MIN_AGE:       num('RISK_OLD_VESSEL_MIN_AGE', 35),
  MULT_HIGH_RISK:    num('RISK_MULT_HIGH_RISK', 0.5),
  MULT_FOC:          num('RISK_MULT_FOC', 0.2),
};

// ── Mutable runtime state ────────────────────────────────────────────────────
// Shared by reference across modules so live updates (preset / import toggles)
// are visible everywhere without re-wiring.
const state = {
  preset: INITIAL_PRESET,
  boundingBox: null,
  bboxName: null,
  centerLat: null,
  centerLon: null,
  importVfData: props.IMPORT_VF_DATA === 'true',
  importMtData: props.IMPORT_MT_DATA === 'true',
  importSanctions: props.IMPORT_SANCTIONS === 'true',
  importPsc: props.IMPORT_PSC === 'true',
  // Equasis ownership lookup. Off by default and never auto-runs — only the
  // detail-view button triggers a fetch. Needs Equasis credentials too.
  importEquasis: props.IMPORT_EQUASIS === 'true',
  // Notifications default ON unless explicitly disabled in local.properties.
  notificationsEnabled: props.NOTIFICATIONS_ENABLED !== 'false',
  notifyRevisit: props.NOTIFY_REVISIT !== 'false',
  notifyAreaChange: props.NOTIFY_AREA_CHANGE !== 'false',
  notifyHighRisk: props.NOTIFY_HIGH_RISK !== 'false',
  // Berth lifecycle alerts: a new berth is detected, or one gets characterised.
  notifyBerthNew: props.NOTIFY_BERTH_NEW !== 'false',
  notifyBerthChar: props.NOTIFY_BERTH_CHAR !== 'false',
};

function applyPreset(preset) {
  const box = BBOX_PRESETS[preset].box;
  state.preset = preset;
  state.boundingBox = box;
  state.bboxName = BBOX_PRESETS[preset].name;
  state.centerLat = (box[0][0][0] + box[0][1][0]) / 2;
  state.centerLon = (box[0][0][1] + box[0][1][1]) / 2;
}
applyPreset(INITIAL_PRESET);

/** Change the active bounding-box preset and persist it. */
function setPreset(preset) {
  if (!BBOX_PRESETS[preset]) {
    throw new Error(`Preset sconosciuto. Validi: ${Object.keys(BBOX_PRESETS).join(', ')}`);
  }
  applyPreset(preset);
  saveProperty('BBOX_PRESET', preset);
}

function setImportVf(enabled) {
  state.importVfData = !!enabled;
  saveProperty('IMPORT_VF_DATA', state.importVfData);
}

function setImportMt(enabled) {
  state.importMtData = !!enabled;
  saveProperty('IMPORT_MT_DATA', state.importMtData);
}

function setImportSanctions(enabled) {
  state.importSanctions = !!enabled;
  saveProperty('IMPORT_SANCTIONS', state.importSanctions);
}

function setImportPsc(enabled) {
  state.importPsc = !!enabled;
  saveProperty('IMPORT_PSC', state.importPsc);
}

function setImportEquasis(enabled) {
  state.importEquasis = !!enabled;
  saveProperty('IMPORT_EQUASIS', state.importEquasis);
}

function setNotificationsEnabled(enabled) {
  state.notificationsEnabled = !!enabled;
  saveProperty('NOTIFICATIONS_ENABLED', state.notificationsEnabled);
}

function setNotifyRevisit(enabled) {
  state.notifyRevisit = !!enabled;
  saveProperty('NOTIFY_REVISIT', state.notifyRevisit);
}

function setNotifyAreaChange(enabled) {
  state.notifyAreaChange = !!enabled;
  saveProperty('NOTIFY_AREA_CHANGE', state.notifyAreaChange);
}

function setNotifyHighRisk(enabled) {
  state.notifyHighRisk = !!enabled;
  saveProperty('NOTIFY_HIGH_RISK', state.notifyHighRisk);
}

function setNotifyBerthNew(enabled) {
  state.notifyBerthNew = !!enabled;
  saveProperty('NOTIFY_BERTH_NEW', state.notifyBerthNew);
}

function setNotifyBerthChar(enabled) {
  state.notifyBerthChar = !!enabled;
  saveProperty('NOTIFY_BERTH_CHAR', state.notifyBerthChar);
}

/** Keyword for a preset (used to flag "expected" ships by destination). */
function currentKeyword(area) {
  return BBOX_PRESETS[area || state.preset]?.keyword || null;
}

// ── Runtime area management ───────────────────────────────────────────────────
// Areas can be added/removed at runtime; changes are persisted back to
// `bounding-boxes.json` so they survive a restart. BBOX_PRESETS is mutated in
// place (same object reference imported elsewhere), so live streams see updates.

/** Derive a safe, JSON-key-friendly slug from a free-text area name. */
function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'area';
}

/** Slug not yet used as a preset key (appends _2, _3, … on collision). */
function uniqueKey(base) {
  let key = base;
  let i = 2;
  while (BBOX_PRESETS[key]) key = `${base}_${i++}`;
  return key;
}

/** Serialize current presets back to bounding-boxes.json, preserving _comment. */
function saveBboxPresets() {
  let comment;
  try {
    comment = JSON.parse(fs.readFileSync(BBOX_FILE, 'utf8'))._comment;
  } catch {
    /* file unreadable — write without comment */
  }
  const out = {};
  if (comment) out._comment = comment;
  for (const [k, v] of Object.entries(BBOX_PRESETS)) {
    out[k] = { name: v.name, keyword: v.keyword || null, sw: v.box[0][0], ne: v.box[0][1] };
  }
  fs.writeFileSync(BBOX_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

/**
 * Add a monitoring area at runtime. Corners may be given in any order; they are
 * normalized to a true SW/NE pair. Returns the created area descriptor.
 */
function addArea({ name, sw, ne, keyword }) {
  if (!name || !String(name).trim()) throw new Error('Nome area obbligatorio');
  const ok = (c) => Array.isArray(c) && c.length === 2 && c.every((n) => Number.isFinite(Number(n)));
  if (!ok(sw) || !ok(ne)) throw new Error('Coordinate non valide: usa [lat, lon] in gradi decimali');
  const swLat = Math.min(Number(sw[0]), Number(ne[0]));
  const neLat = Math.max(Number(sw[0]), Number(ne[0]));
  const swLon = Math.min(Number(sw[1]), Number(ne[1]));
  const neLon = Math.max(Number(sw[1]), Number(ne[1]));
  if (swLat < -90 || neLat > 90 || swLon < -180 || neLon > 180) {
    throw new Error('Coordinate fuori range (lat -90..90, lon -180..180)');
  }
  if (swLat === neLat || swLon === neLon) throw new Error('Area degenerata: i due angoli coincidono');
  const key = uniqueKey(slugify(name));
  BBOX_PRESETS[key] = {
    box: [[[swLat, swLon], [neLat, neLon]]],
    name: String(name).trim(),
    keyword: keyword && String(keyword).trim() ? String(keyword).trim() : null,
  };
  saveBboxPresets();
  return { key, name: BBOX_PRESETS[key].name, keyword: BBOX_PRESETS[key].keyword, bbox: BBOX_PRESETS[key].box[0] };
}

/**
 * Merge a set of area definitions (the `bounding-boxes.json` shape) into the
 * current presets. Keys starting with `_` (e.g. `_comment`) are ignored. An
 * incoming key that already exists is updated in place; a new key is added.
 * Corners are normalized to a true SW/NE pair. Re-importing the same export is
 * idempotent. Returns `{ added: [keys], updated: [keys], skipped: [{key,reason}] }`.
 */
function importAreas(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('File aree non valido');
  const ok = (c) => Array.isArray(c) && c.length === 2 && c.every((n) => Number.isFinite(Number(n)));
  const added = [];
  const updated = [];
  const skipped = [];
  for (const [key, v] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;
    if (!v || typeof v !== 'object' || !ok(v.sw) || !ok(v.ne)) {
      skipped.push({ key, reason: 'coordinate non valide' });
      continue;
    }
    const swLat = Math.min(Number(v.sw[0]), Number(v.ne[0]));
    const neLat = Math.max(Number(v.sw[0]), Number(v.ne[0]));
    const swLon = Math.min(Number(v.sw[1]), Number(v.ne[1]));
    const neLon = Math.max(Number(v.sw[1]), Number(v.ne[1]));
    if (swLat < -90 || neLat > 90 || swLon < -180 || neLon > 180 || swLat === neLat || swLon === neLon) {
      skipped.push({ key, reason: 'coordinate fuori range o degeneri' });
      continue;
    }
    const existed = !!BBOX_PRESETS[key];
    BBOX_PRESETS[key] = {
      box: [[[swLat, swLon], [neLat, neLon]]],
      name: v.name && String(v.name).trim() ? String(v.name).trim() : key,
      keyword: v.keyword && String(v.keyword).trim() ? String(v.keyword).trim() : null,
    };
    (existed ? updated : added).push(key);
  }
  if (!added.length && !updated.length) {
    throw new Error('Nessuna area valida nel file');
  }
  saveBboxPresets();
  return { added, updated, skipped };
}

/**
 * Serialize the current presets to the portable `bounding-boxes.json` shape
 * (`{ key: { name, keyword, sw, ne } }`) for download/export.
 */
function exportAreas() {
  const out = {};
  for (const [k, v] of Object.entries(BBOX_PRESETS)) {
    out[k] = { name: v.name, keyword: v.keyword || null, sw: v.box[0][0], ne: v.box[0][1] };
  }
  return out;
}

/**
 * Remove an area. Refuses to drop the last remaining one. If the removed area
 * was the active view preset, switches to another and persists the change.
 * Returns `{ switched }` (the new preset key, or null).
 */
function removeArea(key) {
  if (!BBOX_PRESETS[key]) throw new Error(`Area sconosciuta: ${key}`);
  if (Object.keys(BBOX_PRESETS).length <= 1) throw new Error('Deve restare almeno un\'area');
  delete BBOX_PRESETS[key];
  saveBboxPresets();
  let switched = null;
  if (state.preset === key) {
    switched = Object.keys(BBOX_PRESETS)[0];
    applyPreset(switched);
    saveProperty('BBOX_PRESET', switched);
  }
  return { switched };
}

/**
 * Preset key whose bounding box contains the point. When several boxes overlap
 * (e.g. a wide "test" area over a port), the smallest (most specific) wins so a
 * ship in Taranto maps to "taranto", not the broader "puglia". null if outside
 * every box.
 */
function areaForPoint(lat, lon) {
  if (lat == null || lon == null) return null;
  let best = null;
  let bestArea = Infinity;
  for (const [key, p] of Object.entries(BBOX_PRESETS)) {
    const [[swLat, swLon], [neLat, neLon]] = p.box[0];
    if (lat >= swLat && lat <= neLat && lon >= swLon && lon <= neLon) {
      const a = (neLat - swLat) * (neLon - swLon);
      if (a < bestArea) {
        bestArea = a;
        best = key;
      }
    }
  }
  return best;
}

module.exports = {
  API_KEY,
  API_KEY_SOURCE,
  AUTH_USER,
  AUTH_PASSWORD,
  EQUASIS_USER,
  EQUASIS_PASSWORD,
  PORT,
  AIS_URL,
  MSG_TYPES,
  SOG_FERMA,
  STILL_RADIUS_M,
  ACTIVE_WINDOW_HOURS,
  PORT_WINDOW_HOURS,
  SCRAPE_CACHE_TTL,
  RECONNECT_DELAY_MS,
  MAX_READINGS_PER_TYPE,
  MAX_API_LOG_RECORDS,
  POLL_INTERVAL_MS,
  TRACK_MERGE_RADIUS_M,
  TRACK_DEFAULT_LIMIT,
  TRACK_MAX_LIMIT,
  MAX_BODY,
  NOTIF_DELETE_UNDO_SECONDS,
  BACKUP_INTERVAL_MIN,
  AUTO_RESTORE_ON_DEPLOY,
  APP_CONFIG_FILE,
  saveAppProperty,
  BERTH,
  RISK,
  BBOX_PRESETS,
  state,
  setPreset,
  setImportVf,
  setImportMt,
  setImportSanctions,
  setImportPsc,
  setImportEquasis,
  setNotificationsEnabled,
  setNotifyRevisit,
  setNotifyAreaChange,
  setNotifyHighRisk,
  setNotifyBerthNew,
  setNotifyBerthChar,
  currentKeyword,
  areaForPoint,
  addArea,
  removeArea,
  importAreas,
  exportAreas,
};
