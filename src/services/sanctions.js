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
const appLog = require('./app-log');
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
    parse: (f) => parseOpenSanctions(f, 'EU Consolidated', 'eu'),
  },
  uk: {
    label: 'UK OFSI',
    extra: true,
    url: `${OS}/gb_fcdo_sanctions/targets.simple.csv`,
    file: path.join(DATA_DIR, 'uk-sanctions.csv'),
    parse: (f) => parseOpenSanctions(f, 'UK OFSI', 'uk'),
  },
  un: {
    label: 'UN Security Council',
    extra: true,
    url: `${OS}/un_1718_vessels/targets.simple.csv`,
    file: path.join(DATA_DIR, 'un-sanctions.csv'),
    parse: (f) => parseOpenSanctions(f, 'UN Security Council', 'un'),
  },
};

/** Public profile URL for a listed entity, when we captured its id.
 *  OFAC → its sanctions-search detail page (id = SDN ent_num).
 *  OpenSanctions lists (EU/UK/UN) → the entity page (id = OpenSanctions id). */
function entityUrl(entry) {
  if (!entry || !entry.entityId) return null;
  if (entry.sourceKey === 'ofac') {
    return `https://sanctionssearch.ofac.treas.gov/Details.aspx?id=${encodeURIComponent(entry.entityId)}`;
  }
  return `https://www.opensanctions.org/entities/${encodeURIComponent(entry.entityId)}/`;
}

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

/** Download a URL over HTTPS following redirects, streaming the body straight to
 *  `dest` on disk. Never buffers the whole response in memory — the EU/UK lists
 *  are several MB each and the host can run on a small (~256 MB) heap, so a
 *  string-buffered download (plus parse) was OOM-ing. Resolves when fully written. */
function downloadToFile(url, dest, depth = 0) {
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
          downloadToFile(new URL(res.headers.location, url).href, dest, depth + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const out = fs.createWriteStream(dest);
        out.on('error', reject);
        out.on('finish', () => out.close(() => resolve()));
        res.on('error', reject);
        res.pipe(out);
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

/** Stream-parse a CSV file, invoking `onRow(cols)` for each row as it completes.
 *  Quote-aware (honours "" escaping and quoted commas/newlines) and safe across
 *  read-chunk boundaries, so the whole file is never held in memory at once —
 *  only the current row. OFAC marks empty fields with the literal `-0-`.
 *  Callers keep just the rows they care about (vessels), so a multi-MB list with
 *  100k+ non-vessel entities costs near-constant memory. */
function parseCsvFile(filePath, onRow) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 16 });
    let row = [];
    let field = '';
    let inQuotes = false;
    let maybeEscape = false; // saw a '"' while inside quotes — escape or close?
    let lastWasCR = false;

    const endField = () => { row.push(field); field = ''; };
    const endRow = () => {
      endField();
      if (row.length > 1 || row[0] !== '') onRow(row);
      row = [];
    };

    function consume(c) {
      const wasCR = lastWasCR;
      lastWasCR = false;
      if (maybeEscape) {
        maybeEscape = false;
        if (c === '"') { field += '"'; return; } // doubled "" inside quotes
        inQuotes = false; // the quote closed the field — fall through to handle c
      }
      if (inQuotes) {
        if (c === '"') maybeEscape = true;
        else field += c;
        return;
      }
      if (c === '"') { inQuotes = true; return; }
      if (c === ',') { endField(); return; }
      if (c === '\n') { if (!wasCR) endRow(); return; } // \r\n already ended on the \r
      if (c === '\r') { endRow(); lastWasCR = true; return; }
      field += c;
    }

    stream.on('data', (chunk) => {
      for (const c of chunk) consume(c);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      if (maybeEscape) inQuotes = false;
      if (field !== '' || row.length) {
        row.push(field);
        if (row.length > 1 || row[0] !== '') onRow(row);
      }
      resolve();
    });
  });
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
async function parseOfacSdn(filePath) {
  const entries = [];
  await parseCsvFile(filePath, (cols) => {
    if (cols.length < 4) return;
    if ((cols[2] || '').trim().toLowerCase() !== 'vessel') return;
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
      sourceKey: 'ofac',
      entityId: clean(cols[0]),
    });
  });
  return entries;
}

// OpenSanctions "targets.simple" CSV (with header). Vessel entities carry the
// IMO inside the semicolon-joined `identifiers` field; `program_ids` holds the
// sanctions programme code (EU-MARE, GB-RUS, UN-SC1718), with the free-text
// `sanctions` column as a fallback. `countries` are ISO-2 flag codes.
//   id,schema,name,aliases,birth_date,countries,addresses,identifiers,
//   sanctions,phones,emails,program_ids,dataset,first_seen,last_seen,last_change
async function parseOpenSanctions(filePath, label, sourceKey) {
  const entries = [];
  let col = null; // resolved from the header row (first row seen)
  await parseCsvFile(filePath, (cols) => {
    if (!col) {
      const header = cols.map((h) => h.trim().toLowerCase());
      const at = (name) => header.indexOf(name);
      col = {
        id: at('id'),
        schema: at('schema'), name: at('name'), aliases: at('aliases'),
        countries: at('countries'), ident: at('identifiers'),
        program: at('program_ids'), sanctions: at('sanctions'),
      };
      return;
    }
    if ((cols[col.schema] || '').trim().toLowerCase() !== 'vessel') return;
    const imo = (cols[col.ident] || '').match(/IMO\s*0*(\d{6,7})/i)?.[1] || null;
    const aliases = (cols[col.aliases] || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean);
    entries.push({
      name: (cols[col.name] || '').trim() || null,
      program: (cols[col.program] || '').trim() || (cols[col.sanctions] || '').trim() || null,
      callSign: null,
      flag: (cols[col.countries] || '').trim() || null,
      owner: null,
      imo,
      aliases,
      source: label,
      sourceKey,
      entityId: col.id >= 0 ? ((cols[col.id] || '').trim() || null) : null,
    });
  });
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

/** Load every source's cached file from disk and (re)build the index. Safe to
 *  call at startup with no network — sources with no cached file are skipped. */
async function loadFromDisk() {
  for (const key of Object.keys(meta)) delete meta[key]; // drop stale (e.g. disabled) sources
  // Index incrementally and discard each source's entries afterwards, so only
  // the (small) vessel index is retained — never every list's rows at once.
  index.byImo.clear();
  index.byCallSign.clear();
  index.byName.clear();
  let total = 0; // true vessel count (rows parsed), not index-key count
  for (const key of activeKeys()) {
    const src = SOURCES[key];
    if (!fs.existsSync(src.file)) continue;
    try {
      const entries = await src.parse(src.file);
      for (const e of entries) indexEntry(e);
      meta[key] = { vesselCount: entries.length, lastRefreshed: fs.statSync(src.file).mtime.toISOString() };
      total += entries.length;
    } catch (e) {
      console.error(`[SANCTIONS:${key}] parse cached file failed: ${e.message}`);
    }
  }
  // Count every parsed vessel, not just those with an IMO: a list indexed only
  // by name/call sign would otherwise return 0 and trigger a needless refresh.
  if (total) console.log(`[SANCTIONS] Loaded ${total} listed vessels from cache`);
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
    const tmp = `${src.file}.download`;
    try {
      console.log(`[SANCTIONS:${key}] Refreshing from ${src.url}`);
      await downloadToFile(src.url, tmp);
      // Sanity check before replacing the cache with garbage.
      const entries = await src.parse(tmp);
      if (!entries.length) throw new Error('no vessel rows parsed');
      fs.renameSync(tmp, src.file);
      console.log(`[SANCTIONS:${key}] Saved ${entries.length} listed vessels`);
      appLog.info('SANCTIONS', appLog.t('sanctions.list_updated', { list: key.toUpperCase() }), { navi: entries.length });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      console.error(`[SANCTIONS:${key}] Refresh failed: ${e.message}`);
      appLog.error('SANCTIONS', appLog.t('sanctions.list_failed', { list: key.toUpperCase(), error: e.message }));
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
    // A list indexed only by name/call sign (no IMO column) would otherwise
    // read as "not loaded" and skip screening entirely — count every index.
    loaded: index.byImo.size + index.byName.size + index.byCallSign.size > 0,
    vesselCount,
    lastRefreshed,
    source: sources.map((s) => s.label).join(', '),
    sources,
  };
}

module.exports = { loadFromDisk, refresh, matchShip, getStatus, entityUrl };
