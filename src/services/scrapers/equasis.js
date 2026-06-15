'use strict';

// Equasis scraper — recovers ship ownership/management (registered owner, ISM
// manager, operator, …) which AIS never broadcasts and VesselFinder/MarineTraffic
// don't expose for free. Equasis (www.equasis.org) is a free EU/US-run database
// keyed by IMO number, but every query requires an authenticated session, so the
// user must supply an Equasis account (EQUASIS_USER / EQUASIS_PASSWORD).
//
// Flow (reverse-engineered, stable for years):
//   1. POST /EquasisWeb/authen/HomePage  with j_email + j_password  → session cookie
//   2. POST /EquasisWeb/restricted/ShipInfo  with P_IMO  → ship detail HTML
// Cookies are kept in a throwaway jar file for the lifetime of the two calls.
//
// This is intentionally NOT wired into the proactive enrichment path: it only
// runs when the user presses "Recupera informazioni Equasis" in the ship detail.

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { BROWSER_UA, stripHtml } = require('./http');
const { EQUASIS_USER, EQUASIS_PASSWORD } = require('../../config');

const BASE = 'https://www.equasis.org/EquasisWeb';
const LOGIN_URL = `${BASE}/authen/HomePage`;
const SHIPINFO_URL = `${BASE}/restricted/ShipInfo`;

// Run curl with a shared cookie jar. `fields` (when given) are sent as a POST
// body via --data-urlencode. Resolves with the response body; rejects on a
// non-2xx/3xx status or a curl transport error.
function curl(url, jar, fields) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-S', '-L', '--compressed', '-m', '25', '-A', BROWSER_UA,
      '-c', jar, '-b', jar];
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        args.push('--data-urlencode', `${k}=${v}`);
      }
    }
    args.push('-w', '\n%{http_code}', url);
    execFile('curl', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl: ${err.message}`));
      const nl = stdout.lastIndexOf('\n');
      const code = Number(stdout.slice(nl + 1).trim());
      const body = stdout.slice(0, nl);
      if (code >= 400) return reject(new Error(`HTTP ${code}`));
      resolve(body);
    });
  });
}

// Pull rows out of the "Management detail(s)" table: any row whose first cell is
// a known company role. Equasis lays each out as
//   <td>Role</td><td>Company name + IMO</td><td>Address</td><td>Date of effect</td>
const ROLE_RE = /\b(owner|manager|operator|charterer|doc company)\b/i;

function parseManagement(html) {
  const out = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(html)) !== null) {
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let td;
    while ((td = tdRe.exec(tr[1])) !== null) tds.push(stripHtml(td[1]));
    if (tds.length < 2) continue;
    const role = tds[0];
    if (!role || !ROLE_RE.test(role) || role.length > 60) continue;
    const company = tds[1];
    if (!company) continue;
    const entry = { role, company };
    if (tds.length >= 4) {
      if (tds[2]) entry.address = tds[2];
      const date = tds[tds.length - 1];
      if (/\d{4}/.test(date)) entry.date = date;
    }
    out.push(entry);
  }
  // De-dup identical (role, company) pairs Equasis sometimes repeats.
  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.role}|${e.company}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Best-effort ship particulars: pull a curated set of labelled values from the
// detail page text. Labels are matched loosely against the visible text so the
// scraper survives minor markup changes.
const PARTICULAR_LABELS = [
  'Name', 'IMO number', 'Call Sign', 'MMSI', 'Gross tonnage', 'DWT',
  'Type of ship', 'Year of build', 'Flag', 'Status', 'Port of registry',
];

function parseParticulars(html) {
  const out = {};
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(html)) !== null) {
    const tds = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;
    while ((td = tdRe.exec(tr[1])) !== null) tds.push(stripHtml(td[1]));
    if (tds.length < 2) continue;
    const label = tds[0].replace(/:$/, '').trim();
    const value = tds[1].trim();
    if (!label || !value || value.length > 120) continue;
    const match = PARTICULAR_LABELS.find((l) => l.toLowerCase() === label.toLowerCase());
    if (match && !out[match]) out[match] = value;
  }
  return out;
}

/**
 * Look up a ship on Equasis by IMO number. Returns
 * `{ particulars: {label: value}, management: [{role, company, address?, date?}] }`.
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
    const management = parseManagement(html);
    const particulars = parseParticulars(html);
    if (!management.length && !Object.keys(particulars).length) {
      throw new Error('Nessun dato trovato su Equasis per questo IMO');
    }
    return { particulars, management };
  } finally {
    fs.promises.unlink(jar).catch(() => {});
  }
}

module.exports = { crawlEquasis };
