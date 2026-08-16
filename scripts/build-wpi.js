#!/usr/bin/env node
// Builds data/wpi.json ({name, lat, lon}[]) from NGA's World Port Index (Pub 150).
// Run once (or ~1/year, WPI is updated infrequently): node scripts/build-wpi.js
//
// Verified 2026-08-17: https://msi.nga.mil/api/publications/world-port-index?output=json
// is a plain, unauthenticated GET returning { ports: [...] } with ~2950 entries. Each
// port already carries decimal-degree coordinates as ycoord (lat) / xcoord (lon) — no
// need to parse the human-readable "latitude"/"longitude" DMS strings (e.g. `30°20'00"N`).
// If this URL ever stops working, re-run the Step 1 spike in
// .superpowers/sdd/2026-08-16-port-discovery/task-3-brief.md before touching this script.
'use strict';

const https = require('https');
const path = require('path');
const fs = require('fs');

const SOURCE_URL = 'https://msi.nga.mil/api/publications/world-port-index?output=json';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'curl/8.0', Accept: '*/*' } }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Unexpected status ${res.statusCode} fetching ${url}`));
          res.resume();
          return;
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`);
  const data = await fetchJson(SOURCE_URL);
  const ports = Array.isArray(data.ports) ? data.ports : [];
  if (ports.length === 0) {
    throw new Error('World Port Index response had zero ports — refusing to overwrite data/wpi.json with an unexpectedly empty result');
  }

  const out = [];
  let skipped = 0;
  for (const p of ports) {
    const name = p.portName;
    const lat = p.ycoord;
    const lon = p.xcoord;
    if (!name || typeof lat !== 'number' || typeof lon !== 'number') {
      skipped++;
      continue;
    }
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) {
      skipped++;
      continue;
    }
    out.push({ name, lat, lon });
  }

  const outPath = path.join(__dirname, '../data/wpi.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(
    `Written ${out.length} ports (skipped ${skipped} with missing/invalid name or coordinates) → ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`
  );
}

main().catch((e) => {
  console.error('build-wpi.js failed:', e.message);
  process.exit(1);
});
