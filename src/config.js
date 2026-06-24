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

// ── Multi-user auth (sessions) ───────────────────────────────────────────────
// Built-in administrator account, always (re)seeded at startup if absent. The
// password defaults to the shipped value but can be overridden via
// local.properties / env. Login accepts this username OR the synthetic email.
const DEFAULT_ADMIN_USERNAME = props.ADMIN_USERNAME || process.env.ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_EMAIL = props.ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@local';
const DEFAULT_ADMIN_PASSWORD = props.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'v*ZG!S@GE2^yK^';
// Session cookie name + flags. COOKIE_SECURE should be 'true' when served over
// HTTPS (the cookie is then withheld on plain HTTP). Default off for local dev.
const SESSION_COOKIE = 'tp_session';
const COOKIE_SECURE = (props.COOKIE_SECURE || process.env.COOKIE_SECURE) === 'true';
// Session lifetime in days.
const SESSION_TTL_DAYS = num('SESSION_TTL_DAYS', 30);

// ── Equasis credentials (optional) ───────────────────────────────────────────
// Needed only for the on-demand Equasis ownership lookup. The feature stays
// hidden/unusable until both are set.
const EQUASIS_USER = props.EQUASIS_USER || process.env.EQUASIS_USER || '';
const EQUASIS_PASSWORD = props.EQUASIS_PASSWORD || process.env.EQUASIS_PASSWORD || '';

// ── Global Fishing Watch API token (optional) ─────────────────────────────────
// The GFW API authenticates with a long-lived Bearer token generated in the GFW
// API portal (https://globalfishingwatch.org/our-apis/ → API tokens) — NOT the
// website username/password. Enrichment from GFW stays inert until it is set.
const GFW_TOKEN = props.GLOBAL_FISHING_WATCH_TOKEN || process.env.GLOBAL_FISHING_WATCH_TOKEN || '';
const GFW_TOKEN_SOURCE = props.GLOBAL_FISHING_WATCH_TOKEN
  ? 'local.properties'
  : process.env.GLOBAL_FISHING_WATCH_TOKEN
    ? 'env'
    : null;

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
// Negative cache: days a ship VF/MT returned no data for is skipped by the
// backfill (0 = disabled, always retry).
const SCRAPE_NEG_CACHE_DAYS = num('SCRAPE_NEG_CACHE_DAYS', 3);
const RECONNECT_DELAY_MS = num('RECONNECT_DELAY_MS', 5000);

// ── AIS outage detection ──────────────────────────────────────────────────────
// When an active stream stops receiving ship messages for AIS_OUTAGE_SILENCE_MIN
// minutes, the app cross-checks an AISStream uptime monitor
// (github.com/buttermilkgreen/AISStream-Uptime, MIT) via its /api/v1/status API.
// Only when that monitor also reports the service down does the UI raise a
// (non-blocking) disruption banner, so a genuinely quiet area never triggers a
// false alarm. Set AIS_OUTAGE_CHECK to 'false' to disable the whole feature.
//
// Two monitors can be consulted, in priority order (hybrid mode):
//   AIS_UPTIME_SELFHOST_URL — a self-hosted instance of the monitor (run it
//     yourself, MIT-licensed). Probed first, so a healthy deployment never
//     touches the public service. Empty (default) = no self-hosted instance.
//   AIS_UPTIME_URL — the public monitor. Used as a fallback when the self-hosted
//     one is unreachable, and it also reflects whether the outage is global
//     (community-wide), not just local to us.
const AIS_OUTAGE_CHECK = (appCfg.AIS_OUTAGE_CHECK ?? 'true') !== 'false';
const AIS_OUTAGE_SILENCE_MIN = num('AIS_OUTAGE_SILENCE_MIN', 10);
const AIS_UPTIME_URL = (appCfg.AIS_UPTIME_URL || 'https://aisuptime.buttermilkgreen.fyi').replace(/\/+$/, '');
const AIS_UPTIME_SELFHOST_URL = (appCfg.AIS_UPTIME_SELFHOST_URL || '').replace(/\/+$/, '');
const MAX_READINGS_PER_TYPE = num('MAX_READINGS_PER_TYPE', 10000);
// API audit trail (api_log table) is capped to the most recent N requests;
// older rows are pruned on every insert (see db.js) so the table can't grow
// unbounded. Default 1000 — enough to inspect recent activity without bloat.
const MAX_API_LOG_RECORDS = num('MAX_API_LOG_RECORDS', 1000);
const POLL_INTERVAL_MS = num('POLL_INTERVAL_MS', 300000);
const TRACK_MERGE_RADIUS_M = num('TRACK_MERGE_RADIUS_M', 100);
const TRACK_DEFAULT_LIMIT = num('TRACK_DEFAULT_LIMIT', 500);
const TRACK_MAX_LIMIT = num('TRACK_MAX_LIMIT', 2000);
// Per-body cap for the api_log audit trail. Average logged body is ~600B, so
// 2KB keeps virtually every real payload intact while capping the rare large
// response that would otherwise bloat the log table.
const MAX_BODY = num('MAX_BODY_BYTES', 2048);
const NOTIF_DELETE_UNDO_SECONDS = num('NOTIF_DELETE_UNDO_SECONDS', 5);

// ── Follow (segui) parameters ────────────────────────────────────────────────
// Half-side of the per-ship bounding box, in degrees: a FOLLOW_BOX_DEG box is
// ~2× this wide. 0.5° ≈ 60nm of latitude — comfortably covers a fast ship's
// movement between two refreshes.
const FOLLOW_BOX_HALF_DEG = num('FOLLOW_BOX_HALF_DEG', 0.5);
// How often the follow stream rebuilds its boxes from current positions and
// re-subscribes, and runs the inactivity auto-stop sweep.
const FOLLOW_REFRESH_MS = num('FOLLOW_REFRESH_MIN', 5) * 60 * 1000;
// A followed ship with no position for this many hours is auto-unfollowed and
// moves to the "passate" history.
const FOLLOW_STALE_HOURS = num('FOLLOW_STALE_HOURS', 48);

// Max size (MB) of an uploaded restore/bundle body. Caps the in-memory buffer
// express.raw() allocates, so a single request can't exhaust memory. Generous
// by default to fit a large base64-encoded database (~1.3× the .db size).
const MAX_UPLOAD_MB = num('MAX_UPLOAD_MB', 512);

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
  // How often (minutes) to recompute only the areas that received new arrivals
  // since the last flush, so the berth list stays fresh without a full sweep.
  DIRTY_FLUSH_MIN: num('BERTH_DIRTY_FLUSH_MIN', 2),
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
  // Global Fishing Watch behavioural-event signatures (AIS-derived, authoritative
  // — far stronger than the local-reading heuristics they reinforce).
  GFW_ENCOUNTER:     num('RISK_GFW_ENCOUNTER', 18),
  GFW_GAP:           num('RISK_GFW_GAP', 15),
  GFW_LOITERING:     num('RISK_GFW_LOITERING', 12),
  GFW_PORT_HIGH:     num('RISK_GFW_PORT_VISIT_HIGH_RISK', 15),
  OLD_MIN_AGE:       num('RISK_OLD_VESSEL_MIN_AGE', 35),
  MULT_HIGH_RISK:    num('RISK_MULT_HIGH_RISK', 0.5),
  MULT_FOC:          num('RISK_MULT_FOC', 0.2),
};

// ── Per-cargo-type risk weights (runtime-editable, persisted to local.properties)
// Replaces the old flat HAZMAT/CARGO points: the ship's cargo class (derived
// from VesselFinder/MarineTraffic subtype, falling back to the AIS code) picks a
// weight here. Stored as a single JSON property RISK_CARGO_WEIGHTS so the whole
// map round-trips in one settings line; unknown keys are dropped and missing
// keys keep their built-in default. Unlike the RISK.* weights above (boot-only,
// from app.config.properties) these are editable live from the Settings UI.
const { DEFAULT_CARGO_WEIGHTS } = require('./services/cargo-type');

/** Sanitize an incoming weight map: keep only known classes, coerce to a
 *  non-negative number, and fall back to the default for anything missing. */
function normalizeCargoWeights(raw) {
  const out = { ...DEFAULT_CARGO_WEIGHTS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_CARGO_WEIGHTS)) {
      const v = Number(raw[k]);
      if (Number.isFinite(v) && v >= 0) out[k] = v;
    }
  }
  return out;
}

function parseCargoWeightsProp() {
  if (!props.RISK_CARGO_WEIGHTS) return { ...DEFAULT_CARGO_WEIGHTS };
  try {
    return normalizeCargoWeights(JSON.parse(props.RISK_CARGO_WEIGHTS));
  } catch {
    return { ...DEFAULT_CARGO_WEIGHTS };
  }
}

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
  // Extended sanctions lists (EU / UK OFSI / UN), on top of OFAC SDN. Only
  // effective while importSanctions is on. Default ON unless explicitly disabled.
  importSanctionsExtra: props.IMPORT_SANCTIONS_EXTRA !== 'false',
  importPsc: props.IMPORT_PSC === 'true',
  // Equasis ownership lookup. Off by default and never auto-runs — only the
  // detail-view button triggers a fetch. Needs Equasis credentials too.
  importEquasis: props.IMPORT_EQUASIS === 'true',
  // Global Fishing Watch enrichment (vessel identity + behavioural events).
  // Default ON unless explicitly disabled. Effective only when a GFW token is
  // set; otherwise the enrichment no-ops and the detail panel shows a hint.
  importGfw: props.IMPORT_GFW !== 'false',
  // Operational application log (human-readable event log). Default ON unless
  // explicitly disabled in local.properties.
  appLogEnabled: props.APP_LOG_ENABLED !== 'false',
  // UI language the operational log writes in. Mirrors the browser's localStorage
  // 'lang' (captured from the lang= query the frontend sends on every API call),
  // so background events log in whatever language the app is showing. Persisted
  // so the language survives a restart until the next request refreshes it.
  uiLang: props.UI_LANG === 'en' ? 'en' : 'it',
  // Notifications default ON unless explicitly disabled in local.properties.
  notificationsEnabled: props.NOTIFICATIONS_ENABLED !== 'false',
  notifyRevisit: props.NOTIFY_REVISIT !== 'false',
  notifyAreaChange: props.NOTIFY_AREA_CHANGE !== 'false',
  notifyHighRisk: props.NOTIFY_HIGH_RISK !== 'false',
  // Berth lifecycle alerts: a new berth is detected, or one gets characterised.
  notifyBerthNew: props.NOTIFY_BERTH_NEW !== 'false',
  notifyBerthChar: props.NOTIFY_BERTH_CHAR !== 'false',
  // Exclude tankers from the ship-type risk bonus. When ON, tanker hulls
  // (AIS type 80–89) get no CARGO/HAZMAT *type* points — useful when monitoring
  // arms transport, which tankers cannot carry. Default OFF (current behaviour).
  excludeTankers: props.EXCLUDE_TANKERS === 'true',
  // Per-cargo-type risk weights (see normalizeCargoWeights / DEFAULT_CARGO_WEIGHTS).
  cargoWeights: parseCargoWeightsProp(),
  // Id of the weight preset ("classe di pesi") the live weights were last set
  // from, or null when they were hand-edited (a "custom" set). Purely a UI hint
  // so Settings can show which preset is active; the authoritative weights are
  // always state.cargoWeights. Built-in ids live in BUILTIN_CARGO_PRESETS,
  // user-defined ones in the DB `meta` table.
  cargoWeightsPreset: props.RISK_CARGO_WEIGHTS_PRESET || null,
  // Risk-factor switches for signals that are unreliable in poorly-covered areas.
  // Both default ON; turning one off removes that factor from the score entirely.
  //   checkSpoofing     → "Impossible position jump" (sparse AIS = false jumps)
  //   checkDarkActivity → "AIS blackout" (coverage gaps look like deliberate dark)
  checkSpoofing: props.CHECK_SPOOFING !== 'false',
  checkDarkActivity: props.CHECK_DARK_ACTIVITY !== 'false',
  // OpenSeaMap overlay, split into two INDEPENDENT layers (both client-side,
  // no DB, no API key, default ON):
  //   showOpenSeaMap        → the seamark *tile* raster on every map (lights,
  //     beacons, marks…). All-or-nothing: a raster can't be filtered per element.
  //   showOpenSeaMapMarkers → the Overpass *vector* markers on the overview map
  //     (harbours/berths/… — filterable per category via openSeaMapHidden).
  showOpenSeaMap: props.SHOW_OPENSEAMAP === 'true',
  showOpenSeaMapMarkers: props.SHOW_OPENSEAMAP_MARKERS !== 'false',
  // OpenSeaMap marker categories the user has HIDDEN (JSON array of category
  // keys; the keys live in public/js/seamarks.js). Empty/absent = show all,
  // which is the default. Stored as the disabled set, not the enabled set, so
  // categories added in a future version default to visible.
  openSeaMapHidden: parseOpenSeaMapHidden(),
};

function parseOpenSeaMapHidden() {
  try {
    const v = JSON.parse(props.OPENSEAMAP_HIDDEN || '["light","beacon","pilot"]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

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

function setImportSanctionsExtra(enabled) {
  state.importSanctionsExtra = !!enabled;
  saveProperty('IMPORT_SANCTIONS_EXTRA', state.importSanctionsExtra);
}

function setImportPsc(enabled) {
  state.importPsc = !!enabled;
  saveProperty('IMPORT_PSC', state.importPsc);
}

function setImportEquasis(enabled) {
  state.importEquasis = !!enabled;
  saveProperty('IMPORT_EQUASIS', state.importEquasis);
}

function setImportGfw(enabled) {
  state.importGfw = !!enabled;
  saveProperty('IMPORT_GFW', state.importGfw);
}

function setAppLogEnabled(enabled) {
  state.appLogEnabled = !!enabled;
  saveProperty('APP_LOG_ENABLED', state.appLogEnabled);
}

/** Track the UI language (for the operational log). Persists only on a change. */
function setUiLang(lang) {
  const v = lang === 'en' ? 'en' : 'it';
  if (v === state.uiLang) return;
  state.uiLang = v;
  saveProperty('UI_LANG', v);
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

function setExcludeTankers(enabled) {
  state.excludeTankers = !!enabled;
  saveProperty('EXCLUDE_TANKERS', state.excludeTankers);
}

function setCheckSpoofing(enabled) {
  state.checkSpoofing = !!enabled;
  saveProperty('CHECK_SPOOFING', state.checkSpoofing);
}

function setCheckDarkActivity(enabled) {
  state.checkDarkActivity = !!enabled;
  saveProperty('CHECK_DARK_ACTIVITY', state.checkDarkActivity);
}

function setShowOpenSeaMap(enabled) {
  state.showOpenSeaMap = !!enabled;
  saveProperty('SHOW_OPENSEAMAP', state.showOpenSeaMap);
}

function setShowOpenSeaMapMarkers(enabled) {
  state.showOpenSeaMapMarkers = !!enabled;
  saveProperty('SHOW_OPENSEAMAP_MARKERS', state.showOpenSeaMapMarkers);
}

/** Replace the set of hidden OpenSeaMap marker categories and persist it as one
 *  JSON line. Accepts an array of category-key strings; anything else clears it. */
function setOpenSeaMapHidden(list) {
  const arr = Array.isArray(list) ? [...new Set(list.filter((x) => typeof x === 'string'))] : [];
  state.openSeaMapHidden = arr;
  saveProperty('OPENSEAMAP_HIDDEN', JSON.stringify(arr));
  return arr;
}

/** Update the per-cargo-type risk weights and persist them as one JSON line.
 *  Accepts a partial map; unknown keys are dropped, missing keys keep their
 *  current/default value. Returns the full normalized map. */
function setCargoWeights(map) {
  state.cargoWeights = normalizeCargoWeights({ ...state.cargoWeights, ...(map || {}) });
  saveProperty('RISK_CARGO_WEIGHTS', JSON.stringify(state.cargoWeights));
  return state.cargoWeights;
}

/** Record which weight preset the live weights came from (or null = custom).
 *  Stored as a plain string in local.properties so it round-trips with the
 *  other settings; the empty string is normalized to null. */
function setCargoWeightsPreset(id) {
  state.cargoWeightsPreset = id ? String(id) : null;
  saveProperty('RISK_CARGO_WEIGHTS_PRESET', state.cargoWeightsPreset || '');
  return state.cargoWeightsPreset;
}

/** Keyword for a preset (used to flag "expected" ships by destination). */
function currentKeyword(area) {
  return BBOX_PRESETS[area || state.preset]?.keyword || null;
}

/**
 * Stable signature of the current area definitions (keys + corner coordinates).
 * Used to decide whether a coordinate-based area reconcile needs to run again:
 * the expensive full-table reconcile is skipped at startup unless this changed.
 */
function bboxSignature() {
  const parts = Object.keys(BBOX_PRESETS)
    .sort()
    .map((k) => `${k}:${JSON.stringify(BBOX_PRESETS[k].box[0])}`);
  return parts.join('|');
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

// Lazily reach the db module from inside area functions. A top-level
// `require('./db')` would form a cycle (db.js requires this config at load);
// resolving it at call time (after both modules finish loading) breaks it.
function dbLazy() {
  return require('./db');
}

/**
 * Reconcile the in-memory area presets with the DB catalog (the source of truth
 * that replaced bounding-boxes.json). Called once at startup AFTER the db is
 * ready: seeds the catalog from the bootstrap JSON when empty, then rebuilds
 * BBOX_PRESETS from the catalog so the DB wins. The BBOX_PRESETS object is
 * mutated in place (same reference held by streams/areaForPoint elsewhere).
 */
function syncAreasWithDb(createdBy = null) {
  const db = dbLazy();
  const list = Object.entries(BBOX_PRESETS).map(([key, v]) => ({
    key, name: v.name, keyword: v.keyword || null, sw: v.box[0][0], ne: v.box[0][1],
  }));
  const seeded = db.seedAreaCatalogIfEmpty(list, createdBy);
  const rows = db.getAllAreas();
  if (rows.length) {
    for (const k of Object.keys(BBOX_PRESETS)) delete BBOX_PRESETS[k];
    for (const r of rows) {
      BBOX_PRESETS[r.key] = {
        box: [[[r.sw_lat, r.sw_lon], [r.ne_lat, r.ne_lon]]],
        name: r.name,
        keyword: r.keyword || null,
      };
    }
    if (!BBOX_PRESETS[state.preset]) applyPreset(Object.keys(BBOX_PRESETS)[0]);
  }
  return { seeded, count: rows.length };
}

/** Persist one area into the DB catalog (mirror of the in-memory preset). */
function persistAreaToDb(key) {
  const v = BBOX_PRESETS[key];
  if (!v) return;
  try {
    dbLazy().upsertArea({ key, name: v.name, keyword: v.keyword || null, sw: v.box[0][0], ne: v.box[0][1] });
  } catch { /* db not ready (shouldn't happen post-boot) */ }
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
  persistAreaToDb(key);
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
  for (const key of [...added, ...updated]) persistAreaToDb(key);
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
  delete BBOX_PRESETS[key];
  saveBboxPresets();
  try { dbLazy().deleteAreaRow(key); } catch { /* db not ready */ }
  // If the removed area was the active view preset, switch to any remaining one.
  // Multi-user: the catalog may now be empty — leave the stale preset (no streams,
  // areaForPoint returns null) rather than crashing.
  let switched = null;
  if (state.preset === key) {
    const next = Object.keys(BBOX_PRESETS)[0];
    if (next) {
      switched = next;
      applyPreset(next);
      saveProperty('BBOX_PRESET', next);
    }
  }
  return { switched, empty: Object.keys(BBOX_PRESETS).length === 0 };
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
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  SESSION_COOKIE,
  COOKIE_SECURE,
  SESSION_TTL_DAYS,
  EQUASIS_USER,
  EQUASIS_PASSWORD,
  GFW_TOKEN,
  GFW_TOKEN_SOURCE,
  PORT,
  AIS_URL,
  MSG_TYPES,
  SOG_FERMA,
  STILL_RADIUS_M,
  ACTIVE_WINDOW_HOURS,
  PORT_WINDOW_HOURS,
  SCRAPE_CACHE_TTL,
  SCRAPE_NEG_CACHE_DAYS,
  RECONNECT_DELAY_MS,
  AIS_OUTAGE_CHECK,
  AIS_OUTAGE_SILENCE_MIN,
  AIS_UPTIME_URL,
  AIS_UPTIME_SELFHOST_URL,
  MAX_READINGS_PER_TYPE,
  MAX_API_LOG_RECORDS,
  POLL_INTERVAL_MS,
  TRACK_MERGE_RADIUS_M,
  TRACK_DEFAULT_LIMIT,
  TRACK_MAX_LIMIT,
  MAX_BODY,
  MAX_UPLOAD_MB,
  NOTIF_DELETE_UNDO_SECONDS,
  FOLLOW_BOX_HALF_DEG,
  FOLLOW_REFRESH_MS,
  FOLLOW_STALE_HOURS,
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
  setImportSanctionsExtra,
  setImportPsc,
  setImportEquasis,
  setImportGfw,
  setAppLogEnabled,
  setUiLang,
  setNotificationsEnabled,
  setNotifyRevisit,
  setNotifyAreaChange,
  setNotifyHighRisk,
  setNotifyBerthNew,
  setNotifyBerthChar,
  setExcludeTankers,
  setCheckSpoofing,
  setCheckDarkActivity,
  setShowOpenSeaMap,
  setShowOpenSeaMapMarkers,
  setOpenSeaMapHidden,
  setCargoWeights,
  setCargoWeightsPreset,
  normalizeCargoWeights,
  DEFAULT_CARGO_WEIGHTS,
  currentKeyword,
  bboxSignature,
  areaForPoint,
  addArea,
  removeArea,
  importAreas,
  exportAreas,
  syncAreasWithDb,
};
