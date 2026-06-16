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
        cur.fields.push({ key, value, type, description: pending.join(' ') });
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
