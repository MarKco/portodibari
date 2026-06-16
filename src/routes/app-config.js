'use strict';

// Read/write the operating parameters in app.config.properties from the UI.
//
// The form is built directly from the file itself: section headers (`# ── X ──`)
// become groups and the comment line(s) above each `KEY=value` become the
// field's description — so the UI documentation always matches the file and
// never duplicates it. Only keys ALREADY present in the file can be written
// (no new keys injected). These values are read once at server startup, so a
// change only takes effect after a RESTART — the UI states this clearly.

const express = require('express');
const fs = require('fs');
const { APP_CONFIG_FILE, saveAppProperty } = require('../config');

const router = express.Router();

const KEY_RE = /^[A-Z0-9_]+$/;

// Unit of measure shown next to each value (outside the input box). Exact-key
// map first, then a suffix-based fallback so future keys get a sensible unit.
const UNITS = {
  SOG_FERMA_KN: 'kn',
  STILL_RADIUS_M: 'm',
  ACTIVE_WINDOW_HOURS: 'ore',
  PORT_WINDOW_HOURS: 'ore',
  RECONNECT_DELAY_MS: 'ms',
  POLL_INTERVAL_MS: 'ms',
  TRACK_MERGE_RADIUS_M: 'm',
  TRACK_DEFAULT_LIMIT: 'punti',
  TRACK_MAX_LIMIT: 'punti',
  MAX_READINGS_PER_TYPE: 'record',
  MAX_API_LOG_RECORDS: 'record',
  SCRAPE_CACHE_TTL_HOURS: 'ore',
  MAX_BODY_BYTES: 'byte',
  NOTIF_DELETE_UNDO_SECONDS: 's',
  BACKUP_INTERVAL_MIN: 'min',
  BERTH_CLUSTER_EPS_M: 'm',
  BERTH_MIN_PTS: 'attracchi',
  BERTH_MIN_MOORINGS: 'attracchi',
  BERTH_DOMINANT_PCT: '%',
  BERTH_RECOMPUTE_MIN: 'min',
  RISK_DARK_MAX: 'punti',
  RISK_DARK_MIN_H: 'ore',
  RISK_DARK_MAX_H: 'ore',
  RISK_DARK_PARTIAL_MIN: 'punti',
  RISK_SPOOFING_MAX: 'punti',
  RISK_SPOOF_ANOMALOUS_POINTS: 'punti',
  RISK_SPOOF_IMPOSSIBLE_KN: 'kn',
  RISK_SPOOF_ANOMALOUS_KN: 'kn',
  RISK_LOITERING_MAX: 'punti',
  RISK_LOITERING_PARTIAL: 'punti',
  RISK_LOITERING_MIN_POSITIONS: 'posizioni',
  RISK_LOITERING_FAR_KM: 'km',
  RISK_DRAUGHT_MAX: 'punti',
  RISK_DRAUGHT_FACTOR: 'punti/m',
  RISK_DRAUGHT_MIN_DELTA_M: 'm',
  RISK_DEST_MAX: 'punti',
  RISK_DEST_PER_CHANGE: 'punti',
  RISK_HAZMAT_POINTS: 'punti',
  RISK_CARGO_POINTS: 'punti',
  RISK_NAME_HOPPING_POINTS: 'punti',
  RISK_EMBARGO_FLAG_POINTS: 'punti',
  RISK_FOC_FLAG_POINTS: 'punti',
  RISK_OLD_VESSEL_POINTS: 'punti',
  RISK_HIGH_RISK_HOMEPORT_POINTS: 'punti',
  RISK_SANCTION_MATCH_POINTS: 'punti',
  RISK_OLD_VESSEL_MIN_AGE: 'anni',
  RISK_PSC_BLACK_FLAG_POINTS: 'punti',
  RISK_PSC_GREY_FLAG_POINTS: 'punti',
  RISK_PSC_BANNED_POINTS: 'punti',
  RISK_MULT_HIGH_RISK: '× (moltipl.)',
  RISK_MULT_FOC: '× (moltipl.)',
};

function unitFor(key) {
  if (UNITS[key]) return UNITS[key];
  if (/_KN$/.test(key)) return 'kn';
  if (/_KM$/.test(key)) return 'km';
  if (/_(M|RADIUS_M|DELTA_M)$/.test(key)) return 'm';
  if (/_MS$/.test(key)) return 'ms';
  if (/_(HOURS|_H)$/.test(key)) return 'ore';
  if (/_MIN$/.test(key)) return 'min';
  if (/_SECONDS$/.test(key)) return 's';
  if (/_PCT$/.test(key)) return '%';
  if (/_BYTES$/.test(key)) return 'byte';
  if (/_POINTS$/.test(key)) return 'punti';
  if (/_AGE$/.test(key)) return 'anni';
  return '';
}

function readFileText() {
  return fs.existsSync(APP_CONFIG_FILE) ? fs.readFileSync(APP_CONFIG_FILE, 'utf8') : '';
}

// Parse the properties file into ordered groups of fields, attaching the
// preceding comment block to each key as its human description.
function parseGroups(text) {
  const groups = [];
  let cur = { title: null, fields: [] };
  let pending = [];
  const flush = () => {
    if (cur.fields.length) groups.push(cur);
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();

    if (trimmed === '') {
      pending = [];
      continue;
    }

    if (trimmed.startsWith('#')) {
      const body = trimmed.replace(/^#+/, '').trim();
      const section = body.match(/^[─=]+\s*(.+?)\s*[─=]+$/);
      if (section && /[A-Za-zÀ-ÿ]/.test(section[1])) {
        flush();
        cur = { title: section[1], fields: [] };
        pending = [];
      } else if (!/^[─=\s]*$/.test(body)) {
        pending.push(body); // real description text
      }
      continue;
    }

    const eq = line.indexOf('=');
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      if (KEY_RE.test(key)) {
        const value = line.slice(eq + 1).trim();
        const type = value === 'true' || value === 'false' ? 'bool' : 'number';
        cur.fields.push({
          key,
          value,
          type,
          description: pending.join(' '),
          unit: type === 'bool' ? '' : unitFor(key),
        });
      }
    }
    pending = [];
  }
  flush();
  return groups;
}

// Current value + inferred type for a single key, read fresh from the file.
function readKey(text, key) {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) return null;
  const value = m[1].trim();
  return { value, type: value === 'true' || value === 'false' ? 'bool' : 'number' };
}

// GET — the whole parameter set, grouped, with descriptions taken from the file.
router.get('/app-config', (req, res) => {
  try {
    res.json({ groups: parseGroups(readFileText()), applies: 'restart' });
  } catch (e) {
    res.status(500).json({ error: `Lettura configurazione fallita: ${e.message}` });
  }
});

// POST — persist edited values. Body: { values: { KEY: value, ... } }. Only keys
// already present in the file are accepted; values are validated by their
// current type. Returns the list of keys actually changed.
router.post('/app-config', (req, res) => {
  const values = req.body && req.body.values;
  if (!values || typeof values !== 'object') {
    return res
      .status(400)
      .json({ error: 'Corpo non valido: atteso { values: { CHIAVE: valore } }' });
  }

  const text = readFileText();
  const changed = [];
  try {
    for (const [key, rawVal] of Object.entries(values)) {
      if (!KEY_RE.test(key)) throw new Error(`Chiave non valida: ${key}`);
      const cur = readKey(text, key);
      if (!cur) throw new Error(`Chiave sconosciuta: ${key}`);

      let out;
      if (cur.type === 'bool') {
        const v = typeof rawVal === 'boolean' ? rawVal : String(rawVal).trim().toLowerCase();
        if (v === true || v === 'true') out = 'true';
        else if (v === false || v === 'false') out = 'false';
        else throw new Error(`${key}: atteso true/false`);
      } else {
        const n = Number(rawVal);
        if (!Number.isFinite(n)) throw new Error(`${key}: valore numerico non valido`);
        out = String(n);
      }

      if (out !== cur.value) {
        saveAppProperty(key, out);
        changed.push(key);
      }
    }
    res.json({ ok: true, changed, restart: changed.length > 0 });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
