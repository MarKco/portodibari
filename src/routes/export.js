'use strict';

const express = require('express');
const archiver = require('archiver');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const { state, areaForPoint } = require('../config');
const { flattenObject, csvEscape } = require('../lib/csv');

const router = express.Router();

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

module.exports = router;
