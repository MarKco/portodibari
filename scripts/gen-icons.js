'use strict';

// Regenerate the PWA icon set from public/icons/source.png (the brand logo:
// a blue rounded tile with a white anchor over a map). Run: `node scripts/gen-icons.js`.
//
// It auto-detects the blue tile inside the source (dropping the white margin),
// finds the largest centred square whose corners are still blue (so the icons
// are full-bleed blue, no white rounded-corner triangles), then crops + resizes
// with macOS `sips` — chosen over a JS resampler for quality and zero new deps.
// REQUIRES macOS (`sips`). The generated PNGs are committed; this is a dev-time
// tool only (production never runs it). Re-run after replacing source.png.

const path = require('path');
const cp = require('child_process');
const { PNG } = require('pngjs');
const nodefs = require('fs');

const DIR = path.join(__dirname, '..', 'public', 'icons');
const SRC = path.join(DIR, 'source.png');

if (!nodefs.existsSync(SRC)) {
  console.error(`Missing ${SRC} — drop the brand logo there first.`);
  process.exit(1);
}

const png = PNG.sync.read(nodefs.readFileSync(SRC));
const { width: W, height: H, data } = png;
const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
const isContent = (x, y) => Math.min(...px(x, y)) < 210; // not near-white background
const isBlue = (x, y) => { const [r, g, b] = px(x, y); return b > r + 20 && Math.min(r, g, b) < 210; };

// Content bounding box (the blue tile).
let minX = W, minY = H, maxX = 0, maxY = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isContent(x, y)) {
  if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
}
const cx = Math.round((minX + maxX) / 2), cy = Math.round((minY + maxY) / 2);
const maxSide = Math.min(maxX - minX + 1, maxY - minY + 1);

// Largest centred square with all-blue corners (inside the rounded corners).
let side = maxSide;
const cornersBlue = (s) => {
  const h = Math.floor(s / 2);
  return [[cx - h, cy - h], [cx + h, cy - h], [cx - h, cy + h], [cx + h, cy + h]]
    .every(([x, y]) => x >= 0 && y >= 0 && x < W && y < H && isBlue(x, y));
};
while (side > 64 && !cornersBlue(side)) side -= 8;
console.log(`tile bbox ${maxX - minX + 1}x${maxY - minY + 1} @ (${cx},${cy}) → full-blue crop ${side}px`);

// Pad colour for the maskable safe zone: a solid blue sampled from the tile.
const [pr, pg, pb] = px(cx, Math.max(0, cy - Math.floor(side * 0.45)));
const padHex = [pr, pg, pb].map((v) => v.toString(16).padStart(2, '0')).join('');

const sips = (args) => cp.execFileSync('sips', args, { stdio: ['ignore', 'ignore', 'inherit'] });
const TILE = path.join(DIR, '_tile.png');
const TMP = path.join(DIR, '_m.png');

try {
  // sips -c is centred crop (HEIGHT WIDTH); the tile is centred in the source.
  sips(['-c', String(side), String(side), SRC, '--out', TILE]);

  for (const [name, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180], ['favicon-32.png', 32]]) {
    sips(['-z', String(size), String(size), TILE, '--out', path.join(DIR, name)]);
    console.log('wrote', name, `(${size}x${size})`);
  }

  // Maskable: content at ~78% on a full-bleed blue canvas (circular-mask safe zone).
  sips(['-z', '400', '400', TILE, '--out', TMP]);
  sips(['-p', '512', '512', '--padColor', padHex, TMP, '--out', path.join(DIR, 'icon-512-maskable.png')]);
  console.log('wrote icon-512-maskable.png (512x512, pad #' + padHex + ')');
} finally {
  for (const f of [TILE, TMP]) if (nodefs.existsSync(f)) nodefs.unlinkSync(f);
}
