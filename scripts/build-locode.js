#!/usr/bin/env node
// Builds data/locode.json (CODE → port name), data/locode-coords.json
// (CODE → [lat, lon]) and data/locode-ports.json (array of CODEs classified
// as maritime ports) from the un-locode npm package.
// Run once: node scripts/build-locode.js
// Requires: npm install --no-save un-locode  (dev-only; remove after running)
'use strict';

const path = require('path');
const fs = require('fs');

const srcPath = path.join(__dirname, '../node_modules/un-locode/data/code-list.json');
if (!fs.existsSync(srcPath)) {
  console.error('un-locode not installed. Run: npm install --no-save un-locode');
  process.exit(1);
}

// UN/LOCODE coordinates are "DDMM[N/S] DDDMM[E/W]" (degrees+minutes, e.g.
// "4323N 01112E"). Convert to a decimal [lat, lon] pair, or null if absent/odd.
// Precision is ~1 minute (≈1–2 km): a locality centroid, good enough to centre a
// map on the port. Present for ~75% of entries.
const COORD_RE = /^(\d{2})(\d{2})([NS])\s+(\d{3})(\d{2})([EW])$/;
function parseCoord(raw) {
  if (!raw) return null;
  const m = COORD_RE.exec(raw.trim());
  if (!m) return null;
  let lat = Number(m[1]) + Number(m[2]) / 60;
  let lon = Number(m[4]) + Number(m[5]) / 60;
  if (m[3] === 'S') lat = -lat;
  if (m[6] === 'W') lon = -lon;
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  return [Number(lat.toFixed(4)), Number(lon.toFixed(4))];
}

const data = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
const lookup = {};
const coords = {};
for (const entry of Object.values(data)) {
  const code = entry.Country + entry.Location;
  if (code.length !== 5 || !entry.Name) continue;
  lookup[code] = entry.NameWoDiacritics || entry.Name;
  const c = parseCoord(entry.Coordinates);
  if (c) coords[code] = c;
}

const outPath = path.join(__dirname, '../data/locode.json');
fs.writeFileSync(outPath, JSON.stringify(lookup));
console.log(`Written ${Object.keys(lookup).length} names → ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);

const coordPath = path.join(__dirname, '../data/locode-coords.json');
fs.writeFileSync(coordPath, JSON.stringify(coords));
console.log(`Written ${Object.keys(coords).length} coordinates → ${coordPath} (${(fs.statSync(coordPath).size / 1024).toFixed(0)} KB)`);

// UN/LOCODE "Function" field is an 8-char classification string; position 0
// = '1' means "port, maritime" (e.g. "1-------"), '0'/'-' otherwise.
const ports = [];
for (const entry of Object.values(data)) {
  const code = entry.Country + entry.Location;
  if (code.length !== 5 || !entry.Name) continue;
  if ((entry.Function || '')[0] === '1') ports.push(code);
}
const portsPath = path.join(__dirname, '../data/locode-ports.json');
fs.writeFileSync(portsPath, JSON.stringify(ports));
console.log(`Written ${ports.length} port codes → ${portsPath} (${(fs.statSync(portsPath).size / 1024).toFixed(0)} KB)`);
