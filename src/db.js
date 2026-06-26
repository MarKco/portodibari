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
const DB_SOG_FERMA = numOr(cfg.SOG_FERMA, 0.5);

// The SQLite file lives at the project root (one level above src/).
const DB_PATH = path.join(__dirname, '..', 'ais_data.db');
const db = new DatabaseSync(DB_PATH);

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
// `user_flags` / `user_follows` / `user_mutes`: per-user replacements for the
//   old global ships.flagged / ships.followed / ships.notif_muted columns.
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

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
  );
`);

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
  for (const t of ['sessions', 'user_areas', 'user_flags', 'user_follows', 'user_mutes', 'user_settings', 'notifications']) {
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
  if (existing) {
    if (!auth.verifyPassword(password, existing.pw_hash, existing.pw_salt)) {
      appLog.info('AUTH', `Reset password amministratore di default "${username}"`);
      setUserPassword(existing.id, password);
    }
    return existing;
  }
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

// ── Area catalog & per-user ownership ────────────────────────────────────────

const getAllAreasStmt = db.prepare('SELECT * FROM areas ORDER BY created_at ASC, key ASC');
/** Full catalog as rows (raw columns). */
function getAllAreas() {
  return getAllAreasStmt.all();
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

/** Users who actively follow a given ship (for notification fan-out). */
function getFollowersOf(mmsi) {
  return db.prepare('SELECT user_id FROM user_follows WHERE mmsi = ? AND followed = 1').all(mmsi).map((r) => r.user_id);
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
  const stale = db
    .prepare(
      `SELECT DISTINCT f.mmsi, s.ship_name FROM user_follows f JOIN ships s ON s.mmsi = f.mmsi
       WHERE f.followed = 1
         AND s.last_seen_at < datetime('now', ?)
         AND f.follow_started_at < datetime('now', ?)`
    )
    .all(`-${hours} hours`, `-${hours} hours`);
  if (stale.length) {
    const now = new Date().toISOString();
    const stmt = db.prepare('UPDATE user_follows SET followed = 0, follow_ended_at = ? WHERE mmsi = ? AND followed = 1');
    for (const s of stale) stmt.run(now, s.mmsi);
  }
  return stale;
}

const insertReading = db.prepare(`
  INSERT INTO readings (received_at, message_type, mmsi, ship_name, latitude, longitude,
    navigational_status, sog, cog, true_heading, raw_json, area)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

const getShipLastSeen = db.prepare(
  'SELECT last_seen_at, ship_name, ship_type, destination, max_draught, flagged, last_area FROM ships WHERE mmsi = ?'
);

// 1 if ANY user has flagged this ship (per-user flags replaced the global column).
const anyUserFlagStmt = db.prepare('SELECT 1 FROM user_flags WHERE mmsi = ? LIMIT 1');

const insertPortEventStmt = db.prepare(
  'INSERT INTO port_events (mmsi, ship_name, event_type, ts, ship_type, destination, draught, area) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);

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
      areaChange = { mmsi: row.mmsi, fromArea: prevArea, toArea: areaKey };
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
        row.ship_name || existing?.ship_name,
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

function checkAndLogDepartures() {
  const departed = db
    .prepare(
      `
    SELECT mmsi, ship_name, ship_type, destination, max_draught, last_seen_at, last_area
    FROM ships
    WHERE last_seen_at BETWEEN datetime('now', '-62 minutes') AND datetime('now', '-60 minutes')
    AND NOT EXISTS (
      SELECT 1 FROM port_events
      WHERE port_events.mmsi = ships.mmsi
        AND port_events.event_type = 'departed'
        AND port_events.ts > datetime('now', '-3 hours')
    )
  `
    )
    .all();

  for (const ship of departed) {
    insertPortEventStmt.run(
      ship.mmsi,
      ship.ship_name,
      'departed',
      ship.last_seen_at,
      ship.ship_type,
      ship.destination,
      ship.max_draught ?? null,
      ship.last_area || ''
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
           navigational_status, sog, cog, true_heading
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
      AND latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY received_at DESC
    LIMIT 50
  `
    )
    .all(mmsi, `-${minutes} minutes`);
}

// Recent positions for risk scoring (dark-activity gaps, speed-jump spoofing,
// loitering). Time-bounded and oldest-first so consecutive-pair analysis works.
function getShipPositions(mmsi, hours = 168, limit = 2000) {
  return db
    .prepare(
      `
    SELECT received_at, latitude AS lat, longitude AS lon, sog, navigational_status AS ns
    FROM readings
    WHERE mmsi = ? AND received_at > datetime('now', ?)
      AND latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY received_at ASC
    LIMIT ?
  `
    )
    .all(mmsi, `-${hours} hours`, limit);
}

// Distinct (non-null) names a single MMSI has broadcast — name hopping signal.
function getDistinctShipNames(mmsi) {
  return db
    .prepare(
      'SELECT DISTINCT ship_name FROM readings WHERE mmsi = ? AND ship_name IS NOT NULL'
    )
    .all(mmsi)
    .map((r) => r.ship_name);
}

function getShipTrackRange(mmsi) {
  return db
    .prepare(
      `SELECT MIN(received_at) AS lo, MAX(received_at) AS hi
       FROM readings WHERE mmsi = ? AND latitude IS NOT NULL AND longitude IS NOT NULL`
    )
    .get(mmsi);
}

function getShipTrack(mmsi, limit = 500, from = null, to = null) {
  const where = ['mmsi = ?', 'latitude IS NOT NULL', 'longitude IS NOT NULL'];
  const params = [mmsi];
  if (from) { where.push('received_at >= ?'); params.push(from); }
  if (to)   { where.push('received_at <= ?'); params.push(to); }
  params.push(limit);
  return db
    .prepare(
      `SELECT id, received_at, latitude, longitude, sog, cog
       FROM readings
       WHERE ${where.join(' AND ')}
       ORDER BY received_at ASC
       LIMIT ?`
    )
    .all(...params);
}

// Positions inside an area's bbox(es) within a time window, for historical
// replay. Joined with the ship master for name/type. Ordered by ship then time
// so the route can group cheaply. `limit` caps the raw rows (the route
// downsamples per ship if the cap is hit).
function getAreaReplayPositions(boxes, fromIso, toIso, limit) {
  const geo = boxesSql(boxes, 'r.latitude', 'r.longitude');
  return db
    .prepare(
      `SELECT r.mmsi, r.received_at, r.latitude AS lat, r.longitude AS lon, r.sog, r.cog,
              s.ship_name, s.ship_type
       FROM readings r
       LEFT JOIN ships s ON s.mmsi = r.mmsi
       WHERE r.latitude IS NOT NULL AND r.longitude IS NOT NULL
         AND r.received_at >= ? AND r.received_at <= ?
         AND ${geo}
       ORDER BY r.mmsi ASC, r.received_at ASC
       LIMIT ?`
    )
    .all(fromIso, toIso, limit);
}

// Oldest/newest reading timestamp available inside an area's bbox(es) — bounds
// the replay window picker. Cheap (indexed scan over received_at).
function getAreaReplayRange(boxes) {
  const geo = boxesSql(boxes, 'latitude', 'longitude');
  return db
    .prepare(
      `SELECT MIN(received_at) AS lo, MAX(received_at) AS hi, COUNT(*) AS n
       FROM readings
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND ${geo}`
    )
    .get();
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
    SELECT * FROM port_events WHERE mmsi = ? ORDER BY ts DESC
  `
    )
    .all(mmsi);
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

const insertNotificationStmt = db.prepare(
  `INSERT INTO notifications (user_id, type, mmsi, ship_name, area, from_area, band, score, berth_id, berth_lat, berth_lon, ts, read)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
);
// Prune per-user: keep only the most recent MAX_NOTIFICATIONS rows for that user.
const pruneNotificationsStmt = db.prepare(
  `DELETE FROM notifications WHERE user_id IS ? AND id NOT IN (
     SELECT id FROM notifications WHERE user_id IS ? ORDER BY id DESC LIMIT ${MAX_NOTIFICATIONS}
   )`
);

// Notifications are now per-user: `user_id` identifies the recipient. The stream
// fan-out (see ais-stream.js) calls this once per user who should be alerted.
function addNotification({ user_id = null, type, mmsi = null, ship_name = null, area = null, from_area = null, band = null, score = null, berth_id = null, berth_lat = null, berth_lon = null }) {
  const ts = new Date().toISOString();
  const result = insertNotificationStmt.run(user_id, type, mmsi, ship_name, area, from_area, band, score, berth_id, berth_lat, berth_lon, ts);
  pruneNotificationsStmt.run(user_id, user_id);
  return { id: Number(result.lastInsertRowid), user_id, type, mmsi, ship_name, area, from_area, band, score, berth_id, berth_lat, berth_lon, ts, read: 0 };
}

function getNotifications(userId, limit = MAX_NOTIFICATIONS) {
  return db.prepare('SELECT * FROM notifications WHERE user_id IS ? ORDER BY id DESC LIMIT ?').all(userId, limit);
}

function getUnreadNotificationCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id IS ? AND read = 0').get(userId).n;
}

// Mutations are scoped to the owner so a user can't touch another's notifications.
function markNotificationRead(id, userId) {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id IS ?').run(id, userId);
}

function deleteNotification(id, userId) {
  db.prepare('DELETE FROM notifications WHERE id = ? AND user_id IS ?').run(id, userId);
}

function deleteAllNotifications(userId) {
  db.prepare('DELETE FROM notifications WHERE user_id IS ?').run(userId);
}

function markAllNotificationsRead(userId) {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id IS ? AND read = 0').run(userId);
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

function setSeen(mmsi, seen) {
  db.prepare('UPDATE ships SET seen = ? WHERE mmsi = ?').run(seen ? 1 : 0, mmsi);
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
  // Realign port_events to their ship's (corrected) area.
  db.prepare(
    `UPDATE port_events SET area = (SELECT last_area FROM ships WHERE ships.mmsi = port_events.mmsi)
     WHERE EXISTS (
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
      const purge = db.transaction((ids) => {
        const stmts = [
          db.prepare('DELETE FROM readings WHERE mmsi = ?'),
          db.prepare('DELETE FROM port_events WHERE mmsi = ?'),
          db.prepare('DELETE FROM risk_history WHERE mmsi = ?'),
          db.prepare('DELETE FROM moorings WHERE mmsi = ?'),
          db.prepare('DELETE FROM ship_scrape_cache WHERE mmsi = ?'),
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
const BACKUP_TABLES = ['readings', 'ships', 'port_events', 'api_log', 'ship_scrape_cache', 'ship_scrape_failures', 'notifications', 'risk_history', 'moorings', 'berths', 'proximity_events', 'meta', 'users', 'sessions', 'groups', 'areas', 'user_areas', 'user_flags', 'user_follows', 'user_mutes', 'user_settings'];

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
  getPastShips,
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
  getAreaReplayPositions,
  getAreaReplayRange,
  getShipPositions,
  getDistinctShipNames,
  getRecentPositions,
  setFlag,
  setSeen,
  updateNotes,
  setMtShipId,
  setMilitary,
  setNotifMuted,
  getPortEvents,
  getShipEvents,
  getArrivalsForArea,
  getStayCentroid,
  replaceMoorings,
  addMooring,
  updateMooringPosition,
  deleteMooring,
  getMoorings,
  setMooringBerth,
  clearMooringBerths,
  getBerths,
  getBerth,
  getAutoBerths,
  deleteAutoBerths,
  insertBerth,
  updateBerthChar,
  updateBerthManual,
  deleteBerth,
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
  // Area catalog & per-user ownership
  getAllAreas,
  upsertArea,
  deleteAreaRow,
  addUserArea,
  removeUserArea,
  getUserAreaKeys,
  areaOwnerCount,
  getOrphanAreaKeys,
  seedAreaCatalogIfEmpty,
  migrateMultiUser,
  // Per-user visibility & ship state
  getUserBoxes,
  isShipVisible,
  getVisibleAreaKeys,
  getUserFlaggedMmsis,
  setUserFlag,
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
  getUserSettings,
  setUserSetting,
  findUserIdBySetting,
  getTelegramLinkedUserIds,
  getUserIdsWithSetting,
  autoStopStaleFollowsAll,
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
