'use strict';

const express = require('express');
const archiver = require('archiver');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const { state, areaForPoint, exportAreas } = require('../config');
const { flattenObject, csvEscape } = require('../lib/csv');
const { importAreasAndStart } = require('./areas');
const { exportSettings, applyImportedSettings } = require('./settings');

const router = express.Router();

const BUNDLE_FORMAT = 'tracker-porti-bundle';

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
router.post('/restore', express.raw({ type: () => true, limit: '1024mb' }), (req, res) => {
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
    res.json({ ok: true, counts });
  } catch (e) {
    res.status(400).json({ error: `Ripristino fallito: ${e.message}` });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

// ── Full bundle (database + areas + settings) ─────────────────────────────────
// One self-contained JSON file holding everything needed to recreate the app's
// state: the SQLite database (base64), the area definitions and the settings
// toggles. Re-importable via POST /bundle/import.

// Download the full bundle.
router.get('/bundle', (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmp = path.join(os.tmpdir(), `tracker-porti-bundle-${ts}-${process.pid}.db`);
  try {
    db.backupTo(tmp);
    const dbB64 = fs.readFileSync(tmp).toString('base64');
    const bundle = {
      format: BUNDLE_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      areas: exportAreas(),
      settings: exportSettings(),
      db: dbB64,
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="tracker-porti-bundle-${ts}.json"`);
    res.send(JSON.stringify(bundle));
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: `Esportazione fallita: ${e.message}` });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

// Restore a full bundle: replaces the database, merges the areas and applies the
// settings. The raw JSON file is sent as the request body (large: contains the
// base64 database), so it bypasses the global express.json() size limit.
router.post('/bundle/import', express.raw({ type: () => true, limit: '1024mb' }), (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'Nessun file ricevuto' });
  }
  let bundle;
  try {
    bundle = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'File non valido: JSON non leggibile' });
  }
  if (!bundle || bundle.format !== BUNDLE_FORMAT || !bundle.db) {
    return res.status(400).json({ error: 'File non valido: non è un backup completo di tracker-porti' });
  }

  const tmp = path.join(os.tmpdir(), `tracker-porti-bundle-restore-${process.pid}.db`);
  try {
    const buf = Buffer.from(bundle.db, 'base64');
    if (buf.slice(0, 15).toString('latin1') !== 'SQLite format 3') {
      return res.status(400).json({ error: 'Database nel backup non valido' });
    }
    fs.writeFileSync(tmp, buf);
    const counts = db.restoreFrom(tmp);

    let areas = null;
    if (bundle.areas) {
      try {
        areas = importAreasAndStart(bundle.areas);
      } catch (e) {
        console.error(`[BUNDLE] Import aree fallito: ${e.message}`);
      }
    }
    // Tag/reconcile areas only after the imported definitions exist, so legacy
    // rows can be matched against the freshly merged bounding boxes.
    db.tagLegacyArea(state.preset, areaForPoint);
    db.reconcileAreasByCoords(areaForPoint);

    let settings = null;
    if (bundle.settings) {
      try {
        settings = applyImportedSettings(bundle.settings);
      } catch (e) {
        console.error(`[BUNDLE] Import impostazioni fallito: ${e.message}`);
      }
    }

    res.json({ ok: true, counts, areas, settings });
  } catch (e) {
    res.status(400).json({ error: `Importazione fallita: ${e.message}` });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

module.exports = router;
