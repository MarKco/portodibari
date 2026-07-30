// "Ricerca navi per aree di transito" — pick two of your monitored areas and see
// which ships called at BOTH (a real stop, not a bbox crossing) and how many
// times they sailed straight from one to the other. The point is discovery: the
// interesting rows are ships nobody followed yet.
//
// The counts come from port_events (the long-lived history); the per-leg replay
// instead needs positions, which are capped globally (MAX_READINGS_PER_TYPE) and
// only ever recorded INSIDE the monitored boxes — so the open-sea part of a leg
// is normally missing. showLegReplay draws what exists as a solid track and the
// missing stretches as a dashed "estimated" line, clearly labelled as such.

import { el } from './dom.js';
import { S } from './store.js';
import { api } from './api.js';
import { t, getLang } from './i18n.js';
import { escHtml, formatTime, shipTypeBadge, riskBadge } from './helpers.js';
import { flagSeenButtonsHtml, bindFlagSeenButtons, bindShipRows, updateFilterCount } from './ships.js';
import { addBaseLayers } from './tiles.js';
import { showAlert } from './toast.js';

// Playback of one leg always takes this long, whatever the leg's real duration:
// a single ship on a single trip needs a readable sweep, not a speed multiplier.
const PLAY_MS = 20000;
const PAD_MS = 2 * 3600000; // fetch a couple of hours around the leg for context

let result = null; // last /api/transits response
let filterText = '';
let sort = { col: 'legs', dir: 'desc' };

function areaOptions() {
  return Object.entries(S.presets || {})
    .map(([k, v]) => `<option value="${escHtml(k)}">${escHtml(v.name || k)}</option>`)
    .join('');
}

// Enter the view: (re)fill the two area pickers from the user's areas, restoring
// the previous choice when those areas still exist.
export function enterTransitsView() {
  document.title = `${t('app.title')} - ${t('transits.title')}`;
  const keys = Object.keys(S.presets || {});
  const opts = areaOptions();
  el.transitsAreaA.innerHTML = opts;
  el.transitsAreaB.innerHTML = opts;
  const savedA = localStorage.getItem('transitsAreaA');
  const savedB = localStorage.getItem('transitsAreaB');
  el.transitsAreaA.value = keys.includes(savedA) ? savedA : keys[0] || '';
  el.transitsAreaB.value = keys.includes(savedB) && savedB !== el.transitsAreaA.value
    ? savedB
    : keys.find((k) => k !== el.transitsAreaA.value) || '';
  if (keys.length < 2) {
    el.transitsResults.classList.add('hidden');
    showAlert(t('transits.needTwoAreas'));
  }
}

async function search() {
  const a = el.transitsAreaA.value;
  const b = el.transitsAreaB.value;
  if (!a || !b) return showAlert(t('transits.needTwoAreas'));
  if (a === b) return showAlert(t('transits.sameArea'));
  localStorage.setItem('transitsAreaA', a);
  localStorage.setItem('transitsAreaB', b);
  const qs = new URLSearchParams({
    a, b,
    period: el.transitsPeriod.value || 'all',
    includeNoLeg: el.transitsNoLeg.checked ? '1' : '0',
    lang: getLang(),
  });
  el.transitsBody.innerHTML = `<tr><td colspan="7" class="empty">${t('transits.searching')}</td></tr>`;
  el.transitsResults.classList.remove('hidden');
  try {
    result = await api(`/api/transits?${qs}`);
    render();
  } catch (e) {
    result = null;
    el.transitsBody.innerHTML = `<tr><td colspan="7" class="empty">${escHtml(e?.message || t('transits.error'))}</td></tr>`;
  }
}

function matchesFilter(s) {
  if (!filterText) return true;
  const q = filterText.toLowerCase();
  return [s.ship_name, String(s.mmsi), s.destination_label, s.destination]
    .some((v) => v && String(v).toLowerCase().includes(q));
}

function sortRows(rows) {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const val = (s) => {
    switch (sort.col) {
      case 'ship_name': return (s.ship_name || '').toLowerCase();
      case 'mmsi': return s.mmsi;
      case 'ship_type': return s.ship_type ?? -1;
      case 'legs': return s.legs;
      case 'lastLeg': return s.lastLeg?.arrivedAt || '';
      case 'risk': return s.risk?.score ?? -1;
      default: return 0;
    }
  };
  return [...rows].sort((x, y) => {
    const a = val(x), b = val(y);
    if (a < b) return -1 * dir;
    if (a > b) return 1 * dir;
    return y.legs - x.legs;
  });
}

// "A→B" / "B→A" using the real area names, so a row reads as an actual route.
function legDirection(leg) {
  if (!leg || !result) return '';
  const name = (key) => (key === result.areaA.key ? result.areaA.name : result.areaB.name);
  return `${escHtml(name(leg.from))} → ${escHtml(name(leg.to))}`;
}

function lastLegCell(s) {
  if (!s.lastLeg) return '—';
  return `
    ${formatTime(s.lastLeg.arrivedAt)}
    <span class="leg-dir">${legDirection(s.lastLeg)}</span>
    <button class="btn btn-secondary btn-sm leg-replay-btn" data-mmsi="${s.mmsi}"
            title="${escHtml(t('transits.replayTitle'))}">${t('transits.replayBtn')}</button>`;
}

function render() {
  if (!result) return;
  const { areaA, areaB, gate } = result;
  el.transitsThLegs.textContent = t('transits.colLegs', { a: areaA.name, b: areaB.name });
  el.transitsGate.textContent = t('transits.gateNote', {
    stopH: gate.stopMinH,
    dist: Math.round(gate.distNm),
    hours: Math.round(gate.gateH),
  });
  // Never let a capped result read as "this is everything".
  if (result.truncated) {
    el.transitsGate.textContent += ` ${t('transits.truncated', { shown: (result.ships || []).length, total: result.total })}`;
  }

  const all = result.ships || [];
  const rows = sortRows(all.filter(matchesFilter));
  updateFilterCount('transits-filter-count', rows.length, all.length);

  if (!rows.length) {
    el.transitsBody.innerHTML =
      `<tr><td colspan="7" class="empty">${all.length ? t('filter.noMatch') : t('transits.empty')}</td></tr>`;
    applySortHeader();
    return;
  }

  el.transitsBody.innerHTML = rows
    .map(
      (s) => `
    <tr class="ship-row ${s.is_military ? 'military-row' : s.risk?.band === 'high' ? 'risk-row' : ''} ${s.flagged ? 'flagged-row' : ''} ${s.seen ? 'seen-row' : ''} ${s.chargedBy?.length ? 'charged-row' : ''}" data-mmsi="${s.mmsi}">
      <td class="col-flags">${flagSeenButtonsHtml(s)}</td>
      <td class="ship-name">${escHtml(s.ship_name) || '—'}</td>
      <td class="mono">${s.mmsi}</td>
      <td>${shipTypeBadge(s.ship_type)}</td>
      <td class="mono" title="${escHtml(t('transits.stopsTitle', { a: areaA.name, na: s.stopsA, b: areaB.name, nb: s.stopsB }))}">${s.legs}</td>
      <td class="transits-lastleg">${lastLegCell(s)}</td>
      <td class="col-risk">${riskBadge(s.risk)}</td>
    </tr>`
    )
    .join('');

  bindShipRows(el.transitsBody, 'transits', rows);
  bindFlagSeenButtons(el.transitsBody, search);
  el.transitsBody.querySelectorAll('.leg-replay-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // never open the ship detail from the replay button
      const s = rows.find((x) => x.mmsi === Number(btn.dataset.mmsi));
      if (s) showLegReplay(s);
    });
  });
  applySortHeader();
}

// Same sort-arrow convention as the other lists (.sort-asc / .sort-desc on th).
function applySortHeader() {
  const thead = document.querySelector('#view-transits thead');
  if (!thead) return;
  for (const th of thead.querySelectorAll('th[data-col]')) {
    th.classList.toggle('sort-asc', th.dataset.col === sort.col && sort.dir === 'asc');
    th.classList.toggle('sort-desc', th.dataset.col === sort.col && sort.dir === 'desc');
  }
}

// ── Leg replay overlay ───────────────────────────────────────────────────────
// Reuses the shared centred modal (#modal-overlay, already responsive) rather
// than the draggable desktop-only log window. The Leaflet map is created once
// and its container re-attached on every open: destroying/recreating maps would
// leave stale entries in the shared seamark-layer registry (see tiles.js).

let leg = null; // { map, layer, wrap, points, t0, t1, clock, playing, rafId, ... }

function legDom() {
  if (leg?.wrap) return leg;
  const wrap = document.createElement('div');
  wrap.className = 'leg-replay';
  wrap.innerHTML = `
    <div class="leg-replay-map" id="leg-replay-map"></div>
    <div class="leg-replay-bar">
      <button class="btn btn-secondary btn-sm" id="leg-play">▶</button>
      <input type="range" id="leg-slider" min="0" max="1000" value="0">
      <span class="leg-clock mono" id="leg-clock">—</span>
    </div>
    <p class="leg-replay-info" id="leg-info"></p>`;
  leg = { wrap, map: null, layer: null, points: [], playing: false, rafId: null };
  return leg;
}

function legStop() {
  if (leg?.rafId) cancelAnimationFrame(leg.rafId);
  if (leg) { leg.rafId = null; leg.playing = false; }
  const play = document.getElementById('leg-play');
  if (play) play.textContent = '▶';
}

function legFrame() {
  const p = leg.points;
  if (!p.length) return;
  const clock = leg.clock;
  // Position at `clock`: interpolate between the surrounding fixes. Across a gap
  // the marker keeps moving along the dashed estimated line — that stretch is
  // openly presented as a guess, so a moving marker is honest here (unlike the
  // area replay, which holds a ship still rather than invent traffic).
  let i = 0;
  while (i < p.length - 1 && new Date(p[i + 1].received_at).getTime() <= clock) i++;
  const a = p[i], b = p[Math.min(i + 1, p.length - 1)];
  const ta = new Date(a.received_at).getTime(), tb = new Date(b.received_at).getTime();
  const f = tb > ta ? Math.min(1, Math.max(0, (clock - ta) / (tb - ta))) : 0;
  const lat = a.latitude + (b.latitude - a.latitude) * f;
  const lon = a.longitude + (b.longitude - a.longitude) * f;
  leg.marker.setLatLng([lat, lon]);
  document.getElementById('leg-clock').textContent = formatTime(new Date(clock).toISOString());
  const slider = document.getElementById('leg-slider');
  if (slider && document.activeElement !== slider) {
    slider.value = String(Math.round(((clock - leg.t0) / (leg.t1 - leg.t0 || 1)) * 1000));
  }
}

function legTick(ts) {
  if (!leg.playing) return;
  const dt = leg.lastTs ? ts - leg.lastTs : 0;
  leg.lastTs = ts;
  leg.clock += (dt / PLAY_MS) * (leg.t1 - leg.t0);
  if (leg.clock >= leg.t1) { leg.clock = leg.t1; legStop(); legFrame(); return; }
  legFrame();
  leg.rafId = requestAnimationFrame(legTick);
}

export async function showLegReplay(ship) {
  const L2 = window.L;
  const l = ship.lastLeg;
  if (!l) return;
  const d = legDom();
  el.modalTitle.textContent = t('transits.replayModalTitle', {
    ship: ship.ship_name || ship.mmsi,
    route: legDirection(l).replace(/<[^>]*>/g, ''),
  });
  el.modalBody.replaceChildren(d.wrap);
  el.modalOverlay.classList.remove('hidden');

  if (!d.map) {
    d.map = L2.map('leg-replay-map', { zoomControl: true });
    // A Leaflet map with no view has no pixel bounds, and adding any layer to it
    // throws inside _clipPoints — so set a placeholder view before the layers
    // (fitBounds replaces it as soon as the track is in).
    d.map.setView([41.138, 16.843], 6); // same placeholder the other maps use
    addBaseLayers(d.map);
    d.layer = L2.layerGroup().addTo(d.map);
    d.marker = L2.circleMarker([0, 0], { radius: 7, color: '#93c5fd', fillColor: '#2563eb', fillOpacity: 1, weight: 2.5 }).addTo(d.map);
    document.getElementById('leg-play').addEventListener('click', () => {
      if (leg.playing) { legStop(); return; }
      if (leg.clock >= leg.t1) leg.clock = leg.t0;
      leg.playing = true;
      leg.lastTs = null;
      document.getElementById('leg-play').textContent = '⏸';
      leg.rafId = requestAnimationFrame(legTick);
    });
    document.getElementById('leg-slider').addEventListener('input', (e) => {
      legStop();
      leg.clock = leg.t0 + (Number(e.target.value) / 1000) * (leg.t1 - leg.t0);
      legFrame();
    });
    // Every close path (× button, backdrop click, Escape) just hides the overlay
    // from main.js, so watch the class instead of duplicating those handlers.
    new window.MutationObserver(() => {
      if (el.modalOverlay.classList.contains('hidden')) legStop();
    }).observe(el.modalOverlay, { attributes: true, attributeFilter: ['class'] });
  }
  // A Leaflet map in a zero-height container renders nothing and says nothing.
  // That happens whenever the stylesheet is stale (the service worker serves the
  // shell cache-first, so a CSS change only lands after CACHE is bumped) — the
  // overlay then opens with working controls and an invisible map. Fall back to an
  // explicit height so the map is always usable, whatever the CSS says.
  const mapEl = document.getElementById('leg-replay-map');
  if (mapEl && mapEl.clientHeight < 80) mapEl.style.height = 'min(52vh, 420px)';
  d.map.invalidateSize();
  d.layer.clearLayers();

  const from = new Date(new Date(l.departedAt).getTime() - PAD_MS).toISOString();
  const to = new Date(new Date(l.arrivedAt).getTime() + PAD_MS).toISOString();
  const info = document.getElementById('leg-info');
  info.textContent = t('transits.replayLoading');

  let points = [];
  try {
    const res = await api(`/api/ships/${ship.mmsi}/track?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&scraped=1&limit=2000`);
    points = (res.points || []).filter((p) => p.latitude != null && p.longitude != null);
  } catch {
    /* leave points empty → handled below */
  }
  leg.points = points;

  if (!points.length) {
    info.textContent = t('transits.replayNoData', {
      from: formatTime(l.departedAt), to: formatTime(l.arrivedAt),
    });
    document.getElementById('leg-clock').textContent = '—';
    return;
  }

  // Solid where consecutive fixes are close in time, dashed grey across the gaps
  // (open sea, where nothing was recorded): the dashed stretch is a straight-line
  // guess between two known points, not a recorded route.
  const gapMs = (S.replayMaxGapMin || 30) * 60000;
  let estimatedMin = 0;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1], p1 = points[i];
    const dt = new Date(p1.received_at).getTime() - new Date(p0.received_at).getTime();
    const latlngs = [[p0.latitude, p0.longitude], [p1.latitude, p1.longitude]];
    if (dt > gapMs) {
      estimatedMin += dt / 60000;
      L2.polyline(latlngs, { color: '#9ca3af', weight: 2, dashArray: '6 8', opacity: 0.9 }).addTo(d.layer);
    } else {
      L2.polyline(latlngs, { color: '#2563eb', weight: 3, opacity: 0.85 }).addTo(d.layer);
    }
  }
  const first = points[0], last = points[points.length - 1];
  L2.circleMarker([first.latitude, first.longitude], { radius: 6, color: '#34d399', fillColor: '#059669', fillOpacity: 1, weight: 2 })
    .addTo(d.layer).bindTooltip(`${t('transits.legStart')} · ${formatTime(first.received_at)}`);
  L2.circleMarker([last.latitude, last.longitude], { radius: 6, color: '#f87171', fillColor: '#dc2626', fillOpacity: 1, weight: 2 })
    .addTo(d.layer).bindTooltip(`${t('transits.legEnd')} · ${formatTime(last.received_at)}`);
  d.map.fitBounds(L2.latLngBounds(points.map((p) => [p.latitude, p.longitude])).pad(0.2));

  leg.t0 = new Date(first.received_at).getTime();
  leg.t1 = new Date(last.received_at).getTime();
  leg.clock = leg.t0;
  legFrame();
  info.textContent = t('transits.replayInfo', {
    n: points.length,
    from: formatTime(l.departedAt),
    to: formatTime(l.arrivedAt),
    estimated: Math.round(estimatedMin / 60),
  });
}

// ── Init (bound once at module load; the markup is static) ───────────────────
export function initTransits() {
  if (!el.btnTransitsSearch) return;
  el.btnTransitsSearch.addEventListener('click', search);
  el.transitsNoLeg.addEventListener('change', search);
  el.transitsSearch.addEventListener('input', () => {
    filterText = el.transitsSearch.value.trim();
    render();
  });
  // Changing an area invalidates the shown result — hide it until "Cerca" again.
  for (const sel of [el.transitsAreaA, el.transitsAreaB, el.transitsPeriod]) {
    sel.addEventListener('change', () => {
      result = null;
      el.transitsResults.classList.add('hidden');
    });
  }
  const thead = document.querySelector('#view-transits thead');
  for (const th of thead?.querySelectorAll('th[data-col]') || []) {
    th.addEventListener('click', () => {
      if (sort.col === th.dataset.col) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      else { sort.col = th.dataset.col; sort.dir = th.dataset.col === 'ship_name' ? 'asc' : 'desc'; }
      render();
    });
  }
}
