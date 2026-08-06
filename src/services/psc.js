'use strict';

// ── Port State Control (Paris / Tokyo MoU) screening ─────────────────────────
// Two complementary, dataset-based signals — like sanctions.js, every ship is
// matched locally against pre-loaded data, no per-ship network call.
//
//  Level 1 — Flag performance (White/Grey/Black list).
//    The MoUs rank flags over a 3-year rolling window of inspections/detentions.
//    A black-listed flag is a high-risk registry, grey is intermediate, white is
//    a quality flag. Published once a year as a PDF only (no machine-readable
//    feed), so the current lists are bundled as JSON under data/ and refreshed
//    by hand each year. Matching is by (normalized) flag/country name.
//
//  Level 2 — Banned ships (refusal of access).
//    A ship banned from the Paris MoU region has been detained repeatedly — the
//    strongest possible "many detentions" signal. OpenSanctions republishes the
//    EMSA banned list as a clean CSV (stable "latest" URL), so this one IS
//    downloaded and cached exactly like the OFAC list. Matching is by IMO/name.

const fs = require('fs');
const path = require('path');
const https = require('https');
const appLog = require('./app-log');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// Bundled flag-performance lists (Level 1). Shipped in the repo, updated yearly.
const FLAG_FILES = [
  path.join(DATA_DIR, 'paris-mou-flags.json'),
  path.join(DATA_DIR, 'tokyo-mou-flags.json'),
];

// Banned-ships list (Level 2). OpenSanctions mirror of the EMSA/Paris MoU data,
// "latest" alias is a stable URL refreshed daily upstream.
const BANNED = {
  label: 'Paris MoU Banned List',
  url: 'https://data.opensanctions.org/datasets/latest/paris_mou_banned/targets.simple.csv',
  file: path.join(DATA_DIR, 'paris-mou-banned.csv'),
};

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── In-memory state ──────────────────────────────────────────────────────────
// flagIndex: canonical flag name → { perf:'black'|'grey'|'white', mous:[...] }
// banned:    byImo / byName → { name, flag, reason, source }
const flagIndex = new Map();
const banned = { byImo: new Map(), byName: new Map() };
const meta = { flags: {}, banned: { count: 0, lastRefreshed: null } };

// The Paris MoU banned-vessels list (the only caller, see BANNED.url below) is
// real bulk data, unlike a scraped HTML page — generous cap, still bounded
// instead of growing until OOM on a ~256MB heap. `timeout` below is
// socket-inactivity only — see scrapers/http.js for why an absolute deadline
// is also needed.
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const ABS_DEADLINE_MS = 45000;

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
        let bytes = 0;
        res.setEncoding('utf8');
        res.on('data', (c) => {
          bytes += Buffer.byteLength(c, 'utf8');
          if (bytes > MAX_BODY_BYTES) {
            req.destroy(new Error('Response body too large'));
            return;
          }
          body += c;
        });
        res.on('end', () => resolve(body));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    const deadline = setTimeout(() => req.destroy(new Error('Deadline exceeded')), ABS_DEADLINE_MS);
    req.on('close', () => clearTimeout(deadline));
    req.end();
  });
}

/** Parse CSV text into rows of string fields, honouring "" escaping and quoted
 *  commas/newlines. */
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

// Flag/country names differ between the MoU PDFs and the registry strings that
// VesselFinder/MarineTraffic report. Canonicalize aggressively: uppercase, drop
// accents and parentheticals ("(UK)"), drop "Republic of", strip non-alphanum,
// then fold a handful of well-known variants onto one key.
const FLAG_ALIAS = {
  RUSSIANFEDERATION: 'RUSSIA',
  KOREA: 'SOUTHKOREA',
  REPUBLICOFKOREA: 'SOUTHKOREA',
  TURKIYE: 'TURKEY',
  UNITEDSTATESOFAMERICA: 'UNITEDSTATES',
  USA: 'UNITEDSTATES',
  US: 'UNITEDSTATES',
  UK: 'UNITEDKINGDOM',
};

function canonFlag(s) {
  const x = (s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents (Türkiye → TURKIYE)
    .replace(/\([^)]*\)/g, ' ') // drop "(UK)", "(China)"
    .replace(/,?\s*(UNITED\s+)?REPUBLIC\s+OF/g, ' ') // "Korea, Republic of" → "Korea"
    .replace(/[^A-Z0-9]/g, '');
  return FLAG_ALIAS[x] || x;
}

/** UPPERCASE, alphanumerics only — forgiving name matching for banned ships. */
function normalize(s) {
  return (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');
}

/** Load the bundled flag-performance JSON files and build the flag index. When a
 *  flag appears on more than one MoU list, the first file wins the verdict — the
 *  files are ordered by regional relevance (Paris MoU first, as this tracker
 *  watches the Paris region), with later lists only adding flags not yet seen
 *  and recording that they also list the flag. */
function loadFlags() {
  flagIndex.clear();
  meta.flags = {};
  for (const file of FLAG_FILES) {
    if (!fs.existsSync(file)) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`[PSC] parse ${path.basename(file)} failed: ${e.message}`);
      continue;
    }
    const mou = doc.mou || path.basename(file);
    let n = 0;
    for (const perf of ['black', 'grey', 'white']) {
      for (const name of doc[perf] || []) {
        const key = canonFlag(name);
        if (!key) continue;
        n++;
        const cur = flagIndex.get(key);
        if (!cur) {
          flagIndex.set(key, { perf, mous: [mou] });
        } else if (!cur.mous.includes(mou)) {
          cur.mous.push(mou); // first file keeps the verdict (Paris-priority)
        }
      }
    }
    meta.flags[mou] = { count: n, valid: doc.valid || null };
  }
  return flagIndex.size;
}

// OpenSanctions "targets.simple" CSV columns (with header):
//   id,schema,name,aliases,birth_date,countries,addresses,identifiers,
//   sanctions,phones,emails,program_ids,dataset,first_seen,last_seen,last_change
function parseBanned(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iSchema = col('schema');
  const iName = col('name');
  const iAliases = col('aliases');
  const iCountries = col('countries');
  const iIdent = col('identifiers');
  const iSanctions = col('sanctions');
  const entries = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    if ((cols[iSchema] || '').trim().toLowerCase() !== 'vessel') continue;
    const ident = cols[iIdent] || '';
    const imo = ident.match(/IMO\s*0*(\d{6,7})/i)?.[1] || null;
    const aliases = (cols[iAliases] || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean);
    entries.push({
      name: (cols[iName] || '').trim() || null,
      flag: (cols[iCountries] || '').trim() || null,
      reason: (cols[iSanctions] || '').trim() || null,
      imo,
      aliases,
      source: BANNED.label,
    });
  }
  return entries;
}

function indexBanned(entries) {
  banned.byImo.clear();
  banned.byName.clear();
  for (const e of entries) {
    if (e.imo) banned.byImo.set(e.imo, e);
    for (const name of [e.name, ...e.aliases]) {
      const k = normalize(name);
      if (k.length >= 3 && !banned.byName.has(k)) banned.byName.set(k, e);
    }
  }
}

/** Load the cached banned-ships CSV from disk (if present) into the index. */
function loadBanned() {
  if (!fs.existsSync(BANNED.file)) {
    meta.banned = { count: 0, lastRefreshed: null };
    indexBanned([]);
    return 0;
  }
  try {
    const entries = parseBanned(fs.readFileSync(BANNED.file, 'utf8'));
    indexBanned(entries);
    meta.banned = { count: entries.length, lastRefreshed: fs.statSync(BANNED.file).mtime.toISOString() };
    return entries.length;
  } catch (e) {
    console.error(`[PSC] parse cached banned list failed: ${e.message}`);
    return 0;
  }
}

/** Load everything from disk and (re)build indexes. Network-free, safe at
 *  startup. Returns true if any data (flags or banned ships) was loaded. */
function loadFromDisk() {
  const flags = loadFlags();
  const ban = loadBanned();
  if (flags) {
    const counts = Object.entries(meta.flags).map(([m, v]) => `${m}:${v.count}`).join(', ');
    console.log(`[PSC] Loaded ${flags} flag entries (${counts})`);
  }
  if (ban) console.log(`[PSC] Loaded ${ban} banned vessels from cache`);
  return flags > 0 || ban > 0;
}

/** Download the banned-ships list, persist to disk, rebuild that index. Flag
 *  lists are bundled (not downloaded), only reloaded from disk. */
async function refresh() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  loadFlags(); // pick up any manual edit to the bundled lists
  try {
    console.log(`[PSC] Refreshing banned list from ${BANNED.url}`);
    const body = await download(BANNED.url);
    const entries = parseBanned(body);
    if (!entries.length) throw new Error('no vessel rows parsed');
    fs.writeFileSync(BANNED.file, body, 'utf8');
    console.log(`[PSC] Saved ${entries.length} banned vessels`);
    appLog.info('PSC', appLog.t('psc.banned_updated'), { navi: entries.length });
  } catch (e) {
    console.error(`[PSC] Banned-list refresh failed: ${e.message}`);
    appLog.error('PSC', appLog.t('psc.banned_failed', { error: e.message }));
  }
  loadBanned();
  return loadFromDisk();
}

/** Look up a registry flag/country name. Returns { perf, mous } or null. */
function matchFlag(flagName) {
  if (!flagName) return null;
  return flagIndex.get(canonFlag(flagName)) || null;
}

/** Match a ship against the banned list. IMO first (near-certain), then name.
 *  Returns { entry, matchedOn } or null. */
function matchBanned(ship) {
  if (!ship) return null;
  if (ship.imo_number) {
    const e = banned.byImo.get(String(ship.imo_number));
    if (e) return { entry: e, matchedOn: 'imo' };
  }
  const nk = normalize(ship.ship_name);
  if (nk.length >= 3) {
    const e = banned.byName.get(nk);
    if (e) return { entry: e, matchedOn: 'name' };
  }
  return null;
}

const flagsLoaded = () => flagIndex.size > 0;
const bannedLoaded = () => banned.byImo.size > 0;
const anyLoaded = () => flagsLoaded() || bannedLoaded();

/** Dataset status for the settings UI. */
function getStatus() {
  const flagCounts = { black: 0, grey: 0, white: 0 };
  for (const v of flagIndex.values()) flagCounts[v.perf]++;
  return {
    flagsLoaded: flagsLoaded(),
    flagCounts,
    flagSources: meta.flags,
    bannedLoaded: bannedLoaded(),
    bannedCount: meta.banned.count,
    bannedRefreshed: meta.banned.lastRefreshed,
    loaded: anyLoaded(),
  };
}

module.exports = {
  loadFromDisk,
  refresh,
  matchFlag,
  matchBanned,
  flagsLoaded,
  bannedLoaded,
  anyLoaded,
  getStatus,
};
