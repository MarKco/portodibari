#!/usr/bin/env node
// Builds data/locode.json from the un-locode npm package.
// Run once: node scripts/build-locode.js
// Requires: npm install un-locode  (then uninstall after running)
'use strict';

const path = require('path');
const fs = require('fs');

const srcPath = path.join(__dirname, '../node_modules/un-locode/data/code-list.json');
if (!fs.existsSync(srcPath)) {
  console.error('un-locode not installed. Run: npm install un-locode');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
const lookup = {};
for (const entry of Object.values(data)) {
  const code = entry.Country + entry.Location;
  if (code.length === 5 && entry.Name) {
    lookup[code] = entry.NameWoDiacritics || entry.Name;
  }
}

const outPath = path.join(__dirname, '../data/locode.json');
fs.writeFileSync(outPath, JSON.stringify(lookup));
console.log(`Written ${Object.keys(lookup).length} entries → ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
