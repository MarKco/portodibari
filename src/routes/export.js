'use strict';

const express = require('express');
const archiver = require('archiver');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const heatmapDb = require('../heatmap-db');
const berths = require('../services/berths');
const stream = require('../services/ais-stream');
const appLog = require('../services/app-log');
const { state, areaForPoint, exportAreas, bboxSignature, BACKUP_INTERVAL_MIN, MAX_UPLOAD_MB, syncAreasWithDb,
  DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD, SESSION_TTL_DAYS } = require('../config');
const { flattenObject, csvEscape } = require('../lib/csv');
const { importAreasAndStart } = require('./areas');
const { exportSettings, applyImportedSettings } = require('./settings');
const { requireAdmin, setSessionCookie } = require('../middleware/session-auth');

const router = express.Router();

// Whole-DB export/backup/restore exposes every user's data and can overwrite the
// entire database — admin only.
router.use(requireAdmin);

const BUNDLE_FORMAT = 'tracker-porti-bundle';
const BACKUP_DIR = path.join(__dirname, '..', '..', 'data', 'backups');
const MAX_BACKUPS = 5;
const BACKUP_INTERVAL_MS = BACKUP_INTERVAL_MIN * 60 * 1000;
const UPLOAD_LIMIT = `${MAX_UPLOAD_MB}mb`;

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ── Bundle container (format v2) ──────────────────────────────────────────────
// A bundle is a single portable file holding the DB + areas + settings. v2 is a
// streaming binary container so neither writing nor restoring ever holds the
// whole database in the (small, ~256 MB) V8 heap — the old v1 wrapped the DB as
// base64 inside one JSON string, costing ~3× the DB size and OOM-ing as the DB
// grows. Layout:
//   [4B magic "TPB2"][4B BE uint32 metaLen][metaLen B meta JSON][raw SQLite bytes]
// meta JSON = { format, version, exportedAt, label?, areas, settings }.
// Legacy v1 (JSON with base64 `db`) is still read on restore for backward compat.
const BUNDLE_MAGIC = 'TPB2';
// v3 extends v2 by appending the SEPARATE heatmap database after the main DB, each
// length-prefixed so both are extractable (the main DB can no longer be "read to
// EOF"). Layout:
//   [4B "TPB3"][4B metaLen][meta JSON][8B mainLen][main DB][8B hmLen][heatmap DB]
// v2/v1 bundles are still read on restore; they simply carry no heatmap section,
// so a restore from an old bundle leaves the current heatmap data untouched.
const BUNDLE_MAGIC_V3 = 'TPB3';
const COPY_CHUNK = 1 << 20; // 1 MB

// Copy `srcPath[start..EOF]` to destPath synchronously, in bounded memory.
function copySliceSync(srcPath, start, destPath) {
  const inFd = fs.openSync(srcPath, 'r');
  const outFd = fs.openSync(destPath, 'w');
  try {
    const buf = Buffer.alloc(COPY_CHUNK);
    let pos = start;
    let n;
    while ((n = fs.readSync(inFd, buf, 0, buf.length, pos)) > 0) {
      fs.writeSync(outFd, buf, 0, n);
      pos += n;
    }
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
}

// Copy exactly `len` bytes of `srcPath` starting at `start` to destPath, bounded memory.
function copySliceRangeSync(srcPath, start, len, destPath) {
  const inFd = fs.openSync(srcPath, 'r');
  const outFd = fs.openSync(destPath, 'w');
  try {
    const buf = Buffer.alloc(COPY_CHUNK);
    let pos = start;
    let left = len;
    while (left > 0) {
      const want = Math.min(buf.length, left);
      const n = fs.readSync(inFd, buf, 0, want, pos);
      if (n <= 0) break;
      fs.writeSync(outFd, buf, 0, n);
      pos += n;
      left -= n;
    }
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
}

// Write a v3 bundle: header + meta, then the main DB and heatmap DB, each
// preceded by an 8-byte big-endian length. Streamed in 1 MB chunks (no buffering).
function writeBundleV3Sync(destPath, meta, mainDbPath, heatmapDbPath) {
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
  const header = Buffer.alloc(8);
  header.write(BUNDLE_MAGIC_V3, 0, 'ascii');
  header.writeUInt32BE(metaBuf.length, 4);
  const outFd = fs.openSync(destPath, 'w');
  try {
    fs.writeSync(outFd, header);
    fs.writeSync(outFd, metaBuf);
    for (const p of [mainDbPath, heatmapDbPath]) {
      const size = fs.statSync(p).size;
      const lenBuf = Buffer.alloc(8);
      lenBuf.writeBigUInt64BE(BigInt(size));
      fs.writeSync(outFd, lenBuf);
      const inFd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(COPY_CHUNK);
        let n;
        while ((n = fs.readSync(inFd, buf, 0, buf.length, null)) > 0) fs.writeSync(outFd, buf, 0, n);
      } finally {
        fs.closeSync(inFd);
      }
    }
  } finally {
    fs.closeSync(outFd);
  }
}

function assertSqliteFile(dbPath) {
  const fd = fs.openSync(dbPath, 'r');
  try {
    const b = Buffer.alloc(16);
    const n = fs.readSync(fd, b, 0, 16, 0);
    if (n < 15 || b.toString('latin1', 0, 15) !== 'SQLite format 3') {
      throw new Error('database nel backup non valido');
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Inspect a bundle file's head. v2 → { version: 2, payload, dbStart } reading
// only the small header. Legacy → { version: 1, payload } parsing the whole JSON.
// `payload` carries .areas / .settings (and, for v1, the base64 .db).
function readBundleHead(bundlePath) {
  const fd = fs.openSync(bundlePath, 'r');
  let head;
  try {
    head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  const magic = head.toString('ascii', 0, 4);
  if (magic === BUNDLE_MAGIC || magic === BUNDLE_MAGIC_V3) {
    const metaLen = head.readUInt32BE(4);
    if (metaLen <= 0 || metaLen > 50 * 1024 * 1024) throw new Error('intestazione backup non valida');
    const metaBuf = Buffer.alloc(metaLen);
    const mfd = fs.openSync(bundlePath, 'r');
    try {
      fs.readSync(mfd, metaBuf, 0, metaLen, 8);
    } finally {
      fs.closeSync(mfd);
    }
    let payload;
    try { payload = JSON.parse(metaBuf.toString('utf8')); } catch { throw new Error('intestazione backup non valida'); }
    if (magic === BUNDLE_MAGIC) {
      // v2: the main DB runs from here to EOF; no heatmap section.
      return { version: 2, payload, dbStart: 8 + metaLen };
    }
    // v3: [8B mainLen][main][8B hmLen][hm], read the length prefixes.
    const fd2 = fs.openSync(bundlePath, 'r');
    try {
      const lenBuf = Buffer.alloc(8);
      const mainLenOff = 8 + metaLen;
      fs.readSync(fd2, lenBuf, 0, 8, mainLenOff);
      const mainLen = Number(lenBuf.readBigUInt64BE());
      const mainStart = mainLenOff + 8;
      const hmLenOff = mainStart + mainLen;
      fs.readSync(fd2, lenBuf, 0, 8, hmLenOff);
      const hmLen = Number(lenBuf.readBigUInt64BE());
      const hmStart = hmLenOff + 8;
      return { version: 3, payload, dbStart: mainStart, mainLen, hmStart, hmLen };
    } finally {
      fs.closeSync(fd2);
    }
  }
  // Legacy v1: the whole file is JSON with a base64 `db`.
  let payload;
  try { payload = JSON.parse(fs.readFileSync(bundlePath, 'utf8')); } catch { throw new Error('formato backup non valido'); }
  if (!payload || payload.format !== BUNDLE_FORMAT) throw new Error('formato backup non valido');
  return { version: 1, payload };
}

// Write the bundle's embedded main SQLite DB to destDb, validating the magic header.
function extractBundleDb(bundlePath, head, destDb) {
  if (head.version === 3) {
    copySliceRangeSync(bundlePath, head.dbStart, head.mainLen, destDb);
  } else if (head.version === 2) {
    copySliceSync(bundlePath, head.dbStart, destDb);
  } else {
    if (!head.payload.db) throw new Error('database nel backup non valido');
    const buf = Buffer.from(head.payload.db, 'base64');
    fs.writeFileSync(destDb, buf);
  }
  assertSqliteFile(destDb);
}

// Extract the embedded heatmap DB (v3 only) to destDb. Returns false when the
// bundle carries no heatmap section (v1/v2, or an empty section).
function extractBundleHeatmap(bundlePath, head, destDb) {
  if (head.version !== 3 || !head.hmLen) return false;
  copySliceRangeSync(bundlePath, head.hmStart, head.hmLen, destDb);
  assertSqliteFile(destDb);
  return true;
}

// Restore the heatmap DB from a bundle if it carries one (best-effort: a heatmap
// import failure must never abort the main restore). Returns the restored cell
// count, or null when there was nothing to restore.
function restoreBundleHeatmap(bundlePath, head) {
  const tmp = path.join(os.tmpdir(), `tracker-porti-hm-restore-${process.pid}.db`);
  try {
    if (!extractBundleHeatmap(bundlePath, head, tmp)) return null;
    return heatmapDb.restoreFrom(tmp);
  } catch (e) {
    console.error(`[BUNDLE] Ripristino heatmap fallito: ${e.message}`);
    return null;
  } finally {
    fs.unlink(tmp, () => {});
  }
}

// ── Auto-backup helpers ───────────────────────────────────────────────────────

function listSavedBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('tracker-porti-') && (f.endsWith('.tpbk') || f.endsWith('.json')))
      .map((filename) => {
        const stat = fs.statSync(path.join(BACKUP_DIR, filename));
        return { filename, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function pruneOldBackups() {
  const files = listSavedBackups();
  for (const f of files.slice(MAX_BACKUPS)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f.filename)); } catch { /* ignore */ }
  }
}

// Build the v3 meta blob (everything except the raw DB blobs). The heatmap entry
// is informational; the actual heatmap DB is appended after the main DB.
function bundleMeta(label) {
  let hm = null;
  try { const st = heatmapDb.getStats(); hm = { cells: st.cells, total: st.total }; } catch { /* ignore */ }
  return {
    format: BUNDLE_FORMAT,
    version: 3,
    exportedAt: new Date().toISOString(),
    ...(label ? { label } : {}),
    areas: exportAreas(),
    settings: exportSettings(),
    heatmap: hm,
  };
}

// Snapshot both databases to temp files and write a v3 bundle. Returns the temp
// paths so the caller can clean them up.
function writeBundle(destPath, label) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmpMain = path.join(os.tmpdir(), `tracker-porti-bundle-main-${ts}-${process.pid}.db`);
  const tmpHm = path.join(os.tmpdir(), `tracker-porti-bundle-hm-${ts}-${process.pid}.db`);
  try {
    db.backupTo(tmpMain);
    heatmapDb.backupTo(tmpHm);
    writeBundleV3Sync(destPath, bundleMeta(label), tmpMain, tmpHm); // streamed; DBs never enter the heap
  } finally {
    fs.unlink(tmpMain, () => {});
    fs.unlink(tmpHm, () => {});
  }
}

function createAndSaveBundle(label = 'auto') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `tracker-porti-${label}backup-${ts}.tpbk`;
  const filePath = path.join(BACKUP_DIR, filename);
  writeBundle(filePath, label);
  pruneOldBackups();
  return { filename, mtime: fs.statSync(filePath).mtimeMs, size: fs.statSync(filePath).size };
}

// Restore ONLY the database from the most recent saved backup. Used at startup
// when the .db file was wiped by a deploy. Areas (bounding-boxes.json) and
// settings (local.properties) survive a deploy as plain files, so they are left
// as-is — restoring them from an older backup could regress current config.
// Returns { filename, counts } or null when no backup is available; throws on a
// corrupt/unreadable backup.
function restoreDbFromLatestBackup() {
  const backups = listSavedBackups();
  if (!backups.length) return null;
  const { filename } = backups[0];
  const filePath = path.join(BACKUP_DIR, filename);

  let head;
  try {
    head = readBundleHead(filePath);
  } catch (e) {
    throw new Error(`backup non valido (${filename}): ${e.message}`);
  }

  const tmp = path.join(os.tmpdir(), `tracker-porti-autorestore-${process.pid}.db`);
  try {
    extractBundleDb(filePath, head, tmp); // v2: streamed slice; v1: base64 decode
    const counts = db.restoreFrom(tmp);
    // v3 bundles also carry the heatmap DB — restore it too (deploys wipe its file).
    const heatmapCells = restoreBundleHeatmap(filePath, head);
    return { filename, counts, heatmapCells };
  } finally {
    fs.unlink(tmp, () => {});
  }
}

// After any DB restore the moorings/berths tables may be stale: an older backup
// (pre-berths schema) has no such tables, so restoreFrom leaves the current ones
// untouched — pointing at data that no longer exists. Rebuild them so the
// overlay matches the restored database immediately (manual berths are kept).
//
// counts: the per-table row counts returned by restoreFrom. If the backup had a
// moorings table (counts.moorings is defined), the restored moorings are already
// correct — skip re-deriving from readings (which may be pruned) and only
// re-cluster. For old backups without a moorings table, do a full re-derive.
function rebuildBerthsAfterRestore(counts = {}) {
  const skipSync = counts.moorings !== undefined;
  try {
    berths.recomputeAll({ skipSync });
  } catch (e) {
    console.error(`[BERTHS] Ricalcolo post-restore fallito: ${e.message}`);
  }
}

// After ANY restore: reconcile the area catalog with the in-memory presets and
// re-home legacy global state (flags/follows/mutes/orphan areas/notifications)
// to the admin. Idempotent — handles importing an old pre-multi-user backup as
// well as a new bundle that already carries the per-user tables.
function rehomeAfterRestore() {
  try {
    // A restore replaced the users table with the backup's. Guarantee the built-in
    // admin still exists (an older backup may predate the users schema, or carry a
    // different admin set), so the instance is never left with no known login.
    db.seedDefaultAdmin({ username: DEFAULT_ADMIN_USERNAME, email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD });
    const admin = db.findUserByLogin(DEFAULT_ADMIN_USERNAME);
    syncAreasWithDb(admin ? admin.id : null);
    if (admin) db.migrateMultiUser(admin.id);
  } catch (e) {
    console.error(`[RESTORE] Re-home multi-utente fallito: ${e.message}`);
  }
}

// A DB restore also replaces the sessions table, so the operator who launched the
// restore loses their session and would be locked out until the next login. Mint a
// fresh session (as themselves if their account survived the restore, else as the
// re-seeded admin) and set the cookie so they stay authenticated.
function reissueSession(req, res) {
  try {
    const uname = req.realUser && req.realUser.username;
    let u = uname ? db.findUserByLogin(uname) : null;
    if (!u || u.role !== 'admin') u = db.findUserByLogin(DEFAULT_ADMIN_USERNAME);
    if (!u) return;
    const sid = db.createSession(u.id, {
      ttlMs: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    setSessionCookie(res, sid);
  } catch (e) {
    console.error(`[RESTORE] Riemissione sessione fallita: ${e.message}`);
  }
}

function startAutoBackup() {
  setTimeout(() => {
    try {
      const r = createAndSaveBundle('auto');
      console.log('[BACKUP] Auto-backup iniziale creato');
      appLog.info('BACKUP', appLog.t('backup.auto_initial'), { file: r.filename, sizeKB: Math.round(r.size / 1024) });
    } catch (e) {
      console.error(`[BACKUP] Auto-backup iniziale fallito: ${e.message}`);
      appLog.error('BACKUP', appLog.t('backup.auto_initial_failed', { error: e.message }));
    }
  }, 30000);

  setInterval(() => {
    try {
      const r = createAndSaveBundle('auto');
      console.log('[BACKUP] Auto-backup creato');
      appLog.info('BACKUP', appLog.t('backup.auto_created'), { file: r.filename, sizeKB: Math.round(r.size / 1024) });
    } catch (e) {
      console.error(`[BACKUP] Auto-backup fallito: ${e.message}`);
      appLog.error('BACKUP', appLog.t('backup.auto_failed', { error: e.message }));
    }
  }, BACKUP_INTERVAL_MS);
}

// Stream a ZIP of one CSV per AIS message type. Each row merges the flat
// reading columns with the flattened raw AIS payload for that type.
router.get('/export', (req, res) => {
  const types = db.getDistinctTypes();
  if (types.length === 0) {
    return res.status(404).json({ error: 'No data to export' });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="tracker-porti-export-${ts}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  for (const type of types) {
    const rows = db.getAllByType(type);
    if (rows.length === 0) continue;

    const allKeys = new Set();
    const parsed = rows.map((r) => {
      const base = {
        id: r.id,
        received_at: r.received_at,
        message_type: r.message_type,
        mmsi: r.mmsi,
        ship_name: r.ship_name,
        latitude: r.latitude,
        longitude: r.longitude,
        navigational_status: r.navigational_status,
        sog: r.sog,
        cog: r.cog,
        true_heading: r.true_heading,
      };
      try {
        const raw = JSON.parse(r.raw_json);
        const msgData = raw.Message?.[type] || {};
        const flat = flattenObject(msgData, '');
        Object.assign(base, flat);
      } catch {
        /* keep base columns only if raw payload is unparseable */
      }
      Object.keys(base).forEach((k) => allKeys.add(k));
      return base;
    });

    const headers = Array.from(allKeys);
    const csvLines = [
      headers.map((h) => csvEscape(h)).join(','),
      ...parsed.map((row) => headers.map((h) => csvEscape(row[h] ?? '')).join(',')),
    ];

    archive.append(csvLines.join('\n'), { name: `${type}.csv` });
  }

  archive.finalize();
});

// Download a consistent snapshot of the whole SQLite database (single .db file).
router.get('/backup', (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmp = path.join(os.tmpdir(), `tracker-porti-backup-${ts}-${process.pid}.db`);
  try {
    db.backupTo(tmp);
  } catch (e) {
    return res.status(500).json({ error: `Backup fallito: ${e.message}` });
  }
  res.download(tmp, `tracker-porti-backup-${ts}.db`, (err) => {
    fs.unlink(tmp, () => {});
    if (err && !res.headersSent) res.status(500).end();
  });
});

// Replace the whole database with an uploaded backup (.db) file.
// The raw file is sent as the request body (application/octet-stream).
router.post('/restore', express.raw({ type: () => true, limit: UPLOAD_LIMIT }), (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'Nessun file ricevuto' });
  }
  // SQLite files start with the 16-byte magic header "SQLite format 3\0".
  if (req.body.slice(0, 15).toString('latin1') !== 'SQLite format 3') {
    return res.status(400).json({ error: 'Il file caricato non è un database SQLite valido' });
  }

  const tmp = path.join(os.tmpdir(), `tracker-porti-restore-${process.pid}-${req.body.length}.db`);
  try {
    fs.writeFileSync(tmp, req.body);
    const counts = db.restoreFrom(tmp);
    // Righe importate da un DB pre-multi-area arrivano con area='' (default
    // colonna). Assegna l'area per coordinate (fallback area corrente) e
    // riconcilia eventuali righe mal-taggate, come fa l'avvio del server.
    db.tagLegacyArea(state.preset, areaForPoint);
    db.reconcileAreasByCoords(areaForPoint);
    db.setMeta('areas_sig', bboxSignature()); // reconciled now; skip the startup sweep
    rebuildBerthsAfterRestore(counts);
    rehomeAfterRestore();
    reissueSession(req, res);
    // Reconcile live streams to the just-restored active set (start/stop so only
    // the monitorings active in the backup run).
    const resumed = stream.resumeActiveStreams({ defaultArea: state.preset });
    appLog.info('AIS', appLog.t('ais.streams_resumed', { count: resumed.length }), { count: resumed.length, aree: resumed });
    const total = Object.values(counts || {}).reduce((a, b) => a + b, 0);
    appLog.info('RESTORE', appLog.t('restore.db_from_upload'), { righe: total });
    res.json({ ok: true, counts });
  } catch (e) {
    appLog.error('RESTORE', appLog.t('restore.db_failed', { error: e.message }));
    res.status(400).json({ error: `Ripristino fallito: ${e.message}` });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

// ── Full bundle (database + areas + settings) ─────────────────────────────────
// One self-contained file holding everything needed to recreate the app's state:
// the SQLite database, the area definitions and the settings toggles. Format v2
// is a streaming binary container (see writeBundleFileSync) so the multi-MB DB
// never enters the heap. Re-importable via POST /bundle/import (also reads the
// legacy v1 JSON-base64 bundles).

// Download the full bundle.
router.get('/bundle', (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmpBundle = path.join(os.tmpdir(), `tracker-porti-bundle-${ts}-${process.pid}.tpbk`);
  try {
    writeBundle(tmpBundle, null); // v3: main DB + heatmap DB, streamed
  } catch (e) {
    fs.unlink(tmpBundle, () => {});
    return res.status(500).json({ error: `Esportazione fallita: ${e.message}` });
  }
  res.download(tmpBundle, `tracker-porti-bundle-${ts}.tpbk`, (err) => {
    fs.unlink(tmpBundle, () => {});
    if (err && !res.headersSent) res.status(500).end();
  });
});

// Restore a full bundle: replaces the database, merges the areas and applies the
// settings. The raw file is sent as the request body (large: contains the whole
// DB), so it bypasses the global express.json() size limit. The upload is spooled
// to disk and the DB is streamed out of it — never base64-decoded into the heap.
router.post('/bundle/import', express.raw({ type: () => true, limit: UPLOAD_LIMIT }), (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'Nessun file ricevuto' });
  }

  const tmpBundle = path.join(os.tmpdir(), `tracker-porti-bundle-upload-${process.pid}.tpbk`);
  const tmpDb = path.join(os.tmpdir(), `tracker-porti-bundle-restore-${process.pid}.db`);
  try {
    fs.writeFileSync(tmpBundle, req.body);
    let head;
    try {
      head = readBundleHead(tmpBundle);
    } catch {
      return res.status(400).json({ error: 'File non valido: non è un backup completo di tracker-porti' });
    }
    const payload = head.payload || {};

    extractBundleDb(tmpBundle, head, tmpDb);
    const counts = db.restoreFrom(tmpDb);
    const heatmapCells = restoreBundleHeatmap(tmpBundle, head); // v3 only; null otherwise

    let areas = null;
    if (payload.areas) {
      try {
        areas = importAreasAndStart(payload.areas);
      } catch (e) {
        console.error(`[BUNDLE] Import aree fallito: ${e.message}`);
      }
    }
    // Tag/reconcile areas only after the imported definitions exist, so legacy
    // rows can be matched against the freshly merged bounding boxes.
    db.tagLegacyArea(state.preset, areaForPoint);
    db.reconcileAreasByCoords(areaForPoint);
    db.setMeta('areas_sig', bboxSignature()); // reconciled now; skip the startup sweep

    let settings = null;
    if (payload.settings) {
      try {
        settings = applyImportedSettings(payload.settings);
      } catch (e) {
        console.error(`[BUNDLE] Import impostazioni fallito: ${e.message}`);
      }
    }

    rebuildBerthsAfterRestore(counts);
    rehomeAfterRestore();
    reissueSession(req, res);
    const resumed = stream.resumeActiveStreams({ defaultArea: state.preset });
    appLog.info('AIS', appLog.t('ais.streams_resumed', { count: resumed.length }), { count: resumed.length, aree: resumed });
    const total = Object.values(counts || {}).reduce((a, b) => a + b, 0);
    appLog.info('BUNDLE', appLog.t('bundle.imported'), { righe: total });
    res.json({ ok: true, counts, areas, settings, heatmapCells });
  } catch (e) {
    appLog.error('BUNDLE', appLog.t('bundle.import_failed', { error: e.message }));
    res.status(400).json({ error: `Importazione fallita: ${e.message}` });
  } finally {
    fs.unlink(tmpBundle, () => {});
    fs.unlink(tmpDb, () => {});
  }
});

// ── Auto-backup routes ────────────────────────────────────────────────────────

// List saved backups.
router.get('/backups', (req, res) => {
  res.json({ backups: listSavedBackups() });
});

// Manually trigger a bundle save to disk.
router.post('/backups/save', (req, res) => {
  try {
    const result = createAndSaveBundle('manual');
    appLog.info('BACKUP', appLog.t('backup.manual_saved'), { file: result.filename, sizeKB: Math.round(result.size / 1024) });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: `Salvataggio fallito: ${e.message}` });
  }
});

// Download a specific backup file.
router.get('/backups/:filename/download', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!/^tracker-porti-(auto|manual)backup-[\w-]+\.(tpbk|json)$/.test(filename)) {
    return res.status(400).json({ error: 'Nome file non valido' });
  }
  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup non trovato' });
  res.download(filePath, filename);
});

// Selective restore from a saved backup. Body: { parts: ['db','areas','settings'] }.
router.post('/backups/:filename/restore', express.json({ limit: '10kb' }), (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!/^tracker-porti-(auto|manual)backup-[\w-]+\.(tpbk|json)$/.test(filename)) {
    return res.status(400).json({ error: 'Nome file non valido' });
  }
  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup non trovato' });

  const parts = req.body?.parts;
  const VALID = new Set(['db', 'areas', 'settings']);
  if (!Array.isArray(parts) || parts.length === 0 || !parts.every((p) => VALID.has(p))) {
    return res.status(400).json({ error: 'Parti non valide. Usa: db, areas, settings' });
  }

  let head;
  try {
    head = readBundleHead(filePath);
  } catch (e) {
    return res.status(400).json({ error: `File non leggibile: ${e.message}` });
  }
  const payload = head.payload || {};

  const tmp = path.join(os.tmpdir(), `tracker-porti-backup-restore-${process.pid}.db`);
  try {
    let counts = null;
    let areas = null;
    let settings = null;

    let heatmapCells = null;
    if (parts.includes('db')) {
      extractBundleDb(filePath, head, tmp);
      counts = db.restoreFrom(tmp);
      heatmapCells = restoreBundleHeatmap(filePath, head); // heatmap rides with the db part
    }

    if (parts.includes('areas') && payload.areas) {
      try { areas = importAreasAndStart(payload.areas); } catch (e) {
        console.error(`[BACKUP] Import aree: ${e.message}`);
      }
    }

    if (parts.includes('db') || parts.includes('areas')) {
      db.tagLegacyArea(state.preset, areaForPoint);
      db.reconcileAreasByCoords(areaForPoint);
      db.setMeta('areas_sig', bboxSignature()); // reconciled now; skip the startup sweep
    }
    if (parts.includes('db')) rebuildBerthsAfterRestore(counts);
    if (parts.includes('db') || parts.includes('areas')) {
      rehomeAfterRestore();
      if (parts.includes('db')) reissueSession(req, res); // sessions table only replaced with the db part
      const resumed = stream.resumeActiveStreams({ defaultArea: state.preset });
      appLog.info('AIS', appLog.t('ais.streams_resumed', { count: resumed.length }), { count: resumed.length, aree: resumed });
    }

    if (parts.includes('settings') && payload.settings) {
      try { settings = applyImportedSettings(payload.settings); } catch (e) {
        console.error(`[BACKUP] Import impostazioni: ${e.message}`);
      }
    }

    res.json({ ok: true, counts, areas, settings, heatmapCells });
  } catch (e) {
    res.status(400).json({ error: `Ripristino fallito: ${e.message}` });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

module.exports = router;
module.exports.startAutoBackup = startAutoBackup;
module.exports.restoreDbFromLatestBackup = restoreDbFromLatestBackup;
