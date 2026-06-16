'use strict';

// ── Sanctions list matching (OFAC SDN + EU / UK / UN) ─────────────────────────
// Unlike VesselFinder/MarineTraffic enrichment (per-ship scraping), sanctions
// screening is dataset-based: each downloadable list is fetched, parsed into a
// shared in-memory index, and every ship is matched against it locally (IMO /
// name / call sign). No per-ship network call, so matching stays instant and
// robust — no scraping, no Cloudflare. Pluggable by design: every list is one
// SOURCES entry, all gated by the single `importSanctions` toggle.
//
// Lists:
//   ofac — OFAC SDN (US Treasury). Bespoke headerless CSV; vessel rows have
//          SDN_Type == "vessel" and carry the IMO inside the free-text remarks.
//   eu   — EU consolidated sanctions  (OpenSanctions eu_sanctions collection)
//   uk   — UK OFSI / FCDO sanctions   (OpenSanctions gb_fcdo_sanctions)
//   un   — UN Security Council 1718 designated vessels (OpenSanctions un_1718_vessels)
// The three non-OFAC lists share OpenSanctions' uniform "targets.simple" CSV
// (stable "latest" URL, refreshed daily upstream) — same robust file-download
// pattern already used for the Paris MoU banned list in psc.js.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { state } = require('../config');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// OpenSanctions "latest" alias — stable URL, refreshed daily upstream.
const OS = 'https://data.opensanctions.org/datasets/latest';

// Every list is one entry. `extra: true` marks the EU/UK/UN lists, which are
// gated by the importSanctionsExtra toggle (the OFAC core list always loads
// when sanctions screening is on). `parse` turns the raw file into entries of
// { name, program, callSign, flag, owner, imo, aliases, source }.
const SOURCES = {
  ofac: {
    label: 'OFAC SDN',
    url: 'https://www.treasury.gov/ofac/downloads/sdn.csv',
    file: path.join(DATA_DIR, 'ofac-sdn.csv'),
    parse: parseOfacSdn,
  },
  eu: {
    label: 'EU Consolidated',
    extra: true,
    url: `${OS}/eu_sanctions/targets.simple.csv`,
    file: path.join(DATA_DIR, 'eu-sanctions.csv'),
    parse: (t) => parseOpenSanctions(t, 'EU Consolidated'),
  },
  uk: {
    label: 'UK OFSI',
    extra: true,
    url: `${OS}/gb_fcdo_sanctions/targets.simple.csv`,
    file: path.join(DATA_DIR, 'uk-sanctions.csv'),
    parse: (t) => parseOpenSanctions(t, 'UK OFSI'),
  },
  un: {
    label: 'UN Security Council',
    extra: true,
    url: `${OS}/un_1718_vessels/targets.simple.csv`,
    file: path.join(DATA_DIR, 'un-sanctions.csv'),
    parse: (t) => parseOpenSanctions(t, 'UN Security Council'),
  },
};

/** Which source keys are active right now: OFAC always, the extra lists only
 *  while the importSanctionsExtra toggle is on. */
function activeKeys() {
  return Object.entries(SOURCES)
    .filter(([, src]) => !src.extra || state.importSanctionsExtra)
    .map(([key]) => key);
}

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

// OpenSanctions "targets.simple" CSV (with header). Vessel entities carry the
// IMO inside the semicolon-joined `identifiers` field; `program_ids` holds the
// sanctions programme code (EU-MARE, GB-RUS, UN-SC1718), with the free-text
// `sanctions` column as a fallback. `countries` are ISO-2 flag codes.
//   id,schema,name,aliases,birth_date,countries,addresses,identifiers,
//   sanctions,phones,emails,program_ids,dataset,first_seen,last_seen,last_change
function parseOpenSanctions(text, label) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iSchema = col('schema');
  const iName = col('name');
  const iAliases = col('aliases');
  const iCountries = col('countries');
  const iIdent = col('identifiers');
  const iProgram = col('program_ids');
  const iSanctions = col('sanctions');
  const entries = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    if ((cols[iSchema] || '').trim().toLowerCase() !== 'vessel') continue;
    const imo = (cols[iIdent] || '').match(/IMO\s*0*(\d{6,7})/i)?.[1] || null;
    const aliases = (cols[iAliases] || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean);
    entries.push({
      name: (cols[iName] || '').trim() || null,
      program: (cols[iProgram] || '').trim() || (cols[iSanctions] || '').trim() || null,
      callSign: null,
      flag: (cols[iCountries] || '').trim() || null,
      owner: null,
      imo,
      aliases,
      source: label,
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
  for (const key of Object.keys(meta)) delete meta[key]; // drop stale (e.g. disabled) sources
  const all = [];
  for (const key of activeKeys()) {
    const src = SOURCES[key];
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
  const keys = only ? [only] : activeKeys();
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

/** Dataset status for the settings UI. `loaded` = the index has any entries.
 *  `sources` is the per-list breakdown; `vesselCount` sums loaded entries across
 *  lists and `lastRefreshed` is the most recent successful download. */
function getStatus() {
  const sources = activeKeys().map((key) => {
    const m = meta[key] || { vesselCount: 0, lastRefreshed: null };
    return { key, label: SOURCES[key].label, vesselCount: m.vesselCount, lastRefreshed: m.lastRefreshed };
  });
  const vesselCount = sources.reduce((sum, s) => sum + s.vesselCount, 0);
  const lastRefreshed = sources.map((s) => s.lastRefreshed).filter(Boolean).sort().pop() || null;
  return {
    loaded: index.byImo.size > 0,
    vesselCount,
    lastRefreshed,
    source: sources.map((s) => s.label).join(', '),
    sources,
  };
}

module.exports = { loadFromDisk, refresh, matchShip, getStatus };
