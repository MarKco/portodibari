'use strict';

// Server-side static map renderer for Telegram photo notifications.
//
// Stitches the same two raster layers the web client shows (OSM base +
// OpenSeaMap "seamark" overlay — see public/js/tiles.js) into a single PNG
// centred on a point, draws a marker, and returns the encoded buffer. No API
// key, no headless browser: just fetch the public 256px tiles and composite
// them in-process with pngjs (pure JS, no native build — safe on the NAT box).
//
// Cost controls (notifications fan out per-recipient, so the same map can be
// asked for many times in a burst):
//   • B — tile cache: decoded tiles are kept in an LRU+TTL map, so a busy port
//     (small bbox, heavy tile reuse) fetches each tile from OSM/OpenSeaMap once
//     per TTL instead of once per render. Also keeps us within the OSM tile
//     usage policy (no bulk automated refetching).
//   • C — rendered-map cache: the finished PNG is memoised by rounded
//     coords+zoom, so repeated events at the same spot skip the whole pipeline.
//   • D — render concurrency gate: at most RENDER_CONCURRENCY heavy renders run
//     at once, bounding CPU + RAM spikes when an event fans out to many users.
// (A — render once per event + Telegram file_id reuse — lives in telegram.js.)
//
// Volume is tiny, but we still send a proper User-Agent because
// tile.openstreetmap.org rejects blank-UA clients.

const https = require('https');
const { PNG } = require('pngjs');

const TILE = 256; // OSM/OpenSeaMap tile edge in px
const OSM_SUB = 'abc';
const osmUrl = (z, x, y) => `https://${OSM_SUB[(x + y) % 3]}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
const seamarkUrl = (z, x, y) => `https://tiles.openseamap.org/seamark/${z}/${x}/${y}.png`;
const UA = 'tracker-porti/1.0 (+https://github.com; telegram map notifications)';
const FETCH_TIMEOUT_MS = 8000;

const TILE_TTL_MS = 6 * 60 * 60 * 1000; // decoded tiles live 6h
const TILE_CACHE_MAX = 200; // ~262KB each → ~52MB worst case
const MAP_TTL_MS = 30 * 60 * 1000; // rendered PNGs live 30min
const MAP_CACHE_MAX = 64; // ~180KB each → ~11MB worst case
const RENDER_CONCURRENCY = 2; // heavy renders running at once

// ── Web-mercator: lon/lat → fractional tile coords at zoom z ──────────────────
const lon2tile = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2tile = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

// ── Generic LRU+TTL map. Insertion-ordered Map: re-set on read to mark MRU,
//    evict from the front (oldest) when over capacity. ─────────────────────────
function makeCache(max, ttl) {
  const m = new Map();
  return {
    get(key) {
      const e = m.get(key);
      if (!e) return undefined;
      if (e.exp <= Date.now()) {
        m.delete(key);
        return undefined;
      }
      m.delete(key); // re-insert → most-recently-used
      m.set(key, e);
      return e.val;
    },
    set(key, val) {
      if (m.has(key)) m.delete(key);
      m.set(key, { val, exp: Date.now() + ttl });
      while (m.size > max) m.delete(m.keys().next().value);
    },
  };
}

const tileCache = makeCache(TILE_CACHE_MAX, TILE_TTL_MS);
const mapCache = makeCache(MAP_CACHE_MAX, MAP_TTL_MS);

function fetchTileBuffer(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy());
  });
}

// Fetch + decode a tile, served from the tile cache when warm. Returns a decoded
// PNG ({width,height,data}) or null. The decoded object is treated as read-only
// (blit only reads it), so it is safe to share across renders.
async function getTile(url) {
  const hit = tileCache.get(url);
  if (hit) return hit;
  const buf = await fetchTileBuffer(url);
  if (!buf) return null;
  let img;
  try {
    img = PNG.sync.read(buf);
  } catch {
    return null;
  }
  tileCache.set(url, img);
  return img;
}

// Composite `src` (a decoded PNG) onto `dst` at pixel (ox, oy). When `alpha` is
// true, src's per-pixel alpha is honoured (used for the transparent seamark
// overlay); otherwise pixels are copied opaque (the base layer).
function blit(dst, src, ox, oy, alpha) {
  for (let y = 0; y < src.height; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= dst.width) continue;
      const si = (y * src.width + x) * 4;
      const di = (dy * dst.width + dx) * 4;
      const a = alpha ? src.data[si + 3] / 255 : 1;
      if (a <= 0) continue;
      if (a >= 1) {
        dst.data[di] = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = 255;
      } else {
        dst.data[di] = Math.round(src.data[si] * a + dst.data[di] * (1 - a));
        dst.data[di + 1] = Math.round(src.data[si + 1] * a + dst.data[di + 1] * (1 - a));
        dst.data[di + 2] = Math.round(src.data[si + 2] * a + dst.data[di + 2] * (1 - a));
        dst.data[di + 3] = 255;
      }
    }
  }
}

// Draw a red dot with a white ring at (cx, cy).
function drawMarker(png, cx, cy) {
  const R = 7;
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    const i = (y * png.width + x) * 4;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  };
  for (let y = -R - 2; y <= R + 2; y++) {
    for (let x = -R - 2; x <= R + 2; x++) {
      const d = Math.sqrt(x * x + y * y);
      if (d <= R) set(cx + x, cy + y, 220, 38, 38); // red fill
      else if (d <= R + 2) set(cx + x, cy + y, 255, 255, 255); // white ring
    }
  }
}

// Draw a thick line between two pixels (used to connect a rendezvous pair).
function drawLine(png, x0, y0, x1, y1) {
  const set = (x, y) => {
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const px = x + ox, py = y + oy;
        if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
        const i = (py * png.width + px) * 4;
        png.data[i] = 220; png.data[i + 1] = 38; png.data[i + 2] = 38; png.data[i + 3] = 255;
      }
    }
  };
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (;;) {
    set(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

// ── Render concurrency gate (D) ──────────────────────────────────────────────
let active = 0;
const waiters = [];
function acquire() {
  if (active < RENDER_CONCURRENCY) {
    active++;
    return Promise.resolve();
  }
  return new Promise((r) => waiters.push(r)).then(() => {
    active++;
  });
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) next();
}

// The heavy pipeline: fetch/decode tiles, composite, mark, encode.
async function renderToBuffer(lat, lon, z, W, H, opts = {}) {
  const { seamark, points, connect } = opts;
  const cx = lon2tile(lon, z) * TILE; // centre in world px
  const cy = lat2tile(lat, z) * TILE;
  const left = cx - W / 2;
  const top = cy - H / 2;
  const x0 = Math.floor(left / TILE);
  const y0 = Math.floor(top / TILE);
  const x1 = Math.floor((left + W - 1) / TILE);
  const y1 = Math.floor((top + H - 1) / TILE);
  const max = 2 ** z; // tiles per axis at this zoom (for x wrap / y clamp)

  const out = new PNG({ width: W, height: H });
  out.data.fill(0);
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255; // opaque

  async function layer(urlFn, alpha) {
    let painted = 0;
    const jobs = [];
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= max) continue; // no tiles past the poles
        const wx = ((tx % max) + max) % max; // wrap longitude
        const dx = Math.round(tx * TILE - left);
        const dy = Math.round(ty * TILE - top);
        jobs.push(
          getTile(urlFn(z, wx, ty)).then((img) => {
            if (!img) return;
            blit(out, img, dx, dy, alpha);
            painted++;
          })
        );
      }
    }
    await Promise.all(jobs);
    return painted;
  }

  const basePainted = await layer(osmUrl, false);
  if (!basePainted) return null; // base failed → let caller send text only
  if (seamark) await layer(seamarkUrl, true);

  if (points && points.length) {
    // Multi-point mode (e.g. a rendezvous pair): project each point relative to
    // the centred view, optionally connect them, then mark each.
    const px = points.map((p) => ({
      x: Math.round(lon2tile(p.lon, z) * TILE - left),
      y: Math.round(lat2tile(p.lat, z) * TILE - top),
    }));
    if (connect) for (let i = 1; i < px.length; i++) drawLine(out, px[i - 1].x, px[i - 1].y, px[i].x, px[i].y);
    px.forEach((p) => drawMarker(out, p.x, p.y));
  } else {
    drawMarker(out, Math.round(W / 2), Math.round(H / 2));
  }
  return PNG.sync.write(out);
}

/**
 * Render a static map PNG centred on (lat, lon).
 * @returns {Promise<Buffer|null>} PNG buffer, or null if the base layer could
 *   not be fetched (caller should fall back to a text-only message).
 */
async function render(lat, lon, opts = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const z = Math.max(1, Math.min(18, opts.zoom || 15));
  const W = opts.width || 640;
  const H = opts.height || 400;
  const seamark = opts.seamark !== false;
  const points = Array.isArray(opts.points) && opts.points.length ? opts.points : null;
  const connect = !!opts.connect;

  // C — rendered-map cache: dedupe across events at (roughly) the same spot.
  const ptsKey = points ? ':' + points.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join('|') + (connect ? 'L' : '') : '';
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${z},${W}x${H},${seamark ? 1 : 0}${ptsKey}`;
  const cached = mapCache.get(cacheKey);
  if (cached) return cached;

  // D — bound concurrent heavy renders.
  await acquire();
  try {
    // Re-check the cache: a render for the same key may have finished while we
    // waited on the gate.
    const again = mapCache.get(cacheKey);
    if (again) return again;
    const buf = await renderToBuffer(lat, lon, z, W, H, { seamark, points, connect });
    if (buf) mapCache.set(cacheKey, buf);
    return buf;
  } finally {
    release();
  }
}

module.exports = { render };
