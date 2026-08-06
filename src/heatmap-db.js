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
const { HEATMAP } = require('./config');

// FINEST resolution data is bucketed at on ingest. Implicit in every stored cell
// index, so the DB is tagged with it (heatmap_meta) and cells from a different
// grid are discarded rather than mis-placed (see ensureGridMeta + restoreFrom).
const GRID = HEATMAP.GRID_DEG;
// Coarsest aggregation a client can request (~4°): bounds the GROUP BY fan-in.
const MAX_FACTOR = Math.max(1, Math.round(4.0 / GRID));

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

// Tiny key/value side-table; currently holds 'grid_deg' so a DB carries the
// resolution its indices are bucketed at (export/import/deploy all copy it).
db.exec('CREATE TABLE IF NOT EXISTS heatmap_meta (key TEXT PRIMARY KEY, value TEXT)');

function getMeta(key) {
  const row = db.prepare('SELECT value FROM heatmap_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setMeta(key, value) {
  db.prepare(
    'INSERT INTO heatmap_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function cellCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM heatmap_cells').get().n;
}

/**
 * Reconcile the stored grid with the configured GRID. Cells are indexed as
 * floor(coord/GRID); if the DB was filled at a different grid (config changed, or
 * a legacy pre-meta DB that was always 0.5°), the existing indices mean something
 * else now — discard them rather than mis-place every cell. Then tag with GRID.
 */
function ensureGridMeta() {
  const tag = getMeta('grid_deg');
  const stored = tag === null ? null : Number(tag);
  // No tag = legacy DB (pre-meta) → it was bucketed at the old 0.5° default.
  const effectiveStored = stored === null ? (cellCount() > 0 ? 0.5 : GRID) : stored;
  if (effectiveStored !== GRID && cellCount() > 0) {
    db.exec('DELETE FROM heatmap_cells');
    console.log(`[HEATMAP] Griglia cambiata ${effectiveStored}° → ${GRID}°: celle incompatibili scartate`);
  }
  setMeta('grid_deg', GRID);
}
ensureGridMeta();

// ── World-view aggregation cache ─────────────────────────────────────────────────
// Whole-world coarse levels are the expensive reads (full-table GROUP BY). Cache
// them per aggregation factor; bbox (zoomed) reads are small and skip the cache.
// Any write marks the cache dirty so the next read rebuilds.
const aggCache = new Map();
let aggDirty = true;
function invalidate() {
  aggDirty = true;
}

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
  invalidate();
  return batch.length;
}

/** All populated FINE cells for the overlay. Compact aliases keep the JSON small. */
function getCells() {
  return db.prepare('SELECT lat_idx AS a, lon_idx AS o, msg_count AS c FROM heatmap_cells').all();
}

// Snap a requested cell size (deg) to an achievable integer aggregation factor.
// A non-finite/non-positive level (0, negative, NaN from a bad query param) used
// to collapse to factor 1 — the FINEST possible grid — instead of a safe default.
const DEFAULT_LEVEL_DEG = 1.0;
function factorFor(level) {
  const n = Number(level);
  const want = Number.isFinite(n) && n > 0 ? n / GRID : DEFAULT_LEVEL_DEG / GRID;
  return Math.min(MAX_FACTOR, Math.max(1, Math.round(want)));
}

// Requests with no bbox (world view) are reachable unauthenticated via
// /api/heatmap/public-cells: never let one materialize the world at a fine
// resolution, whatever `level` claims. Floors to ~DEFAULT_LEVEL_DEG-sized cells.
const MIN_WORLDVIEW_FACTOR = Math.max(1, Math.round(DEFAULT_LEVEL_DEG / GRID));

// Clamp a viewport to the world and convert to FINE index bounds (±1 cell margin
// so partially-visible edge cells still render).
function fineBounds(bbox) {
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
  const minLat = cl(bbox.minLat, -90, 90);
  const maxLat = cl(bbox.maxLat, -90, 90);
  const minLon = cl(bbox.minLon, -180, 180);
  const maxLon = cl(bbox.maxLon, -180, 180);
  return {
    latMin: Math.floor(minLat / GRID) - 1,
    latMax: Math.floor(maxLat / GRID) + 1,
    lonMin: Math.floor(minLon / GRID) - 1,
    lonMax: Math.floor(maxLon / GRID) + 1,
  };
}

// floor(idx / f) expressed in pure integer SQL (SQLite '/' truncates toward zero,
// so a plain divide is wrong for negative indices — southern/western hemisphere).
// f is a validated integer we control, safe to inline.
function floorDivExpr(col, f) {
  return `(${col} - ((${col} % ${f} + ${f}) % ${f})) / ${f}`;
}

/**
 * Cells for a zoom level. `level` is the desired cell size in degrees (snapped to
 * an achievable factor); `bbox` (optional) restricts to a viewport. `hideSingletons`
 * drops FINE cells with exactly one recorded message BEFORE aggregation — the
 * signature of isolated single-ping noise (e.g. satellite-AIS position fallback
 * artifacts: a stray fix far from any real traffic, never repeated) rather than
 * real coverage. Filtering at the fine level (not on the aggregated sum) means a
 * coarse block that also contains real traffic still shows it; only the noise
 * cell's own contribution is dropped. Returns { gridDeg, cells:[{a,o,c}] } where
 * a/o are indices in the EFFECTIVE grid so the client draws each at a*gridDeg.
 * World-view results are cached (keyed by factor + the singleton-filter flag).
 */
function getCellsAgg({ level, bbox, hideSingletons = false } = {}) {
  const worldView = !bbox;
  const f = worldView ? Math.max(factorFor(level), MIN_WORLDVIEW_FACTOR) : factorFor(level);
  const gridDeg = Number((f * GRID).toFixed(6));
  const cacheKey = `${f}:${hideSingletons ? 1 : 0}`;

  if (worldView) {
    if (aggDirty) {
      aggCache.clear();
      aggDirty = false;
    } else if (aggCache.has(cacheKey)) {
      return { gridDeg, cells: aggCache.get(cacheKey) };
    }
  }

  const conds = [];
  const args = [];
  if (bbox) {
    conds.push('lat_idx BETWEEN ? AND ? AND lon_idx BETWEEN ? AND ?');
    args.push(...boundsArgs(bbox));
  }
  if (hideSingletons) conds.push('msg_count > 1');
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  let cells;
  if (f === 1) {
    cells = db.prepare(`SELECT lat_idx AS a, lon_idx AS o, msg_count AS c FROM heatmap_cells ${where}`).all(...args);
  } else {
    const a = floorDivExpr('lat_idx', f);
    const o = floorDivExpr('lon_idx', f);
    const sql = `SELECT ${a} AS a, ${o} AS o, SUM(msg_count) AS c FROM heatmap_cells ${where} GROUP BY a, o`;
    cells = db.prepare(sql).all(...args);
  }

  if (worldView) aggCache.set(cacheKey, cells);
  return { gridDeg, cells };
}

function boundsArgs(bbox) {
  const b = fineBounds(bbox);
  return [b.latMin, b.latMax, b.lonMin, b.lonMax];
}

/** Drop low-count cells not seen since `cutoffIso` (AIS noise). Returns rows removed. */
function pruneCells(minCount, cutoffIso) {
  const r = db.prepare('DELETE FROM heatmap_cells WHERE msg_count <= ? AND last_seen < ?').run(minCount, cutoffIso);
  const n = Number(r.changes || 0);
  if (n) invalidate();
  return n;
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
  const n = cellCount();
  db.exec('DELETE FROM heatmap_cells');
  invalidate();
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

    // Grid-compatibility gate: a file bucketed at a different resolution carries
    // indices that mean something else here. Discard rather than mis-place — the
    // map starts empty and re-populates at the current grid. A pre-meta file is
    // legacy 0.5° (unless it has no cells, in which case it's harmless).
    const hasMeta = db
      .prepare("SELECT 1 FROM himp.sqlite_master WHERE type='table' AND name='heatmap_meta'")
      .get();
    const tag = hasMeta
      ? db.prepare("SELECT value FROM himp.heatmap_meta WHERE key = 'grid_deg'").get()
      : null;
    const srcRows = db.prepare('SELECT COUNT(*) AS n FROM himp.heatmap_cells').get().n;
    const srcGrid = tag ? Number(tag.value) : srcRows > 0 ? 0.5 : GRID;
    if (srcGrid !== GRID) {
      db.exec('DELETE FROM main.heatmap_cells');
      invalidate();
      console.warn(
        `[HEATMAP] Restore ignorato: griglia file ${srcGrid}° ≠ griglia attuale ${GRID}° (${srcRows} celle scartate)`
      );
      return 0;
    }

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
    invalidate();
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
    // Legacy in-main cells were always bucketed at 0.5°; only adopt them if the
    // current grid still matches, else they'd be mis-placed (same rule as restore).
    if (GRID !== 0.5) return;
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
  getCellsAgg,
  pruneCells,
  getStats,
  clear,
  backupTo,
  restoreFrom,
  runMaintenance,
  migrateFromMainIfNeeded,
};
