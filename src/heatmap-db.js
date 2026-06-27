'use strict';

// Separate SQLite database for the global coverage heatmap (the "mappa delle zone
// coperte"). Kept in its OWN file (heatmap_data.db) — distinct from the main
// ais_data.db — so it can be exported/imported on its own from Settings, while
// still being embedded in the full bundle (see routes/export.js, format v3).
//
// The data is a single bounded table of per-cell message counts (see
// services/heatmap-stream.js). Mirrors the main db.js connection setup (WAL,
// busy_timeout, incremental auto_vacuum).

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { relocateDbFile } = require('./lib/db-location');

// Under data/db/ (was the project root in older versions — relocated on first start).
const DB_PATH = path.join(__dirname, '..', 'data', 'db', 'heatmap_data.db');
const MAIN_DB_PATH = path.join(__dirname, '..', 'data', 'db', 'ais_data.db');
relocateDbFile(path.join(__dirname, '..', 'heatmap_data.db'), DB_PATH);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA auto_vacuum = INCREMENTAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS heatmap_cells (
    lat_idx   INTEGER NOT NULL,
    lon_idx   INTEGER NOT NULL,
    msg_count INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT,
    PRIMARY KEY (lat_idx, lon_idx)
  )
`);

const bumpStmt = db.prepare(`
  INSERT INTO heatmap_cells (lat_idx, lon_idx, msg_count, last_seen)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(lat_idx, lon_idx) DO UPDATE SET
    msg_count = msg_count + excluded.msg_count,
    last_seen = excluded.last_seen
`);

/** Apply a batch of per-cell count deltas in one transaction (see the stream's
 *  periodic flush). `batch` = [{ latIdx, lonIdx, count, lastSeen }]. */
function bumpCells(batch) {
  if (!batch || !batch.length) return 0;
  db.exec('BEGIN');
  try {
    for (const c of batch) bumpStmt.run(c.latIdx, c.lonIdx, c.count, c.lastSeen);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return batch.length;
}

/** All populated cells for the overlay. Compact aliases keep the JSON small. */
function getCells() {
  return db.prepare('SELECT lat_idx AS a, lon_idx AS o, msg_count AS c FROM heatmap_cells').all();
}

function getStats() {
  return db
    .prepare(
      `SELECT COUNT(*) AS cells, COALESCE(SUM(msg_count), 0) AS total,
              COALESCE(MAX(msg_count), 0) AS maxCount,
              MIN(last_seen) AS firstSeen, MAX(last_seen) AS lastSeen
       FROM heatmap_cells`
    )
    .get();
}

/** Wipe all cells. Returns rows removed. */
function clear() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM heatmap_cells').get().n;
  db.exec('DELETE FROM heatmap_cells');
  return n;
}

/** Consistent snapshot to `dest` (for export / bundle), even while writing. */
function backupTo(dest) {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}

/**
 * REPLACE all cells with those from the SQLite file at `src` (import / bundle /
 * deploy restore). Single transaction on the live connection so prepared
 * statements stay valid. Returns the restored row count.
 */
function restoreFrom(src) {
  db.exec(`ATTACH DATABASE '${src.replace(/'/g, "''")}' AS himp`);
  try {
    const has = db
      .prepare("SELECT 1 FROM himp.sqlite_master WHERE type='table' AND name='heatmap_cells'")
      .get();
    if (!has) throw new Error('File heatmap non valido: tabella heatmap_cells assente');
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM main.heatmap_cells');
      db.exec(
        'INSERT INTO main.heatmap_cells (lat_idx, lon_idx, msg_count, last_seen) ' +
          'SELECT lat_idx, lon_idx, msg_count, last_seen FROM himp.heatmap_cells'
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return db.prepare('SELECT COUNT(*) AS n FROM main.heatmap_cells').get().n;
  } finally {
    db.exec('DETACH DATABASE himp');
  }
}

function runMaintenance() {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA incremental_vacuum');
}

/**
 * One-time migration: earlier versions kept heatmap_cells INSIDE the main
 * ais_data.db. If this heatmap DB is still empty but the main DB has cells, copy
 * them over (best-effort, via an independent read connection so there's no module
 * cycle with db.js). The leftover main-DB table is harmless — it's no longer
 * written or backed up.
 */
function migrateFromMainIfNeeded() {
  try {
    if (getStats().cells > 0) return;
    if (!fs.existsSync(MAIN_DB_PATH)) return;
    const main = new DatabaseSync(MAIN_DB_PATH);
    try {
      const has = main
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='heatmap_cells'")
        .get();
      if (!has) return;
      const rows = main.prepare('SELECT lat_idx, lon_idx, msg_count, last_seen FROM heatmap_cells').all();
      if (!rows.length) return;
      bumpCells(rows.map((r) => ({ latIdx: r.lat_idx, lonIdx: r.lon_idx, count: r.msg_count, lastSeen: r.last_seen })));
      console.log(`[HEATMAP] Migrate ${rows.length} celle dal DB principale al DB heatmap separato`);
    } finally {
      main.close();
    }
  } catch (e) {
    console.error(`[HEATMAP] Migrazione celle dal DB principale fallita: ${e.message}`);
  }
}

module.exports = {
  DB_PATH,
  bumpCells,
  getCells,
  getStats,
  clear,
  backupTo,
  restoreFrom,
  runMaintenance,
  migrateFromMainIfNeeded,
};
