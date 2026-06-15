'use strict';

// Append-only audit log of every Equasis lookup. Equasis is a manual, on-demand
// query against an external account, so we keep a plain-text trail of what was
// requested and what came back — handy to review past lookups without re-hitting
// Equasis (and as a record of which IMOs were queried). Viewable from Settings.

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', '..', 'equasis.log');
// Cap what we read back to the client so a long-lived log can't blow up the UI.
const MAX_READ_BYTES = 256 * 1024;

// Append one lookup outcome. `ok` lookups serialize the retrieved data
// (management + particulars); failures record the error message instead.
function append({ mmsi, imo, name, ok, data, error }) {
  const ts = new Date().toISOString();
  const head = `[${ts}] mmsi=${mmsi ?? '—'} imo=${imo ?? '—'} name=${name || '—'} → ${ok ? 'OK' : 'ERROR'}`;
  let block = head + '\n';
  if (ok) {
    const mgmt = (data && data.management) || [];
    const particulars = (data && data.particulars) || {};
    for (const m of mgmt) {
      block += `    ${m.role}: ${m.company}`;
      if (m.address) block += ` | ${m.address}`;
      if (m.date) block += ` | ${m.date}`;
      block += '\n';
    }
    for (const [k, v] of Object.entries(particulars)) {
      block += `    ${k}: ${v}\n`;
    }
    if (!mgmt.length && !Object.keys(particulars).length) block += '    (no data)\n';
  } else {
    block += `    ${error || 'unknown error'}\n`;
  }
  block += '\n';
  try {
    fs.appendFileSync(LOG_FILE, block, 'utf8');
  } catch (e) {
    console.error(`[EQUASIS] Log write failed: ${e.message}`);
  }
}

// Return the log as text (tail-truncated to MAX_READ_BYTES). Empty string if
// nothing has been logged yet.
function read() {
  try {
    const stat = fs.statSync(LOG_FILE);
    const start = Math.max(0, stat.size - MAX_READ_BYTES);
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      let text = buf.toString('utf8');
      // If we truncated mid-file, drop the partial first line.
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      return { text, truncated: start > 0, size: stat.size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: '', truncated: false, size: 0 };
  }
}

function clear() {
  try {
    fs.unlinkSync(LOG_FILE);
  } catch {
    /* already absent */
  }
}

module.exports = { append, read, clear, LOG_FILE };
