'use strict';

// Human-readable operational log, separate from the API log (api_log table).
//
// Records significant application events (stream lifecycle, scraping, sanctions
// / PSC refreshes, backup/restore, settings changes, errors) as NDJSON lines in
// data/app.log. Each line is one JSON object: { ts, level, tag, msg, data? }.
//
// - Size-based rotation: when app.log passes MAX_BYTES it is renamed to
//   app.log.1 (the previous .1 is discarded) and a fresh app.log is started, so
//   the on-disk footprint stays bounded (~2× MAX_BYTES) and the oldest lines
//   drop off automatically.
// - Live streaming: every entry is broadcast to connected SSE clients so the
//   in-app viewers (settings tab + floating overlay) can tail it in real time.
// - Each entry is also echoed to the process stdout/stderr, preserving the
//   terminal output that existed before this module.
// - Can be disabled at runtime; while disabled nothing is written to file or
//   streamed (only the console echo remains).

const fs = require('fs');
const path = require('path');
const { broadcastAppLog } = require('../realtime');

const LOG_DIR = path.join(__dirname, '..', '..', 'data');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const ROTATED_FILE = path.join(LOG_DIR, 'app.log.1');
const MAX_BYTES = 5 * 1024 * 1024; // rotate at ~5 MB
const MAX_DATA_CHARS = 600; // cap per-entry context so lines stay small
const TAIL_DEFAULT = 1000;
const TAIL_MAX = 4000;

let enabled = true;
let currentSize = 0;
try {
  currentSize = fs.statSync(LOG_FILE).size;
} catch {
  /* file not created yet */
}

function setEnabled(v) {
  enabled = !!v;
}
function isEnabled() {
  return enabled;
}

// Serialize the optional context object, guarding against cycles and bloat.
function serializeData(data) {
  if (data === undefined || data === null) return undefined;
  let s;
  try {
    s = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    s = String(data);
  }
  if (s.length > MAX_DATA_CHARS) s = s.slice(0, MAX_DATA_CHARS) + '…';
  return s;
}

function rotateIfNeeded(lineBytes) {
  if (currentSize + lineBytes <= MAX_BYTES) return;
  try {
    fs.renameSync(LOG_FILE, ROTATED_FILE); // replaces any previous .1
  } catch {
    /* if rename fails (e.g. file absent), just continue appending */
  }
  currentSize = 0;
}

function consoleEcho(level, tag, msg, dataStr) {
  const line = `[${tag}] ${msg}${dataStr ? ` ${dataStr}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Record one entry. `tag` is a short subsystem label (e.g. 'AIS', 'BACKUP'),
 * `msg` a concise human-readable message, `data` an optional small context
 * object. Never throws — logging must not break the operation it describes.
 */
function record(level, tag, msg, data) {
  const dataStr = serializeData(data);
  consoleEcho(level, tag, msg, dataStr);
  if (!enabled) return;

  const entry = { ts: new Date().toISOString(), level, tag, msg };
  if (dataStr !== undefined) entry.data = dataStr;

  try {
    const line = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(line);
    rotateIfNeeded(bytes);
    fs.appendFileSync(LOG_FILE, line);
    currentSize += bytes;
  } catch {
    /* disk error — keep the app running, drop the file write */
  }

  broadcastAppLog(entry);
}

const info = (tag, msg, data) => record('info', tag, msg, data);
const warn = (tag, msg, data) => record('warn', tag, msg, data);
const error = (tag, msg, data) => record('error', tag, msg, data);

// Read the most recent `limit` entries (oldest → newest), spanning the rotated
// file when the current one is short. Malformed lines are skipped.
function tail(limit = TAIL_DEFAULT) {
  const n = Math.min(Math.max(1, limit | 0), TAIL_MAX);
  let lines = [];
  for (const f of [ROTATED_FILE, LOG_FILE]) {
    try {
      const txt = fs.readFileSync(f, 'utf8');
      lines = lines.concat(txt.split('\n').filter(Boolean));
    } catch {
      /* file may not exist */
    }
  }
  const slice = lines.slice(-n);
  const entries = [];
  for (const l of slice) {
    try {
      entries.push(JSON.parse(l));
    } catch {
      /* skip malformed line */
    }
  }
  return entries;
}

function clear() {
  for (const f of [LOG_FILE, ROTATED_FILE]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* nothing to remove */
    }
  }
  currentSize = 0;
}

module.exports = { record, info, warn, error, tail, clear, setEnabled, isEnabled };
