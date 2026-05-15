'use strict';

// ── Sanctions list matching (OFAC SDN) ───────────────────────────────────────
// Unlike VesselFinder/MarineTraffic enrichment (per-ship scraping), sanctions
// screening is dataset-based: one downloadable list is fetched, parsed into an
// in-memory index, and every ship is matched against it locally (IMO / name /
// call sign). No per-ship network call, so matching stays instant and robust —
// no scraping, no Cloudflare. Architected pluggable: more lists (UK OFSI, EU,
// UN) can register additional SOURCES entries later on the same schema.
//
// Primary list: OFAC SDN (US Treasury). The CSV has no header; vessel rows have
// SDN_Type == "vessel" and carry the IMO inside the free-text remarks field.

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

const SOURCES = {
  ofac: {
    label: 'OFAC SDN',
    url: 'https://www.treasury.gov/ofac/downloads/sdn.csv',
    file: path.join(DATA_DIR, 'ofac-sdn.csv'),
    parse: parseOfacSdn,
  },
};

// In-memory index, rebuilt from disk on load / after each refresh.
//   byImo / byCallSign / byName : Map(key -> entry)   entry = { name, program,
//   source, flag, owner, imo, aliases }
const index = { byImo: new Map(), byCallSign: new Map(), byName: new Map() };
const meta = {}; // source key -> { vesselCount, lastRefreshed }

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Download a URL over HTTPS following redirects, resolving to the body text. */
function download(url, depth = 0) {
  if (depth > 4) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', 'Accept-Encoding': 'identity' },
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          download(new URL(res.headers.location, url).href, depth + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

/** Parse CSV text into rows of string fields, honouring "" escaping and quoted
 *  commas/newlines. OFAC marks empty fields with the literal `-0-`. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const clean = (v) => {
  const s = (v || '').trim();
  return s === '-0-' || s === '' ? null : s;
};

/** UPPERCASE, alphanumerics only — used for forgiving name/call-sign matching. */
function normalize(s) {
  return (s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

// OFAC SDN columns (no header):
// 0 ent_num | 1 name | 2 type | 3 program | 4 title | 5 call_sign |
// 6 vessel_type | 7 tonnage | 8 grt | 9 flag | 10 owner | 11 remarks
function parseOfacSdn(text) {
  const entries = [];
  for (const cols of parseCsv(text)) {
    if (cols.length < 4) continue;
    if ((cols[2] || '').trim().toLowerCase() !== 'vessel') continue;
    const remarks = clean(cols[11]) || '';
    const imo = remarks.match(/IMO\s+(\d{7})/i)?.[1] || null;
    // Aliases declared inside remarks as a.k.a. / f.k.a. 'NAME'
    const aliases = [];
    const aliasRe = /[af]\.k\.a\.\s+'([^']+)'/gi;
    let m;
    while ((m = aliasRe.exec(remarks)) !== null) aliases.push(m[1]);
    entries.push({
      name: clean(cols[1]),
      program: clean(cols[3]),
      callSign: clean(cols[5]),
      flag: clean(cols[9]),
      owner: clean(cols[10]),
      imo,
      aliases,
      source: 'OFAC SDN',
    });
  }
  return entries;
}

/** Insert one parsed entry into the shared lookup index (first writer wins). */
function indexEntry(e) {
  if (e.imo) index.byImo.set(e.imo, e);
  if (e.callSign) {
    const k = normalize(e.callSign);
    if (k.length >= 3 && !index.byCallSign.has(k)) index.byCallSign.set(k, e);
  }
  for (const name of [e.name, ...e.aliases]) {
    const k = normalize(name);
    if (k.length >= 3 && !index.byName.has(k)) index.byName.set(k, e);
  }
}

function rebuildIndex(allEntries) {
  index.byImo.clear();
  index.byCallSign.clear();
  index.byName.clear();
  for (const e of allEntries) indexEntry(e);
}

/** Load every source's cached file from disk and (re)build the index. Safe to
 *  call at startup with no network — sources with no cached file are skipped. */
function loadFromDisk() {
  const all = [];
  for (const [key, src] of Object.entries(SOURCES)) {
    if (!fs.existsSync(src.file)) continue;
    try {
      const entries = src.parse(fs.readFileSync(src.file, 'utf8'));
      all.push(...entries);
      meta[key] = { vesselCount: entries.length, lastRefreshed: fs.statSync(src.file).mtime.toISOString() };
    } catch (e) {
      console.error(`[SANCTIONS:${key}] parse cached file failed: ${e.message}`);
    }
  }
  rebuildIndex(all);
  const total = index.byImo.size;
  if (total) console.log(`[SANCTIONS] Loaded ${total} listed vessels (by IMO) from cache`);
  return total;
}

/** Download the named source (default: all), persist to disk, rebuild index.
 *  Returns { ok, vesselCount } per source. */
async function refresh(only) {
  const keys = only ? [only] : Object.keys(SOURCES);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const key of keys) {
    const src = SOURCES[key];
    if (!src) continue;
    try {
      console.log(`[SANCTIONS:${key}] Refreshing from ${src.url}`);
      const body = await download(src.url);
      // Sanity check before overwriting the cache with garbage.
      const entries = src.parse(body);
      if (!entries.length) throw new Error('no vessel rows parsed');
      fs.writeFileSync(src.file, body, 'utf8');
      console.log(`[SANCTIONS:${key}] Saved ${entries.length} listed vessels`);
    } catch (e) {
      console.error(`[SANCTIONS:${key}] Refresh failed: ${e.message}`);
    }
  }
  return loadFromDisk();
}

/**
 * Match a ship against the loaded sanctions index. Strongest key first:
 * IMO (exact, near-certain) → call sign → normalized hull name. Returns
 * { entry, matchedOn } or null when not listed / index empty.
 */
function matchShip(ship) {
  if (!ship) return null;
  if (ship.imo_number) {
    const e = index.byImo.get(String(ship.imo_number));
    if (e) return { entry: e, matchedOn: 'imo' };
  }
  if (ship.call_sign) {
    const e = index.byCallSign.get(normalize(ship.call_sign));
    if (e) return { entry: e, matchedOn: 'callSign' };
  }
  const nk = normalize(ship.ship_name);
  if (nk.length >= 3) {
    const e = index.byName.get(nk);
    if (e) return { entry: e, matchedOn: 'name' };
  }
  return null;
}

/** Dataset status for the settings UI. `loaded` = the index has any entries. */
function getStatus() {
  const ofac = meta.ofac || { vesselCount: 0, lastRefreshed: null };
  return {
    loaded: index.byImo.size > 0,
    vesselCount: ofac.vesselCount,
    lastRefreshed: ofac.lastRefreshed,
    source: SOURCES.ofac.label,
  };
}

module.exports = { loadFromDisk, refresh, matchShip, getStatus };
