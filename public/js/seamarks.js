// OpenSeaMap nautical objects, fetched live from the Overpass API (OpenStreetMap's
// query backend) for the current area and drawn as vector markers on the overview
// map — alongside the app's own auto-computed berths, so the two can be compared.
// No API key needed; Overpass is free and CORS-enabled, so the browser queries it
// directly. Which categories are drawn is user-controlled from Settings (default:
// all). NOTE: this filtering applies to these Overpass markers only — the OpenSeaMap
// seamark *tile* layer (tiles.js) is a single raster and always shows every mark.
import { S } from './store.js';
import { escHtml } from './helpers.js';
import { t } from './i18n.js';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Marker categories, in display order (Settings renders one checkbox per entry).
// `match` lists the seamark:type values; `prefix:true` matches any type starting
// with one of them (e.g. 'light' → light_major, light_minor, …). `color` styles
// the marker so the categories are visually distinct on the map.
export const SEAMARK_CATEGORIES = [
  { key: 'harbour', match: ['harbour', 'harbour_basin'], color: '#f59e0b' },
  { key: 'berth', match: ['berth', 'mooring'], color: '#fb923c' },
  { key: 'anchorage', match: ['anchorage'], color: '#38bdf8' },
  { key: 'marina', match: ['small_craft_facility'], color: '#a78bfa' },
  { key: 'restricted', match: ['restricted_area'], color: '#f43f5e' },
  { key: 'light', match: ['light'], prefix: true, color: '#facc15' },
  { key: 'beacon', match: ['beacon', 'buoy'], prefix: true, color: '#22d3ee' },
  { key: 'hazard', match: ['wreck', 'obstruction'], color: '#ef4444' },
  { key: 'pilot', match: ['pilot_boarding'], color: '#34d399' },
];

const CAT_BY_KEY = new Map(SEAMARK_CATEGORIES.map((c) => [c.key, c]));

// Overpass regex over seamark:type covering every category. Prefix categories
// contribute `name.*`, exact ones contribute the literal type.
const TYPE_REGEX =
  '^(' +
  SEAMARK_CATEGORIES.flatMap((c) => c.match.map((m) => (c.prefix ? m + '.*' : m))).join('|') +
  ')$';

// bbox-string -> Promise<features[]>. Caches per area so the per-poll
// renderActiveMap reuses the result instead of re-hitting Overpass each cycle,
// and dedupes concurrent in-flight requests.
const cache = new Map();

// S.currentBbox is [[swLat, swLon], [neLat, neLon]]; Overpass wants "south,west,north,east".
function bboxStr(bbox) {
  const [[s, w], [n, e]] = bbox;
  return `${s},${w},${n},${e}`;
}

// Classify a seamark:type into one of the category keys (or null if none).
function categoryOf(type) {
  if (!type) return null;
  for (const c of SEAMARK_CATEGORIES) {
    for (const m of c.match) {
      if (c.prefix ? type.startsWith(m) : type === m) return c.key;
    }
  }
  return null;
}

function categoryLabel(key) {
  const k = `seamark.cat.${key}`;
  const label = t(k);
  return label === k ? key : label;
}

function categoryDesc(key) {
  const k = `seamark.desc.${key}`;
  const desc = t(k);
  return desc === k ? '' : desc;
}

// Per-category specific details extracted from OSM tags.
function seamarkDetails(f) {
  const tags = f.tags || {};
  const parts = [];
  const add = (key, val) => { if (val) parts.push(`${t('seamark.detail.' + key)}: ${val}`); };

  switch (f.category) {
    case 'light':
      add('char',   tags['seamark:light:character']);
      add('period', tags['seamark:light:period'] ? tags['seamark:light:period'] + ' s' : null);
      add('range',  tags['seamark:light:range']  ? tags['seamark:light:range']  + ' M' : null);
      add('height', tags['seamark:light:height'] ? tags['seamark:light:height'] + ' m' : null);
      break;
    case 'berth':
      add('length',   tags['seamark:berth:length']       ? tags['seamark:berth:length']       + ' m' : null);
      add('depth',    tags['seamark:berth:depth']         ? tags['seamark:berth:depth']         + ' m' : null);
      add('bollards', tags['seamark:berth:bollard_count']);
      break;
    case 'anchorage': {
      const dep = tags['seamark:anchorage:depth'] || tags.depth;
      add('depth', dep ? dep + ' m' : null);
      add('type',  tags['seamark:anchorage:category']);
      break;
    }
    case 'hazard': {
      const dep = tags['seamark:obstruction:depth'] || tags['seamark:wreck:depth'] || tags.depth;
      add('depth', dep ? dep + ' m' : null);
      break;
    }
    case 'beacon':
      add('colour',  tags['seamark:buoy_lateral:colour'] || tags['seamark:beacon_lateral:colour'] || tags['seamark:light:colour']);
      add('topmark', tags['seamark:topmark:shape']);
      break;
    case 'restricted':
      add('type', tags['seamark:restricted_area:category']);
      break;
    case 'pilot':
      add('vhf', tags['seamark:pilot_boarding:communication:vhf']);
      break;
    case 'harbour':
      add('type',     tags['seamark:harbour:category']);
      add('operator', tags.operator);
      break;
    case 'marina':
      add('operator', tags.operator);
      break;
  }

  const ref = tags.ref || tags['seamark:ref'];
  if (ref && parts.length < 3) add('ref', ref);

  return parts;
}

// Rich hover overlay: name, category, one-line explanation, and any
// object-specific details available from OSM tags.
function seamarkTooltip(f) {
  const title = f.name || categoryLabel(f.category);
  const desc = categoryDesc(f.category);
  const details = seamarkDetails(f);
  return (
    `<div class="seamark-tip">` +
    `<b>⚓ ${escHtml(title)}</b>` +
    `<div class="seamark-tip-cat">${escHtml(categoryLabel(f.category))}</div>` +
    (desc ? `<div class="seamark-tip-desc">${escHtml(desc)}</div>` : '') +
    (details.length ? `<div class="seamark-tip-details">${details.map(escHtml).join(' · ')}</div>` : '') +
    `</div>`
  );
}

async function fetchSeamarks(bbox) {
  const bb = bboxStr(bbox);
  const query =
    '[out:json][timeout:25];(' +
    `node["seamark:type"~"${TYPE_REGEX}"](${bb});` +
    `way["seamark:type"~"${TYPE_REGEX}"](${bb});` +
    ');out center tags;';
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: query,
  });
  if (!res.ok) throw new Error('overpass ' + res.status);
  const data = await res.json();
  return (data.elements || [])
    .map((el) => {
      const lat = el.lat != null ? el.lat : el.center && el.center.lat;
      const lon = el.lon != null ? el.lon : el.center && el.center.lon;
      if (lat == null || lon == null) return null;
      const tags = el.tags || {};
      const type = tags['seamark:type'];
      const category = categoryOf(type);
      if (!category) return null;
      return {
        lat,
        lon,
        type,
        category,
        name: tags['seamark:name'] || tags['seamark:berth:name'] || tags.name || null,
        tags,
      };
    })
    .filter(Boolean);
}

// Cached fetch. On failure resolves to [] (cached) so a flaky Overpass call
// doesn't keep retrying on every poll; reload the area to retry.
export function loadSeamarks(bbox) {
  const key = bboxStr(bbox);
  if (!cache.has(key)) cache.set(key, fetchSeamarks(bbox).catch(() => []));
  return cache.get(key);
}

function seamarkPopup(f) {
  return (
    `<div class="berth-popup seamark-popup">` +
    `<b style="font-size:1rem">⚓ ${escHtml(f.name || categoryLabel(f.category))}</b><br>` +
    `<span class="seamark-type">${escHtml(categoryLabel(f.category))}</span>` +
    `<div class="seamark-source">${escHtml(t('seamark.source'))} · ${escHtml(f.type)}</div>` +
    `</div>`
  );
}

// Draw the OpenSeaMap markers on the overview map, skipping any category the user
// has hidden. No-op (and clears) when the feature is off. Safe to call on every
// poll: data is cached by bbox and only the cheap marker redraw runs. Awaits the
// fetch then re-checks state so an area switch / toggle-off mid-fetch can't draw
// stale markers.
export async function renderSeamarkBerths() {
  if (!S.activeMap) return;
  if (!S.activeMap.getPane('seamarkBerths')) {
    // Above the auto-computed berths pane (350), below the default overlay pane
    // (400) where the ship markers live, so OpenSeaMap marks never steal clicks.
    const pane = S.activeMap.createPane('seamarkBerths');
    pane.style.zIndex = 360;
  }
  if (!S.seamarkBerthsLayer) S.seamarkBerthsLayer = L.layerGroup().addTo(S.activeMap);
  if (!S.showOpenSeaMapMarkers || !S.currentBbox) {
    S.seamarkBerthsLayer.clearLayers();
    return;
  }
  const bbox = S.currentBbox;
  let features;
  try {
    features = await loadSeamarks(bbox);
  } catch {
    return;
  }
  // Area changed or feature turned off while awaiting → drop this result.
  if (!S.showOpenSeaMapMarkers || S.currentBbox !== bbox || !S.seamarkBerthsLayer) return;
  const hidden = new Set(S.openSeaMapHidden || []);
  S.seamarkBerthsLayer.clearLayers();
  const mapSize = S.activeMap.getSize();
  for (const f of features) {
    if (hidden.has(f.category)) continue;
    const color = (CAT_BY_KEY.get(f.category) || {}).color || '#f59e0b';
    // Flip tooltip below the marker when near the top of the viewport.
    const pt = S.activeMap.latLngToContainerPoint([f.lat, f.lon]);
    const tipDirection = pt.y < mapSize.y * 0.35 ? 'bottom' : 'top';
    L.circleMarker([f.lat, f.lon], {
      pane: 'seamarkBerths',
      radius: 6,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.45,
      dashArray: '2,2',
    })
      .bindTooltip(seamarkTooltip(f), {
        direction: tipDirection,
        className: 'seamark-tooltip',
        opacity: 1,
      })
      .bindPopup(seamarkPopup(f))
      .addTo(S.seamarkBerthsLayer);
  }
}
