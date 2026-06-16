'use strict';

// Equasis scraper — recovers ship ownership/management (registered owner, ISM
// manager, operator, …) plus classification, P&I cover, port-State performance
// and recent positions. None of this is broadcast over AIS and VesselFinder /
// MarineTraffic don't expose it for free. Equasis (www.equasis.org) is a free
// EU/US-run database keyed by IMO number, but every query requires an
// authenticated session, so the user must supply an Equasis account
// (EQUASIS_USER / EQUASIS_PASSWORD).
//
// Flow (reverse-engineered, stable for years):
//   1. POST /EquasisWeb/authen/HomePage  with j_email + j_password  → session cookie
//   2. POST /EquasisWeb/restricted/ShipInfo  with P_IMO  → ship detail HTML
// Cookies are kept in a throwaway jar file for the lifetime of the two calls.
//
// The detail page is one big Bootstrap document split into commented sections
// (<!-- Overview -->, <!-- MGT DET -->, <!-- Classification -->, <!-- PI -->,
// <!-- Geo -->, …). Each section duplicates its data twice: a desktop <table>
// and a `hidden-md hidden-lg` mobile <div> block. We always parse the desktop
// markup and ignore the mobile duplicate to avoid counting everything twice.
//
// This is intentionally NOT wired into the proactive enrichment path: it only
// runs when the user presses "Recupera informazioni Equasis" in the ship detail.

const { curly } = require('node-libcurl');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { BROWSER_UA, stripHtml } = require('./http');
const { EQUASIS_USER, EQUASIS_PASSWORD } = require('../../config');

const BASE = 'https://www.equasis.org/EquasisWeb';
const LOGIN_URL = `${BASE}/authen/HomePage`;
const SHIPINFO_URL = `${BASE}/restricted/ShipInfo`;

// Run a request through libcurl (node-libcurl) with a shared cookie jar.
// `fields` (when given) are sent as a urlencoded POST body. Resolves with the
// response body; rejects on a 4xx/5xx status or a transport error. Uses
// node-libcurl so no system `curl` binary is required on the deploy host.
function curl(url, jar, fields) {
  const options = {
    followLocation: true,
    acceptEncoding: '', // --compressed
    timeout: 25,
    userAgent: BROWSER_UA,
    cookieJar: jar, // write Set-Cookie here (-c)
    cookieFile: jar, // send cookies from here (-b)
    curlyResponseBodyParser: false, // raw Buffer; the HTML parsers want a string
  };
  let run;
  if (fields) {
    options.postFields = Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    run = curly.post(url, options);
  } else {
    run = curly.get(url, options);
  }
  return run.then(({ statusCode, data }) => {
    if (statusCode >= 400) throw new Error(`HTTP ${statusCode}`);
    return data.toString('utf8');
  });
}

// ── HTML helpers ───────────────────────────────────────────────────────────

// Return the slice of `html` between the `start` and `end` markers (regexes).
// Used to scope a parser to one commented page section so labels don't leak
// across sections. Returns '' when the start marker is absent.
function section(html, start, end) {
  const i = html.search(start);
  if (i < 0) return '';
  const rest = html.slice(i);
  const j = rest.search(end);
  return j < 0 ? rest : rest.slice(0, j);
}

// Parse a single `<table class="tableLS">`: returns { heads: [...], rows: [[...]] }
// where heads come from <thead><th> and each row is its <td> cells (stripped).
function parseTableLS(tableHtml) {
  const heads = [];
  const thead = tableHtml.match(/<thead>([\s\S]*?)<\/thead>/i);
  if (thead) {
    const re = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let m;
    while ((m = re.exec(thead[1])) !== null) heads.push(stripHtml(m[1]));
  }
  const rows = [];
  const tbody = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  const body = tbody ? tbody[1] : tableHtml;
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let r;
  while ((r = rowRe.exec(body)) !== null) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let c;
    while ((c = cellRe.exec(r[1])) !== null) cells.push(stripHtml(c[1]));
    if (cells.some((x) => x)) rows.push(cells);
  }
  return { heads, rows };
}

// Find every `<table class="tableLS">…</table>` in a chunk of HTML.
function findTablesLS(html) {
  const out = [];
  const re = /<table[^>]*class="[^"]*tableLS[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[0]);
  return out;
}

// Pull the visible text of every <p> in a block, dropping empties.
function paragraphs(html) {
  const out = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = stripHtml(m[1]);
    if (t) out.push(t);
  }
  return out;
}

// ── Section parsers ──────────────────────────────────────────────────────────

// Ship name + IMO live in the page <h4>: "<b>NAME</b> - IMO n° <b>9424546</b>".
function parseHeader(html) {
  const out = {};
  const h4 = html.match(/<h4[^>]*>([\s\S]*?IMO[\s\S]*?)<\/h4>/i);
  if (!h4) return out;
  const bolds = [...h4[1].matchAll(/<b>\s*([\s\S]*?)\s*<\/b>/gi)].map((m) => stripHtml(m[1]));
  if (bolds[0]) out.Name = bolds[0];
  const imo = bolds.find((b) => /^\d{6,7}$/.test(b));
  if (imo) out['IMO number'] = imo;
  return out;
}

// Ship particulars are laid out as <b>Label</b> followed by the value in sibling
// <div>s (NOT a table). We walk every <b>…</b> in the "Ship info" section and
// take the text up to the next <b> as that label's value.
const PARTICULAR_LABELS = [
  'Flag', 'Call Sign', 'MMSI', 'Gross tonnage', 'DWT', 'Type of ship',
  'Year of build', 'Status', 'Port of registry',
];

function parseParticulars(html) {
  const sec = section(html, /<!--\s*ShipInfo\s*-->/i, /<!--\s*\/ship\s*info\s*-->/i);
  if (!sec) return {};
  const out = {};
  const marks = [];
  const bRe = /<b>\s*([\s\S]*?)\s*<\/b>/gi;
  let m;
  while ((m = bRe.exec(sec)) !== null) {
    marks.push({ label: stripHtml(m[1]).replace(/[:\s]+$/, '').trim(), end: bRe.lastIndex, start: m.index });
  }
  for (let i = 0; i < marks.length; i++) {
    const known = PARTICULAR_LABELS.find((l) => l.toLowerCase() === marks[i].label.toLowerCase());
    if (!known || out[known]) continue;
    const slice = sec.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : undefined);
    let val = stripHtml(slice)
      .replace(/\s*\((?:since|during|until)[^)]*\)\s*/gi, ' ') // drop "(since 01/11/2009)" suffixes
      .replace(/\s*Last update[\s\S]*$/i, '') // trailing "Last update of ship particulars …" after the final field
      .trim();
    if (known === 'Flag') val = val.replace(/[()]/g, '').trim(); // "(Netherlands)" → "Netherlands"
    if (val && val.length <= 120) out[known] = val;
  }
  return out;
}

// Management detail: a tableLS whose header has Role + Name of company. Equasis
// reorders the columns over time, so we map by header name rather than fixed
// index. Column order today: IMO | Role | Name of company | Address | Date | Details.
const ROLE_RE = /\b(owner|manager|operator|charterer|doc company)\b/i;

function parseManagement(html) {
  const sec = section(html, /<!--\s*MGT DET\s*-->/i, /<!--\s*\/MGT DET\s*-->/i);
  const out = [];
  for (const tbl of findTablesLS(sec)) {
    const { heads, rows } = parseTableLS(tbl);
    const idx = (re) => heads.findIndex((h) => re.test(h));
    const iRole = idx(/^role$/i);
    const iComp = idx(/name of company/i);
    if (iRole < 0 || iComp < 0) continue; // not the management table
    const iAddr = idx(/address/i);
    const iDate = idx(/date of effect/i);
    const iImo = idx(/imo number/i);
    for (const cells of rows) {
      const role = cells[iRole];
      const company = cells[iComp];
      if (!role || !company || !ROLE_RE.test(role)) continue;
      const entry = { role, company };
      if (iImo >= 0 && /^\d{4,7}$/.test(cells[iImo] || '')) entry.companyImo = cells[iImo];
      if (iAddr >= 0 && cells[iAddr]) entry.address = cells[iAddr];
      if (iDate >= 0 && cells[iDate]) entry.date = cells[iDate];
      out.push(entry);
    }
  }
  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.role}|${e.company}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Classification: each society sits in its own `access-item` block carrying a
// status badge (Delivered / Reinstated / Withdrawn …), the society name in the
// first <p>, and the effective date in a "since …" <p>.
function parseClassification(html) {
  const sec = section(html, /<!--\s*Classification\s*-->/i, /<!--\s*\/Classification\s*-->/i);
  const out = [];
  const blocks = sec.split(/<div class="access-item">/i).slice(1);
  for (const block of blocks) {
    const badge = block.match(/<span class="badge[^"]*">\s*([\s\S]*?)\s*<\/span>/i);
    const status = badge ? stripHtml(badge[1]) : '';
    if (!status) continue; // skip the "Status" header block and empty duplicates
    const ps = paragraphs(block);
    const society = ps.find((p) => !/^(since|until|during)\b/i.test(p) && !/^by society/i.test(p));
    if (!society) continue;
    const entry = { society, status };
    const date = ps.find((p) => /\b\d{2}\/\d{2}\/\d{4}\b/.test(p));
    if (date) entry.date = date;
    const reason = ps.find((p) => /^by society/i.test(p));
    if (reason) entry.reason = reason;
    out.push(entry);
  }
  return out;
}

// P&I cover: club name (+ country) in one <p>, "Inception at <date>" in another.
function parsePI(html) {
  const sec = section(html, /<!--\s*PI\s*-->/i, /<!--\s*\/PI\s*-->/i);
  const out = [];
  const blocks = sec.split(/<div class="access-item">/i).slice(1);
  for (const block of blocks) {
    const ps = paragraphs(block);
    const club = ps.find((p) => !/inception/i.test(p));
    if (!club) continue;
    const entry = { club };
    const inc = ps.find((p) => /inception/i.test(p));
    if (inc) entry.date = inc.replace(/^inception\s*(at)?\s*/i, '').trim();
    out.push(entry);
  }
  return out;
}

// Overview: the port-State performance summary — detention rate, IACS class
// flag, Paris/Tokyo MOU list colour, USCG targeting. Returned as an ordered
// label→value map for straightforward rendering.
function parseRisk(html) {
  const sec = section(html, /<!--\s*Overview\s*-->/i, /<!--\s*\/Overview\s*-->/i);
  if (!sec) return {};
  const out = {};
  const det = sec.match(/<b>\s*([\d.,]+\s*%)\s*<\/b>\s*Of inspections having led to a detention/i);
  if (det) out['Detenzioni (36 mesi)'] = det[1].trim();
  if (/classed by \(at least\) one of the IACS/i.test(sec)) out['Società di classe IACS'] = 'Sì';
  const mouRe = /<p>\s*(Paris MOU|Tokyo MOU)\s*<\/p>[\s\S]{0,200}?<p>\s*(White|Grey|Gray|Black)\s*<\/p>/gi;
  let mou;
  while ((mou = mouRe.exec(sec)) !== null) out[`Performance ${mou[1]}`] = mou[2];
  const uscg = sec.match(/<p>\s*USCG:\s*([^<]+?)\s*<\/p>/i);
  if (uscg) out['Targeting USCG'] = stripHtml(uscg[1]);
  return out;
}

// Geographical information: recent "where the ship was seen" records. We keep a
// handful of the most recent (the table is newest-first).
function parsePositions(html, limit = 6) {
  const sec = section(html, /<!--\s*Geo\s*-->/i, /<!--\s*\/Geo\s*-->/i);
  const out = [];
  for (const tbl of findTablesLS(sec)) {
    const { heads, rows } = parseTableLS(tbl);
    const iDate = heads.findIndex((h) => /date of record/i.test(h));
    const iArea = heads.findIndex((h) => /area where the ship/i.test(h));
    const iSrc = heads.findIndex((h) => /source/i.test(h));
    if (iDate < 0 || iArea < 0) continue;
    for (const cells of rows) {
      if (!cells[iDate] || !cells[iArea]) continue;
      const entry = { date: cells[iDate], area: cells[iArea] };
      if (iSrc >= 0 && cells[iSrc]) entry.source = cells[iSrc];
      out.push(entry);
      if (out.length >= limit) break;
    }
    if (out.length) break;
  }
  return out;
}

/**
 * Look up a ship on Equasis by IMO number. Returns
 *   {
 *     particulars:    {label: value},
 *     management:     [{role, company, companyImo?, address?, date?}],
 *     classification: [{society, status, date?, reason?}],
 *     pi:             [{club, date?}],
 *     risk:           {label: value},
 *     positions:      [{date, area, source?}],
 *   }
 * Throws on missing credentials, login failure, ship-not-found, or transport error.
 */
async function crawlEquasis(imo) {
  if (!imo) throw new Error('IMO mancante: Equasis interroga solo per numero IMO');
  if (!EQUASIS_USER || !EQUASIS_PASSWORD) {
    throw new Error('Credenziali Equasis mancanti: imposta EQUASIS_USER e EQUASIS_PASSWORD in local.properties');
  }
  const jar = path.join(os.tmpdir(), `equasis-${process.pid}-${imo}.cookies`);
  try {
    await curl(LOGIN_URL, jar, { j_email: EQUASIS_USER, j_password: EQUASIS_PASSWORD, submit: 'Login' });
    const html = await curl(SHIPINFO_URL, jar, { P_IMO: String(imo) });
    if (/Please enter your login|Authentication failed|j_password/i.test(html) && !/Management/i.test(html)) {
      throw new Error('Login Equasis fallito: verifica le credenziali');
    }
    const particulars = { ...parseHeader(html), ...parseParticulars(html) };
    const management = parseManagement(html);
    const classification = parseClassification(html);
    const pi = parsePI(html);
    const risk = parseRisk(html);
    const positions = parsePositions(html);
    const empty = !management.length && !Object.keys(particulars).length
      && !classification.length && !pi.length && !Object.keys(risk).length;
    if (empty) throw new Error('Nessun dato trovato su Equasis per questo IMO');
    return { particulars, management, classification, pi, risk, positions };
  } finally {
    fs.promises.unlink(jar).catch(() => {});
  }
}

module.exports = { crawlEquasis };
