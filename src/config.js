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

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sanitize a properties value: strip CR/LF so a value can never inject extra
 * lines into the file (a `\n` in an id/JSON would otherwise forge new keys).
 */
function sanitizePropValue(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ');
}

/**
 * Write a file atomically: write to a temp file and rename over the target, so a
 * crash mid-write can never leave a half-written (corrupt) config that would then
 * break the next boot (e.g. a truncated local.properties → "AIS_API_KEY missing").
 */
function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Upsert a single `key=value` line in local.properties. Creates the file if it
 * is missing (e.g. when the API key comes from env) so runtime settings still
 * persist across restarts instead of being silently dropped.
 */
function saveProperty(key, value) {
  const val = sanitizePropValue(value);
  let content = fs.existsSync(PROPERTIES_FILE) ? fs.readFileSync(PROPERTIES_FILE, 'utf8') : '';
  const re = new RegExp(`^${escapeRegExp(key)}=.*`, 'm');
  if (re.test(content)) {
    // Function replacer so `$&`/`$'`/`$1` in the value are treated literally.
    content = content.replace(re, () => `${key}=${val}`);
  } else {
    content += `${content.endsWith('\n') || content === '' ? '' : '\n'}${key}=${val}\n`;
  }
  writeFileAtomic(PROPERTIES_FILE, content);
}

/**
 * Upsert a `key=value` line in app.config.properties, preserving comments and
 * layout. These values are read once at startup, so a write only takes effect
 * after a server restart (the Settings UI tells the user so).
 */
function saveAppProperty(key, value) {
  const val = sanitizePropValue(value);
  let content = fs.existsSync(APP_CONFIG_FILE) ? fs.readFileSync(APP_CONFIG_FILE, 'utf8') : '';
  const re = new RegExp(`^${escapeRegExp(key)}=.*`, 'm');
  if (re.test(content)) {
    content = content.replace(re, () => `${key}=${val}`);
  } else {
    content += `${content.endsWith('\n') || content === '' ? '' : '\n'}${key}=${val}\n`;
  }
  writeFileAtomic(APP_CONFIG_FILE, content);
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

// Separate key for the admin global-coverage heatmap (services/heatmap-stream.js).
// Optional: when absent the heatmap feature is inert (the page reports it off).
// Isolating it from API_KEY keeps the worldwide firehose from putting the core
// monitoring account at risk of throttling.
const HEATMAP_API_KEY = props.HEATMAP_AIS_API_KEY || process.env.HEATMAP_AIS_API_KEY || '';
const HEATMAP_API_KEY_SOURCE = props.HEATMAP_AIS_API_KEY
  ? 'local.properties'
  : process.env.HEATMAP_AIS_API_KEY
    ? 'env'
    : null;

// Separate key for the ship-follow stream (services/ship-follow.js). AISstream
// limits concurrent connections PER KEY: when follow shares API_KEY with the
// per-area streams, the area connection holds the only slot and follow's handshake
// is refused with 429 in a loop. Giving follow its own key sidesteps that. Optional:
// falls back to API_KEY (original behaviour; backoff then keeps the 429 loop tame).
const FOLLOW_API_KEY = props.FOLLOW_AIS_API_KEY || process.env.FOLLOW_AIS_API_KEY || API_KEY;
const FOLLOW_API_KEY_SOURCE = props.FOLLOW_AIS_API_KEY
  ? 'local.properties'
  : process.env.FOLLOW_AIS_API_KEY
    ? 'env'
    : 'shared'; // reusing API_KEY

// Non-secret fingerprint of an API key for logs: last 4 chars only, so two streams
// using the same key show the same tail (handy when diagnosing per-key 429s)
// without ever writing the secret to the log.
const maskKey = (k) => (k ? `…${String(k).slice(-4)}` : 'none');

// ── Multi-user auth (sessions) ───────────────────────────────────────────────
// Built-in administrator account, always (re)seeded at startup if absent. The
// password has NO built-in default — it must come from local.properties / env.
// A committed literal fallback here would ship the same admin password to every
// installation that forgets to set one, in a public git history. See server.js:
// boot refuses to start rather than ever create the admin with an empty/weak
// password. Login accepts this username OR the synthetic email.
const DEFAULT_ADMIN_USERNAME = props.ADMIN_USERNAME || process.env.ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_EMAIL = props.ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@local';
const DEFAULT_ADMIN_PASSWORD = props.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';
// Session cookie name + flags. The Secure flag is applied automatically on any
// HTTPS request (see useSecureCookie in middleware/session-auth), so a TLS
// deploy is protected without configuration. COOKIE_SECURE=true is an override
// that forces Secure on always — use it when the proxy terminates TLS but does
// not forward X-Forwarded-Proto. Leave it off for plain-HTTP/local deploys.
const SESSION_COOKIE = 'tp_session';
const COOKIE_SECURE = (props.COOKIE_SECURE || process.env.COOKIE_SECURE) === 'true';
// Session lifetime in days.
const SESSION_TTL_DAYS = num('SESSION_TTL_DAYS', 30);

// ── Tester account limits ─────────────────────────────────────────────────────
// Configurable in app.config.properties (restart required after change).
const TESTER_MAX_AREAS = num('TESTER_MAX_AREAS', 2);
const TESTER_MAX_AREA_KM2 = num('TESTER_MAX_AREA_KM2', 100);
const TESTER_MAX_FOLLOWS = num('TESTER_MAX_FOLLOWS', 5);

// ── Telegram bot token (optional) ────────────────────────────────────────────
// One bot serves all users; each user links their chat via a /start <code> flow
// (see services/telegram.js). The bot stays inert until the token is set. The
// token is a SECRET — keep it in local.properties (gitignored), never committed.
const TELEGRAM_BOT_TOKEN = props.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_BOT_TOKEN_SOURCE = props.TELEGRAM_BOT_TOKEN
  ? 'local.properties'
  : process.env.TELEGRAM_BOT_TOKEN
    ? 'env'
    : null;

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
  return presets;
}

// Empty on a fresh install (no areas pre-seeded) is a valid, fully-supported
// state — same one you reach at runtime by deleting every area via the UI
// (see removeArea). Only an EXPLICIT BBOX_PRESET pointing at a missing key is
// a misconfiguration worth failing boot over.
const BBOX_PRESETS = loadBboxPresets(BBOX_FILE);

const INITIAL_PRESET =
  props.BBOX_PRESET || process.env.BBOX_PRESET || Object.keys(BBOX_PRESETS)[0] || null;
if (INITIAL_PRESET && !BBOX_PRESETS[INITIAL_PRESET]) {
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

// ── Global coverage heatmap (admin-only) ─────────────────────────────────────
// A worldwide AISStream subscription whose position reports are aggregated into a
// fixed lat/lon grid (message counts per cell) to visualise where AIS coverage is
// dense and where the holes are. See services/heatmap-stream.js. All boot-only
// (app.config.properties); the feature also needs HEATMAP_AIS_API_KEY set.
//   GRID_DEG    — FINEST cell size in degrees, the resolution data is bucketed at
//                 on ingest (0.05° ≈ 5.5 km). Coarser zoom levels are derived by
//                 aggregating fine cells up (LEVELS); you can sum fine→coarse but
//                 never recover detail from coarse, so always ingest at the finest
//                 you'll ever want to show. Bucketing is implicit in the stored
//                 cell index (floor(coord/GRID_DEG)), so changing this value makes
//                 existing cells incompatible — heatmap-db.js tags the DB with the
//                 grid and discards mismatched cells (on boot and on restore).
//   LEVELS      — cell sizes (deg) the client may request per zoom. Each must be a
//                 ~integer multiple of GRID_DEG so aggregation is exact; the server
//                 snaps any request to the nearest achievable factor.
//   PRUNE_*     — daily noise sweep: drop cells with msg_count ≤ MIN_COUNT not seen
//                 in AGE_DAYS (one-off AIS pings) so the DB stays bounded over months.
//   FLUSH_MS    — how often in-memory cell deltas are batch-written to SQLite
//                 (never per-message — that would hammer the disk on a firehose).
//   MSG_TYPES   — position-report types counted. Static data is excluded (it adds
//                 volume without improving the coverage picture). Class-B reports
//                 are kept so recreational-only zones don't read as false holes.
//   STATS_MS    — cadence of the live bandwidth/throughput SSE pushed to the page.
const HEATMAP = {
  GRID_DEG: num('HEATMAP_GRID_DEG', 0.05),
  LEVELS: [0.05, 0.1, 0.25, 0.5, 1.0, 2.0],
  PRUNE_MIN_COUNT: num('HEATMAP_PRUNE_MIN_COUNT', 2),
  PRUNE_AGE_DAYS: num('HEATMAP_PRUNE_AGE_DAYS', 30),
  FLUSH_MS: num('HEATMAP_FLUSH_SEC', 10) * 1000,
  STATS_MS: num('HEATMAP_STATS_SEC', 2) * 1000,
  MSG_TYPES: ['PositionReport', 'ExtendedClassBPositionReport', 'StandardClassBPositionReport'],
  // Whole-globe box AISStream expects as [[swLat, swLon], [neLat, neLon]].
  WORLD_BOX: [[-90, -180], [90, 180]],
};

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
// Exponential-backoff ceiling for AIS reconnects, and a longer floor applied when
// the handshake was refused with HTTP 429 (rate/connection limit). Without these a
// 429 sends the stream into a fixed-5s reconnect loop that hammers AISstream and
// never recovers (the per-key connection slot stays contended). See ais-backoff.js.
const RECONNECT_MAX_DELAY_MS = num('RECONNECT_MAX_DELAY_MS', 5 * 60 * 1000);
const RECONNECT_429_DELAY_MS = num('RECONNECT_429_DELAY_MS', 60 * 1000);

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
// Group activity audit trail (group_activity_log table, services/group-sync.js):
// rows older than this are pruned periodically (see db.js) so the table can't
// grow unbounded.
const GROUP_ACTIVITY_LOG_RETENTION_DAYS = num('GROUP_ACTIVITY_LOG_RETENTION_DAYS', 90);
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
// moves to the "passate" history. Until then it stays on the worldwide
// re-acquire net (see ship-follow.buildSubscription) and resumes automatically
// the moment it transmits again — so this is a deliberately long cutoff (default
// ~6 months) that only sweeps away truly dead follows, not coverage gaps.
const FOLLOW_STALE_HOURS = num('FOLLOW_STALE_HOURS', 4320);
// How long a ship-search position lookup waits for a live AIS fix before giving
// up (the worldwide-box subscription is dropped and the UI offers "Riprova").
// Re-following a ship (background re-acquisition) reuses the same timeout.
const SEARCH_LOOKUP_TIMEOUT_MS = num('SEARCH_LOOKUP_TIMEOUT_SEC', 90) * 1000;
// A followed ship whose last position is newer than this is "fresh": its tight
// follow box still covers it, so re-following needs no worldwide re-acquisition.
// Older (or missing) → trigger a background worldwide re-acquire.
const FOLLOW_FRESH_MS = num('FOLLOW_FRESH_MIN', 60) * 60 * 1000;
// Min gap between ShipFinder position scrapes for the same ship during the
// stale-follow re-acquire sweep. The follow refresh runs every FOLLOW_REFRESH_MS;
// this throttle keeps us from re-hitting ShipFinder for the same vessel each pass
// (default 30 min) so the worldwide AIS box stays the primary recovery path and
// ShipFinder is only an occasional fallback — also keeps request volume captcha-safe.
const SF_REACQUIRE_THROTTLE_MS = num('SF_REACQUIRE_THROTTLE_MIN', 60) * 60 * 1000;
// Cap on how many stale follows we scrape from ShipFinder in a single sweep, so a
// large lost-follow backlog can't burst-hammer the site.
const SF_REACQUIRE_MAX_PER_SWEEP = num('SF_REACQUIRE_MAX_PER_SWEEP', 20);
// Minimum distance (metres) a scraped position must differ from the previous fix
// for the same ship+source before a new row is inserted. Within this radius the
// existing row's timestamp is updated instead, preventing port-cluster bloat.
// Overridable at runtime via admin Settings. Zero = disabled.
const SCRAPE_CLUSTER_RADIUS_M_DEFAULT = num('SCRAPE_CLUSTER_RADIUS_M', 200);

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

// ── Ship-to-ship proximity (rendezvous) detection ────────────────────────────
// A periodic per-area scan flags pairs of distinct vessels that linger close
// together offshore while both are slow — the classic ship-to-ship transfer
// signature. SCAN_MIN = 0 disables the scan entirely. Distances in metres, the
// dwell threshold in minutes, the speed gate in knots. BERTH_M excludes ships
// sitting in a known port (within BERTH_M of any computed berth centroid) — the
// real "in port vs offshore" signal. FAR_KM is only a fallback for areas with
// no computed berths yet: distance from the bbox centre beyond which a pair
// counts as offshore. CLOSE_MULT widens the separation that keeps an open
// contact alive (hysteresis) so a single noisy fix doesn't flap it shut.
const PROXIMITY = {
  SCAN_MIN: num('PROXIMITY_SCAN_MIN', 10),
  DIST_M: num('PROXIMITY_DIST_M', 500),
  CLOSE_MULT: num('PROXIMITY_CLOSE_MULT', 1.5),
  MIN_MINUTES: num('PROXIMITY_MIN_MINUTES', 10),
  MAX_SOG_KN: num('PROXIMITY_MAX_SOG_KN', 3),
  BERTH_M: num('PROXIMITY_BERTH_M', 600),
  FAR_KM: num('PROXIMITY_FAR_KM', 10),
  FRESH_MIN: num('PROXIMITY_FRESH_MIN', 20),
};

// ── Historical replay (time-scrubber on the area map) ────────────────────────
// MAX_POINTS caps the positions a single replay query returns; over the cap the
// server downsamples per ship (keeps every Nth fix) and flags the response as
// truncated. MAX_GAP_MIN: a ship is hidden at clock times that fall inside a gap
// between two fixes longer than this (no fabricated motion across missing data).
// TAIL_MIN: how many trailing minutes of path the fading trail shows (client).
const REPLAY = {
  MAX_POINTS: num('REPLAY_MAX_POINTS', 40000),
  MAX_GAP_MIN: num('REPLAY_MAX_GAP_MIN', 30),
  TAIL_MIN: num('REPLAY_TAIL_MIN', 20),
};

// ── "Ricerca navi per aree di transito" (see db.getAreaTransits) ─────────────
// A visit counts as a STOP (the area was the destination, not just a bbox the
// ship crossed) when it lasted at least STOP_MIN_H; visits closed after the
// port_events.stopped column exists also require the minimum observed speed to
// be under STOP_MAX_SOG_KN (readings are still in DB when departure is logged,
// so that flag is accurate — older visits fall back to dwell alone).
// A leg between the two areas counts when no stop in ANY other catalog area sits
// in between and the elapsed time is compatible with a direct passage:
// gap <= max(MIN_SLACK_H, distance_nm / MIN_KN).
// "Cambio area": fire the notification only when the ship actually CALLED at the
// origin area (same stop criterion as the transit search, TRANSIT_STOP_MIN_H).
// A bbox is an area of interest, not a port: without this, a ship that merely
// crossed a wide area on its way elsewhere is announced as "moved from" it.
// Set AREA_CHANGE_REQUIRE_STOP=false to go back to notifying on every crossing.
const AREA_CHANGE_REQUIRE_STOP = appCfg.AREA_CHANGE_REQUIRE_STOP !== 'false';
// Same notification, second condition: the origin call must be recent enough to
// explain the ship being here now — elapsed time within what the passage
// plausibly takes (db.areaHopGate, driven by TRANSIT_MIN_KN / MIN_SLACK_H /
// MAX_GAP_DAYS). Without it, a call weeks old is announced as if it were the
// ship's provenance, while whatever it did in between happened outside our areas.
const AREA_CHANGE_REQUIRE_PLAUSIBLE_TIME = appCfg.AREA_CHANGE_REQUIRE_PLAUSIBLE_TIME !== 'false';
// Same notification, third condition: the two areas must not share water. Two
// overlapping (or nested) boxes contain the same positions, so which area a
// message belongs to depends on which subscription delivered it — a ship moored
// in the shared part flips between them and generates a stream of bogus
// "movements" while standing still. See db.boxesOverlap.
const AREA_CHANGE_SKIP_OVERLAPPING = appCfg.AREA_CHANGE_SKIP_OVERLAPPING !== 'false';

const TRANSIT = {
  STOP_MIN_H: num('TRANSIT_STOP_MIN_H', 3),
  STOP_MAX_SOG_KN: num('TRANSIT_STOP_MAX_SOG_KN', 0.5),
  MIN_KN: num('TRANSIT_MIN_KN', 4),
  MIN_SLACK_H: num('TRANSIT_MIN_SLACK_H', 12),
  MAX_GAP_DAYS: num('TRANSIT_MAX_GAP_DAYS', 30),
  MAX_ROWS: num('TRANSIT_MAX_ROWS', 500),
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
  // Minimum minutes the stationary-offshore fixes must span for the MAX score:
  // guards against a burst of high-frequency Class-A reports over seconds.
  LOITER_MIN_SPAN_MIN: num('RISK_LOITERING_MIN_SPAN_MIN', 20),
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
  // Ship-to-ship rendezvous (local detection): a confirmed close offshore
  // encounter within the trailing window adds points to BOTH ships. Set the
  // weight to 0 to disable the factor without stopping the detection scan.
  PROXIMITY:         num('RISK_PROXIMITY_POINTS', 18),
  PROXIMITY_WINDOW_DAYS: num('RISK_PROXIMITY_WINDOW_DAYS', 7),
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

// ── Live-editable risk-signal weights ────────────────────────────────────────
// The RISK object above holds the boot defaults (from app.config.properties).
// These point-contribution weights are additionally editable at runtime from the
// Settings UI (like the per-cargo weights): the override is persisted as a single
// JSON property RISK_WEIGHTS in local.properties, layered over the RISK defaults,
// and read by risk-score.js as state.riskWeights. Only these keys are editable —
// detection thresholds and multipliers stay boot-only (RISK). risk-score reads
// EVERY weight from state.riskWeights, so it always carries the full RISK set
// with just these keys overridable.
const EDITABLE_RISK_WEIGHTS = [
  'DARK_MAX', 'DARK_PARTIAL_MIN', 'SPOOF_MAX', 'SPOOF_ANOM_PTS',
  'LOITER_MAX', 'LOITER_PARTIAL', 'DRAUGHT_MAX', 'DRAUGHT_FACTOR',
  'DEST_MAX', 'DEST_PER_CHANGE', 'NAME_HOP', 'EMBARGO_FLAG', 'FOC_FLAG',
  'OLD_VESSEL', 'HIGH_RISK_PORT', 'SANCTION_MATCH', 'PSC_BLACK_FLAG',
  'PSC_GREY_FLAG', 'PSC_BANNED', 'GFW_ENCOUNTER', 'GFW_GAP', 'GFW_LOITERING',
  'GFW_PORT_HIGH', 'PROXIMITY',
];

// The editable defaults only (subset of RISK) — sent to the UI for "reset".
const DEFAULT_RISK_WEIGHTS = Object.fromEntries(EDITABLE_RISK_WEIGHTS.map((k) => [k, RISK[k]]));

// Merge a partial override onto the full RISK set: non-editable keys always keep
// their RISK default; editable keys take a finite, non-negative override.
function normalizeRiskWeights(raw) {
  const out = { ...RISK };
  if (raw && typeof raw === 'object') {
    for (const k of EDITABLE_RISK_WEIGHTS) {
      const v = Number(raw[k]);
      if (Number.isFinite(v) && v >= 0) out[k] = v;
    }
  }
  return out;
}

function parseRiskWeightsProp() {
  if (!props.RISK_WEIGHTS) return { ...RISK };
  try {
    return normalizeRiskWeights(JSON.parse(props.RISK_WEIGHTS));
  } catch {
    return { ...RISK };
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
  // ShipFinder enrichment: static fields (fallback, mostly duplicates VF/MT) plus
  // its unique free last-known position, used to re-locate lost followed ships.
  // Off by default, like VF/MT.
  importSfData: props.IMPORT_SF_DATA === 'true',
  // MyShipTracking enrichment: like ShipFinder, a free last-known position (plus
  // duplicate static fields) used to re-locate lost followed ships — a second,
  // independent position backup alongside SF. Off by default.
  importMstData: props.IMPORT_MST_DATA === 'true',
  // Per-ship scrape cooldown for SF and MST (ms). Overrides SF_REACQUIRE_THROTTLE_MS
  // at runtime; persisted to local.properties so changes survive restart.
  sfScrapeIntervalMs: +(props.SF_SCRAPE_INTERVAL_MS || SF_REACQUIRE_THROTTLE_MS),
  mstScrapeIntervalMs: +(props.MST_SCRAPE_INTERVAL_MS || SF_REACQUIRE_THROTTLE_MS),
  // Spatial dedup radius for scraped positions. New fix within this distance from
  // the last stored fix updates the timestamp instead of inserting a new row.
  scrapeClusterRadiusM: +(props.SCRAPE_CLUSTER_RADIUS_M || SCRAPE_CLUSTER_RADIUS_M_DEFAULT),
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
  // Live-editable risk-signal weights (see EDITABLE_RISK_WEIGHTS above) + the
  // named preset they came from (null = custom).
  riskWeights: parseRiskWeightsProp(),
  riskWeightsPreset: props.RISK_WEIGHTS_PRESET || null,
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
  // No areas configured yet (fresh install, or every area deleted) — leave the
  // "active view" fields null rather than crashing; see removeArea for the
  // same empty-catalog case at runtime.
  if (!preset || !BBOX_PRESETS[preset]) {
    state.preset = null;
    state.boundingBox = null;
    state.bboxName = null;
    state.centerLat = null;
    state.centerLon = null;
    return;
  }
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

function setImportSf(enabled) {
  state.importSfData = !!enabled;
  saveProperty('IMPORT_SF_DATA', state.importSfData);
}

function setImportMst(enabled) {
  state.importMstData = !!enabled;
  saveProperty('IMPORT_MST_DATA', state.importMstData);
}

function setSfScrapeInterval(ms) {
  state.sfScrapeIntervalMs = Math.max(60000, +ms || SF_REACQUIRE_THROTTLE_MS);
  saveProperty('SF_SCRAPE_INTERVAL_MS', state.sfScrapeIntervalMs);
}

function setMstScrapeInterval(ms) {
  state.mstScrapeIntervalMs = Math.max(60000, +ms || SF_REACQUIRE_THROTTLE_MS);
  saveProperty('MST_SCRAPE_INTERVAL_MS', state.mstScrapeIntervalMs);
}

function setScrapeClusterRadius(m) {
  state.scrapeClusterRadiusM = Math.max(0, +m || SCRAPE_CLUSTER_RADIUS_M_DEFAULT);
  saveProperty('SCRAPE_CLUSTER_RADIUS_M', state.scrapeClusterRadiusM);
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

// Live-editable risk-signal weights — same shape as the cargo-weights setters.
// Persists only the editable subset as JSON; risk-score reads state.riskWeights.
function setRiskWeights(map) {
  state.riskWeights = normalizeRiskWeights({ ...state.riskWeights, ...(map || {}) });
  const subset = Object.fromEntries(EDITABLE_RISK_WEIGHTS.map((k) => [k, state.riskWeights[k]]));
  saveProperty('RISK_WEIGHTS', JSON.stringify(subset));
  return subset;
}

function setRiskWeightsPreset(id) {
  state.riskWeightsPreset = id ? String(id) : null;
  saveProperty('RISK_WEIGHTS_PRESET', state.riskWeightsPreset || '');
  return state.riskWeightsPreset;
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
  writeFileAtomic(BBOX_FILE, JSON.stringify(out, null, 2) + '\n');
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
 * Edit an existing area in place: name, keyword and/or corners. The KEY never
 * changes (it is the foreign key of every reading/event/mooring row collected so
 * far), so the stored history stays attached to the area even if its box moves.
 * Only the fields present in `patch` are touched. Returns the updated descriptor
 * plus `boxChanged`, which the caller uses to decide whether the live
 * subscription has to be re-sent.
 */
function updateArea(key, { name, sw, ne, keyword } = {}) {
  const v = BBOX_PRESETS[key];
  if (!v) throw new Error(`Area sconosciuta: ${key}`);
  const next = { name: v.name, keyword: v.keyword || null, box: v.box[0] };
  if (name !== undefined) {
    if (!String(name).trim()) throw new Error('Nome area obbligatorio');
    next.name = String(name).trim();
  }
  if (keyword !== undefined) {
    next.keyword = keyword && String(keyword).trim() ? String(keyword).trim() : null;
  }
  let boxChanged = false;
  if (sw !== undefined || ne !== undefined) {
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
    const [[oSwLat, oSwLon], [oNeLat, oNeLon]] = v.box[0];
    boxChanged = swLat !== oSwLat || swLon !== oSwLon || neLat !== oNeLat || neLon !== oNeLon;
    next.box = [[swLat, swLon], [neLat, neLon]];
  }
  BBOX_PRESETS[key] = { box: [next.box], name: next.name, keyword: next.keyword };
  saveBboxPresets();
  persistAreaToDb(key);
  // The edited area may be the active view preset: refresh the derived state
  // (bboxName/centerLat/…) so the rest of the app sees the new name and box.
  if (state.preset === key) applyPreset(key);
  return { key, name: next.name, keyword: next.keyword, bbox: next.box, boxChanged };
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
 * Remove an area. The catalog CAN end up empty (a valid, supported state — see
 * applyPreset). If the removed area was the active view preset, switches to
 * another and persists the change. Returns `{ switched }` (the new preset key,
 * or null).
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

/** Approximate bbox area in km². Uses equirectangular projection at mid-latitude. */
function bboxAreaKm2(swLat, neLat, swLon, neLon) {
  const midLat = (swLat + neLat) / 2;
  const dLat = Math.abs(neLat - swLat) * 111.0;
  const dLon = Math.abs(neLon - swLon) * 111.0 * Math.cos((midLat * Math.PI) / 180);
  return dLat * dLon;
}

module.exports = {
  API_KEY,
  API_KEY_SOURCE,
  HEATMAP_API_KEY,
  HEATMAP_API_KEY_SOURCE,
  FOLLOW_API_KEY,
  FOLLOW_API_KEY_SOURCE,
  maskKey,
  HEATMAP,
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
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_TOKEN_SOURCE,
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
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_429_DELAY_MS,
  AIS_OUTAGE_CHECK,
  AIS_OUTAGE_SILENCE_MIN,
  AIS_UPTIME_URL,
  AIS_UPTIME_SELFHOST_URL,
  MAX_READINGS_PER_TYPE,
  MAX_API_LOG_RECORDS,
  GROUP_ACTIVITY_LOG_RETENTION_DAYS,
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
  SEARCH_LOOKUP_TIMEOUT_MS,
  FOLLOW_FRESH_MS,
  SF_REACQUIRE_THROTTLE_MS,
  SF_REACQUIRE_MAX_PER_SWEEP,
  BACKUP_INTERVAL_MIN,
  AUTO_RESTORE_ON_DEPLOY,
  APP_CONFIG_FILE,
  saveAppProperty,
  BERTH,
  PROXIMITY,
  REPLAY,
  TRANSIT,
  AREA_CHANGE_REQUIRE_STOP,
  AREA_CHANGE_REQUIRE_PLAUSIBLE_TIME,
  AREA_CHANGE_SKIP_OVERLAPPING,
  RISK,
  BBOX_PRESETS,
  state,
  setPreset,
  setImportVf,
  setImportMt,
  setImportSf,
  setImportMst,
  setSfScrapeInterval,
  setMstScrapeInterval,
  setScrapeClusterRadius,
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
  setRiskWeights,
  setRiskWeightsPreset,
  normalizeRiskWeights,
  DEFAULT_RISK_WEIGHTS,
  EDITABLE_RISK_WEIGHTS,
  currentKeyword,
  TESTER_MAX_AREAS,
  TESTER_MAX_AREA_KM2,
  TESTER_MAX_FOLLOWS,
  bboxAreaKm2,
  bboxSignature,
  areaForPoint,
  addArea,
  updateArea,
  removeArea,
  importAreas,
  exportAreas,
  syncAreasWithDb,
};
