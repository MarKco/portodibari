'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const cfg = require('./config');
const appLog = require('./services/app-log');
const auth = require('./services/auth');

// These values are interpolated into SQL strings below (parameter binding can't
// be used for LIMIT-in-subquery / datetime modifiers / predicate literals), so
// force each to a finite number first. They already come from config.num(), but
// this makes the interpolation injection-proof regardless of upstream changes.
const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const ACTIVE_WINDOW_HOURS = numOr(cfg.ACTIVE_WINDOW_HOURS, 6);
const PORT_WINDOW_HOURS = numOr(cfg.PORT_WINDOW_HOURS, 24);
const MAX_READINGS_PER_TYPE = numOr(cfg.MAX_READINGS_PER_TYPE, 10000);
const MAX_API_LOG_RECORDS = numOr(cfg.MAX_API_LOG_RECORDS, 1000);
const GROUP_ACTIVITY_LOG_RETENTION_DAYS = numOr(cfg.GROUP_ACTIVITY_LOG_RETENTION_DAYS, 90);
const DB_SOG_FERMA = numOr(cfg.SOG_FERMA, 0.5);
const TRANSIT = {
  STOP_MIN_H: numOr(cfg.TRANSIT?.STOP_MIN_H, 3),
  STOP_MAX_SOG_KN: numOr(cfg.TRANSIT?.STOP_MAX_SOG_KN, 0.5),
  MIN_KN: numOr(cfg.TRANSIT?.MIN_KN, 4),
  MIN_SLACK_H: numOr(cfg.TRANSIT?.MIN_SLACK_H, 12),
  MAX_GAP_DAYS: numOr(cfg.TRANSIT?.MAX_GAP_DAYS, 30),
  MAX_ROWS: numOr(cfg.TRANSIT?.MAX_ROWS, 500),
};

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// The SQLite file lives under data/db/ (was the project root in older versions —
// relocateDbFile moves a legacy root-level file here on first start of this version).
const { relocateDbFile } = require('./lib/db-location');
const DB_PATH = path.join(__dirname, '..', 'data', 'db', 'ais_data.db');
relocateDbFile(path.join(__dirname, '..', 'ais_data.db'), DB_PATH);
const db = new DatabaseSync(DB_PATH);

// node:sqlite's DatabaseSync has no transaction() helper (better-sqlite3, which
// this code was written against, does). Provide a compatible one: it returns a
// callable that wraps `fn` in BEGIN/COMMIT and ROLLBACKs on throw — matching the
// better-sqlite3 call sites (pruneOrphans, area-delete purge, the maintenance
// migrations). Without this every `db.transaction(...)` call throws
// "db.transaction is not a function" and its whole code path aborts.
if (typeof db.transaction !== 'function') {
  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try {
      const r = fn(...args);
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  };
}

// Exported for callers outside this module (e.g. services/berths.js incremental
// recompute) that batch several writes and want one commit instead of an
// implicit auto-commit per statement. Keep `fn` free of network/await calls —
// it runs synchronously inside BEGIN/COMMIT and would otherwise hold the write
// lock open for the duration of any I/O it triggers.
function runTransaction(fn) {
  return db.transaction(fn)();
}

db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA synchronous = NORMAL`);
// Wait (and retry internally) up to 5s for a lock instead of throwing
// SQLITE_BUSY ("database is locked") on the spot. WAL serializes writers, and a
// second connection can briefly contend during a deploy's backup→restore
// overlap or a checkpoint; without this any such collision throws and, if the
// throw lands somewhere unguarded, takes the whole process down.
db.exec(`PRAGMA busy_timeout = 5000`);
// Return freed pages to the OS incrementally so deletes/prunes actually shrink
// the file. On an existing DB created with auto_vacuum=NONE this pragma only
// takes effect after a one-time VACUUM (run by runMaintenance() at startup).
db.exec(`PRAGMA auto_vacuum = INCREMENTAL`);
// Cap how large the WAL can grow before a passive checkpoint folds it back into
// the main file. The long-lived AIS-stream/SSE readers can hold a passive
// checkpoint open indefinitely, so runMaintenance() also forces a TRUNCATE
// checkpoint on a timer — this just bounds growth between those.
db.exec(`PRAGMA wal_autocheckpoint = 400`);

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL,
    message_type TEXT NOT NULL,
    mmsi INTEGER,
    ship_name TEXT,
    latitude REAL,
    longitude REAL,
    navigational_status TEXT,
    sog REAL,
    cog REAL,
    true_heading INTEGER,
    raw_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_type_time ON readings(message_type, received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_mmsi ON readings(mmsi);
  CREATE INDEX IF NOT EXISTS idx_readings_received_at ON readings(received_at);

  CREATE TABLE IF NOT EXISTS ships (
    mmsi INTEGER PRIMARY KEY,
    ship_name TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_latitude REAL,
    last_longitude REAL,
    last_sog REAL,
    last_cog REAL,
    last_navigational_status TEXT,
    ship_type INTEGER,
    destination TEXT,
    max_draught REAL,
    flagged INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ships_last_seen ON ships(last_seen_at DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS api_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER,
    duration_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_api_log_ts ON api_log(ts DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS port_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mmsi INTEGER NOT NULL,
    ship_name TEXT,
    event_type TEXT NOT NULL,
    ts TEXT NOT NULL,
    ship_type INTEGER,
    destination TEXT,
    draught REAL
  );
  CREATE INDEX IF NOT EXISTS idx_port_events_ts ON port_events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_port_events_mmsi ON port_events(mmsi);
`);

// Notifications — in-app alert feed shown in the sidebar. Only the last
// MAX_NOTIFICATIONS rows are retained (pruned on every insert).
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    mmsi INTEGER,
    ship_name TEXT,
    area TEXT,
    band TEXT,
    score INTEGER,
    ts TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_id ON notifications(id DESC);
`);

// Risk-score history — periodic snapshots of each ship's computed risk score, so
// the detail view can plot how the score evolved over time (escalation = signal).
// Sampled sparsely (at most once per ship per hour, see recordRiskSnapshot) to
// keep the table small; globally capped with rotation.
db.exec(`
  CREATE TABLE IF NOT EXISTS risk_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mmsi INTEGER NOT NULL,
    ts TEXT NOT NULL,
    score INTEGER NOT NULL,
    band TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_risk_history_mmsi ON risk_history(mmsi, ts);
`);

// Moorings — one point per ship visit (centroid of its stationary readings in
// the area during that stay). Tagged with the ship's broad category so each
// berth can be characterised by what moors there. Rebuilt by the berths
// service; `berth_id` is the cluster it was assigned to (null = unassigned).
db.exec(`
  CREATE TABLE IF NOT EXISTS moorings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area TEXT NOT NULL,
    mmsi INTEGER NOT NULL,
    ship_type INTEGER,
    category TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    ts TEXT NOT NULL,
    berth_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_moorings_area ON moorings(area);
  CREATE INDEX IF NOT EXISTS idx_moorings_berth ON moorings(berth_id);

  CREATE TABLE IF NOT EXISTS berths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area TEXT NOT NULL,
    name TEXT,
    polygon_json TEXT NOT NULL,
    centroid_lat REAL NOT NULL,
    centroid_lon REAL NOT NULL,
    manual_geom INTEGER NOT NULL DEFAULT 0,
    char_label TEXT,
    char_override TEXT,
    mooring_count INTEGER NOT NULL DEFAULT 0,
    dist_json TEXT,
    hazmat_pct REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_berths_area ON berths(area);

  -- Ship-to-ship proximity (rendezvous) contacts. One row per encounter between
  -- a canonical pair (mmsi_a < mmsi_b). ended_at NULL = the contact is still
  -- open (ships currently close). alerted = the dwell threshold was reached and
  -- a notification fired (fires once per contact). Feeds the risk score (both
  -- ships) and the ship-detail rendezvous list.
  CREATE TABLE IF NOT EXISTS proximity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area TEXT NOT NULL,
    mmsi_a INTEGER NOT NULL,
    mmsi_b INTEGER NOT NULL,
    name_a TEXT,
    name_b TEXT,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT,
    min_dist_m REAL,
    lat_a REAL, lon_a REAL,
    lat_b REAL, lon_b REAL,
    alerted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_prox_a ON proximity_events(mmsi_a);
  CREATE INDEX IF NOT EXISTS idx_prox_b ON proximity_events(mmsi_b);
  CREATE INDEX IF NOT EXISTS idx_prox_open ON proximity_events(area, ended_at);
  CREATE INDEX IF NOT EXISTS idx_prox_started ON proximity_events(started_at DESC);
`);

// Small key/value store for app-internal bookkeeping that must survive restarts
// (e.g. "areas already reconciled for this bbox signature"). Created with
// IF NOT EXISTS and copied as a column-intersection by restoreFrom, so restoring
// an older backup that lacks it never errors — the key is simply re-derived.
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ── Users & sessions (multi-user auth) ───────────────────────────────────────
// `users`: one row per account. Password stored as scrypt hash+salt (never
//   recoverable). role = 'user' | 'admin'. status = 'pending' (awaiting admin
//   approval) | 'active' | 'disabled'. email_verified + verify_token support a
//   future email-confirmation step (inert until SMTP is configured). reset_token
//   / reset_expires back the password-reset flow (admin-initiated for now).
// `sessions`: opaque token → user. Cookie carries an HMAC-signed copy of `id`.
//   impersonating_user_id lets an admin view another user's world read-only; the
//   session still belongs to the admin (audit), the effective user is resolved
//   in the auth middleware.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    pw_hash TEXT NOT NULL,
    pw_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'pending',
    email_verified INTEGER NOT NULL DEFAULT 0,
    verify_token TEXT,
    reset_token TEXT,
    reset_expires TEXT,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    approved_by INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email));
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username)) WHERE username IS NOT NULL;

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    impersonating_user_id INTEGER,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL
  );

  -- Audit trail of group-sync mirror actions (services/group-sync.js): one row
  -- per member action that gets mirrored to co-members, so the group can see
  -- WHO did WHAT and WHEN instead of just silently inheriting shared state.
  -- 'detail' is a JSON blob with display data resolved at write time (ship
  -- name, area name, ...) so the log stays readable even if the ship/area is
  -- later renamed or removed.
  CREATE TABLE IF NOT EXISTS group_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_group_activity_log_group ON group_activity_log(group_id, id DESC);
`);

// `sessions.last_seen_at`: timestamp of the session's most recent request,
// bumped (throttled) by the auth middleware. Drives the admin "online now"
// indicator. Nullable so older backups restore cleanly (treated as never-seen).
for (const col of ['last_seen_at TEXT']) {
  try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* already exists */ }
}

// `users.group_id`: optional membership into a `groups` row. Members of a group
// share (UNION) their areas/follows/flags/mutes and a subset of settings, kept
// in sync write-through by src/services/group-sync.js. Nullable = no group.
for (const col of ['group_id INTEGER']) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch { /* already exists */ }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_users_group ON users(group_id)');

// ── Per-user data model ──────────────────────────────────────────────────────
// `areas`: the global catalog of monitoring areas (the source of truth that
//   replaces bounding-boxes.json; the JSON file is now only a first-run seed).
//   Each area is a single bbox; streams + areaForPoint() run over this catalog,
//   deduped by geometry. created_by records the author (admin for seeded ones).
// `user_areas`: which users monitor which catalog areas ("le proprie aree").
// `user_flags` / `user_follows` / `user_mutes` / `user_seen`: per-user replacements
//   for the old global ships.flagged / ships.followed / ships.notif_muted / ships.seen
//   columns.
// `user_settings`: per-user personal preferences (notif toggles, map display,
//   language, default area) as key/value rows.
// Core AIS data (readings/ships/...) stays GLOBAL and shared; per-user views are
// derived by geography (a ship is visible if its last position is in any of the
// user's areas' bboxes).
db.exec(`
  CREATE TABLE IF NOT EXISTS areas (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    keyword TEXT,
    sw_lat REAL NOT NULL,
    sw_lon REAL NOT NULL,
    ne_lat REAL NOT NULL,
    ne_lon REAL NOT NULL,
    created_by INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_areas (
    user_id INTEGER NOT NULL,
    area_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, area_key)
  );
  CREATE INDEX IF NOT EXISTS idx_user_areas_user ON user_areas(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_areas_area ON user_areas(area_key);

  CREATE TABLE IF NOT EXISTS user_flags (
    user_id INTEGER NOT NULL,
    mmsi INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, mmsi)
  );
  CREATE INDEX IF NOT EXISTS idx_user_flags_user ON user_flags(user_id);

  CREATE TABLE IF NOT EXISTS user_follows (
    user_id INTEGER NOT NULL,
    mmsi INTEGER NOT NULL,
    followed INTEGER NOT NULL DEFAULT 1,
    follow_started_at TEXT,
    follow_ended_at TEXT,
    PRIMARY KEY (user_id, mmsi)
  );
  CREATE INDEX IF NOT EXISTS idx_user_follows_user ON user_follows(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_follows_active ON user_follows(followed);

  CREATE TABLE IF NOT EXISTS user_mutes (
    user_id INTEGER NOT NULL,
    mmsi INTEGER NOT NULL,
    PRIMARY KEY (user_id, mmsi)
  );

  CREATE TABLE IF NOT EXISTS user_seen (
    user_id INTEGER NOT NULL,
    mmsi INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, mmsi)
  );
  CREATE INDEX IF NOT EXISTS idx_user_seen_user ON user_seen(user_id);

  -- "Taken in charge" (group triage): unlike the tables above, several users can
  -- hold this tag on the SAME ship at once, and it is never mirrored group-wide
  -- by group-sync.js — a row here is who actually took (or was assigned) the
  -- ship, not shared state. assigned_by_id is NULL when a user took charge of a
  -- ship themselves rather than being assigned by a co-member.
  CREATE TABLE IF NOT EXISTS user_ship_charges (
    user_id INTEGER NOT NULL,
    mmsi INTEGER NOT NULL,
    assigned_by_id INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, mmsi)
  );
  CREATE INDEX IF NOT EXISTS idx_user_ship_charges_mmsi ON user_ship_charges(mmsi);

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
  );

  -- Per-user track "cuts" for the ship detail replay. Each cut is a timestamp
  -- that splits that user timeline into segments (trips): N cuts produce N+1
  -- segments [data start..C1], [C1..C2], ... [Cn..now]. Non-destructive: the
  -- shared readings rows are untouched, so the risk score, port events and other
  -- users views are unaffected. The detail view lists the segments in a dropdown.
  CREATE TABLE IF NOT EXISTS user_track_cuts (
    user_id INTEGER NOT NULL,
    mmsi INTEGER NOT NULL,
    cut_at TEXT NOT NULL,
    PRIMARY KEY (user_id, mmsi, cut_at)
  );
  CREATE INDEX IF NOT EXISTS idx_user_track_cuts_user ON user_track_cuts(user_id, mmsi);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS area_ports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area_key TEXT NOT NULL,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    sources TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'review',
    admin_reviewed INTEGER NOT NULL DEFAULT 0,
    mst_pid TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(area_key, name)
  );
  CREATE INDEX IF NOT EXISTS idx_area_ports_area ON area_ports(area_key);
`);

// One-time migration from the earlier single-cut design (user_track_resets, one
// row per user+ship): fold each reset into a cut, then drop the old table.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_track_resets'").get()) {
  db.exec(`INSERT OR IGNORE INTO user_track_cuts (user_id, mmsi, cut_at)
           SELECT user_id, mmsi, reset_at FROM user_track_resets`);
  db.exec('DROP TABLE user_track_resets');
}

// Each catalog area carries whether its live stream is meant to be running. This
// is the ONLY persisted record of "monitoraggi attivi": the in-memory streams map
// is lost on every restart, so without this a deploy or a DB restore couldn't know
// which monitorings to bring back. It lives on the area row (not per-user) because
// a stream is shared across all users that own the area, and it rides along in
// backups (areas is in BACKUP_TABLES; restoreFrom is column-intersection so older
// backups without the column simply restore as 0).
// fallback_enabled/last_ais_message_at back the per-area silent fallback (see
// services/fallback-mode.js): an area is "silent" right now when enabled AND
// its last real AIS message is older than AREA_SILENT_THRESHOLD_MIN — computed
// live from these two columns, never a persisted state machine. Same
// backup/restore reasoning as `active`: rides in BACKUP_TABLES, older backups
// without these columns restore as enabled=1/never-seen (both safe defaults).
for (const col of [
  'active INTEGER NOT NULL DEFAULT 0',
  'fallback_enabled INTEGER NOT NULL DEFAULT 1',
  'last_ais_message_at TEXT',
]) {
  try { db.exec(`ALTER TABLE areas ADD COLUMN ${col}`); } catch { /* already exists */ }
}

// notifications get a user_id (fan-out per owning user). Legacy rows (null) are
// re-homed to the admin by the multi-user migration.
for (const col of ['user_id INTEGER']) {
  try { db.exec(`ALTER TABLE notifications ADD COLUMN ${col}`); } catch { /* already exists */ }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)');

// Migrate existing DB: add new columns if missing
for (const col of [
  'ship_type INTEGER',
  'destination TEXT',
  'max_draught REAL',
  'call_sign TEXT',
  'imo_number INTEGER',
  'dim_bow INTEGER',
  'dim_stern INTEGER',
  'dim_port INTEGER',
  'dim_starboard INTEGER',
  'eta TEXT',
  'notes TEXT',
  'seen INTEGER NOT NULL DEFAULT 0',
  'mt_ship_id INTEGER',
  'is_military INTEGER NOT NULL DEFAULT 0',
  "last_area TEXT NOT NULL DEFAULT ''",
]) {
  try {
    db.exec(`ALTER TABLE ships ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_ships_last_area ON ships(last_area)');

for (const col of ['notif_muted INTEGER NOT NULL DEFAULT 0']) {
  try {
    db.exec(`ALTER TABLE ships ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

// "Follow" (segui) — track a ship across the open sea via a dedicated AISstream
// connection with a small bounding box around its last known position. `followed`
// is the live flag; follow_started_at marks the first time it was ever followed
// (so a now-unfollowed ship with a non-null start still shows in the "passate"
// history); follow_ended_at is when following stopped (manual de-select or the
// 48h-inactivity auto-stop).
for (const col of [
  'followed INTEGER NOT NULL DEFAULT 0',
  'follow_started_at TEXT',
  'follow_ended_at TEXT',
]) {
  try {
    db.exec(`ALTER TABLE ships ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

for (const col of ['request_body TEXT', 'response_body TEXT']) {
  try {
    db.exec(`ALTER TABLE api_log ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

for (const col of ["area TEXT NOT NULL DEFAULT ''"]) {
  try { db.exec(`ALTER TABLE readings ADD COLUMN ${col}`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE port_events ADD COLUMN ${col}`); } catch { /* already exists */ }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_readings_area ON readings(area)');
db.exec('CREATE INDEX IF NOT EXISTS idx_port_events_area_type ON port_events(area, event_type)');

// Stop evidence for a completed visit, written on the 'departed' event (see
// checkAndLogDepartures): stop_min_sog = the lowest speed the ship broadcast
// while inside the area, stopped = 1 when the visit was a real call (dwell over
// TRANSIT_STOP_MIN_H and, when speeds are known, actually stationary) rather
// than a mere crossing of the bbox. Both stay NULL for events logged before
// this version (and whenever the visit's readings were already pruned) — the
// transit search then falls back to dwell alone, which is why they are nullable
// instead of NOT NULL DEFAULT 0: "unknown" must not read as "did not stop".
for (const col of ['stop_min_sog REAL', 'stopped INTEGER']) {
  try { db.exec(`ALTER TABLE port_events ADD COLUMN ${col}`); } catch { /* already exists */ }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_port_events_area_mmsi ON port_events(area, mmsi, ts)');

// Provenance of a position row. 'ais' (default) = broadcast we received live;
// non-'ais' (e.g. 'sf' = ShipFinder) = a position obtained by scraping to re-locate
// a ship AIS lost. Scraped positions are EXCLUDED from the AIS track/risk/replay
// queries below and surface only as distinct "last known" markers.
try { db.exec("ALTER TABLE readings ADD COLUMN source TEXT NOT NULL DEFAULT 'ais'"); } catch { /* already exists */ }

// Origin area for 'area_change' notifications (the `area` column holds the destination).
for (const col of ['from_area TEXT']) {
  try { db.exec(`ALTER TABLE notifications ADD COLUMN ${col}`); } catch { /* already exists */ }
}

// Berth reference for 'berth_new' / 'berth_characterized' notifications, so a
// tap on the row can locate that berth on the map. berth_lat/berth_lon hold the
// berth centroid captured at notification time: berth ids are reassigned on
// every cluster recompute (delete+insert), so the id alone goes stale almost
// immediately — the coordinates let a tap still locate the berth on the map.
for (const col of ['berth_id INTEGER', 'berth_lat REAL', 'berth_lon REAL']) {
  try { db.exec(`ALTER TABLE notifications ADD COLUMN ${col}`); } catch { /* already exists */ }
}

// Group-activity notifications ('group_*' types, see group-sync.js): actor_id is
// who performed the mirrored action (the recipient is the existing user_id
// column); target_user_id is the OTHER user involved for charge_assign/charge_off
// (who a ship was assigned to / taken from).
for (const col of ['actor_id INTEGER', 'target_user_id INTEGER']) {
  try { db.exec(`ALTER TABLE notifications ADD COLUMN ${col}`); } catch { /* already exists */ }
}

try { db.exec('ALTER TABLE user_follows ADD COLUMN search_mode INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS ship_scrape_cache (
    mmsi    INTEGER NOT NULL,
    source  TEXT    NOT NULL,
    data_json TEXT  NOT NULL,
    scraped_at TEXT NOT NULL,
    PRIMARY KEY (mmsi, source)
  )
`);

const upsertScrapeStmt = db.prepare(`
  INSERT INTO ship_scrape_cache (mmsi, source, data_json, scraped_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(mmsi, source) DO UPDATE SET
    data_json  = excluded.data_json,
    scraped_at = excluded.scraped_at
`);

function getScrapedData(mmsi, source) {
  return (
    db
      .prepare('SELECT data_json, scraped_at FROM ship_scrape_cache WHERE mmsi = ? AND source = ?')
      .get(mmsi, source) || null
  );
}

function setScrapedData(mmsi, source, data) {
  const scraped_at = new Date().toISOString();
  upsertScrapeStmt.run(mmsi, source, JSON.stringify(data), scraped_at);
  return scraped_at;
}

// ── Scrape negative cache ─────────────────────────────────────────────────────
// VesselFinder/MarineTraffic don't know every vessel (no IMO → looked up by MMSI
// → 404 / redirect). A failed lookup writes nothing to ship_scrape_cache, so the
// ship stays "uncached" and the backfill re-fetches it on every re-enable. This
// table records the last failure per (mmsi, source); the enrichment skips a ship
// whose failure is newer than SCRAPE_NEG_CACHE_DAYS, then retries it afterwards.
db.exec(`
  CREATE TABLE IF NOT EXISTS ship_scrape_failures (
    mmsi    INTEGER NOT NULL,
    source  TEXT    NOT NULL,
    failed_at TEXT  NOT NULL,
    reason  TEXT,
    PRIMARY KEY (mmsi, source)
  )
`);

const upsertScrapeFailureStmt = db.prepare(`
  INSERT INTO ship_scrape_failures (mmsi, source, failed_at, reason)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(mmsi, source) DO UPDATE SET
    failed_at = excluded.failed_at,
    reason    = excluded.reason
`);

function setScrapeFailure(mmsi, source, reason) {
  upsertScrapeFailureStmt.run(mmsi, source, new Date().toISOString(), reason ? String(reason).slice(0, 200) : null);
}

function clearScrapeFailure(mmsi, source) {
  db.prepare('DELETE FROM ship_scrape_failures WHERE mmsi = ? AND source = ?').run(mmsi, source);
}

// True if a lookup for (mmsi, source) failed within the last `days` days. ISO
// timestamps compare lexicographically, so the cutoff is built the same way.
function hasRecentScrapeFailure(mmsi, source, days) {
  if (!days || days <= 0) return false; // negative cache disabled → always retry
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return !!db
    .prepare('SELECT 1 FROM ship_scrape_failures WHERE mmsi = ? AND source = ? AND failed_at >= ?')
    .get(mmsi, source, cutoff);
}

// ── Scrape activity log (diagnostics) ────────────────────────────────────────
// One row per scrape attempt per vendor, used only for the "last 24h" counters in
// Settings → Diagnostica AIS. Ephemeral diagnostics: NOT in BACKUP_TABLES, pruned
// to ~2 days. `ok` distinguishes successful fetches from failures.
db.exec(`
  CREATE TABLE IF NOT EXISTS scrape_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    ok     INTEGER NOT NULL,
    at     TEXT NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_scrape_log_at ON scrape_log(at)');
const insertScrapeLogStmt = db.prepare('INSERT INTO scrape_log (source, ok, at) VALUES (?, ?, ?)');
let scrapeLogInserts = 0;
function recordScrape(source, ok) {
  insertScrapeLogStmt.run(source, ok ? 1 : 0, new Date().toISOString());
  // Periodic prune so the table stays tiny (counters only need a 24h window).
  if (++scrapeLogInserts % 100 === 0) {
    db.prepare('DELETE FROM scrape_log WHERE at < ?').run(new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString());
  }
}

// { vf: {total, ok, failed}, mt: {...}, sf: {...}, ... } over the last 24h.
function getScrapeCounts24h() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = db
    .prepare('SELECT source, COUNT(*) AS total, SUM(ok) AS ok FROM scrape_log WHERE at >= ? GROUP BY source')
    .all(cutoff);
  const out = {};
  for (const r of rows) out[r.source] = { total: r.total, ok: r.ok, failed: r.total - r.ok };
  return out;
}

// Same scrape_log table as getScrapeCounts24h, bucketed by hour instead of a
// single total — feeds the fallback-mode admin panel's history chart (real
// volume vs. the solo-follow/full-monitoring estimates). Only ~48h of history
// exists (scrape_log is pruned above, not backed up — see its comment).
function getScrapeCountsHourly(hours = 48) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:00:00Z', at) AS hour, source, COUNT(*) AS total, SUM(ok) AS ok
       FROM scrape_log WHERE at >= ? GROUP BY hour, source ORDER BY hour`
    )
    .all(cutoff);
  return rows.map((r) => ({ hour: r.hour, source: r.source, total: r.total, ok: r.ok, failed: r.total - r.ok }));
}

// ── Meta key/value ───────────────────────────────────────────────────────────
const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
function getMeta(key) {
  return getMetaStmt.get(key)?.value ?? null;
}
function setMeta(key, value) {
  setMetaStmt.run(key, value == null ? null : String(value));
}

// ── Users & sessions ─────────────────────────────────────────────────────────

const PUBLIC_USER_COLS =
  'id, email, username, first_name, last_name, role, status, email_verified, created_at, approved_at, approved_by, group_id';

/** Lazily create + cache the HMAC secret used to sign session cookies. Persisted
 *  in `meta` so it survives restarts/deploys and every instance agrees. */
function getSessionSecret() {
  let secret = getMeta('session_secret');
  if (!secret) {
    secret = auth.randomToken(32);
    setMeta('session_secret', secret);
  }
  return secret;
}

const insertUserStmt = db.prepare(`
  INSERT INTO users (email, username, first_name, last_name, pw_hash, pw_salt,
    role, status, email_verified, verify_token, created_at, approved_at, approved_by)
  VALUES (@email, @username, @first_name, @last_name, @pw_hash, @pw_salt,
    @role, @status, @email_verified, @verify_token, @created_at, @approved_at, @approved_by)
`);

/** Create a user. `password` is hashed here; caller passes plaintext. Returns the
 *  new public user row. Throws on a duplicate email/username (UNIQUE index). */
function createUser({ email, username = null, firstName = null, lastName = null, password, role = 'user', status = 'pending', emailVerified = 0, approvedBy = null }) {
  const { hash, salt } = auth.hashPassword(password);
  const now = new Date().toISOString();
  const info = insertUserStmt.run({
    email: String(email).trim(),
    username: username ? String(username).trim() : null,
    first_name: firstName,
    last_name: lastName,
    pw_hash: hash,
    pw_salt: salt,
    role,
    status,
    email_verified: emailVerified ? 1 : 0,
    verify_token: emailVerified ? null : auth.randomToken(24),
    created_at: now,
    approved_at: status === 'active' ? now : null,
    approved_by: approvedBy,
  });
  return getUserById(Number(info.lastInsertRowid));
}

const getUserByIdStmt = db.prepare(`SELECT ${PUBLIC_USER_COLS} FROM users WHERE id = ?`);
const getUserAuthStmt = db.prepare('SELECT * FROM users WHERE id = ?');
function getUserById(id) {
  return getUserByIdStmt.get(id) || null;
}
/** Full row incl. password hash — for the auth path only, never serialized. */
function getUserAuthRow(id) {
  return getUserAuthStmt.get(id) || null;
}

// Login lookup: match email OR username, case-insensitively. Returns the full
// row (incl. hash) so the caller can verify the password.
const findLoginStmt = db.prepare(
  'SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) LIMIT 1'
);
function findUserByLogin(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  return findLoginStmt.get(id, id) || null;
}

const listUsersStmt = db.prepare(`SELECT ${PUBLIC_USER_COLS} FROM users ORDER BY created_at ASC`);
function listUsers() {
  return listUsersStmt.all();
}

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}
function countAdmins() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n;
}

// Active admins, for system-level alerts that must reach admins only (e.g. the
// fallback-mode "suspected ban" alert, services/fallback-mode.js) — not a
// per-ship/per-user notification, so it doesn't go through the normal
// notify-categories.js gate.
function getAdminUserIds() {
  return db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all().map((r) => r.id);
}

const setUserStatusStmt = db.prepare('UPDATE users SET status = ? WHERE id = ?');
function setUserStatus(id, status) {
  setUserStatusStmt.run(status, id);
}

const approveUserStmt = db.prepare(
  "UPDATE users SET status = 'active', approved_at = ?, approved_by = ? WHERE id = ?"
);
function approveUser(id, approvedBy) {
  approveUserStmt.run(new Date().toISOString(), approvedBy, id);
}

const approveTesterStmt = db.prepare(
  "UPDATE users SET status = 'active', role = 'tester', approved_at = ?, approved_by = ? WHERE id = ?"
);
function approveTester(id, approvedBy) {
  approveTesterStmt.run(new Date().toISOString(), approvedBy, id);
}

const setUserRoleStmt = db.prepare('UPDATE users SET role = ? WHERE id = ?');
function setUserRole(id, role) {
  const allowed = ['admin', 'user', 'tester'];
  setUserRoleStmt.run(allowed.includes(role) ? role : 'user', id);
}

const setUserPasswordStmt = db.prepare(
  'UPDATE users SET pw_hash = ?, pw_salt = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?'
);
function setUserPassword(id, password) {
  const { hash, salt } = auth.hashPassword(password);
  setUserPasswordStmt.run(hash, salt, id);
}

const setResetTokenStmt = db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?');
/** Issue a one-shot password-reset token (returns it). expiresMs from now. */
function issueResetToken(id, expiresMs = 60 * 60 * 1000) {
  const token = auth.randomToken(24);
  const expires = new Date(Date.now() + expiresMs).toISOString();
  setResetTokenStmt.run(token, expires, id);
  return token;
}

const findResetStmt = db.prepare('SELECT * FROM users WHERE reset_token = ? LIMIT 1');
/** Resolve a reset token to a user, only if it hasn't expired. */
function findUserByResetToken(token) {
  if (!token) return null;
  const u = findResetStmt.get(String(token));
  if (!u) return null;
  if (!u.reset_expires || u.reset_expires < new Date().toISOString()) return null;
  return u;
}

const findVerifyStmt = db.prepare('SELECT * FROM users WHERE verify_token = ? LIMIT 1');
const markVerifiedStmt = db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL WHERE id = ?');
function verifyEmailToken(token) {
  if (!token) return null;
  const u = findVerifyStmt.get(String(token));
  if (!u) return null;
  markVerifiedStmt.run(u.id);
  return getUserById(u.id);
}

const deleteUserStmt = db.prepare('DELETE FROM users WHERE id = ?');
const deleteUserSessionsStmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');
// Cascade a user's per-user data on delete (no FKs in this schema). Areas left
// memberless are re-homed to the admin by migrateMultiUser on the next boot.
function deleteUser(id) {
  for (const t of ['sessions', 'user_areas', 'user_flags', 'user_follows', 'user_mutes', 'user_seen', 'user_ship_charges', 'user_settings', 'notifications']) {
    db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
  }
  deleteUserStmt.run(id);
}

// Groups ────────────────────────────────────────────────────────────────────
//
// A group binds ≥2 users who SHARE (union) their areas/follows/flags/mutes and a
// subset of settings. The sharing itself is write-through (src/services/
// group-sync.js): per-user rows stay the source of truth, so the notification /
// visibility layer is untouched. These functions only manage membership.

const createGroupStmt = db.prepare('INSERT INTO groups (name, description, created_by, created_at) VALUES (?, ?, ?, ?)');
function createGroup(name, description, createdBy) {
  const info = createGroupStmt.run(String(name).trim(), description ? String(description).trim() : null, createdBy || null, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

/** All groups with their current member count. */
function getGroups() {
  return db.prepare(
    `SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id) AS member_count
     FROM groups g ORDER BY g.created_at ASC`
  ).all();
}

function getGroup(id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id) || null;
}

const renameGroupStmt = db.prepare('UPDATE groups SET name = ?, description = ? WHERE id = ?');
function updateGroup(id, { name, description }) {
  const g = getGroup(id);
  if (!g) return;
  renameGroupStmt.run(
    name != null ? String(name).trim() : g.name,
    description !== undefined ? (description ? String(description).trim() : null) : g.description,
    id
  );
}

const setUserGroupStmt = db.prepare('UPDATE users SET group_id = ? WHERE id = ?');
function setUserGroup(userId, groupId) {
  setUserGroupStmt.run(groupId == null ? null : groupId, userId);
}

/** Dissolve a group: detach all members (they keep their accumulated data), drop the row. */
function deleteGroup(id) {
  db.prepare('UPDATE users SET group_id = NULL WHERE group_id = ?').run(id);
  db.prepare('DELETE FROM groups WHERE id = ?').run(id);
}

/** Member user ids of a group (ordered by join age = user creation). */
function getGroupMembers(groupId) {
  return db.prepare('SELECT id FROM users WHERE group_id = ? ORDER BY created_at ASC').all(groupId).map((r) => r.id);
}

function getUserGroupId(userId) {
  const r = db.prepare('SELECT group_id FROM users WHERE id = ?').get(userId);
  return r ? r.group_id : null;
}

function groupMemberCount(groupId) {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE group_id = ?').get(groupId).n;
}

const insertGroupActivityStmt = db.prepare(
  'INSERT INTO group_activity_log (group_id, user_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
let groupActivityInsertCount = 0;

/** Append one row to the group activity audit trail; prunes rows older than
 *  GROUP_ACTIVITY_LOG_RETENTION_DAYS every 20 inserts (same pattern as api_log). */
function logGroupActivity({ groupId, userId, action, targetType = null, targetId = null, detail = null }) {
  const createdAt = new Date().toISOString();
  insertGroupActivityStmt.run(
    groupId, userId, action, targetType, targetId != null ? String(targetId) : null,
    detail != null ? JSON.stringify(detail) : null, createdAt
  );
  if (++groupActivityInsertCount % 20 === 0) {
    const cutoff = new Date(Date.now() - GROUP_ACTIVITY_LOG_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
    db.prepare('DELETE FROM group_activity_log WHERE created_at < ?').run(cutoff);
  }
}

/** Paginated activity feed for a group, newest first. `detail` is parsed back
 *  into an object (null if absent/corrupt). */
function getGroupActivityLog(groupId, limit, offset) {
  const rows = db.prepare(
    'SELECT * FROM group_activity_log WHERE group_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(groupId, limit, offset);
  return rows.map((r) => {
    let detail = null;
    try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { /* corrupt row, ignore */ }
    return { ...r, detail };
  });
}

// Sessions ────────────────────────────────────────────────────────────────────

const insertSessionStmt = db.prepare(`
  INSERT INTO sessions (id, user_id, impersonating_user_id, created_at, expires_at, last_seen_at, ip, user_agent)
  VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
`);
/** Create a session for `userId`. Returns the opaque session id (cookie value). */
function createSession(userId, { ttlMs = 30 * 24 * 60 * 60 * 1000, ip = null, userAgent = null } = {}) {
  const id = auth.randomToken(32);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  insertSessionStmt.run(id, userId, nowIso, new Date(now + ttlMs).toISOString(), nowIso, ip, userAgent ? String(userAgent).slice(0, 255) : null);
  return id;
}

const touchSessionStmt = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
/** Record that a session made a request just now (drives the "online" flag). */
function touchSession(id, nowIso = new Date().toISOString()) {
  touchSessionStmt.run(nowIso, id);
}

const onlineUserIdsStmt = db.prepare(
  'SELECT DISTINCT user_id FROM sessions WHERE last_seen_at >= ? AND expires_at > ?'
);
/** User ids with at least one non-expired session seen since `cutoffIso`. The
 *  session OWNER counts as online (an admin impersonating someone is themselves
 *  online, not the target). */
function getOnlineUserIds(cutoffIso, nowIso = new Date().toISOString()) {
  return onlineUserIdsStmt.all(cutoffIso, nowIso).map((r) => r.user_id);
}

const getSessionStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
/** Resolve a session id to its row, or null if missing/expired (expired → pruned). */
function getSession(id) {
  const s = getSessionStmt.get(id);
  if (!s) return null;
  if (s.expires_at < new Date().toISOString()) {
    deleteSession(id);
    return null;
  }
  return s;
}

const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
function deleteSession(id) {
  deleteSessionStmt.run(id);
}

/** Destroy all sessions for a user (e.g. after a password reset or disable). */
function deleteUserSessions(userId) {
  deleteUserSessionsStmt.run(userId);
}

const setImpersonationStmt = db.prepare('UPDATE sessions SET impersonating_user_id = ? WHERE id = ?');
function setSessionImpersonation(sessionId, targetUserId) {
  setImpersonationStmt.run(targetUserId, sessionId);
}

function pruneExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

/**
 * Ensure the built-in admin account exists. Idempotent: only creates it when no
 * account with the configured admin username is present, so a later password
 * change or role edit is never clobbered on restart.
 */
function seedDefaultAdmin({ username = 'admin', email = 'admin@local', password } = {}) {
  if (!password) return null;
  const existing = findUserByLogin(username);
  // Idempotent: if the admin already exists, leave it untouched. Never re-write the
  // password of an existing account — doing so on every boot silently reverted any
  // password (or role) change made through the UI, and with the shipped default
  // password left the admin account permanently on a public credential.
  if (existing) return existing;
  // Also avoid colliding with a user who already claimed the synthetic email.
  if (findUserByLogin(email)) return null;
  appLog.info('AUTH', `Creazione utente amministratore di default "${username}"`);
  return createUser({
    email,
    username,
    firstName: 'Amministratore',
    lastName: null,
    password,
    role: 'admin',
    status: 'active',
    emailVerified: 1,
  });
}

function hasAnyAdmin() {
  return !!db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
}

// ── Area catalog & per-user ownership ────────────────────────────────────────

const getAllAreasStmt = db.prepare('SELECT * FROM areas ORDER BY created_at ASC, key ASC');
/** Full catalog as rows (raw columns). */
function getAllAreas() {
  return getAllAreasStmt.all();
}

const getAreaStmt = db.prepare('SELECT * FROM areas WHERE key = ?');
function getArea(key) {
  return getAreaStmt.get(key) || null;
}

const upsertAreaStmt = db.prepare(`
  INSERT INTO areas (key, name, keyword, sw_lat, sw_lon, ne_lat, ne_lon, created_by, created_at)
  VALUES (@key, @name, @keyword, @sw_lat, @sw_lon, @ne_lat, @ne_lon, @created_by, @created_at)
  ON CONFLICT(key) DO UPDATE SET
    name = excluded.name, keyword = excluded.keyword,
    sw_lat = excluded.sw_lat, sw_lon = excluded.sw_lon,
    ne_lat = excluded.ne_lat, ne_lon = excluded.ne_lon
`);
/** Insert or update one catalog area. `box` = [[swLat,swLon],[neLat,neLon]]. */
function upsertArea({ key, name, keyword = null, sw, ne, createdBy = null }) {
  upsertAreaStmt.run({
    key,
    name,
    keyword: keyword || null,
    sw_lat: sw[0], sw_lon: sw[1],
    ne_lat: ne[0], ne_lon: ne[1],
    created_by: createdBy,
    created_at: new Date().toISOString(),
  });
}

// Persisted "is this monitoring meant to be running" flag (see the ALTER above).
// startStream/stopStream write it; boot and post-restore read getActiveAreaKeys()
// to bring back exactly the streams that were active before.
const setAreaActiveStmt = db.prepare('UPDATE areas SET active = ? WHERE key = ?');
function setAreaActive(key, active) {
  setAreaActiveStmt.run(active ? 1 : 0, key);
}

// Admin per-area toggle for the silent fallback (see services/fallback-mode.js).
const setAreaFallbackEnabledStmt = db.prepare('UPDATE areas SET fallback_enabled = ? WHERE key = ?');
function setAreaFallbackEnabled(key, enabled) {
  setAreaFallbackEnabledStmt.run(enabled ? 1 : 0, key);
}

// Called from ais-stream.js on real AIS traffic, throttled in-memory by the
// caller (never once per message — see fallback-mode.js's cadence comments for
// why an unthrottled per-message write here would be exactly the event-loop-
// starvation bug already fixed once in this codebase for berth recompute).
const touchAreaLastAisMessageStmt = db.prepare('UPDATE areas SET last_ais_message_at = ? WHERE key = ?');
function touchAreaLastAisMessage(key, ts) {
  touchAreaLastAisMessageStmt.run(ts, key);
}
const getActiveAreaKeysStmt = db.prepare(
  'SELECT key FROM areas WHERE active = 1 ORDER BY created_at ASC, key ASC'
);
function getActiveAreaKeys() {
  return getActiveAreaKeysStmt.all().map((r) => r.key);
}

const deleteAreaRowStmt = db.prepare('DELETE FROM areas WHERE key = ?');
const deleteAreaMembershipsStmt = db.prepare('DELETE FROM user_areas WHERE area_key = ?');
/** Remove a catalog area and every membership of it. */
function deleteAreaRow(key) {
  deleteAreaMembershipsStmt.run(key);
  deleteAreaRowStmt.run(key);
}

const addUserAreaStmt = db.prepare(
  'INSERT INTO user_areas (user_id, area_key, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
);
function addUserArea(userId, areaKey) {
  addUserAreaStmt.run(userId, areaKey, new Date().toISOString());
}

const removeUserAreaStmt = db.prepare('DELETE FROM user_areas WHERE user_id = ? AND area_key = ?');
function removeUserArea(userId, areaKey) {
  removeUserAreaStmt.run(userId, areaKey);
}

const getUserAreaKeysStmt = db.prepare('SELECT area_key FROM user_areas WHERE user_id = ?');
/** Set of catalog keys the user monitors. */
function getUserAreaKeys(userId) {
  return getUserAreaKeysStmt.all(userId).map((r) => r.area_key);
}

const areaOwnerCountStmt = db.prepare('SELECT COUNT(*) AS n FROM user_areas WHERE area_key = ?');
/** How many users monitor this area. */
function areaOwnerCount(areaKey) {
  return areaOwnerCountStmt.get(areaKey).n;
}

/** Catalog keys monitored by NO user (memberless) — re-homed to admin by migration. */
function getOrphanAreaKeys() {
  return db
    .prepare('SELECT key FROM areas WHERE key NOT IN (SELECT DISTINCT area_key FROM user_areas)')
    .all()
    .map((r) => r.key);
}

/**
 * Seed the area catalog from an in-memory preset list (the bounding-boxes.json
 * shape) when the catalog is empty — first-run bootstrap only. `list` items:
 * { key, name, keyword, sw:[lat,lon], ne:[lat,lon] }. Returns the number seeded.
 */
function seedAreaCatalogIfEmpty(list, createdBy = null) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM areas').get().n;
  if (n > 0) return 0;
  db.exec('BEGIN');
  try {
    for (const a of list) upsertArea({ ...a, createdBy });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return list.length;
}

// ── Area ports (discovery per-area) ──────────────────────────────────────────
const upsertAreaPortStmt = db.prepare(`
  INSERT INTO area_ports (area_key, name, lat, lon, sources, status, admin_reviewed, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  ON CONFLICT(area_key, name) DO UPDATE SET
    lat = excluded.lat,
    lon = excluded.lon,
    sources = excluded.sources,
    status = CASE WHEN area_ports.admin_reviewed = 1 THEN area_ports.status ELSE excluded.status END,
    updated_at = excluded.updated_at
`);
// Upserts one discovered/confirmed port candidate. `sources` is an array of
// strings (e.g. ['berths'] or ['gfw','locode']), stored as JSON. Re-running
// discovery for the same area+name never resurrects an admin-rejected port
// back to 'review'/'confirmed', nor downgrades an admin-confirmed one — see
// the ON CONFLICT clause above (admin_reviewed gates it).
function upsertAreaPort({ area_key, name, lat, lon, sources, status }) {
  const now = new Date().toISOString();
  upsertAreaPortStmt.run(area_key, name, lat, lon, JSON.stringify(sources), status, now, now);
}

function getAreaPorts(areaKey) {
  return db.prepare('SELECT * FROM area_ports WHERE area_key = ? ORDER BY name').all(areaKey)
    .map((r) => ({ ...r, sources: JSON.parse(r.sources) }));
}

function getConfirmedAreaPorts(areaKey) {
  return db.prepare("SELECT * FROM area_ports WHERE area_key = ? AND status = 'confirmed' ORDER BY name").all(areaKey)
    .map((r) => ({ ...r, sources: JSON.parse(r.sources) }));
}

function countAreaPorts(areaKey) {
  return db.prepare('SELECT COUNT(*) AS n FROM area_ports WHERE area_key = ?').get(areaKey).n;
}

const setAreaPortDecisionStmt = db.prepare(
  "UPDATE area_ports SET status = ?, admin_reviewed = 1, updated_at = ? WHERE id = ?"
);
function setAreaPortDecision(id, status) {
  setAreaPortDecisionStmt.run(status, new Date().toISOString(), id);
}

const setAreaPortMstPidStmt = db.prepare('UPDATE area_ports SET mst_pid = ?, updated_at = ? WHERE id = ?');
function setAreaPortMstPid(id, pid) {
  setAreaPortMstPidStmt.run(pid, new Date().toISOString(), id);
}

// ── Multi-user migration (idempotent, self-retiring) ─────────────────────────
//
// Re-homes legacy GLOBAL state to the admin when a pre-multi-user database is
// imported (deploy path: take an old backup, restore into this version). Safe to
// run on every boot:
//   - The legacy→user_* steps fire ONLY while the new per-user table is empty AND
//     the old global column still carries data, then RETIRE the legacy column
//     (zero it) so a later restart can't resurrect un-flagged/un-followed ships.
//   - A new-version backup already carries the user_* tables (restored verbatim),
//     so those steps see a non-empty table and no-op.
//   - notifications.user_id backfill and orphan-area re-homing are naturally
//     idempotent (WHERE ... IS NULL / NOT IN (...)).
function migrateMultiUser(adminId) {
  if (!adminId) return;
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;

  // 1) notifications without an owner → admin.
  db.prepare('UPDATE notifications SET user_id = ? WHERE user_id IS NULL').run(adminId);

  // 2) flagged ships → admin user_flags (then retire ships.flagged).
  if (count('SELECT COUNT(*) AS n FROM user_flags') === 0 &&
      count('SELECT COUNT(*) AS n FROM ships WHERE flagged = 1') > 0) {
    db.prepare(
      'INSERT OR IGNORE INTO user_flags (user_id, mmsi, created_at) SELECT ?, mmsi, ? FROM ships WHERE flagged = 1'
    ).run(adminId, new Date().toISOString());
    db.prepare('UPDATE ships SET flagged = 0 WHERE flagged = 1').run();
  }

  // 3) followed ships + follow history → admin user_follows (retire ships cols).
  if (count('SELECT COUNT(*) AS n FROM user_follows') === 0 &&
      count('SELECT COUNT(*) AS n FROM ships WHERE followed = 1 OR follow_started_at IS NOT NULL') > 0) {
    db.prepare(
      `INSERT OR IGNORE INTO user_follows (user_id, mmsi, followed, follow_started_at, follow_ended_at)
       SELECT ?, mmsi, followed, follow_started_at, follow_ended_at
       FROM ships WHERE followed = 1 OR follow_started_at IS NOT NULL`
    ).run(adminId);
    db.prepare('UPDATE ships SET followed = 0 WHERE followed = 1').run();
  }

  // 4) muted ships → admin user_mutes (retire ships.notif_muted).
  if (count('SELECT COUNT(*) AS n FROM user_mutes') === 0 &&
      count('SELECT COUNT(*) AS n FROM ships WHERE notif_muted = 1') > 0) {
    db.prepare('INSERT OR IGNORE INTO user_mutes (user_id, mmsi) SELECT ?, mmsi FROM ships WHERE notif_muted = 1').run(adminId);
    db.prepare('UPDATE ships SET notif_muted = 0 WHERE notif_muted = 1').run();
  }

  // 4b) seen ships → admin user_seen (retire ships.seen, was global, now per-user).
  if (count('SELECT COUNT(*) AS n FROM user_seen') === 0 &&
      count('SELECT COUNT(*) AS n FROM ships WHERE seen = 1') > 0) {
    db.prepare(
      'INSERT OR IGNORE INTO user_seen (user_id, mmsi, created_at) SELECT ?, mmsi, ? FROM ships WHERE seen = 1'
    ).run(adminId, new Date().toISOString());
    db.prepare('UPDATE ships SET seen = 0 WHERE seen = 1').run();
  }

  // 5) memberless catalog areas → admin (covers a fresh seed from JSON and any
  //    area whose owners all vanished).
  const orphans = getOrphanAreaKeys();
  for (const key of orphans) addUserArea(adminId, key);

  return { orphanAreas: orphans.length };
}

// ── Per-user visibility (geographic) ─────────────────────────────────────────
// A user sees AIS data whose position falls inside any of the bounding boxes of
// the areas they monitor. Computed from the catalog so overlapping boxes work:
// owning a wide "puglia" box surfaces a ship tagged with the contained "taranto".

const getUserBoxesStmt = db.prepare(
  `SELECT a.key, a.sw_lat, a.sw_lon, a.ne_lat, a.ne_lon
   FROM user_areas u JOIN areas a ON a.key = u.area_key
   WHERE u.user_id = ?`
);
/** Bounding boxes (with key) of every area the user monitors. */
function getUserBoxes(userId) {
  return getUserBoxesStmt.all(userId);
}

/**
 * Build a SQL predicate that is true when (latCol, lonCol) lies in ANY of the
 * given boxes. Coordinates are coerced to finite numbers, so the interpolation
 * is injection-proof. No boxes → '0' (matches nothing: a user with no areas sees
 * no data). null/undefined boxes → '1' (no filter, for background callers).
 */
function boxesSql(boxes, latCol, lonCol) {
  if (boxes == null) return '1';
  if (!boxes.length) return '0';
  const fin = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return (
    '(' +
    boxes
      .map((b) => `(${latCol} BETWEEN ${fin(b.sw_lat)} AND ${fin(b.ne_lat)} AND ${lonCol} BETWEEN ${fin(b.sw_lon)} AND ${fin(b.ne_lon)})`)
      .join(' OR ') +
    ')'
  );
}

/** True if the ship's last known position is visible to the user. */
function isShipVisible(userId, mmsi) {
  const ship = db.prepare('SELECT last_latitude AS lat, last_longitude AS lon FROM ships WHERE mmsi = ?').get(mmsi);
  if (!ship || ship.lat == null || ship.lon == null) return false;
  const boxes = getUserBoxes(userId);
  return boxes.some(
    (b) => ship.lat >= b.sw_lat && ship.lat <= b.ne_lat && ship.lon >= b.sw_lon && ship.lon <= b.ne_lon
  );
}

/** Catalog area keys whose box intersects any of the user's boxes — used to
 *  scope area-tagged tables that carry no coordinates (port_events). */
function getVisibleAreaKeys(userId) {
  const mine = getUserBoxes(userId);
  if (!mine.length) return [];
  const out = new Set(mine.map((b) => b.key));
  for (const a of getAllAreas()) {
    if (out.has(a.key)) continue;
    const hit = mine.some(
      (b) => !(a.ne_lat < b.sw_lat || a.sw_lat > b.ne_lat || a.ne_lon < b.sw_lon || a.sw_lon > b.ne_lon)
    );
    if (hit) out.add(a.key);
  }
  return [...out];
}

// ── Per-user flags / mutes / follows ─────────────────────────────────────────

const getUserFlagSetStmt = db.prepare('SELECT mmsi FROM user_flags WHERE user_id = ?');
function getUserFlaggedMmsis(userId) {
  return new Set(getUserFlagSetStmt.all(userId).map((r) => r.mmsi));
}
const addUserFlagStmt = db.prepare('INSERT INTO user_flags (user_id, mmsi, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
const removeUserFlagStmt = db.prepare('DELETE FROM user_flags WHERE user_id = ? AND mmsi = ?');
function setUserFlag(userId, mmsi, on) {
  if (on) addUserFlagStmt.run(userId, mmsi, new Date().toISOString());
  else removeUserFlagStmt.run(userId, mmsi);
}

const getUserSeenSetStmt = db.prepare('SELECT mmsi FROM user_seen WHERE user_id = ?');
function getUserSeenMmsis(userId) {
  return new Set(getUserSeenSetStmt.all(userId).map((r) => r.mmsi));
}
function isUserSeen(userId, mmsi) {
  return !!db.prepare('SELECT 1 FROM user_seen WHERE user_id = ? AND mmsi = ?').get(userId, mmsi);
}
const addUserSeenStmt = db.prepare('INSERT INTO user_seen (user_id, mmsi, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
const removeUserSeenStmt = db.prepare('DELETE FROM user_seen WHERE user_id = ? AND mmsi = ?');
function setUserSeen(userId, mmsi, on) {
  if (on) addUserSeenStmt.run(userId, mmsi, new Date().toISOString());
  else removeUserSeenStmt.run(userId, mmsi);
}

// ── Per-user "taken in charge" (group triage, see schema comment above) ─────
const addUserChargeStmt = db.prepare(
  `INSERT INTO user_ship_charges (user_id, mmsi, assigned_by_id, created_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(user_id, mmsi) DO UPDATE SET assigned_by_id = excluded.assigned_by_id, created_at = excluded.created_at`
);
const removeUserChargeStmt = db.prepare('DELETE FROM user_ship_charges WHERE user_id = ? AND mmsi = ?');
/** Take/release a ship on behalf of `userId`. `assignedById` is the acting user
 *  when it differs from `userId` (assigning a co-member), else null (self-take). */
function setUserShipCharge(userId, mmsi, on, assignedById) {
  if (on) addUserChargeStmt.run(userId, mmsi, assignedById == null ? null : assignedById, new Date().toISOString());
  else removeUserChargeStmt.run(userId, mmsi);
}

/** Users who have taken charge of a given ship — drives the ship-detail "presa
 *  in carico da" tag list. Oldest first (first to take charge shown first). */
function getUsersCharging(mmsi) {
  return db
    .prepare('SELECT user_id AS userId, assigned_by_id AS assignedById, created_at AS createdAt FROM user_ship_charges WHERE mmsi = ? ORDER BY created_at ASC')
    .all(mmsi);
}

/** Batch version of getUsersCharging for a page of ships (active/past lists) —
 *  one query for the whole page rather than one per row.
 *  Returns { [mmsi]: [{userId, assignedById}, ...] }. */
function getChargesForMmsis(mmsis) {
  if (!mmsis.length) return {};
  const ph = mmsis.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT mmsi, user_id AS userId, assigned_by_id AS assignedById FROM user_ship_charges WHERE mmsi IN (${ph})`)
    .all(...mmsis);
  const out = {};
  for (const r of rows) (out[r.mmsi] || (out[r.mmsi] = [])).push({ userId: r.userId, assignedById: r.assignedById });
  return out;
}

// ── Per-user track cuts (ship detail replay segments) ───────────────────────
// Non-destructive: each cut is a timestamp splitting the user's timeline into
// segments. Shared `readings` are never touched.
const getTrackCutsStmt = db.prepare('SELECT cut_at FROM user_track_cuts WHERE user_id = ? AND mmsi = ? ORDER BY cut_at ASC');
function getTrackCuts(userId, mmsi) {
  return getTrackCutsStmt.all(userId, mmsi).map((r) => r.cut_at);
}
const addTrackCutStmt = db.prepare('INSERT OR IGNORE INTO user_track_cuts (user_id, mmsi, cut_at) VALUES (?, ?, ?)');
function addTrackCut(userId, mmsi, iso) {
  addTrackCutStmt.run(userId, mmsi, iso);
}
const deleteTrackCutStmt = db.prepare('DELETE FROM user_track_cuts WHERE user_id = ? AND mmsi = ? AND cut_at = ?');
function deleteTrackCut(userId, mmsi, iso) {
  deleteTrackCutStmt.run(userId, mmsi, iso);
}

const getUserMuteSetStmt = db.prepare('SELECT mmsi FROM user_mutes WHERE user_id = ?');
function getUserMutedMmsis(userId) {
  return new Set(getUserMuteSetStmt.all(userId).map((r) => r.mmsi));
}
function isUserMuted(userId, mmsi) {
  return !!db.prepare('SELECT 1 FROM user_mutes WHERE user_id = ? AND mmsi = ?').get(userId, mmsi);
}
const addUserMuteStmt = db.prepare('INSERT INTO user_mutes (user_id, mmsi) VALUES (?, ?) ON CONFLICT DO NOTHING');
const removeUserMuteStmt = db.prepare('DELETE FROM user_mutes WHERE user_id = ? AND mmsi = ?');
function setUserMute(userId, mmsi, on) {
  if (on) addUserMuteStmt.run(userId, mmsi);
  else removeUserMuteStmt.run(userId, mmsi);
}

// Toggle a per-user follow. Mirrors the old global setFollow semantics:
// follow_ended_at marks when following stopped (→ "passate" history).
// follow_started_at is (re)stamped each time a *stopped* follow is re-enabled, so
// re-following a ship from "passate" restarts its inactivity grace window (see
// autoStopStaleFollowsAll) — otherwise a ship that went silent >48h ago would be
// auto-stopped again the instant it's re-followed. An already-active follow keeps
// its original start time.
const upsertUserFollowOnStmt = db.prepare(
  `INSERT INTO user_follows (user_id, mmsi, followed, follow_started_at, follow_ended_at)
   VALUES (?, ?, 1, ?, NULL)
   ON CONFLICT(user_id, mmsi) DO UPDATE SET
     followed = 1,
     follow_started_at = CASE WHEN user_follows.followed = 0 THEN excluded.follow_started_at ELSE user_follows.follow_started_at END,
     follow_ended_at = NULL`
);
const followOffStmt = db.prepare('UPDATE user_follows SET followed = 0, follow_ended_at = ? WHERE user_id = ? AND mmsi = ?');
function setUserFollow(userId, mmsi, on) {
  const now = new Date().toISOString();
  if (on) upsertUserFollowOnStmt.run(userId, mmsi, now);
  else followOffStmt.run(now, userId, mmsi);
}

/** Currently-followed ships for a user (joined to ship rows). */
function getUserFollowedShips(userId) {
  return db
    .prepare(
      `SELECT s.*, f.follow_started_at, f.follow_ended_at FROM user_follows f
       JOIN ships s ON s.mmsi = f.mmsi
       WHERE f.user_id = ? AND f.followed = 1
       ORDER BY s.seen ASC, s.last_seen_at DESC`
    )
    .all(userId);
}

/** Ships a user followed in the past but no longer ("passate"). */
function getUserPastFollowedShips(userId) {
  return db
    .prepare(
      `SELECT s.*, f.follow_started_at, f.follow_ended_at FROM user_follows f
       JOIN ships s ON s.mmsi = f.mmsi
       WHERE f.user_id = ? AND f.followed = 0 AND f.follow_started_at IS NOT NULL
       ORDER BY f.follow_ended_at DESC, s.last_seen_at DESC`
    )
    .all(userId);
}

function getUserFollowedMmsis(userId) {
  return new Set(db.prepare('SELECT mmsi FROM user_follows WHERE user_id = ? AND followed = 1').all(userId).map((r) => r.mmsi));
}

/** UNION of every user's active follows + last position — drives the single
 *  shared follow stream (one bbox per distinct followed ship). */
function getAllFollowedPositions() {
  return db
    .prepare(
      `SELECT s.mmsi, s.ship_name, s.last_latitude AS lat, s.last_longitude AS lon, s.last_seen_at
       FROM ships s
       WHERE s.last_latitude IS NOT NULL AND s.last_longitude IS NOT NULL
         AND s.mmsi IN (SELECT DISTINCT mmsi FROM user_follows WHERE followed = 1)`
    )
    .all();
}

// Every followed ship regardless of whether we have an AIS position — including
// follows added by search that never got a fix (no row in `ships`, or a row with
// NULL last position). Used by the ShipFinder re-acquire sweep, which can locate a
// ship by MMSI even with zero prior fixes. (getAllFollowedPositions, used to build
// the AIS subscription boxes, deliberately requires a position and so misses these.)
function getAllFollowedShips() {
  return db
    .prepare(
      `SELECT uf.mmsi, s.ship_name, s.last_seen_at, s.last_latitude AS lat, s.last_longitude AS lon
       FROM (SELECT DISTINCT mmsi FROM user_follows WHERE followed = 1) uf
       LEFT JOIN ships s ON s.mmsi = uf.mmsi`
    )
    .all();
}

/** Users who actively follow a given ship (for notification fan-out). */
function getFollowersOf(mmsi) {
  return db.prepare('SELECT user_id FROM user_follows WHERE mmsi = ? AND followed = 1').all(mmsi).map((r) => r.user_id);
}

function setFollowSearchMode(userId, mmsi, mode) {
  db.prepare('UPDATE user_follows SET search_mode = ? WHERE user_id = ? AND mmsi = ?').run(mode ? 1 : 0, userId, mmsi);
}

function getUserFollowSearchMode(userId, mmsi) {
  const row = db.prepare('SELECT search_mode FROM user_follows WHERE user_id = ? AND mmsi = ? AND followed = 1').get(userId, mmsi);
  return row ? row.search_mode : 0;
}

/** Users actively following mmsi AND in search_mode=1 (follow_searching was sent, awaiting re-detection). */
function getSearchModeFollowersOf(mmsi) {
  return db.prepare('SELECT user_id FROM user_follows WHERE mmsi = ? AND followed = 1 AND search_mode = 1').all(mmsi).map((r) => r.user_id);
}

/** User ids whose monitored areas geographically contain the given point —
 *  the recipients of a position-based notification (arrival/high-risk/…). */
function getUsersSeeingPoint(lat, lon) {
  if (lat == null || lon == null) return [];
  return db
    .prepare(
      `SELECT DISTINCT ua.user_id FROM user_areas ua JOIN areas a ON a.key = ua.area_key
       WHERE ? BETWEEN a.sw_lat AND a.ne_lat AND ? BETWEEN a.sw_lon AND a.ne_lon`
    )
    .all(lat, lon)
    .map((r) => r.user_id);
}

/** User ids who have flagged a given ship. */
function getUsersFlagging(mmsi) {
  return db.prepare('SELECT user_id FROM user_flags WHERE mmsi = ?').all(mmsi).map((r) => r.user_id);
}

/** User ids who monitor a given catalog area (membership) — for area-based
 *  notification fan-out (e.g. berth lifecycle alerts). */
function getAreaOwners(areaKey) {
  return db.prepare('SELECT user_id FROM user_areas WHERE area_key = ?').all(areaKey).map((r) => r.user_id);
}

/** User ids who monitor BOTH given catalog areas (membership by key, not
 *  geographic bbox) — recipients of an area-change notification. Ensures a
 *  transition between two areas is only notified to users who actually
 *  monitor both, even when one area's bbox geographically contains the
 *  other's (which would otherwise over-notify via getUsersSeeingPoint). */
function getUsersWithBothAreas(areaKeyA, areaKeyB) {
  if (!areaKeyA || !areaKeyB) return [];
  return db
    .prepare(
      `SELECT ua1.user_id FROM user_areas ua1
       JOIN user_areas ua2 ON ua2.user_id = ua1.user_id AND ua2.area_key = ?
       WHERE ua1.area_key = ?`
    )
    .all(areaKeyB, areaKeyA)
    .map((r) => r.user_id);
}

// ── Per-user settings (key/value) ────────────────────────────────────────────
const getUserSettingsStmt = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?');
/** Raw {key: value} map of a user's stored settings (values are strings). */
function getUserSettings(userId) {
  const out = {};
  for (const r of getUserSettingsStmt.all(userId)) out[r.key] = r.value;
  return out;
}
const setUserSettingStmt = db.prepare(
  'INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value'
);
function setUserSetting(userId, key, value) {
  setUserSettingStmt.run(userId, key, value == null ? null : String(value));
}

// ── Telegram link helpers ────────────────────────────────────────────────────
const findUserBySettingStmt = db.prepare(
  'SELECT user_id FROM user_settings WHERE key = ? AND value = ? LIMIT 1'
);
/** User id whose setting `key` equals `value` (e.g. find the user owning a
 *  one-time Telegram link code, or the user bound to a chat id). null if none. */
function findUserIdBySetting(key, value) {
  if (value == null || value === '') return null;
  const row = findUserBySettingStmt.get(key, String(value));
  return row ? row.user_id : null;
}

const telegramLinkedStmt = db.prepare(
  "SELECT user_id FROM user_settings WHERE key = 'telegramChatId' AND value IS NOT NULL AND value != ''"
);
/** User ids that have linked a Telegram chat (recipients of a broadcast such as
 *  an AIS outage). Per-user toggles are still checked before sending. */
function getTelegramLinkedUserIds() {
  return telegramLinkedStmt.all().map((r) => r.user_id);
}

const userIdsWithSettingStmt = db.prepare(
  'SELECT user_id FROM user_settings WHERE key = ? AND value IS NOT NULL AND value != ?'
);
/** User ids that have a non-empty value for `key` — e.g. users who configured
 *  outbound webhooks, for broadcasting a global event like an AIS outage. */
function getUserIdsWithSetting(key, emptyValue = '') {
  return userIdsWithSettingStmt.all(key, emptyValue).map((r) => r.user_id);
}

/** Auto-stop follows whose ship has been silent for `hours`, across ALL users.
 *  Returns the distinct ships affected (for logging). */
function autoStopStaleFollowsAll(hours) {
  // Stop a follow only once it's been silent for `hours` AND has *been a follow*
  // for at least that long. The follow_started_at grace prevents a just-(re)started
  // follow — e.g. re-following a ship from "passate", whose last position is by
  // definition old — from being auto-stopped the instant it's re-enabled (it gets
  // a window to be re-acquired; see ship-follow.startReacquire).
  // Returns per-user rows so the caller can send follow_lost notifications.
  // "Silent" means no AIS *and* no scraped fix newer than the threshold: a follow
  // that AIS lost but ShipFinder/MyShipTracking still locates stays alive. The
  // effective-last is max(AIS last_seen, latest scrape received_at) — so a
  // scrape-only follow (epoch AIS sentinel) auto-stops only once even scraping
  // goes cold. NULL/missing both → effective-last NULL → not selected.
  const stale = db
    .prepare(
      `SELECT f.user_id, f.mmsi, s.ship_name FROM user_follows f JOIN ships s ON s.mmsi = f.mmsi
       WHERE f.followed = 1
         AND f.follow_started_at < datetime('now', ?)
         AND (
           SELECT MAX(t) FROM (
             SELECT s.last_seen_at AS t
             UNION ALL
             SELECT (SELECT MAX(received_at) FROM readings r WHERE r.mmsi = f.mmsi AND r.source <> 'ais')
           )
         ) < datetime('now', ?)`
    )
    .all(`-${hours} hours`, `-${hours} hours`);
  if (stale.length) {
    // Per (user_id, mmsi), not deduped by mmsi alone: the SELECT above already
    // scopes staleness to each user's own follow_started_at, but an UPDATE keyed
    // only on mmsi would stop the follow for EVERY user following that ship —
    // including one whose own follow just started and isn't stale at all.
    const now = new Date().toISOString();
    const stmt = db.prepare('UPDATE user_follows SET followed = 0, follow_ended_at = ?, search_mode = 0 WHERE user_id = ? AND mmsi = ? AND followed = 1');
    for (const s of stale) stmt.run(now, s.user_id, s.mmsi);
  }
  return stale;
}

const insertReading = db.prepare(`
  INSERT INTO readings (received_at, message_type, mmsi, ship_name, latitude, longitude,
    navigational_status, sog, cog, true_heading, raw_json, area)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Same as insertReading but sets `source` explicitly — used for scraped positions
// (source != 'ais'). The plain insertReading above lets `source` default to 'ais'.
const insertReadingSourced = db.prepare(`
  INSERT INTO readings (received_at, message_type, mmsi, ship_name, latitude, longitude,
    navigational_status, sog, cog, true_heading, raw_json, area, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const pruneStmt = db.prepare(`
  DELETE FROM readings
  WHERE message_type = ? AND id NOT IN (
    SELECT id FROM readings WHERE message_type = ? ORDER BY id DESC LIMIT ?
  )
`);

const upsertShipStmt = db.prepare(`
  INSERT INTO ships (mmsi, ship_name, first_seen_at, last_seen_at,
    last_latitude, last_longitude, last_sog, last_cog, last_navigational_status,
    ship_type, destination, max_draught,
    call_sign, imo_number, dim_bow, dim_stern, dim_port, dim_starboard, eta, last_area)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(mmsi) DO UPDATE SET
    ship_name = COALESCE(excluded.ship_name, ships.ship_name),
    last_seen_at = excluded.last_seen_at,
    last_latitude = COALESCE(excluded.last_latitude, ships.last_latitude),
    last_longitude = COALESCE(excluded.last_longitude, ships.last_longitude),
    last_sog = COALESCE(excluded.last_sog, ships.last_sog),
    last_cog = COALESCE(excluded.last_cog, ships.last_cog),
    last_navigational_status = COALESCE(excluded.last_navigational_status, ships.last_navigational_status),
    ship_type = COALESCE(excluded.ship_type, ships.ship_type),
    destination = COALESCE(excluded.destination, ships.destination),
    max_draught = COALESCE(excluded.max_draught, ships.max_draught),
    call_sign = COALESCE(excluded.call_sign, ships.call_sign),
    imo_number = COALESCE(excluded.imo_number, ships.imo_number),
    dim_bow = COALESCE(excluded.dim_bow, ships.dim_bow),
    dim_stern = COALESCE(excluded.dim_stern, ships.dim_stern),
    dim_port = COALESCE(excluded.dim_port, ships.dim_port),
    dim_starboard = COALESCE(excluded.dim_starboard, ships.dim_starboard),
    eta = COALESCE(excluded.eta, ships.eta),
    last_area = excluded.last_area
`);

// Minimal master row for a ship we follow but have NEVER seen via AIS (followed
// from a ShipFinder/MyShipTracking scrape fix). last_seen_at is an epoch sentinel
// so the AIS-freshness logic treats it as "never seen": worldwide re-acquire box,
// "in ricerca", and — now that auto-stop counts scrape activity — no premature
// auto-stop. A real AIS frame later overwrites last_seen_at via upsertShip.
// INSERT OR IGNORE never clobbers an existing (AIS-fed) row.
const NEVER_SEEN_AIS = '1970-01-01T00:00:00.000Z';
const insertShipStubStmt = db.prepare(
  `INSERT OR IGNORE INTO ships (mmsi, ship_name, first_seen_at, last_seen_at, flagged)
   VALUES (?, ?, ?, ?, 0)`
);
function ensureShipStub(mmsi, name) {
  insertShipStubStmt.run(mmsi, name || null, NEVER_SEEN_AIS, NEVER_SEEN_AIS);
}

// Most recent name we scraped for a ship (SF/MST), for labelling a stub master row.
function getScrapedShipName(mmsi) {
  const row = db
    .prepare("SELECT ship_name FROM readings WHERE mmsi = ? AND source <> 'ais' AND ship_name IS NOT NULL ORDER BY received_at DESC LIMIT 1")
    .get(mmsi);
  return row ? row.ship_name : null;
}

const getShipLastSeen = db.prepare(
  'SELECT last_seen_at, ship_name, ship_type, destination, max_draught, flagged, last_area FROM ships WHERE mmsi = ?'
);

// 1 if ANY user has flagged this ship (per-user flags replaced the global column).
const anyUserFlagStmt = db.prepare('SELECT 1 FROM user_flags WHERE mmsi = ? LIMIT 1');

const insertPortEventStmt = db.prepare(
  'INSERT INTO port_events (mmsi, ship_name, event_type, ts, ship_type, destination, draught, area) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);

// Same as above but for a 'departed' event, which also carries the stop evidence
// of the visit that just closed (stop_min_sog / stopped, see the ALTER above).
const insertDepartureStmt = db.prepare(
  `INSERT INTO port_events (mmsi, ship_name, event_type, ts, ship_type, destination, draught, area, stop_min_sog, stopped)
   VALUES (?, ?, 'departed', ?, ?, ?, ?, ?, ?, ?)`
);

// Start of the visit that ended at `ts`: the ship's last recorded arrival in that
// area at or before it. Null for a departure with no matching arrival (possible
// for rows restored from a backup that predates the area tagging).
const lastArrivalBeforeStmt = db.prepare(
  `SELECT ts FROM port_events
   WHERE mmsi = ? AND area = ? AND event_type = 'arrived' AND ts <= ?
   ORDER BY ts DESC LIMIT 1`
);

// Slowest speed the ship broadcast inside the area during one visit, plus how
// many positions back it. Only AIS fixes count (scraped SF/MST positions carry a
// coarser, less trustworthy speed). n = 0 means the visit left no usable speed —
// the caller then stores NULL rather than a guess.
const visitMinSogStmt = db.prepare(
  `SELECT MIN(sog) AS min_sog, COUNT(sog) AS n FROM readings
   WHERE mmsi = ? AND area = ? AND source = 'ais' AND sog IS NOT NULL
     AND received_at >= ? AND received_at <= ?`
);

// Stop evidence for a visit [fromIso..toIso] of `mmsi` in `area`, evaluated when
// its departure is logged: { minSog, stopped }. `stopped` is null when the visit
// left no speed data behind (the readings were pruned, or it never broadcast a
// speed) — the transit search then judges it by dwell alone.
function visitStopEvidence(mmsi, area, fromIso, toIso) {
  if (!area || !fromIso) return { minSog: null, stopped: null };
  const dwellH = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3600000;
  if (!Number.isFinite(dwellH)) return { minSog: null, stopped: null };
  const row = visitMinSogStmt.get(mmsi, area, fromIso, toIso);
  if (!row || !row.n) return { minSog: null, stopped: null };
  const minSog = row.min_sog;
  return { minSog, stopped: dwellH >= TRANSIT.STOP_MIN_H && minSog <= TRANSIT.STOP_MAX_SOG_KN ? 1 : 0 };
}

// First departure logged for `area` at or after `ts` — closes the visit that
// started with the arrival at `ts`.
const departureAfterStmt = db.prepare(
  `SELECT ts, stopped FROM port_events
   WHERE mmsi = ? AND area = ? AND event_type = 'departed' AND ts >= ?
   ORDER BY ts ASC LIMIT 1`
);

/**
 * Did this ship actually CALL at `area` on its latest visit there (as opposed to
 * merely crossing the bbox)? `lastSeenIso` is when the ship was last seen before
 * the message being processed — i.e. the end of that visit when it has no
 * departure row yet.
 *
 * Gates the "cambio area" notification: a bbox is an area of interest, often
 * hundreds of km wide, so "moved from X to Y" was firing for ships that only
 * transited X — reported by a user for the wide "Israele" box, where traffic
 * bound for Turkish or Lebanese ports crosses the rectangle without ever calling
 * inside it.
 *
 * Requires POSITIVE evidence: with no recorded arrival to point at (history
 * pruned by an area deletion, or predating area tagging) it returns false rather
 * than claiming a call nobody can verify.
 */
function lastAreaVisitWasStop(mmsi, area, lastSeenIso) {
  if (!area) return false;
  const arrival = lastArrivalBeforeStmt.get(mmsi, area, lastSeenIso || new Date().toISOString());
  if (!arrival) return false;
  const departure = departureAfterStmt.get(mmsi, area, arrival.ts);
  // Visits closed by this version carry the measured verdict (dwell + min speed).
  if (departure && departure.stopped != null) return !!departure.stopped;
  const endIso = departure ? departure.ts : lastSeenIso;
  if (!endIso) return false;
  const dwellH = (new Date(endIso).getTime() - new Date(arrival.ts).getTime()) / 3600000;
  return Number.isFinite(dwellH) && dwellH >= TRANSIT.STOP_MIN_H;
}

// How many times this MMSI has already been recorded arriving in a given area —
// used to detect a re-visit (an arrival where it had been seen before).
const countPriorArrivalsStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM port_events WHERE mmsi = ? AND event_type = 'arrived' AND area = ?"
);

// Returns 1 if the ship's most recent port_event in the given area is a 'departed'.
// Used to guard revisit detection: a new arrival is a true revisit only if the ship
// actually left (has a departed event after its last arrived). Pure AIS signal gaps
// (ship stays put but signal drops >1h) must NOT trigger revisit notifications.
const lastEventWasDepartedStmt = db.prepare(`
  SELECT event_type FROM port_events
  WHERE mmsi = ? AND area = ?
  ORDER BY ts DESC
  LIMIT 1
`);

function parseGoTime(t) {
  if (!t) return new Date().toISOString();
  try {
    const iso = t
      .replace(' ', 'T')
      .replace(/\s\+0000\sUTC$/, 'Z')
      .replace(/(\.\d{3})\d+Z$/, '$1Z');
    const d = new Date(iso);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

const insertCounters = {};

// Returns { arrivedFlagged, newShip, revisit, areaChange, arrived }: arrivedFlagged
// = mmsi when a flagged ship re-arrived (for alerts), newShip = mmsi the first time
// an MMSI is ever seen (for proactive enrichment), revisit = mmsi when a ship arrives
// in an area where it had already been seen before, areaChange = { mmsi, fromArea,
// toArea } when a ship moves from one monitored area to a different one, arrived =
// mmsi on any arrival (new MMSI or after >60min absence, for high-risk notifications
// and score snapshots). All null otherwise.

// AISstream sends Eta as {Month, Day, Hour, Minute} object, not a string.
function formatEta(e) {
  if (!e) return null;
  if (typeof e === 'object') {
    const { Month: mo = 0, Day: d = 0, Hour: h = 0, Minute: mi = 0 } = e;
    if (!mo && !d) return null;
    return `${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }
  return String(e).trim() || null;
}

function insert(parsed, areaKey = '') {
  const { MessageType, MetaData, Message } = parsed;
  const meta = MetaData || {};
  const msgData = Message?.[MessageType] || {};

  const row = {
    received_at: parseGoTime(meta.time_utc),
    message_type: MessageType,
    mmsi: meta.MMSI ?? null,
    ship_name: (meta.ShipName || msgData.Name || '').trim() || null,
    latitude: meta.latitude ?? null,
    longitude: meta.longitude ?? null,
    navigational_status: msgData.NavigationalStatus?.toString() ?? null,
    sog: msgData.Sog ?? null,
    cog: msgData.Cog ?? null,
    true_heading: msgData.TrueHeading ?? null,
    // raw_json is only consumed by the CSV export, to recover the extra fields
    // that have no dedicated column. Position reports carry nothing beyond the
    // columns above, so storing their full payload (~600B/row, the bulk of this
    // table) is pure waste — keep it only for the static-data message types that
    // actually have extra fields. Empty string (not NULL: column is NOT NULL);
    // export.js JSON.parse('') throws and falls back to the base columns.
    raw_json:
      MessageType === 'ShipStaticData' || MessageType === 'ExtendedClassBPositionReport'
        ? JSON.stringify(parsed)
        : '',
    // Static data fields — only present in ShipStaticData / ExtendedClassB
    ship_type: msgData.Type ?? null,
    destination: msgData.Destination?.trim() || null,
    max_draught: msgData.MaximumStaticDraught ?? null,
    call_sign: msgData.CallSign?.trim() || null,
    imo_number: msgData.ImoNumber || null,
    dim_bow: msgData.DimensionToBow || null,
    dim_stern: msgData.DimensionToStern || null,
    dim_port: msgData.DimensionToPort || null,
    dim_starboard: msgData.DimensionToStarboard || null,
    eta: formatEta(msgData.Eta),
  };

  insertReading.run(
    row.received_at,
    row.message_type,
    row.mmsi,
    row.ship_name,
    row.latitude,
    row.longitude,
    row.navigational_status,
    row.sog,
    row.cog,
    row.true_heading,
    row.raw_json,
    areaKey
  );

  let arrivedFlagged = null;
  let newShip = null;
  let revisit = null;
  let areaChange = null;
  let arrived = null;

  if (row.mmsi) {
    const existing = getShipLastSeen.get(row.mmsi);
    if (!existing) newShip = row.mmsi; // first time this MMSI is seen
    const wasAbsent =
      !existing || new Date(row.received_at) - new Date(existing.last_seen_at) > 60 * 60 * 1000;

    // Area change = ship was last seen in a different (non-empty) area than the
    // one this message belongs to. Checked before the upsert overwrites last_area.
    const prevArea = existing?.last_area || '';
    if (prevArea && areaKey && prevArea !== areaKey) {
      // Two questions the notifier needs answered before it can honestly say
      // "moved from X to Y": did the ship actually CALL at X (or just cross the
      // bbox), and is that call recent enough to explain its presence here now?
      // The gap is measured from the last sighting in X to this message, and
      // compared with how long the passage may plausibly take (areaHopGate).
      const gate = areaHopGate(prevArea, areaKey);
      const gapH = existing?.last_seen_at
        ? (new Date(row.received_at).getTime() - new Date(existing.last_seen_at).getTime()) / 3600000
        : null;
      areaChange = {
        mmsi: row.mmsi,
        fromArea: prevArea,
        toArea: areaKey,
        fromWasStop: lastAreaVisitWasStop(row.mmsi, prevArea, existing?.last_seen_at || null),
        fromLastSeenAt: existing?.last_seen_at || null,
        gapH,
        gateH: gate.gateH,
        distNm: gate.distNm,
        timePlausible: gapH != null && gapH >= 0 && gapH <= gate.gateH,
        // Same water in both areas → this is not a move at all (see boxesOverlap).
        overlappingAreas: gate.overlap,
      };
    }

    upsertShipStmt.run(
      row.mmsi,
      row.ship_name,
      row.received_at,
      row.received_at,
      row.latitude,
      row.longitude,
      row.sog,
      row.cog,
      row.navigational_status,
      row.ship_type,
      row.destination,
      row.max_draught,
      row.call_sign,
      row.imo_number,
      row.dim_bow,
      row.dim_stern,
      row.dim_port,
      row.dim_starboard,
      row.eta,
      areaKey
    );

    if (wasAbsent) {
      // A re-visit = this MMSI has already been recorded arriving in this same
      // area before (checked before logging the current arrival).
      const priorSameArea = countPriorArrivalsStmt.get(row.mmsi, areaKey).n;
      const lastEvent = priorSameArea > 0 ? lastEventWasDepartedStmt.get(row.mmsi, areaKey) : null;
      insertPortEventStmt.run(
        row.mmsi,
        row.ship_name || existing?.ship_name || null,
        'arrived',
        row.received_at,
        row.ship_type ?? existing?.ship_type ?? null,
        row.destination || existing?.destination || null,
        row.max_draught ?? existing?.max_draught ?? null,
        areaKey
      );
      if (priorSameArea > 0 && lastEvent?.event_type === 'departed') revisit = row.mmsi;
      // Flagged is now per-user: signal the arrival if ANY user flagged this ship
      // (the stream fans the toast out to those users who also monitor the area).
      if (anyUserFlagStmt.get(row.mmsi)) arrivedFlagged = row.mmsi;
      arrived = row.mmsi; // any arrival (new or after >60min absence)
    }
  }

  insertCounters[MessageType] = (insertCounters[MessageType] || 0) + 1;
  if (insertCounters[MessageType] % 500 === 0) {
    pruneStmt.run(MessageType, MessageType, MAX_READINGS_PER_TYPE);
  }

  return { arrivedFlagged, newShip, revisit, areaChange, arrived };
}

// Like upsertShipStmt but for the follow stream: a followed ship out on the open
// sea has no monitored area, so last_area must NOT be clobbered to '' (that would
// drop it from its last area's active list prematurely). Only overwrite last_area
// when the follow position actually falls inside a monitored area.
const upsertFollowStmt = db.prepare(`
  INSERT INTO ships (mmsi, ship_name, first_seen_at, last_seen_at,
    last_latitude, last_longitude, last_sog, last_cog, last_navigational_status, last_area)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(mmsi) DO UPDATE SET
    ship_name = COALESCE(excluded.ship_name, ships.ship_name),
    last_seen_at = excluded.last_seen_at,
    last_latitude = COALESCE(excluded.last_latitude, ships.last_latitude),
    last_longitude = COALESCE(excluded.last_longitude, ships.last_longitude),
    last_sog = COALESCE(excluded.last_sog, ships.last_sog),
    last_cog = COALESCE(excluded.last_cog, ships.last_cog),
    last_navigational_status = COALESCE(excluded.last_navigational_status, ships.last_navigational_status),
    last_area = CASE WHEN excluded.last_area != '' THEN excluded.last_area ELSE ships.last_area END
`);

// Lightweight write for positions arriving on the follow stream. Updates the
// ship's last position and appends a reading (so the track stays continuous),
// but deliberately skips the port-event / arrival / berth / notification logic
// of insert(): the follow stream's job is "where is it now", not port analytics.
// If the ship is inside a monitored area, that area's own stream handles arrivals.
// `area` is the resolved monitored-area key for this position (or '' if at sea).
function insertFollowPosition(parsed, area = '') {
  const { MessageType, MetaData, Message } = parsed;
  const meta = MetaData || {};
  const msgData = Message?.[MessageType] || {};
  const mmsi = meta.MMSI ?? null;
  if (!mmsi) return null;

  const received_at = parseGoTime(meta.time_utc);
  const name = (meta.ShipName || msgData.Name || '').trim() || null;
  const lat = meta.latitude ?? null;
  const lon = meta.longitude ?? null;

  insertReading.run(
    received_at,
    MessageType,
    mmsi,
    name,
    lat,
    lon,
    msgData.NavigationalStatus?.toString() ?? null,
    msgData.Sog ?? null,
    msgData.Cog ?? null,
    msgData.TrueHeading ?? null,
    MessageType === 'ShipStaticData' || MessageType === 'ExtendedClassBPositionReport'
      ? JSON.stringify(parsed)
      : '',
    area
  );

  upsertFollowStmt.run(
    mmsi,
    name,
    received_at,
    received_at,
    lat,
    lon,
    msgData.Sog ?? null,
    msgData.Cog ?? null,
    msgData.NavigationalStatus?.toString() ?? null,
    area
  );

  insertCounters[MessageType] = (insertCounters[MessageType] || 0) + 1;
  if (insertCounters[MessageType] % 500 === 0) {
    pruneStmt.run(MessageType, MessageType, MAX_READINGS_PER_TYPE);
  }
  return mmsi;
}

// Persist a position obtained by scraping (ShipFinder) for a ship AIS has lost.
// Stored in `readings` tagged source != 'ais', so it is EXCLUDED from the AIS
// track polyline, risk scoring and replay (lower trust, irregular cadence) and
// surfaces only as a distinct "last known (ShipFinder)" marker on the detail map.
// By default does NOT touch the ships master row: last_seen_at stays the AIS
// freshness signal, so the follow stream keeps re-acquiring the ship over its
// worldwide box and the 6-month auto-stop isn't reset by a scraped fix. Skips a
// duplicate of the latest stored fix (same report time). Returns the stored fix.
// `opts.updateShipRow` (used only by fallback-mode's area-scope sweep, which has
// no re-acquire/auto-stop logic to protect) also refreshes ships.last_latitude/
// last_longitude/last_seen_at — otherwise the ship ages out of ACTIVE_PREDICATE
// (main map/list) even while fresh sf/mst fixes keep arriving.
function insertScrapedPosition(mmsi, pos, source = 'sf', opts = {}) {
  if (!mmsi || !pos || pos.lat == null || pos.lon == null) return null;
  const received_at = pos.reportedAt || new Date().toISOString();
  const last = db
    .prepare("SELECT id, received_at, latitude AS lat, longitude AS lon FROM readings WHERE mmsi = ? AND source = ? AND latitude IS NOT NULL ORDER BY received_at DESC LIMIT 1")
    .get(mmsi, source);
  if (last && last.received_at === received_at) return null;
  const touchShipRow = () => {
    if (!opts.updateShipRow) return;
    db.prepare(
      `UPDATE ships SET last_latitude = ?, last_longitude = ?, last_seen_at = ?,
         last_sog = COALESCE(?, last_sog), last_cog = COALESCE(?, last_cog),
         last_navigational_status = COALESCE(?, last_navigational_status)
       WHERE mmsi = ?`
    ).run(pos.lat, pos.lon, received_at, pos.sog ?? null, pos.cog ?? null, pos.status ?? null, mmsi);
  };
  // Spatial dedup: if new fix is within cluster radius of the last stored fix,
  // just refresh the timestamp of that row instead of inserting a new point.
  // Prevents port-cluster bloat when a ship is moored and position doesn't change.
  if (last && last.lat != null && last.lon != null) {
    const radiusM = cfg.state.scrapeClusterRadiusM;
    if (radiusM > 0 && haversineM(last.lat, last.lon, pos.lat, pos.lon) < radiusM) {
      db.prepare('UPDATE readings SET received_at = ? WHERE id = ?').run(received_at, last.id);
      touchShipRow();
      return null;
    }
  }
  insertReadingSourced.run(
    received_at,
    'ShipfinderPosition',
    mmsi,
    pos.name || null,
    pos.lat,
    pos.lon,
    pos.status ?? null,
    pos.sog ?? null,
    pos.cog ?? null,
    pos.heading != null ? Math.round(pos.heading) : null,
    JSON.stringify(pos),
    '',
    source
  );
  insertCounters.ShipfinderPosition = (insertCounters.ShipfinderPosition || 0) + 1;
  if (insertCounters.ShipfinderPosition % 500 === 0) {
    pruneStmt.run('ShipfinderPosition', 'ShipfinderPosition', MAX_READINGS_PER_TYPE);
  }
  touchShipRow();
  return { mmsi, received_at, lat: pos.lat, lon: pos.lon, sog: pos.sog ?? null, cog: pos.cog ?? null, status: pos.status ?? null };
}

// Scraped positions (source != 'ais') for a ship, oldest-first — the breadcrumb of
// last-known fixes shown as distinct markers on the detail map.
function getScrapedPositions(mmsi, source = 'sf', limit = 200) {
  return db
    .prepare(
      `SELECT received_at, latitude AS lat, longitude AS lon, sog, cog, navigational_status AS status
       FROM readings
       WHERE mmsi = ? AND source = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
       ORDER BY received_at ASC LIMIT ?`
    )
    .all(mmsi, source, limit);
}

// Most recent scraped fix for a ship, or null.
function getLatestScrapedPosition(mmsi, source = 'sf') {
  return (
    db
      .prepare(
        `SELECT received_at, latitude AS lat, longitude AS lon, sog, cog, navigational_status AS status
         FROM readings
         WHERE mmsi = ? AND source = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
         ORDER BY received_at DESC LIMIT 1`
      )
      .get(mmsi, source) || null
  );
}

function checkAndLogDepartures() {
  const departed = db
    .prepare(
      `
    SELECT mmsi, ship_name, ship_type, destination, max_draught, last_seen_at, last_area
    FROM ships
    WHERE last_seen_at <= datetime('now', '-60 minutes')
    AND NOT EXISTS (
      SELECT 1 FROM port_events
      WHERE port_events.mmsi = ships.mmsi
        AND port_events.event_type = 'departed'
        AND port_events.ts >= ships.last_seen_at
    )
  `
    )
    .all();

  for (const ship of departed) {
    const area = ship.last_area || '';
    // Judge the visit that just closed while its positions are still in DB
    // (readings are capped globally, so this evidence is only obtainable now).
    const arrival = area ? lastArrivalBeforeStmt.get(ship.mmsi, area, ship.last_seen_at) : null;
    const ev = visitStopEvidence(ship.mmsi, area, arrival?.ts || null, ship.last_seen_at);
    insertDepartureStmt.run(
      ship.mmsi,
      ship.ship_name,
      ship.last_seen_at,
      ship.ship_type,
      ship.destination,
      ship.max_draught ?? null,
      area,
      ev.minSog,
      ev.stopped
    );
  }
  // One per-minute summary line instead of one per ship (mirrors arrivals).
  if (departed.length) {
    const list = departed.map((s) => s.ship_name || s.mmsi).join(', ');
    appLog.info('PORTO', appLog.t('port.departures', { count: departed.length, list }), { navi: departed.length });
  }
  return departed.length;
}

// "Active" = seen within ACTIVE_WINDOW, OR in-port (moored/anchored or
// SOG≈0) seen within the longer PORT_WINDOW. In-port ships transmit rarely
// (up to every few hours for moored AIS class A), so they need a wider
// retention to stay visible after a stream restart instead of dropping to Past.
const ACTIVE_PREDICATE = `(
  last_seen_at > datetime('now', '-${ACTIVE_WINDOW_HOURS} hours')
  OR (
    (last_sog < ${DB_SOG_FERMA} OR last_navigational_status IN ('1', '5'))
    AND last_seen_at > datetime('now', '-${PORT_WINDOW_HOURS} hours')
  )
)`;

// `boxes` (optional): per-user geographic scope. null → no geo filter (used by
// background callers like enrichment that operate over every area).
function getActiveShips(area, boxes = null) {
  const filter = area ? 'AND last_area = ?' : '';
  const geo = `AND ${boxesSql(boxes, 'last_latitude', 'last_longitude')}`;
  const params = area ? [area] : [];
  return db
    .prepare(
      `SELECT * FROM ships
       WHERE ${ACTIVE_PREDICATE} ${filter} ${geo}
       ORDER BY seen ASC, last_seen_at DESC`
    )
    .all(...params);
}

// Ships last tagged to an area currently in "silent fallback" (fallback_enabled
// AND no real AIS message more recently than areaSilentCutoffIso — see
// services/fallback-mode.js) that are NOT already followed and have had no fix
// in freshMs. Followed ships are excluded here since they're already covered
// by the followed-ships pool, so the same MMSI is never scraped twice in one
// sweep.
//
// Deliberately does NOT reuse ACTIVE_PREDICATE (unlike getActiveShips): that
// predicate is exactly what demotes a ship from "active" to "past" after
// ACTIVE_WINDOW_HOURS/PORT_WINDOW_HOURS of AIS silence — gating the fallback
// candidate pool on it created a catch-22 for any outage longer than that
// window (6h/24h): a ship needs a scraped fix to look "active" again, but it's
// excluded from scraping the moment it stops looking active. A real multi-day
// AISStream outage hit this immediately — every area ship fell out of
// ACTIVE_PREDICATE within a day, permanently locking area-scope fallback out
// of ever repositioning any of them, no matter how long it stayed on.
// Membership in a monitored area (`last_area`) doesn't expire this way, so it's
// the right gate here: exactly the ships fallback mode exists to rescue.
function getStaleAreaShips(freshMs, areaSilentCutoffIso) {
  const shipCutoff = new Date(Date.now() - freshMs).toISOString();
  return db
    .prepare(
      `SELECT s.mmsi, s.ship_name, s.last_seen_at, s.last_latitude AS lat, s.last_longitude AS lon
       FROM ships s
       JOIN areas a ON a.key = s.last_area
       WHERE a.fallback_enabled = 1
         AND (a.last_ais_message_at IS NULL OR a.last_ais_message_at < ?)
         AND (s.last_seen_at IS NULL OR s.last_seen_at < ?)
         AND s.mmsi NOT IN (SELECT DISTINCT mmsi FROM user_follows WHERE followed = 1)`
    )
    .all(areaSilentCutoffIso, shipCutoff);
}

// Confirmed area ports with a resolved MyShipTracking id, for areas currently
// silent (same areaSilentCutoffIso as getStaleAreaShips — one shared
// definition of "silent", see services/fallback-mode.js). The candidate pool
// for port-arrivals ship discovery (crawlPortArrivals): areas whose AIS is
// quiet but that have a recognized port get a chance to discover ships AIS
// never reported at all, not just reposition already-known ones.
function getPortDiscoveryTargets(areaSilentCutoffIso) {
  return db
    .prepare(
      `SELECT ap.id AS port_id, ap.area_key, ap.mst_pid, ap.name
       FROM area_ports ap
       JOIN areas a ON a.key = ap.area_key
       WHERE ap.status = 'confirmed' AND ap.mst_pid IS NOT NULL
         AND a.fallback_enabled = 1
         AND (a.last_ais_message_at IS NULL OR a.last_ais_message_at < ?)`
    )
    .all(areaSilentCutoffIso);
}

// Retag a ship's most-recently-associated area — used when a port-arrivals
// discovery hit places a ship near a port for the first time (or again, in a
// different area than last known): an arrival/departure event is a recency
// signal, so retagging is correct even if the ship already belonged elsewhere.
const setShipLastAreaStmt = db.prepare('UPDATE ships SET last_area = ? WHERE mmsi = ?');
function setShipLastArea(mmsi, areaKey) {
  setShipLastAreaStmt.run(areaKey, mmsi);
}

function getPastShips(area, boxes = null) {
  const filter = area ? 'AND last_area = ?' : '';
  const geo = `AND ${boxesSql(boxes, 'last_latitude', 'last_longitude')}`;
  const params = area ? [area] : [];
  return db
    .prepare(
      `SELECT * FROM ships
       WHERE NOT ${ACTIVE_PREDICATE} ${filter} ${geo}
       ORDER BY seen ASC, last_seen_at DESC`
    )
    .all(...params);
}

function getPastShipsCount(area, boxes = null) {
  const filter = area ? 'AND last_area = ?' : '';
  const geo = `AND ${boxesSql(boxes, 'last_latitude', 'last_longitude')}`;
  const params = area ? [area] : [];
  return db
    .prepare(`SELECT COUNT(*) AS n FROM ships WHERE NOT ${ACTIVE_PREDICATE} ${filter} ${geo}`)
    .get(...params).n;
}

function getShip(mmsi) {
  return db.prepare('SELECT * FROM ships WHERE mmsi = ?').get(mmsi) || null;
}

// Free-text search over the local fleet for the ship-search feature: matches a
// numeric term against MMSI / IMO exactly, and a text term against the ship name
// (case-insensitive substring). Most-recently-seen first.
function searchShipsByName(q, limit = 25) {
  const term = String(q || '').trim();
  if (!term) return [];
  const digits = /^\d+$/.test(term);
  if (digits) {
    const n = Number(term);
    return db
      .prepare(
        `SELECT mmsi, ship_name, ship_type, call_sign, imo_number,
                last_latitude, last_longitude, last_seen_at
         FROM ships WHERE mmsi = ? OR imo_number = ?
         ORDER BY last_seen_at DESC LIMIT ?`
      )
      .all(n, n, limit);
  }
  return db
    .prepare(
      `SELECT mmsi, ship_name, ship_type, call_sign, imo_number,
              last_latitude, last_longitude, last_seen_at
       FROM ships WHERE ship_name LIKE ? COLLATE NOCASE
       ORDER BY last_seen_at DESC LIMIT ?`
    )
    .all(`%${term}%`, limit);
}

function getShipReadings(mmsi, limit = 50, offset = 0) {
  const rows = db
    .prepare(
      `
    SELECT id, received_at, message_type, mmsi, ship_name, latitude, longitude,
           navigational_status, sog, cog, true_heading, source
    FROM readings WHERE mmsi = ? ORDER BY received_at DESC LIMIT ? OFFSET ?
  `
    )
    .all(mmsi, limit, offset);
  const total = db.prepare('SELECT COUNT(*) as n FROM readings WHERE mmsi = ?').get(mmsi).n;
  return { rows, total };
}

// Recent positions for in-port hysteresis: a ship swinging at anchor / drifting
// on current stays within a small radius even if its instantaneous SOG spikes.
function getRecentPositions(mmsi, minutes = 30) {
  return db
    .prepare(
      `
    SELECT latitude AS lat, longitude AS lon, sog
    FROM readings
    WHERE mmsi = ? AND received_at > datetime('now', ?)
      AND latitude IS NOT NULL AND longitude IS NOT NULL AND source = 'ais'
    ORDER BY received_at DESC
    LIMIT 50
  `
    )
    .all(mmsi, `-${minutes} minutes`);
}

// Recent positions for risk scoring (dark-activity gaps, speed-jump spoofing,
// loitering). Time-bounded and oldest-first so consecutive-pair analysis works.
function getShipPositions(mmsi, hours = 168, limit = 2000) {
  // Keep the MOST RECENT `limit` positions (inner DESC + LIMIT), then hand them
  // back oldest-first for chronological processing. Ordering ASC before the
  // LIMIT would truncate from the wrong end — dropping recent blackouts/spoofing
  // and keeping stale positions once a ship exceeds `limit` readings in-window.
  return db
    .prepare(
      `
    SELECT received_at, lat, lon, sog, ns FROM (
      SELECT received_at, latitude AS lat, longitude AS lon, sog, navigational_status AS ns
      FROM readings
      WHERE mmsi = ? AND received_at > datetime('now', ?)
        AND latitude IS NOT NULL AND longitude IS NOT NULL AND source = 'ais'
      ORDER BY received_at DESC
      LIMIT ?
    )
    ORDER BY received_at ASC
  `
    )
    .all(mmsi, `-${hours} hours`, limit);
}

// Distinct (non-null) names a single MMSI has broadcast — name hopping signal.
function getDistinctShipNames(mmsi) {
  return db
    .prepare(
      "SELECT DISTINCT ship_name FROM readings WHERE mmsi = ? AND ship_name IS NOT NULL AND source = 'ais'"
    )
    .all(mmsi)
    .map((r) => r.ship_name);
}

// `sources` selects which reading sources feed the single-ship track: ['ais']
// by default, optionally widened with 'sf'/'mst' when the user keeps the track
// "Includi SF/MST" toggle on and those integrations are enabled.
function getShipTrackRange(mmsi, sources = ['ais']) {
  const ph = sources.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT MIN(received_at) AS lo, MAX(received_at) AS hi
       FROM readings WHERE mmsi = ? AND latitude IS NOT NULL AND longitude IS NOT NULL AND source IN (${ph})`
    )
    .get(mmsi, ...sources);
}

function getShipTrack(mmsi, limit = 500, from = null, to = null, sources = ['ais']) {
  const ph = sources.map(() => '?').join(', ');
  const where = ['mmsi = ?', 'latitude IS NOT NULL', 'longitude IS NOT NULL', `source IN (${ph})`];
  const params = [mmsi, ...sources];
  if (from) { where.push('received_at >= ?'); params.push(from); }
  if (to)   { where.push('received_at <= ?'); params.push(to); }
  params.push(limit);
  return db
    .prepare(
      `SELECT id, received_at, latitude, longitude, sog, cog, source
       FROM readings
       WHERE ${where.join(' AND ')}
       ORDER BY received_at ASC
       LIMIT ?`
    )
    .all(...params);
}

// Last `limit` positions per ship (within `sinceIso`) for a batch of mmsis, e.g.
// the small recent-trail breadcrumb drawn under each map marker (navi seguite,
// and optionally the area map). One windowed query for the whole batch rather
// than N per-ship round trips. Returns { [mmsi]: [{lat,lon,at}, ...] } ordered
// oldest→newest per ship.
function getRecentTrails(mmsis, limit, sinceIso, sources) {
  if (!mmsis.length) return {};
  const mmsiPh = mmsis.map(() => '?').join(', ');
  const srcPh = sources.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT mmsi, received_at, latitude, longitude FROM (
         SELECT mmsi, received_at, latitude, longitude,
                ROW_NUMBER() OVER (PARTITION BY mmsi ORDER BY received_at DESC) AS rn
         FROM readings
         WHERE mmsi IN (${mmsiPh}) AND latitude IS NOT NULL AND longitude IS NOT NULL
           AND source IN (${srcPh}) AND received_at >= ?
       ) WHERE rn <= ?
       ORDER BY mmsi, received_at ASC`
    )
    .all(...mmsis, ...sources, sinceIso, limit);
  const out = {};
  for (const r of rows) {
    (out[r.mmsi] || (out[r.mmsi] = [])).push({ lat: r.latitude, lon: r.longitude, at: r.received_at });
  }
  return out;
}

// Whether this ship has any reading from one of `sources` (e.g. ['sf','mst']) —
// drives the track "Includi SF/MST" toggle visibility (shown only when there is
// scraped data to add). Cheap, indexed by mmsi.
function hasShipScrapedPositions(mmsi, sources) {
  if (!sources || !sources.length) return false;
  const ph = sources.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT 1 FROM readings
       WHERE mmsi = ? AND latitude IS NOT NULL AND longitude IS NOT NULL AND source IN (${ph})
       LIMIT 1`
    )
    .get(mmsi, ...sources);
  return !!row;
}

// Positions inside an area's bbox(es) within a time window, for historical
// replay. Joined with the ship master for name/type. Ordered by ship then time
// so the route can group cheaply. `limit` caps the raw rows (the route
// downsamples per ship if the cap is hit).
// `sources` selects which reading sources feed the replay: ['ais'] by default,
// optionally widened with 'sf'/'mst' (ShipFinder/MyShipTracking scraped fixes)
// when the user keeps the replay toggle on and those integrations are enabled.
function getAreaReplayPositions(boxes, fromIso, toIso, limit, sources = ['ais']) {
  const geo = boxesSql(boxes, 'r.latitude', 'r.longitude');
  const ph = sources.map(() => '?').join(', ');
  // Over `limit`, keep the MOST RECENT positions in the window (inner DESC +
  // LIMIT), then return them grouped/chronological for the client. Ordering by
  // mmsi before the LIMIT would drop whole high-MMSI ships when truncated; a
  // time-based cut instead keeps every ship present in the retained span.
  return db
    .prepare(
      `SELECT mmsi, received_at, lat, lon, sog, cog, ship_name, ship_type FROM (
         SELECT r.mmsi, r.received_at, r.latitude AS lat, r.longitude AS lon, r.sog, r.cog,
                s.ship_name, s.ship_type
         FROM readings r
         LEFT JOIN ships s ON s.mmsi = r.mmsi
         WHERE r.latitude IS NOT NULL AND r.longitude IS NOT NULL AND r.source IN (${ph})
           AND r.received_at >= ? AND r.received_at <= ?
           AND ${geo}
         ORDER BY r.received_at DESC
         LIMIT ?
       )
       ORDER BY mmsi ASC, received_at ASC`
    )
    .all(...sources, fromIso, toIso, limit);
}

// Oldest/newest reading timestamp available inside an area's bbox(es) — bounds
// the replay window picker. Cheap (indexed scan over received_at).
function getAreaReplayRange(boxes, sources = ['ais']) {
  const geo = boxesSql(boxes, 'latitude', 'longitude');
  const ph = sources.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT MIN(received_at) AS lo, MAX(received_at) AS hi, COUNT(*) AS n
       FROM readings
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND source IN (${ph}) AND ${geo}`
    )
    .get(...sources);
}

// Whether any reading from one of `sources` exists inside the bbox(es) within
// the window. Drives the replay "use SF/MST positions" toggle visibility — it
// only appears when there is actually scraped data to add. Cheap EXISTS probe.
function hasAreaReplayPositions(boxes, fromIso, toIso, sources) {
  if (!sources || !sources.length) return false;
  const geo = boxesSql(boxes, 'latitude', 'longitude');
  const ph = sources.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT 1 FROM readings
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND source IN (${ph})
         AND received_at >= ? AND received_at <= ? AND ${geo}
       LIMIT 1`
    )
    .get(...sources, fromIso, toIso);
  return !!row;
}

function getPortEvents(limit = 100, offset = 0, area, areaKeys = null) {
  const f = areaKeyFilter('area', area, areaKeys);
  // areaKeyFilter yields an "AND ..." clause; turn the first one into a WHERE.
  const where = f.sql ? `WHERE ${f.sql.replace(/^AND /, '')}` : '';
  const rows = db
    .prepare(`SELECT * FROM port_events ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`)
    .all(...f.params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as n FROM port_events ${where}`).get(...f.params).n;
  return { rows, total };
}

function getShipEvents(mmsi) {
  return db
    .prepare(
      `
    SELECT port_events.*, areas.name AS area_name
    FROM port_events
    LEFT JOIN areas ON areas.key = port_events.area
    WHERE mmsi = ? ORDER BY ts DESC
  `
    )
    .all(mmsi);
}

// ── Transit search between two areas ─────────────────────────────────────────
// "Ricerca navi per aree di transito": which ships called at BOTH of two
// monitored areas, and how many times they sailed straight from one to the
// other. Built on port_events (arrivals/departures), the only long-lived history
// we keep — readings are capped globally (MAX_READINGS_PER_TYPE) so a
// position-based reconstruction would only ever see the last few days.
//
// A visit = an 'arrived' row plus the next 'departed' row for the same area (or
// still open, if the ship is there now). It counts as a STOP — the area was the
// destination, not a bbox the ship crossed — when:
//   · the departure carries stop evidence (port_events.stopped, written live
//     since this version): use it verbatim; else
//   · dwell >= TRANSIT_STOP_MIN_H (the only signal available for older rows).
// A LEG is a pair of consecutive stops in DIFFERENT of the two chosen areas,
// with no stop in ANY other catalog area in between (all areas are considered,
// including other users': port_events are global) and an elapsed time compatible
// with a direct passage — gap <= max(TRANSIT_MIN_SLACK_H, distance_nm /
// TRANSIT_MIN_KN). A ship that merely crossed a third area without stopping does
// not break a leg; one that called somewhere we monitor, or vanished for far
// longer than the crossing takes, does.

const transitEventsStmt = db.prepare(
  `SELECT mmsi, area, event_type, ts, stopped, stop_min_sog
   FROM port_events
   WHERE ts >= ? AND mmsi IN (
     SELECT mmsi FROM port_events WHERE area = ? AND event_type = 'arrived' AND ts >= ?
     INTERSECT
     SELECT mmsi FROM port_events WHERE area = ? AND event_type = 'arrived' AND ts >= ?
   )
   ORDER BY mmsi, ts, id`
);

/** Great-circle distance in nautical miles between two area centroids. */
function areaDistanceNm(a, b) {
  if (!a || !b) return 0;
  const cLat = (r) => (r.sw_lat + r.ne_lat) / 2;
  const cLon = (r) => (r.sw_lon + r.ne_lon) / 2;
  return haversineM(cLat(a), cLon(a), cLat(b), cLon(b)) / 1852;
}

/** Collapse a ship's ordered event list into visits: { area, from, to, open, stopped }. */
function eventsToVisits(events, nowMs) {
  const visits = [];
  let open = null; // arrival waiting for its departure
  for (const e of events) {
    if (e.event_type === 'arrived') {
      // Two arrivals with no departure in between (signal gap inside the area):
      // the earlier visit closes at the later arrival, its dwell unknown-but-real.
      if (open) visits.push({ ...open, to: e.ts, open: false });
      open = { area: e.area, from: e.ts, stopped: null, minSog: null };
    } else if (e.event_type === 'departed') {
      if (open && open.area === e.area) {
        visits.push({ ...open, to: e.ts, open: false, stopped: e.stopped, minSog: e.stop_min_sog });
        open = null;
      }
      // A departure with no matching arrival (restored partial history) is dropped.
    }
  }
  if (open) visits.push({ ...open, to: new Date(nowMs).toISOString(), open: true });
  return visits;
}

/** Did this visit qualify as a stop? Live flag when present, dwell otherwise. */
function visitIsStop(v) {
  if (v.stopped != null) return !!v.stopped;
  const dwellH = (new Date(v.to).getTime() - new Date(v.from).getTime()) / 3600000;
  return Number.isFinite(dwellH) && dwellH >= TRANSIT.STOP_MIN_H;
}

/**
 * How long a ship may plausibly take to get from one area to the other, in hours:
 * max(TRANSIT_MIN_SLACK_H, distance_nm / TRANSIT_MIN_KN), capped at
 * TRANSIT_MAX_GAP_DAYS. MIN_KN is deliberately far below cruising speed (a real
 * ship does 10–14 kn) so a voyage with intermediate calls still fits; the slack
 * floor keeps nearby areas from getting a threshold of minutes; the cap stops a
 * far-apart pair from allowing a "came from there" claim months later.
 *
 * Shared by the transit search (is this pair of calls one leg?) and by the
 * "cambio area" notification (is the origin call recent enough to be the reason
 * this ship is here now?) — same question, so the same threshold.
 */
function areaHopGate(areaA, areaB, areas = null) {
  const rows = areas || getAllAreasStmt.all();
  const rowA = rows.find((a) => a.key === areaA);
  const rowB = rows.find((a) => a.key === areaB);
  const distNm = areaDistanceNm(rowA, rowB);
  const speedH = TRANSIT.MIN_KN > 0 ? distNm / TRANSIT.MIN_KN : 0;
  const gateH = Math.min(Math.max(TRANSIT.MIN_SLACK_H, speedH), TRANSIT.MAX_GAP_DAYS * 24);
  return {
    distNm,
    gateH,
    overlap: boxesOverlap(rowA, rowB),
    minKn: TRANSIT.MIN_KN,
    minSlackH: TRANSIT.MIN_SLACK_H,
    maxGapDays: TRANSIT.MAX_GAP_DAYS,
    stopMinH: TRANSIT.STOP_MIN_H,
  };
}

/**
 * Do the two areas' boxes share any water (intersect, containment included)?
 *
 * Overlapping areas make "cambio area" meaningless: the SAME position belongs to
 * both, so which area a message is credited to depends on which subscription
 * delivered it, and a ship sitting still at a berth flips back and forth between
 * them. Observed in production with "porto di livorno" nested inside "prova
 * livorno" (a ship moored there generated a stream of area changes, in one case
 * one direction at 07:00 and the other at 07:05) — 198 of 229 area-change
 * notifications in a one-day sample were between two such nested pairs.
 */
function boxesOverlap(a, b) {
  if (!a || !b) return false;
  return (
    a.sw_lat <= b.ne_lat && a.ne_lat >= b.sw_lat && a.sw_lon <= b.ne_lon && a.ne_lon >= b.sw_lon
  );
}

/**
 * Ships that stopped in both `areaA` and `areaB` since `sinceIso` (null = all
 * history), with their stop counts, the legs between the two areas and the last
 * one. Rows are NOT filtered by legs here — the route decides whether to keep
 * the leg-less ones. Returns { rows, gate } where gate documents the temporal
 * threshold used (for the UI to explain the result).
 */
function getAreaTransits(areaA, areaB, sinceIso = null) {
  const since = sinceIso || '0000-01-01T00:00:00.000Z';
  const areas = getAllAreasStmt.all();
  const gate = areaHopGate(areaA, areaB, areas);
  const gateH = gate.gateH;

  const events = transitEventsStmt.all(since, areaA, since, areaB, since);
  const nowMs = Date.now();
  const rows = [];

  let i = 0;
  while (i < events.length) {
    const mmsi = events[i].mmsi;
    let j = i;
    while (j < events.length && events[j].mmsi === mmsi) j++;
    const stops = eventsToVisits(events.slice(i, j), nowMs).filter(visitIsStop);
    i = j;

    let stopsA = 0, stopsB = 0;
    for (const s of stops) {
      if (s.area === areaA) stopsA++;
      else if (s.area === areaB) stopsB++;
    }
    if (!stopsA || !stopsB) continue; // stopped in both areas is the entry ticket

    let legs = 0, lastLeg = null;
    for (let k = 1; k < stops.length; k++) {
      const prev = stops[k - 1], cur = stops[k];
      const pair = (prev.area === areaA && cur.area === areaB) || (prev.area === areaB && cur.area === areaA);
      if (!pair) continue; // consecutive stops elsewhere → not a straight leg
      const gapH = (new Date(cur.from).getTime() - new Date(prev.to).getTime()) / 3600000;
      if (!Number.isFinite(gapH) || gapH < 0 || gapH > gateH) continue;
      legs++;
      lastLeg = { from: prev.area, to: cur.area, departedAt: prev.to, arrivedAt: cur.from, hours: gapH };
    }

    rows.push({ mmsi, stopsA, stopsB, legs, lastLeg, lastStopAt: stops[stops.length - 1]?.from || null });
  }
  return { rows, gate };
}

/**
 * Has this ship ever called at (or been recorded in) one of the user's areas?
 * Widens detail-view visibility beyond "its CURRENT position is in my box": a
 * ship surfaced by the transit search may be anywhere in the world now, but its
 * history in the user's own areas is exactly why they may inspect it.
 */
const shipAreaHistoryStmt = db.prepare(
  `SELECT 1 FROM port_events pe
   JOIN user_areas ua ON ua.area_key = pe.area
   WHERE pe.mmsi = ? AND ua.user_id = ? LIMIT 1`
);
function hasShipAreaHistory(userId, mmsi) {
  return !!shipAreaHistoryStmt.get(mmsi, userId);
}

// ── Moorings & berths ────────────────────────────────────────────────────────

// Arrivals for an area, ordered by ship then time, so the berths service can
// pair each arrival with the start of the next visit (the window during which
// the ship sat in port) and derive a single mooring point per visit.
function getArrivalsForArea(area) {
  return db
    .prepare(
      `SELECT mmsi, ts, ship_type FROM port_events
       WHERE event_type = 'arrived' AND area = ?
       ORDER BY mmsi, ts`
    )
    .all(area);
}

// Centroid of a ship's *stationary* readings inside an area during one visit
// window [fromTs, toTs). Stationary = SOG below the "ferma" threshold or an
// explicit moored/anchored nav status (1 = anchored, 5 = moored). Returns
// { lat, lon, n } with n = how many readings backed the centroid (0 = the ship
// passed through without ever settling → not a real mooring).
const stayCentroidStmt = db.prepare(
  `SELECT AVG(latitude) AS lat, AVG(longitude) AS lon, COUNT(*) AS n
   FROM readings
   WHERE mmsi = ? AND area = ?
     AND received_at >= ? AND received_at < ?
     AND latitude IS NOT NULL AND longitude IS NOT NULL
     AND (sog < ${DB_SOG_FERMA} OR navigational_status IN ('1', '5'))`
);
function getStayCentroid(mmsi, area, fromTs, toTs) {
  return stayCentroidStmt.get(mmsi, area, fromTs, toTs);
}

const insertMooringStmt = db.prepare(
  'INSERT INTO moorings (area, mmsi, ship_type, category, lat, lon, ts, berth_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'
);

// Replace every mooring for an area with a freshly-computed set (single txn).
function replaceMoorings(area, moorings) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM moorings WHERE area = ?').run(area);
    for (const m of moorings) {
      insertMooringStmt.run(area, m.mmsi, m.ship_type ?? null, m.category, m.lat, m.lon, m.ts);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function addMooring(area, mmsi, ship_type, category, lat, lon, ts) {
  insertMooringStmt.run(area, mmsi, ship_type ?? null, category, lat, lon, ts);
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

function updateMooringPosition(id, lat, lon) {
  db.prepare('UPDATE moorings SET lat = ?, lon = ? WHERE id = ?').run(lat, lon, id);
}

function deleteMooring(id) {
  db.prepare('DELETE FROM moorings WHERE id = ?').run(id);
}

function getMoorings(area) {
  return db.prepare('SELECT * FROM moorings WHERE area = ? ORDER BY id').all(area);
}

// Moorings with no berth yet — new arrivals, or points that stayed noise (below
// MIN_PTS) last cycle. The only ones incremental recompute needs to (re)evaluate;
// everyone else already has a stable berth_id that full history growth doesn't
// invalidate (see services/berths.js recomputeAreaIncremental).
function getUnclusteredMoorings(area) {
  return db.prepare('SELECT * FROM moorings WHERE area = ? AND berth_id IS NULL ORDER BY id').all(area);
}

function getMooringsByBerth(berthId) {
  return db.prepare('SELECT * FROM moorings WHERE berth_id = ?').all(berthId);
}

function setMooringBerth(ids, berthId) {
  if (!ids.length) return;
  const stmt = db.prepare('UPDATE moorings SET berth_id = ? WHERE id = ?');
  for (const id of ids) stmt.run(berthId, id);
}

function clearMooringBerths(area) {
  db.prepare('UPDATE moorings SET berth_id = NULL WHERE area = ?').run(area);
}

function getBerths(area) {
  const filter = area ? 'WHERE area = ?' : '';
  const params = area ? [area] : [];
  return db.prepare(`SELECT * FROM berths ${filter} ORDER BY id`).all(...params);
}

function getBerth(id) {
  return db.prepare('SELECT * FROM berths WHERE id = ?').get(id) || null;
}

// Auto (non-manual) berths only — captured before a rebuild so new clusters can
// inherit a renamed/overridden identity by centroid proximity.
function getAutoBerths(area) {
  return db.prepare('SELECT * FROM berths WHERE area = ? AND manual_geom = 0').all(area);
}

function deleteAutoBerths(area) {
  db.prepare('DELETE FROM berths WHERE area = ? AND manual_geom = 0').run(area);
}

const insertBerthStmt = db.prepare(
  `INSERT INTO berths (area, name, polygon_json, centroid_lat, centroid_lon, manual_geom,
     char_label, char_override, mooring_count, dist_json, hazmat_pct, updated_at)
   VALUES (@area, @name, @polygon_json, @centroid_lat, @centroid_lon, @manual_geom,
     @char_label, @char_override, @mooring_count, @dist_json, @hazmat_pct, @updated_at)`
);

function insertBerth(b) {
  const row = {
    area: b.area,
    name: b.name ?? null,
    polygon_json: b.polygon_json,
    centroid_lat: b.centroid_lat,
    centroid_lon: b.centroid_lon,
    manual_geom: b.manual_geom ? 1 : 0,
    char_label: b.char_label ?? null,
    char_override: b.char_override ?? null,
    mooring_count: b.mooring_count ?? 0,
    dist_json: b.dist_json ?? null,
    hazmat_pct: b.hazmat_pct ?? 0,
    updated_at: new Date().toISOString(),
  };
  return Number(insertBerthStmt.run(row).lastInsertRowid);
}

// Update the computed characterisation of an existing berth (keeps name,
// char_override and — for manual berths — geometry untouched).
function updateBerthChar(id, { char_label, mooring_count, dist_json, hazmat_pct }) {
  db.prepare(
    `UPDATE berths SET char_label = ?, mooring_count = ?, dist_json = ?, hazmat_pct = ?, updated_at = ?
     WHERE id = ?`
  ).run(char_label ?? null, mooring_count ?? 0, dist_json ?? null, hazmat_pct ?? 0, new Date().toISOString(), id);
}

// Recentre an AUTO berth's geometry after it gains a member incrementally
// (see recomputeAreaIncremental). Deliberately does NOT set manual_geom —
// unlike updateBerthManual, which is for user-drawn geometry.
function updateBerthAutoGeom(id, { centroid_lat, centroid_lon, polygon_json }) {
  db.prepare('UPDATE berths SET centroid_lat = ?, centroid_lon = ?, polygon_json = ? WHERE id = ?').run(
    centroid_lat,
    centroid_lon,
    polygon_json,
    id
  );
}

// Apply user edits: rename, manual category override, and/or a redrawn polygon
// (which locks the geometry as manual). Only provided fields are touched.
function updateBerthManual(id, fields) {
  const sets = [];
  const params = [];
  if ('name' in fields) { sets.push('name = ?'); params.push(fields.name || null); }
  if ('char_override' in fields) { sets.push('char_override = ?'); params.push(fields.char_override || null); }
  if ('polygon_json' in fields) {
    sets.push('polygon_json = ?', 'centroid_lat = ?', 'centroid_lon = ?', 'manual_geom = 1');
    params.push(fields.polygon_json, fields.centroid_lat, fields.centroid_lon);
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString(), id);
  db.prepare(`UPDATE berths SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

function deleteBerth(id) {
  db.prepare('UPDATE moorings SET berth_id = NULL WHERE berth_id = ?').run(id);
  db.prepare('DELETE FROM berths WHERE id = ?').run(id);
}

// ── Notifications ────────────────────────────────────────────────────────────
const MAX_NOTIFICATIONS = 100;

// Group-activity notification types (see group-sync.js NOTIFY_ACTIONS): mirrored
// member actions (area/follow/flag/mute/seen/charge). Kept as their own feed
// (separate badge/overlay, separate MAX_NOTIFICATIONS retention) so a chatty
// group doesn't evict personal high_risk/revisit history and vice versa.
const GROUP_NOTIF_TYPES = [
  'area_add', 'area_remove', 'area_edit', 'follow_on', 'follow_off', 'flag_on', 'flag_off',
  'mute_on', 'mute_off', 'seen_on', 'seen_off', 'charge_on', 'charge_off', 'charge_assign',
].map((a) => `group_${a}`);
const GROUP_TYPES_SQL = GROUP_NOTIF_TYPES.map(() => '?').join(',');

function kindClause(group) {
  return `type ${group ? 'IN' : 'NOT IN'} (${GROUP_TYPES_SQL})`;
}

const insertNotificationStmt = db.prepare(
  `INSERT INTO notifications (user_id, type, mmsi, ship_name, area, from_area, band, score, berth_id, berth_lat, berth_lon, actor_id, target_user_id, ts, read)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
);
// Prune per-user AND per-kind: personal and group_* notifications are separate
// feeds in the UI (separate badge/overlay) and must retain MAX_NOTIFICATIONS
// each independently — otherwise a burst of one kind evicts the other's history.
const pruneStmtByKind = {
  true: db.prepare(
    `DELETE FROM notifications WHERE user_id IS ? AND ${kindClause(true)} AND id NOT IN (
       SELECT id FROM notifications WHERE user_id IS ? AND ${kindClause(true)} ORDER BY id DESC LIMIT ${MAX_NOTIFICATIONS}
     )`
  ),
  false: db.prepare(
    `DELETE FROM notifications WHERE user_id IS ? AND ${kindClause(false)} AND id NOT IN (
       SELECT id FROM notifications WHERE user_id IS ? AND ${kindClause(false)} ORDER BY id DESC LIMIT ${MAX_NOTIFICATIONS}
     )`
  ),
};
function pruneNotifications(userId, group) {
  pruneStmtByKind[group].run(userId, ...GROUP_NOTIF_TYPES, userId, ...GROUP_NOTIF_TYPES);
}

// Notifications are now per-user: `user_id` identifies the recipient. The stream
// fan-out (see ais-stream.js) calls this once per user who should be alerted.
// actor_id/target_user_id are only set for group_* types (see group-sync.js).
function addNotification({ user_id = null, type, mmsi = null, ship_name = null, area = null, from_area = null, band = null, score = null, berth_id = null, berth_lat = null, berth_lon = null, actor_id = null, target_user_id = null }) {
  const ts = new Date().toISOString();
  const result = insertNotificationStmt.run(user_id, type, mmsi, ship_name, area, from_area, band, score, berth_id, berth_lat, berth_lon, actor_id, target_user_id, ts);
  pruneNotifications(user_id, GROUP_NOTIF_TYPES.includes(type));
  return { id: Number(result.lastInsertRowid), user_id, type, mmsi, ship_name, area, from_area, band, score, berth_id, berth_lat, berth_lon, actor_id, target_user_id, ts, read: 0 };
}

// `actor_name` is resolved here rather than client-side: a group_* notification
// can come from someone OUTSIDE the reader's group (an area edit fans out to
// every user monitoring that area), and the client only knows its own roster.
function getNotifications(userId, limit = MAX_NOTIFICATIONS, group = false) {
  return db.prepare(
    `SELECT n.*, COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.username, u.email) AS actor_name
     FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
     WHERE n.user_id IS ? AND ${kindClause(group).replace(/\btype\b/, 'n.type')} ORDER BY n.id DESC LIMIT ?`
  ).all(userId, ...GROUP_NOTIF_TYPES, limit);
}

function getUnreadNotificationCount(userId, group = false) {
  return db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id IS ? AND read = 0 AND ${kindClause(group)}`).get(userId, ...GROUP_NOTIF_TYPES).n;
}

// Mutations are scoped to the owner so a user can't touch another's notifications.
function markNotificationRead(id, userId) {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id IS ?').run(id, userId);
}

function deleteNotification(id, userId) {
  db.prepare('DELETE FROM notifications WHERE id = ? AND user_id IS ?').run(id, userId);
}

function deleteAllNotifications(userId, group = false) {
  db.prepare(`DELETE FROM notifications WHERE user_id IS ? AND ${kindClause(group)}`).run(userId, ...GROUP_NOTIF_TYPES);
}

function markAllNotificationsRead(userId, group = false) {
  db.prepare(`UPDATE notifications SET read = 1 WHERE user_id IS ? AND read = 0 AND ${kindClause(group)}`).run(userId, ...GROUP_NOTIF_TYPES);
}

// ── Risk-score history ─────────────────────────────────────────────────────────
const MAX_RISK_HISTORY = 20000;
let riskSnapshotCount = 0;

// Record a score snapshot, but skip if the most recent snapshot for this MMSI is
// less than an hour old AND has the same score — keeps the series meaningful
// (one point per hour, plus every genuine change) without bloating the table.
function recordRiskSnapshot(mmsi, score, band) {
  if (mmsi == null || score == null) return;
  const last = db
    .prepare('SELECT ts, score FROM risk_history WHERE mmsi = ? ORDER BY id DESC LIMIT 1')
    .get(mmsi);
  if (last && last.score === score && Date.now() - new Date(last.ts).getTime() < 60 * 60 * 1000) {
    return;
  }
  db.prepare('INSERT INTO risk_history (mmsi, ts, score, band) VALUES (?, ?, ?, ?)').run(
    mmsi,
    new Date().toISOString(),
    score,
    band
  );
  if (++riskSnapshotCount % 200 === 0) {
    db.prepare(
      `DELETE FROM risk_history WHERE id NOT IN (SELECT id FROM risk_history ORDER BY id DESC LIMIT ${MAX_RISK_HISTORY})`
    ).run();
  }
}

function getRiskHistory(mmsi, limit = 200) {
  return db
    .prepare('SELECT ts, score, band FROM risk_history WHERE mmsi = ? ORDER BY ts ASC LIMIT ?')
    .all(mmsi, limit);
}

// Build an area filter for port_events queries. `area` (single, user-picked) wins;
// otherwise `areaKeys` (the user's visible set) → IN (...). An empty areaKeys
// array means "no visible areas" → matches nothing. Pass `aliased` for the
// avgStay subquery which references the table alias `a`.
function areaKeyFilter(col, area, areaKeys) {
  if (area) return { sql: `AND ${col} = ?`, params: [area] };
  if (Array.isArray(areaKeys)) {
    if (!areaKeys.length) return { sql: 'AND 0', params: [] };
    return { sql: `AND ${col} IN (${areaKeys.map(() => '?').join(',')})`, params: areaKeys };
  }
  return { sql: '', params: [] };
}

function getStats(area, areaKeys = null) {
  const f = areaKeyFilter('area', area, areaKeys);
  const af = f.sql;
  const ap = (base) => [...base, ...f.params];

  const arrivalsToday = db
    .prepare(`SELECT COUNT(*) as n FROM port_events WHERE event_type = 'arrived' AND ts >= date('now') ${af}`)
    .get(...ap([])).n;

  const arrivalsWeek = db
    .prepare(`SELECT COUNT(*) as n FROM port_events WHERE event_type = 'arrived' AND ts >= datetime('now', '-7 days') ${af}`)
    .get(...ap([])).n;

  const totalArrivals = db
    .prepare(`SELECT COUNT(*) as n FROM port_events WHERE event_type = 'arrived' ${af}`)
    .get(...ap([])).n;

  const avgStayHours = db
    .prepare(
      `SELECT AVG((julianday(d.ts) - julianday(a.ts)) * 24) as avg
       FROM port_events a
       JOIN port_events d ON a.mmsi = d.mmsi
         AND d.event_type = 'departed'
         AND d.ts > a.ts
         AND NOT EXISTS (
           SELECT 1 FROM port_events x
           WHERE x.mmsi = a.mmsi AND x.event_type = 'arrived'
             AND x.ts > a.ts AND x.ts < d.ts
         )
       WHERE a.event_type = 'arrived'
         AND (julianday(d.ts) - julianday(a.ts)) * 24 BETWEEN 0.1 AND 72
         ${areaKeyFilter('a.area', area, areaKeys).sql}`
    )
    .get(...areaKeyFilter('a.area', area, areaKeys).params).avg;

  const byHour = db
    .prepare(
      `SELECT strftime('%H', ts) as hour, COUNT(*) as n
       FROM port_events WHERE event_type = 'arrived' ${af}
       GROUP BY hour ORDER BY hour`
    )
    .all(...ap([]));

  const byType = db
    .prepare(
      `SELECT ship_type, COUNT(*) as n
       FROM port_events WHERE event_type = 'arrived' AND ship_type IS NOT NULL ${af}
       GROUP BY ship_type ORDER BY n DESC LIMIT 10`
    )
    .all(...ap([]));

  return { arrivalsToday, arrivalsWeek, totalArrivals, avgStayHours, byHour, byType };
}

function getRecentShips(area, boxes = null) {
  const filter = area ? 'AND last_area = ?' : '';
  const geo = `AND ${boxesSql(boxes, 'last_latitude', 'last_longitude')}`;
  const params = area ? [area] : [];
  return db
    .prepare(
      `SELECT * FROM ships
       WHERE last_seen_at >= datetime('now', '-7 days') ${filter} ${geo}
       ORDER BY last_seen_at DESC`
    )
    .all(...params);
}

function getDailyArrivals(area, areaKeys = null) {
  const f = areaKeyFilter('area', area, areaKeys);
  return db
    .prepare(
      `SELECT date(ts) as day, COUNT(*) as n
       FROM port_events
       WHERE event_type = 'arrived'
         AND ts >= datetime('now', '-30 days') ${f.sql}
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(...f.params);
}

function getExpectedShips(keyword, boxes = null) {
  if (!keyword) return [];
  const geo = `AND ${boxesSql(boxes, 'last_latitude', 'last_longitude')}`;
  return db
    .prepare(
      `
    SELECT * FROM ships
    WHERE destination LIKE ?
      AND last_seen_at <= datetime('now', '-60 minutes')
      AND last_seen_at >= datetime('now', '-48 hours')
      ${geo}
    ORDER BY last_seen_at DESC
    LIMIT 50
  `
    )
    .all(`%${keyword}%`);
}

function setFlag(mmsi, flagged) {
  db.prepare('UPDATE ships SET flagged = ? WHERE mmsi = ?').run(flagged ? 1 : 0, mmsi);
}

// Toggle "follow" for a ship. Turning it on stamps follow_started_at (and clears
// any prior end), turning it off stamps follow_ended_at so it moves to the
// "passate" history. follow_started_at, once set, is never cleared — it marks
// that the ship was ever followed.
function setFollow(mmsi, on) {
  const now = new Date().toISOString();
  if (on) {
    db.prepare(
      'UPDATE ships SET followed = 1, follow_started_at = ?, follow_ended_at = NULL WHERE mmsi = ?'
    ).run(now, mmsi);
  } else {
    db.prepare('UPDATE ships SET followed = 0, follow_ended_at = ? WHERE mmsi = ?').run(now, mmsi);
  }
}

// Currently-followed ships (the "presenti" tab of Navi seguite).
function getFollowedShips() {
  return db
    .prepare(
      `SELECT * FROM ships WHERE followed = 1
       ORDER BY flagged DESC, seen ASC, last_seen_at DESC`
    )
    .all();
}

// Ships that were followed at some point but no longer are (manual de-select or
// the 48h auto-stop) — the "passate" history tab.
function getPastFollowedShips() {
  return db
    .prepare(
      `SELECT * FROM ships WHERE followed = 0 AND follow_started_at IS NOT NULL
       ORDER BY follow_ended_at DESC, last_seen_at DESC`
    )
    .all();
}

// mmsi + last position of every currently-followed ship that has a known
// position — the follow stream builds one bounding box per row.
function getFollowedPositions() {
  return db
    .prepare(
      `SELECT mmsi, ship_name, last_latitude AS lat, last_longitude AS lon, last_seen_at
       FROM ships
       WHERE followed = 1 AND last_latitude IS NOT NULL AND last_longitude IS NOT NULL`
    )
    .all();
}

// Auto-stop follows that have gone silent: no position for `hours`. Returns the
// affected ships (for logging). Called periodically by the follow service.
function autoStopStaleFollows(hours) {
  const stale = db
    .prepare(
      `SELECT mmsi, ship_name FROM ships
       WHERE followed = 1 AND last_seen_at < datetime('now', ?)`
    )
    .all(`-${hours} hours`);
  if (stale.length) {
    const now = new Date().toISOString();
    const stmt = db.prepare(
      'UPDATE ships SET followed = 0, follow_ended_at = ? WHERE mmsi = ?'
    );
    for (const s of stale) stmt.run(now, s.mmsi);
  }
  return stale;
}

function updateNotes(mmsi, notes) {
  db.prepare('UPDATE ships SET notes = ? WHERE mmsi = ?').run(notes || null, mmsi);
}

function setMtShipId(mmsi, mtShipId) {
  db.prepare('UPDATE ships SET mt_ship_id = ? WHERE mmsi = ?').run(mtShipId || null, mmsi);
}

function setMilitary(mmsi, isMilitary) {
  db.prepare('UPDATE ships SET is_military = ? WHERE mmsi = ?').run(isMilitary ? 1 : 0, mmsi);
}

function setNotifMuted(mmsi, muted) {
  db.prepare('UPDATE ships SET notif_muted = ? WHERE mmsi = ?').run(muted ? 1 : 0, mmsi);
}

function getReadings({ type, limit = 50, offset = 0, boxes = null }) {
  let sql =
    'SELECT id, received_at, message_type, mmsi, ship_name, latitude, longitude, navigational_status, sog, cog, true_heading FROM readings';
  const params = [];
  const where = [];
  if (type) { where.push('message_type = ?'); params.push(type); }
  if (boxes != null) where.push(boxesSql(boxes, 'latitude', 'longitude'));
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function getReading(id) {
  return db.prepare('SELECT * FROM readings WHERE id = ?').get(id);
}

// `boxes` (optional) scopes the count to a user's areas (for the readings view);
// background callers pass nothing → global count.
function getTotalCount(type, boxes = null) {
  const where = [];
  const params = [];
  if (type) { where.push('message_type = ?'); params.push(type); }
  if (boxes != null) where.push(boxesSql(boxes, 'latitude', 'longitude'));
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  return db.prepare(`SELECT COUNT(*) as n FROM readings${clause}`).get(...params).n;
}

function getDistinctTypes() {
  return db
    .prepare('SELECT DISTINCT message_type FROM readings ORDER BY message_type')
    .all()
    .map((r) => r.message_type);
}

function getAllByType(type) {
  return db.prepare('SELECT * FROM readings WHERE message_type = ? ORDER BY id DESC').all(type);
}

// Keyset-paginated variant of getAllByType, for streaming a large export in
// bounded memory (see routes/export.js CSV export). `beforeId` null = start
// from the newest row; pass the last row's id from the previous page to
// continue. Ordering matches getAllByType (id DESC) so a full walk yields the
// same rows in the same order, just one bounded batch at a time.
function getByTypePage(type, beforeId, limit) {
  if (beforeId == null) {
    return db.prepare('SELECT * FROM readings WHERE message_type = ? ORDER BY id DESC LIMIT ?').all(type, limit);
  }
  return db
    .prepare('SELECT * FROM readings WHERE message_type = ? AND id < ? ORDER BY id DESC LIMIT ?')
    .all(type, beforeId, limit);
}

// Assign an area to rows still tagged '' (legacy data collected before
// multi-area support, or imported from an old DB). Coordinate-aware: each row
// goes to the box that contains it; rows outside every box fall back to
// `fallbackArea` so they stay visible somewhere. port_events have no
// coordinates, so they inherit their ship's area (else fallback).
function tagLegacyArea(fallbackArea, areaForPoint) {
  const fb = fallbackArea || '';
  const resolve = (lat, lon) => (areaForPoint ? areaForPoint(lat, lon) : null) || fb;

  const upR = db.prepare('UPDATE readings SET area = ? WHERE id = ?');
  for (const r of db.prepare("SELECT id, latitude, longitude FROM readings WHERE area = ''").all()) {
    upR.run(resolve(r.latitude, r.longitude), r.id);
  }
  const upS = db.prepare('UPDATE ships SET last_area = ? WHERE mmsi = ?');
  for (const s of db.prepare("SELECT mmsi, last_latitude, last_longitude FROM ships WHERE last_area = ''").all()) {
    upS.run(resolve(s.last_latitude, s.last_longitude), s.mmsi);
  }
  db.prepare(
    `UPDATE port_events SET area = COALESCE(
       (SELECT last_area FROM ships WHERE ships.mmsi = port_events.mmsi AND ships.last_area != ''),
       ?)
     WHERE area = ''`
  ).run(fb);
}

// One-shot repair of rows mis-tagged by an earlier blind migration: when a
// row's coordinates fall squarely inside a different area's box, move it there.
// Rows outside every box keep their current tag (could be a legitimately
// drifting tracked ship), so this is safe to run on every startup. Returns the
// number of rows moved.
function reconcileAreasByCoords(areaForPoint) {
  if (!areaForPoint) return 0;
  let moved = 0;
  const upR = db.prepare('UPDATE readings SET area = ? WHERE id = ?');
  for (const r of db.prepare("SELECT id, latitude, longitude, area FROM readings WHERE area != ''").all()) {
    const a = areaForPoint(r.latitude, r.longitude);
    if (a && a !== r.area) {
      upR.run(a, r.id);
      moved++;
    }
  }
  const upS = db.prepare('UPDATE ships SET last_area = ? WHERE mmsi = ?');
  for (const s of db.prepare("SELECT mmsi, last_latitude, last_longitude, last_area FROM ships WHERE last_area != ''").all()) {
    const a = areaForPoint(s.last_latitude, s.last_longitude);
    if (a && a !== s.last_area) {
      upS.run(a, s.mmsi);
      moved++;
    }
  }
  // Re-home only the port_events that have NO usable area of their own: empty, or
  // pointing at an area key that no longer exists. Their ship's current area is
  // the sole clue available (port_events carry no coordinates), so it is used as
  // a fallback here — but ONLY for those rows.
  //
  // It must never touch a row that already carries a valid area: an arrival is
  // tagged at insert time by the stream that received it, and a ship that has
  // since sailed elsewhere still called at the area recorded on the row. Blindly
  // rewriting every event to the ship's last_area (what this did before) collapsed
  // the whole visit history of every multi-area ship onto wherever it happens to
  // be now, breaking per-area arrival history, revisit detection and the
  // "ricerca navi per aree di transito" (which is entirely built on it).
  db.prepare(
    `UPDATE port_events SET area = (SELECT last_area FROM ships WHERE ships.mmsi = port_events.mmsi)
     WHERE (area = '' OR area NOT IN (SELECT key FROM areas))
       AND EXISTS (
         SELECT 1 FROM ships
         WHERE ships.mmsi = port_events.mmsi AND ships.last_area != '' AND ships.last_area != port_events.area
       )`
  ).run();
  return moved;
}

// Row counts attributable to one area (shown in the Areas screen so the user
// knows how much history a deletion will wipe).
function getAreaCounts(area) {
  return {
    readings: db.prepare('SELECT COUNT(*) AS n FROM readings WHERE area = ?').get(area).n,
    ships: db.prepare('SELECT COUNT(*) AS n FROM ships WHERE last_area = ?').get(area).n,
    events: db.prepare('SELECT COUNT(*) AS n FROM port_events WHERE area = ?').get(area).n,
  };
}

// Delete collected data. With `area`, only that area's rows; otherwise all.
function deleteAll(area) {
  if (area) {
    // Capture the ships about to go BEFORE deleting them. A ship keeps the bbox
    // of its latest position in last_area, so a ship that drifted from area A to
    // area B has last_area=B even though it still owns A-tagged readings — and
    // vice-versa. Deleting purely by area would leave rows keyed by these ships'
    // mmsi behind in other areas (orphans). So purge by mmsi too, plus the
    // scrape cache which carries no area tag and was never covered here.
    const mmsis = db.prepare('SELECT mmsi FROM ships WHERE last_area = ?').all(area).map((r) => r.mmsi);
    db.prepare('DELETE FROM readings WHERE area = ?').run(area);
    db.prepare('DELETE FROM ships WHERE last_area = ?').run(area);
    db.prepare('DELETE FROM port_events WHERE area = ?').run(area);
    db.prepare('DELETE FROM notifications WHERE area = ?').run(area);
    db.prepare('DELETE FROM moorings WHERE area = ?').run(area);
    db.prepare('DELETE FROM berths WHERE area = ?').run(area);
    if (mmsis.length) {
      // Scoped to ORPHANED rows only (tagged to an area no longer in the catalog,
      // or the untagged legacy sentinel) — not "any row for this mmsi". A ship
      // last seen in the deleted area can still carry months of readings/events
      // tagged to a DIFFERENT area that still exists and is owned by someone
      // else; an unscoped `WHERE mmsi = ?` used to wipe that history too. No
      // area column on risk_history/ship_scrape_cache, so they're left for the
      // daily pruneOrphans() sweep, which correctly keys off "ship no longer in
      // `ships`" instead (true here, since the ships row was just deleted above).
      const purge = db.transaction((ids) => {
        const stmts = [
          db.prepare("DELETE FROM readings WHERE mmsi = ? AND (area = '' OR area NOT IN (SELECT key FROM areas))"),
          db.prepare("DELETE FROM port_events WHERE mmsi = ? AND (area = '' OR area NOT IN (SELECT key FROM areas))"),
          db.prepare('DELETE FROM moorings WHERE mmsi = ? AND area NOT IN (SELECT key FROM areas)'),
        ];
        for (const m of ids) for (const s of stmts) s.run(m);
      });
      purge(mmsis);
    }
    // Surviving notifications in other areas may reference the dead area as their
    // origin (from_area on an area_change). De-reference rather than delete them.
    db.prepare('UPDATE notifications SET from_area = NULL WHERE from_area = ?').run(area);
  } else {
    db.exec('DELETE FROM readings');
    db.exec('DELETE FROM ships');
    db.exec('DELETE FROM port_events');
    db.exec('DELETE FROM notifications');
    db.exec('DELETE FROM risk_history');
    db.exec('DELETE FROM moorings');
    db.exec('DELETE FROM berths');
  }
  Object.keys(insertCounters).forEach((k) => delete insertCounters[k]);
}

// Defensive sweep that removes rows orphaned by area deletion (current or from
// older versions of deleteAll), manual edits, or interrupted writes. It is
// idempotent and safe to run periodically: every clause deletes only rows that
// point at a parent that no longer exists. Ordering matters — ships with a dead
// last_area are removed first so their now-parentless children are caught by the
// mmsi clauses in the same pass. Returns per-table counts (zero everywhere on a
// healthy DB). Skips the legacy untagged sentinel (area = '').
function pruneOrphans() {
  const run = (sql) => db.prepare(sql).run().changes;
  const counts = {};
  const sweep = db.transaction(() => {
    // Parents first: ships whose area is gone, berths whose area is gone.
    counts.ships = run("DELETE FROM ships WHERE last_area != '' AND last_area NOT IN (SELECT key FROM areas)");
    counts.berths = run('DELETE FROM berths WHERE area NOT IN (SELECT key FROM areas)');
    counts.area_ports = run('DELETE FROM area_ports WHERE area_key NOT IN (SELECT key FROM areas)');
    // Children keyed by area and/or by a now-missing ship.
    counts.readings = run(
      "DELETE FROM readings WHERE (area != '' AND area NOT IN (SELECT key FROM areas)) OR mmsi NOT IN (SELECT mmsi FROM ships)"
    );
    counts.port_events = run(
      "DELETE FROM port_events WHERE (area != '' AND area NOT IN (SELECT key FROM areas)) OR mmsi NOT IN (SELECT mmsi FROM ships)"
    );
    counts.moorings = run(
      'DELETE FROM moorings WHERE area NOT IN (SELECT key FROM areas) OR mmsi NOT IN (SELECT mmsi FROM ships) OR (berth_id IS NOT NULL AND berth_id NOT IN (SELECT id FROM berths))'
    );
    counts.risk_history = run('DELETE FROM risk_history WHERE mmsi NOT IN (SELECT mmsi FROM ships)');
    counts.ship_scrape_cache = run('DELETE FROM ship_scrape_cache WHERE mmsi NOT IN (SELECT mmsi FROM ships)');
    counts.notifications = run(
      "DELETE FROM notifications WHERE (mmsi IS NOT NULL AND mmsi NOT IN (SELECT mmsi FROM ships)) OR (area IS NOT NULL AND area != '' AND area NOT IN (SELECT key FROM areas))"
    );
    // Dangling origin reference on a notification that is otherwise valid.
    counts.notif_from_area = run(
      "UPDATE notifications SET from_area = NULL WHERE from_area IS NOT NULL AND from_area != '' AND from_area NOT IN (SELECT key FROM areas)"
    );
    // A dissolved group leaves its activity log behind (deleteGroup only clears
    // users.group_id, it doesn't touch the log — see comment there).
    counts.group_activity_log = run('DELETE FROM group_activity_log WHERE group_id NOT IN (SELECT id FROM groups)');
  });
  sweep();
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

const insertLogStmt = db.prepare(
  'INSERT INTO api_log (ts, method, path, status, duration_ms, request_body, response_body) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
let logInsertCount = 0;

function insertLog({ method, path, status, duration_ms, request_body = null, response_body = null }) {
  const ts = new Date().toISOString();
  // Best-effort: a log write must never crash the process. This is called from
  // hot paths (incl. error handlers that re-log on failure), so a transient
  // SQLITE_BUSY here used to propagate uncaught and kill the app. Swallow it.
  try {
    const result = insertLogStmt.run(ts, method, path, status, duration_ms, request_body, response_body);
    logInsertCount++;
    if (logInsertCount % 500 === 0) {
      db.prepare(
        `DELETE FROM api_log WHERE id NOT IN (SELECT id FROM api_log ORDER BY id DESC LIMIT ${MAX_API_LOG_RECORDS})`
      ).run();
    }
    return { id: Number(result.lastInsertRowid), ts, method, path, status, duration_ms };
  } catch (e) {
    console.error(`[DB] insertLog fallito (ignorato): ${e.message}`);
    return null;
  }
}

function getLog(id) {
  return db.prepare('SELECT * FROM api_log WHERE id = ?').get(id);
}

function getLogs(limit = 200, offset = 0) {
  return db
    .prepare(
      'SELECT id, ts, method, path, status, duration_ms FROM api_log ORDER BY id DESC LIMIT ? OFFSET ?'
    )
    .all(limit, offset);
}

function clearLogs() {
  db.exec('DELETE FROM api_log');
}

// ── Whole-database backup / restore ──────────────────────────────────────────
// Tables copied on restore. Order matters only for readability; each is
// independent (no cross-table FKs in this schema).
// NOTE: the global coverage heatmap lives in a SEPARATE database (heatmap-db.js,
// file heatmap_data.db), not here — so it can be exported/imported on its own and
// kept out of the main backup tables. An older version stored it in this DB as a
// `heatmap_cells` table; heatmap-db.migrateFromMainIfNeeded() copies any such rows
// out on startup. That leftover table (if present) is intentionally NOT in
// BACKUP_TABLES below.

const BACKUP_TABLES = ['readings', 'ships', 'port_events', 'api_log', 'ship_scrape_cache', 'ship_scrape_failures', 'notifications', 'risk_history', 'moorings', 'berths', 'proximity_events', 'meta', 'users', 'sessions', 'groups', 'group_activity_log', 'areas', 'area_ports', 'user_areas', 'user_flags', 'user_follows', 'user_mutes', 'user_seen', 'user_ship_charges', 'user_settings', 'user_track_cuts'];

/**
 * Write a consistent snapshot of the whole database to `dest`.
 * `VACUUM INTO` produces a clean, fully-checkpointed copy even while the live
 * AIS stream keeps writing — no WAL/-shm sidecar files to ship.
 */
function backupTo(dest) {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}

/**
 * Periodic compaction. Folds the WAL back into the main file and truncates it
 * (the passive autocheckpoint can't, while the stream/SSE readers hold a read
 * lock), then returns pages freed by prunes/deletes to the OS.
 *
 * The first call also performs the one-time VACUUM that converts a legacy
 * auto_vacuum=NONE database to INCREMENTAL (no-op once already converted). The
 * VACUUM rewrites the whole file, so it runs only when actually needed.
 */
function runMaintenance() {
  // One-time fix of ShipFinder positions stored before the UTC+8 timezone fix.
  // ShipFinder renders "Last update" in China Standard Time (UTC+8); the old
  // parser read it as UTC, so every stored `source='sf'` fix landed 8 h in the
  // future (e.g. a "vista su ShipFinder" badge showing tomorrow's time). Shift all
  // existing sf rows back 8 h to real UTC — done once (meta-guarded): at first boot
  // after the fix every sf row present was written by the buggy parser, and rows
  // written afterwards are already correct. Position data is preserved (we correct
  // the timestamp, not delete the fix). JS date math avoids SQLite ISO/format edge
  // cases. (MyShipTracking reports real UTC and is unaffected.)
  if (getMeta('sf_tz_utc8_fixed') !== '1') {
    const SHIFT_MS = 8 * 60 * 60 * 1000;
    const rows = db.prepare("SELECT rowid AS rid, received_at FROM readings WHERE source = 'sf'").all();
    const upd = db.prepare('UPDATE readings SET received_at = ? WHERE rowid = ?');
    // Shift + flag in one transaction so a partial run can't leave rows shifted
    // with the flag unset (which would double-shift them on the next boot).
    const fixed = db.transaction(() => {
      let n = 0;
      for (const r of rows) {
        const t = Date.parse(r.received_at);
        if (Number.isFinite(t)) { upd.run(new Date(t - SHIFT_MS).toISOString(), r.rid); n++; }
      }
      setMeta('sf_tz_utc8_fixed', '1');
      return n;
    })();
    if (fixed) console.log(`[migrate] ShipFinder UTC+8 timezone fix: shifted ${fixed} scraped position(s) back 8h`);
  }

  // One-time conversion to incremental auto_vacuum on legacy databases. The
  // open-time `PRAGMA auto_vacuum = INCREMENTAL` only sets the *intended* mode;
  // the file is actually converted by the first VACUUM. A meta flag guards it so
  // the (expensive, whole-file) VACUUM runs exactly once, not every startup —
  // reading `PRAGMA auto_vacuum` can't tell converted from merely-requested.
  if (getMeta('auto_vacuum_converted') !== '1') {
    // Back-fill: drop the now-unused full payload from existing position-report
    // rows (kept only for static-data types going forward), so the VACUUM below
    // reclaims that space immediately instead of waiting for the natural prune.
    db.exec(
      "UPDATE readings SET raw_json = '' " +
        "WHERE raw_json <> '' AND message_type NOT IN ('ShipStaticData', 'ExtendedClassBPositionReport')"
    );
    db.exec('VACUUM');
    setMeta('auto_vacuum_converted', '1');
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA incremental_vacuum');
}

/**
 * Replace ALL current data with the contents of the SQLite file at `src`.
 * Copies column-by-column over the intersection of source/target columns, so a
 * backup taken from an older schema (fewer columns) still restores cleanly.
 * Runs in a single transaction on the live connection — prepared statements
 * elsewhere stay valid. Returns per-table row counts.
 */
function restoreFrom(src) {
  db.exec(`ATTACH DATABASE '${src.replace(/'/g, "''")}' AS restore`);
  try {
    const srcTables = new Set(
      db.prepare("SELECT name FROM restore.sqlite_master WHERE type='table'").all().map((r) => r.name)
    );
    if (!srcTables.has('readings') || !srcTables.has('ships')) {
      throw new Error('File di backup non valido: tabelle readings/ships assenti');
    }

    const counts = {};
    db.exec('BEGIN');
    try {
      for (const t of BACKUP_TABLES) {
        if (!srcTables.has(t)) continue;
        const mainCols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
        const srcCols = new Set(db.prepare(`PRAGMA restore.table_info(${t})`).all().map((c) => c.name));
        const cols = mainCols.filter((c) => srcCols.has(c));
        if (cols.length === 0) continue;
        const colList = cols.map((c) => `"${c}"`).join(', ');
        db.exec(`DELETE FROM main.${t}`);
        db.exec(`INSERT INTO main.${t} (${colList}) SELECT ${colList} FROM restore.${t}`);
        counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM main.${t}`).get().n;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // Drop score-history snapshots orphaned by the restore. An older backup has
    // no risk_history table, so the copy loop skips it and the pre-restore rows
    // would otherwise survive pointing at MMSIs no longer present in `ships`.
    db.prepare('DELETE FROM risk_history WHERE mmsi NOT IN (SELECT mmsi FROM ships)').run();

    // Drop groups left with no members. A pre-groups backup has no `groups` table
    // (loop skips it) and its `users` carry no group_id (restored as NULL), so any
    // groups defined before the restore would otherwise dangle memberless. Groups
    // always have ≥2 members by construction, so a 0-member group is only ever a
    // restore artifact — safe to prune unconditionally.
    db.prepare('DELETE FROM groups WHERE id NOT IN (SELECT group_id FROM users WHERE group_id IS NOT NULL)').run();

    // Reset prune counters so they re-derive from the restored data.
    Object.keys(insertCounters).forEach((k) => delete insertCounters[k]);
    return counts;
  } finally {
    db.exec('DETACH DATABASE restore');
  }
}

// ── Ship-to-ship proximity (rendezvous) ─────────────────────────────────────
const MAX_PROXIMITY_EVENTS = 5000;

// Candidate vessels for the proximity scan: every ship currently assigned to the
// area with a recent fix. The slow/offshore/not-moored gating is applied by the
// proximity service (it owns the thresholds).
function getProximityCandidates(area, freshSinceIso) {
  return db
    .prepare(
      `SELECT mmsi, ship_name AS name, last_latitude AS lat, last_longitude AS lon,
              last_sog AS sog, last_navigational_status AS ns
       FROM ships
       WHERE last_area = ? AND last_latitude IS NOT NULL AND last_longitude IS NOT NULL
         AND last_seen_at >= ?`
    )
    .all(area, freshSinceIso);
}

function getOpenProximity(area) {
  return db.prepare('SELECT * FROM proximity_events WHERE area = ? AND ended_at IS NULL').all(area);
}

const insertProximityStmt = db.prepare(
  `INSERT INTO proximity_events
     (area, mmsi_a, mmsi_b, name_a, name_b, started_at, last_seen_at, min_dist_m, lat_a, lon_a, lat_b, lon_b, alerted)
   VALUES (@area, @mmsi_a, @mmsi_b, @name_a, @name_b, @ts, @ts, @min_dist_m, @lat_a, @lon_a, @lat_b, @lon_b, 0)`
);
function openProximityContact(c) {
  const r = insertProximityStmt.run(c);
  // Cheap, bounded retention: drop the oldest closed contacts past the cap.
  db.prepare(
    `DELETE FROM proximity_events
     WHERE ended_at IS NOT NULL
       AND id NOT IN (SELECT id FROM proximity_events ORDER BY id DESC LIMIT ?)`
  ).run(MAX_PROXIMITY_EVENTS);
  return Number(r.lastInsertRowid);
}

const updateProximityStmt = db.prepare(
  `UPDATE proximity_events
     SET last_seen_at = @last_seen_at, min_dist_m = @min_dist_m,
         lat_a = @lat_a, lon_a = @lon_a, lat_b = @lat_b, lon_b = @lon_b
   WHERE id = @id`
);
function updateProximityContact(c) {
  updateProximityStmt.run(c);
}

function closeProximityContact(id, endedAt) {
  db.prepare('UPDATE proximity_events SET ended_at = ? WHERE id = ?').run(endedAt, id);
}

function markProximityAlerted(id) {
  db.prepare('UPDATE proximity_events SET alerted = 1 WHERE id = ?').run(id);
}

// Confirmed (alerted) rendezvous involving a ship within the trailing window.
// Feeds the risk score and the ship-detail list. `other` is the partner MMSI.
function getProximityForShip(mmsi, sinceIso) {
  return db
    .prepare(
      `SELECT id, area, started_at, ended_at, min_dist_m, last_seen_at,
              CASE WHEN mmsi_a = ? THEN mmsi_b ELSE mmsi_a END AS other,
              CASE WHEN mmsi_a = ? THEN name_b ELSE name_a END AS other_name
       FROM proximity_events
       WHERE alerted = 1 AND (mmsi_a = ? OR mmsi_b = ?) AND started_at >= ?
       ORDER BY started_at DESC`
    )
    .all(mmsi, mmsi, mmsi, mmsi, sinceIso);
}

module.exports = {
  insert,
  getProximityCandidates,
  getOpenProximity,
  openProximityContact,
  updateProximityContact,
  closeProximityContact,
  markProximityAlerted,
  getProximityForShip,
  insertFollowPosition,
  getAreaCounts,
  pruneOrphans,
  getActiveShips,
  getStaleAreaShips,
  getPortDiscoveryTargets,
  setShipLastArea,
  getPastShips,
  getPastShipsCount,
  getFollowedShips,
  getPastFollowedShips,
  getFollowedPositions,
  autoStopStaleFollows,
  setFollow,
  getShip,
  searchShipsByName,
  getShipReadings,
  getShipTrackRange,
  getShipTrack,
  getRecentTrails,
  hasShipScrapedPositions,
  getAreaReplayPositions,
  getAreaReplayRange,
  hasAreaReplayPositions,
  getShipPositions,
  getDistinctShipNames,
  getRecentPositions,
  getAllFollowedShips,
  recordScrape,
  getScrapeCounts24h,
  getScrapeCountsHourly,
  insertScrapedPosition,
  getScrapedPositions,
  getLatestScrapedPosition,
  setFlag,
  updateNotes,
  setMtShipId,
  setMilitary,
  setNotifMuted,
  getPortEvents,
  getShipEvents,
  getAreaTransits,
  hasShipAreaHistory,
  getArrivalsForArea,
  getStayCentroid,
  replaceMoorings,
  addMooring,
  updateMooringPosition,
  deleteMooring,
  getMoorings,
  getUnclusteredMoorings,
  getMooringsByBerth,
  setMooringBerth,
  clearMooringBerths,
  getBerths,
  getBerth,
  getAutoBerths,
  deleteAutoBerths,
  insertBerth,
  updateBerthChar,
  updateBerthAutoGeom,
  updateBerthManual,
  deleteBerth,
  runTransaction,
  addNotification,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  deleteNotification,
  deleteAllNotifications,
  markAllNotificationsRead,
  recordRiskSnapshot,
  getRiskHistory,
  checkAndLogDepartures,
  getStats,
  getRecentShips,
  getDailyArrivals,
  getExpectedShips,
  getReadings,
  getReading,
  getTotalCount,
  getDistinctTypes,
  getAllByType,
  getByTypePage,
  tagLegacyArea,
  reconcileAreasByCoords,
  getMeta,
  setMeta,
  deleteAll,
  // Users & sessions
  getSessionSecret,
  createUser,
  getUserById,
  getUserAuthRow,
  findUserByLogin,
  listUsers,
  countUsers,
  countAdmins,
  getAdminUserIds,
  setUserStatus,
  approveUser,
  approveTester,
  setUserRole,
  setUserPassword,
  issueResetToken,
  findUserByResetToken,
  verifyEmailToken,
  deleteUser,
  createSession,
  getSession,
  touchSession,
  getOnlineUserIds,
  deleteSession,
  deleteUserSessions,
  setSessionImpersonation,
  pruneExpiredSessions,
  seedDefaultAdmin,
  hasAnyAdmin,
  // Groups
  createGroup,
  getGroups,
  getGroup,
  updateGroup,
  deleteGroup,
  setUserGroup,
  getGroupMembers,
  getUserGroupId,
  groupMemberCount,
  logGroupActivity,
  getGroupActivityLog,
  // Area catalog & per-user ownership
  getAllAreas,
  getArea,
  upsertArea,
  setAreaActive,
  setAreaFallbackEnabled,
  touchAreaLastAisMessage,
  getActiveAreaKeys,
  deleteAreaRow,
  addUserArea,
  removeUserArea,
  getUserAreaKeys,
  areaOwnerCount,
  getOrphanAreaKeys,
  seedAreaCatalogIfEmpty,
  // Area ports (discovery per-area)
  upsertAreaPort,
  getAreaPorts,
  getConfirmedAreaPorts,
  countAreaPorts,
  setAreaPortDecision,
  setAreaPortMstPid,
  migrateMultiUser,
  // Per-user visibility & ship state
  getUserBoxes,
  isShipVisible,
  getVisibleAreaKeys,
  getUserFlaggedMmsis,
  setUserFlag,
  getUserSeenMmsis,
  isUserSeen,
  setUserSeen,
  setUserShipCharge,
  getUsersCharging,
  getChargesForMmsis,
  getTrackCuts,
  addTrackCut,
  deleteTrackCut,
  getUserMutedMmsis,
  isUserMuted,
  setUserMute,
  setUserFollow,
  getUserFollowedShips,
  getUserPastFollowedShips,
  getUserFollowedMmsis,
  getAllFollowedPositions,
  getFollowersOf,
  getUsersSeeingPoint,
  getUsersFlagging,
  getAreaOwners,
  getUsersWithBothAreas,
  getUserSettings,
  setUserSetting,
  findUserIdBySetting,
  getTelegramLinkedUserIds,
  getUserIdsWithSetting,
  autoStopStaleFollowsAll,
  NEVER_SEEN_AIS,
  ensureShipStub,
  getScrapedShipName,
  setFollowSearchMode,
  getUserFollowSearchMode,
  getSearchModeFollowersOf,
  getScrapedData,
  setScrapedData,
  setScrapeFailure,
  clearScrapeFailure,
  hasRecentScrapeFailure,
  insertLog,
  getLog,
  getLogs,
  clearLogs,
  backupTo,
  restoreFrom,
  runMaintenance,
  DB_PATH,
};
