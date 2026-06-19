'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const cfg = require('./config');
const appLog = require('./services/app-log');

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
    eta: msgData.Eta ? String(msgData.Eta).trim() || null : null,
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
      if (existing?.flagged) arrivedFlagged = row.mmsi;
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

function getActiveShips(area) {
  const filter = area ? 'AND last_area = ?' : '';
  const params = area ? [area] : [];
  return db
    .prepare(
      `SELECT * FROM ships
       WHERE ${ACTIVE_PREDICATE} ${filter}
       ORDER BY flagged DESC, seen ASC, last_seen_at DESC`
    )
    .all(...params);
}

function getPastShips(area) {
  const filter = area ? 'AND last_area = ?' : '';
  const params = area ? [area] : [];
  return db
    .prepare(
      `SELECT * FROM ships
       WHERE NOT ${ACTIVE_PREDICATE} ${filter}
       ORDER BY flagged DESC, seen ASC, last_seen_at DESC`
    )
    .all(...params);
}

function getShip(mmsi) {
  return db.prepare('SELECT * FROM ships WHERE mmsi = ?').get(mmsi) || null;
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

function getShipTrack(mmsi, limit = 500) {
  return db
    .prepare(
      `
    SELECT id, received_at, latitude, longitude, sog, cog
    FROM readings
    WHERE mmsi = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY received_at ASC
    LIMIT ?
  `
    )
    .all(mmsi, limit);
}

function getPortEvents(limit = 100, offset = 0, area) {
  const filter = area ? 'WHERE area = ?' : '';
  const params = area ? [area, limit, offset] : [limit, offset];
  const rows = db
    .prepare(`SELECT * FROM port_events ${filter} ORDER BY ts DESC LIMIT ? OFFSET ?`)
    .all(...params);
  const total = area
    ? db.prepare('SELECT COUNT(*) as n FROM port_events WHERE area = ?').get(area).n
    : db.prepare('SELECT COUNT(*) as n FROM port_events').get().n;
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
  `INSERT INTO notifications (type, mmsi, ship_name, area, from_area, band, score, berth_id, berth_lat, berth_lon, ts, read)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
);
const pruneNotificationsStmt = db.prepare(
  `DELETE FROM notifications WHERE id NOT IN (
     SELECT id FROM notifications ORDER BY id DESC LIMIT ${MAX_NOTIFICATIONS}
   )`
);

function addNotification({ type, mmsi = null, ship_name = null, area = null, from_area = null, band = null, score = null, berth_id = null, berth_lat = null, berth_lon = null }) {
  const ts = new Date().toISOString();
  const result = insertNotificationStmt.run(type, mmsi, ship_name, area, from_area, band, score, berth_id, berth_lat, berth_lon, ts);
  pruneNotificationsStmt.run();
  return { id: Number(result.lastInsertRowid), type, mmsi, ship_name, area, from_area, band, score, berth_id, berth_lat, berth_lon, ts, read: 0 };
}

function getNotifications(limit = MAX_NOTIFICATIONS) {
  return db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit);
}

function getUnreadNotificationCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read = 0').get().n;
}

function markNotificationRead(id) {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
}

function deleteNotification(id) {
  db.prepare('DELETE FROM notifications WHERE id = ?').run(id);
}

function deleteAllNotifications() {
  db.prepare('DELETE FROM notifications').run();
}

function markAllNotificationsRead() {
  db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
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

function getStats(area) {
  const af = area ? 'AND area = ?' : '';
  const ap = (base) => area ? [...base, area] : base;

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
         ${area ? 'AND a.area = ?' : ''}`
    )
    .get(...(area ? [area] : [])).avg;

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

function getRecentShips(area) {
  const filter = area ? 'AND last_area = ?' : '';
  const params = area ? [area] : [];
  return db
    .prepare(
      `SELECT * FROM ships
       WHERE last_seen_at >= datetime('now', '-7 days') ${filter}
       ORDER BY last_seen_at DESC`
    )
    .all(...params);
}

function getDailyArrivals(area) {
  const filter = area ? 'AND area = ?' : '';
  const params = area ? [area] : [];
  return db
    .prepare(
      `SELECT date(ts) as day, COUNT(*) as n
       FROM port_events
       WHERE event_type = 'arrived'
         AND ts >= datetime('now', '-30 days') ${filter}
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(...params);
}

function getExpectedShips(keyword) {
  if (!keyword) return [];
  return db
    .prepare(
      `
    SELECT * FROM ships
    WHERE destination LIKE ?
      AND last_seen_at <= datetime('now', '-60 minutes')
      AND last_seen_at >= datetime('now', '-48 hours')
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

function getReadings({ type, limit = 50, offset = 0 }) {
  let sql =
    'SELECT id, received_at, message_type, mmsi, ship_name, latitude, longitude, navigational_status, sog, cog, true_heading FROM readings';
  const params = [];
  if (type) {
    sql += ' WHERE message_type = ?';
    params.push(type);
  }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function getReading(id) {
  return db.prepare('SELECT * FROM readings WHERE id = ?').get(id);
}

function getTotalCount(type) {
  if (type) {
    return db.prepare('SELECT COUNT(*) as n FROM readings WHERE message_type = ?').get(type).n;
  }
  return db.prepare('SELECT COUNT(*) as n FROM readings').get().n;
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
    // Drop score history for ships belonging to this area before the ships go.
    db.prepare('DELETE FROM risk_history WHERE mmsi IN (SELECT mmsi FROM ships WHERE last_area = ?)').run(area);
    db.prepare('DELETE FROM readings WHERE area = ?').run(area);
    db.prepare('DELETE FROM ships WHERE last_area = ?').run(area);
    db.prepare('DELETE FROM port_events WHERE area = ?').run(area);
    db.prepare('DELETE FROM notifications WHERE area = ?').run(area);
    db.prepare('DELETE FROM moorings WHERE area = ?').run(area);
    db.prepare('DELETE FROM berths WHERE area = ?').run(area);
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
const BACKUP_TABLES = ['readings', 'ships', 'port_events', 'api_log', 'ship_scrape_cache', 'ship_scrape_failures', 'notifications', 'risk_history', 'moorings', 'berths', 'meta'];

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

    // Reset prune counters so they re-derive from the restored data.
    Object.keys(insertCounters).forEach((k) => delete insertCounters[k]);
    return counts;
  } finally {
    db.exec('DETACH DATABASE restore');
  }
}

module.exports = {
  insert,
  insertFollowPosition,
  getAreaCounts,
  getActiveShips,
  getPastShips,
  getFollowedShips,
  getPastFollowedShips,
  getFollowedPositions,
  autoStopStaleFollows,
  setFollow,
  getShip,
  getShipReadings,
  getShipTrack,
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
