import { S } from './store.js';
import { api } from './api.js';
import {
  haversineM,
  formatTime,
  directionBadge,
  shipTypeLabel,
  riskBadge,
  escHtml,
} from './helpers.js';
import { showView } from './views.js';
import { t } from './i18n.js';
import { addBaseLayers } from './tiles.js';
import { renderSeamarkBerths } from './seamarks.js';

// Bbox the active map was last framed to, so we re-fit only when the area
// changes — not on every poll, which would fight the user's pan/zoom.
let activeFitKey = null;

// Mark the current area bbox as already framed, so the next renderActiveMap
// skips its fitBounds. Used when navigating to a berth: otherwise the area
// fitBounds animation fights focusBerth's, and Leaflet drops the later one
// mid-animation — leaving the map on the area box instead of the berth.
export function primeActiveFit() {
  if (S.currentBbox) activeFitKey = JSON.stringify(S.currentBbox);
}

// ── Detail map (single ship track) ───────────────────────────────────────────
function initMap() {
  if (S.aisMap) return;
  S.aisMap = L.map('detail-map', { zoomControl: true }).setView([41.138, 16.843], 13);
  addBaseLayers(S.aisMap);
  S.trackLayer = L.layerGroup().addTo(S.aisMap);
  // Separate layer for scraped (ShipFinder) last-known positions — kept apart from
  // the AIS track so loadTrack()'s clearLayers() doesn't wipe them and they render
  // as distinct, un-connected markers.
  S.sfLayer = L.layerGroup().addTo(S.aisMap);
  // Same idea for MyShipTracking last-known positions — its own layer so the two
  // scraped sources clear independently and render as distinct-coloured markers.
  S.mstLayer = L.layerGroup().addTo(S.aisMap);
  // Re-render tiles when container resizes (e.g. VF data loads and grows the flex row)
  const ro = new ResizeObserver(() => S.aisMap && S.aisMap.invalidateSize());
  ro.observe(document.getElementById('detail-map'));
}

// Draw ShipFinder scraped positions as distinct amber markers on their own layer,
// un-connected (no polyline) so they read clearly as "last known, scraped" fixes
// rather than part of the live AIS track. The newest fix is emphasised. When the
// AIS track is empty (a ship gone dark to our stream — the typical case for these),
// fit the map to the scraped points so the user still sees where it was last.
export function renderSfPositions(positions, { focus = false } = {}) {
  initMap();
  if (!S.sfLayer) return;
  S.sfLayer.clearLayers();
  const pts = (positions || []).filter((p) => p.lat != null && p.lon != null);
  if (!pts.length) return;
  pts.forEach((p, i) => {
    const isLast = i === pts.length - 1;
    L.circleMarker([p.lat, p.lon], {
      radius: isLast ? 8 : 5,
      color: '#b45309',
      fillColor: isLast ? '#f59e0b' : '#fbbf24',
      fillOpacity: 0.9,
      weight: 2,
      dashArray: '3 2',
    })
      .bindPopup(
        `<b>📍 ${t('map.sfLastKnown')}</b><br>${formatTime(p.received_at)}<br>` +
          `SOG: ${p.sog != null ? Number(p.sog).toFixed(1) + ' kn' : '—'}&nbsp;&nbsp;` +
          `COG: ${p.cog != null && p.cog <= 360 ? Number(p.cog).toFixed(0) + '°' : '—'}`
      )
      .addTo(S.sfLayer);
  });
  const last = pts[pts.length - 1];
  const noAisTrack = !S.trackLayer || S.trackLayer.getLayers().length === 0;
  if ((focus || noAisTrack) && S.aisMap) {
    const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lon]));
    if (bounds.isValid()) S.aisMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  }
  return last;
}

// MyShipTracking counterpart of renderSfPositions — same un-connected "last known"
// markers on their own layer, in teal/cyan to tell them apart from ShipFinder's amber.
export function renderMstPositions(positions, { focus = false } = {}) {
  initMap();
  if (!S.mstLayer) return;
  S.mstLayer.clearLayers();
  const pts = (positions || []).filter((p) => p.lat != null && p.lon != null);
  if (!pts.length) return;
  pts.forEach((p, i) => {
    const isLast = i === pts.length - 1;
    L.circleMarker([p.lat, p.lon], {
      radius: isLast ? 8 : 5,
      color: '#0e7490',
      fillColor: isLast ? '#06b6d4' : '#67e8f9',
      fillOpacity: 0.9,
      weight: 2,
      dashArray: '3 2',
    })
      .bindPopup(
        `<b>📍 ${t('map.mstLastKnown')}</b><br>${formatTime(p.received_at)}<br>` +
          `SOG: ${p.sog != null ? Number(p.sog).toFixed(1) + ' kn' : '—'}&nbsp;&nbsp;` +
          `COG: ${p.cog != null && p.cog <= 360 ? Number(p.cog).toFixed(0) + '°' : '—'}`
      )
      .addTo(S.mstLayer);
  });
  const last = pts[pts.length - 1];
  const noAisTrack = !S.trackLayer || S.trackLayer.getLayers().length === 0;
  if ((focus || noAisTrack) && S.aisMap) {
    const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lon]));
    if (bounds.isValid()) S.aisMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  }
  return last;
}

// Collapse consecutive stationary points (SOG≈0) that stay within the merge
// radius into a single "sosta" node — declutters anchor-swing / current drift.
function collapseTrack(pts) {
  const nodes = [];
  let cl = null;
  for (const p of pts) {
    const stopped = p.sog != null && p.sog < S.trackSogStop;
    if (
      cl &&
      cl.stopped &&
      stopped &&
      haversineM(cl.latitude, cl.longitude, p.latitude, p.longitude) < S.trackMergeRadiusM
    ) {
      cl.count++;
      cl.toTime = p.received_at;
      cl._latSum += p.latitude;
      cl._lonSum += p.longitude;
      cl.latitude = cl._latSum / cl.count;
      cl.longitude = cl._lonSum / cl.count;
      cl.sog = p.sog;
      cl.cog = p.cog;
      if ((p.source || 'ais') !== cl.source) cl.source = 'mixed';
    } else {
      if (cl) nodes.push(cl);
      cl = {
        latitude: p.latitude,
        longitude: p.longitude,
        received_at: p.received_at,
        fromTime: p.received_at,
        toTime: p.received_at,
        sog: p.sog,
        cog: p.cog,
        source: p.source || 'ais',
        stopped,
        count: 1,
        _latSum: p.latitude,
        _lonSum: p.longitude,
      };
    }
  }
  if (cl) nodes.push(cl);
  return nodes;
}

// Bearing (deg, 0=N) from point A to point B — fallback when COG is missing.
function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dLon = (lon2 - lon1) * r;
  const y = Math.sin(dLon) * Math.cos(lat2 * r);
  const x =
    Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLon);
  return (Math.atan2(y, x) / r + 360) % 360;
}

// COG counts as a usable heading only when present and below the AIS
// "not available" sentinel (≥360). Otherwise fall back to segment bearing.
function cogValid(c) {
  return c != null && c >= 0 && c < 360;
}

const lerp = (a, b, t) => a + (b - a) * t;

// Rotatable ship glyph (points north at 0°); Leaflet translates the outer
// icon, so we rotate the inner element on each frame.
const SHIP_ICON = L.divIcon({
  className: 'track-ship',
  html: '<div class="track-ship-rot"><svg viewBox="0 0 24 24" width="26" height="26"><path d="M12 2 L19 21 L12 17 L5 21 Z"/></svg></div>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

const TRACK_DURATION_MS = 12000;

const isoToLocal = (iso) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const localToIso = (v) => (v ? new Date(v).toISOString() : null);

// Stop and tear down any running track playback (called on reload / leaving
// the detail view). Leaves the static layer intact.
export function stopTrackAnim() {
  const A = S.trackAnim;
  if (!A) return;
  if (A.rafId) cancelAnimationFrame(A.rafId);
  if (A.play) A.play.onclick = null;
  if (A.slider) A.slider.oninput = null;
  S.trackAnim = null;
}

let _trackCtrlsInited = false;
function initTrackControls() {
  if (_trackCtrlsInited) return;
  _trackCtrlsInited = true;

  const winBtns = document.querySelectorAll('.track-win');
  winBtns.forEach((b) =>
    b.addEventListener('click', () => {
      winBtns.forEach((x) => x.classList.toggle('active', x === b));
      loadTrack(S.detailMmsi, { window: b.dataset.win });
    })
  );

  const applyBtn = document.getElementById('track-apply');
  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      const from = localToIso(document.getElementById('track-from').value);
      const to   = localToIso(document.getElementById('track-to').value);
      if (from && to && from < to) {
        winBtns.forEach((x) => x.classList.remove('active'));
        loadTrack(S.detailMmsi, { from, to });
      }
    });
  }

  const speedBtns = document.querySelectorAll('.track-speed');
  speedBtns.forEach((b) =>
    b.addEventListener('click', () => {
      speedBtns.forEach((x) => x.classList.toggle('active', x === b));
      const newSpeed = Number(b.dataset.speed);
      const A = S.trackAnim;
      if (A) {
        A.startTs = performance.now() - (A.p * TRACK_DURATION_MS) / newSpeed;
        A.speed = newSpeed;
      }
    })
  );

  // "Includi SF/MST" — fold scraped positions into the animated track, then
  // reload with the same window so the change takes effect immediately.
  const scrapedToggle = document.getElementById('track-use-scraped');
  if (scrapedToggle) scrapedToggle.addEventListener('change', () => {
    S.trackUseScraped = scrapedToggle.checked;
    loadTrack(S.detailMmsi, _lastTrackOpts || {});
  });
}

// Remembers the last loadTrack options so the SF/MST toggle can reload the same
// window/range without resetting the view to "all".
let _lastTrackOpts = null;

export async function loadTrack(mmsi, opts = {}) {
  initMap();
  stopTrackAnim();
  S.aisMap.invalidateSize();
  S.trackLayer.clearLayers();
  if (S.sfLayer) S.sfLayer.clearLayers(); // SF markers re-added by loadSfData
  if (S.mstLayer) S.mstLayer.clearLayers(); // MST markers re-added by loadMstData
  const ctrls = document.getElementById('track-anim');
  if (ctrls) ctrls.classList.add('hidden');

  initTrackControls();
  // Remember only the query-affecting options (not the keepView refresh flag), so
  // the SF/MST toggle and the poll refresh reload the SAME window the user chose.
  _lastTrackOpts = { from: opts.from, to: opts.to, window: opts.window };

  const q = new URLSearchParams();
  if (opts.from && opts.to) { q.set('from', opts.from); q.set('to', opts.to); }
  else if (opts.window)     { q.set('window', opts.window); }
  // Ask the server to fold in SF/MST scraped positions when the toggle is on.
  if (S.trackUseScraped) q.set('scraped', '1');
  const qs = q.toString() ? `?${q}` : '';

  try {
    const data = await api(`/api/ships/${mmsi}/track${qs}`);
    const pts = data.points || [];

    // Show the "Includi SF/MST" toggle only when the ship has scraped positions
    // and the integrations are on (server reports extraAvailable).
    const scrapedWrap = document.getElementById('track-use-scraped-wrap');
    const scrapedToggle = document.getElementById('track-use-scraped');
    if (scrapedWrap) scrapedWrap.classList.toggle('hidden', !data.extraAvailable);
    if (scrapedToggle) scrapedToggle.checked = S.trackUseScraped;

    // Pre-fill date inputs with the ship's full data range on first open.
    if (!opts.from && !opts.window && data.range && data.range.lo) {
      const fromEl = document.getElementById('track-from');
      const toEl   = document.getElementById('track-to');
      if (fromEl && !fromEl.value) fromEl.value = isoToLocal(data.range.lo);
      if (toEl   && !toEl.value)   toEl.value   = isoToLocal(data.range.hi);
    }

    if (!pts.length) return;

    const nodes = collapseTrack(pts);
    const latlngs = nodes.map((n) => [n.latitude, n.longitude]);
    // Full route as faint context; a bright trail grows over it during playback.
    L.polyline(latlngs, { color: '#3b82f6', weight: 2, opacity: 0.22 }).addTo(S.trackLayer);
    nodes.forEach((n, i) => {
      const isLast = i === nodes.length - 1;
      const isSosta = n.count > 1;
      // Scraped (SF/MST) nodes get a distinct fill — amber for ShipFinder, teal
      // for MyShipTracking (same convention as the standalone scraped markers) —
      // so it stays clear which stretches of the route are not live AIS.
      const scraped = n.source && n.source !== 'ais';
      const scrapedColor = n.source === 'sf' ? '#d97706' : n.source === 'mst' ? '#0e7490' : '#6b7280';
      L.circleMarker([n.latitude, n.longitude], {
        radius: isLast ? 9 : isSosta ? 7 : 5,
        color: isLast ? '#34d399' : scraped ? scrapedColor : isSosta ? '#38bdf8' : '#3b82f6',
        fillColor: isLast ? '#34d399' : scraped ? scrapedColor : isSosta ? '#0ea5e9' : '#1e40af',
        fillOpacity: 0.85,
        weight: isLast ? 2.5 : 1.5,
      })
        .bindPopup(
          `<b>${isLast ? t('map.lastPos') : isSosta ? t('map.stay') : formatTime(n.received_at)}</b><br>` +
            `${isLast ? formatTime(n.received_at) + '<br>' : ''}` +
            `${isSosta ? `${t('map.stays', { n: n.count, from: formatTime(n.fromTime), to: formatTime(n.toTime) })}<br>` : ''}` +
            `${scraped ? `<span class="cargo-src">${t('track.srcScraped', { src: n.source === 'sf' ? 'ShipFinder' : n.source === 'mst' ? 'MyShipTracking' : 'SF/MST' })}</span><br>` : ''}` +
            `SOG: ${n.sog != null ? n.sog.toFixed(1) + ' kn' : '—'}&nbsp;&nbsp;` +
            `COG: ${n.cog != null && n.cog <= 360 ? n.cog.toFixed(0) + '°' : '—'}`
        )
        .addTo(S.trackLayer);
    });

    // On a background poll refresh (keepView) leave the user's pan/zoom alone.
    const bounds = L.latLngBounds(latlngs);
    if (bounds.isValid() && !opts.keepView) S.aisMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });

    // Read current speed from active button (or default 20×).
    const activeSpeed = document.querySelector('.track-speed.active');
    setupTrackAnim(nodes, activeSpeed ? Number(activeSpeed.dataset.speed) : 20, { autoplay: !opts.keepView });
  } catch {
    /* track unavailable */
  }
}

// Build playback over the collapsed nodes: a ship marker (rotated by COG, or
// segment bearing when COG is missing) sliding along the path at a fixed total
// duration, with a trail that grows behind it. Autoplays; play/pause + a
// timeline scrubber let the user replay or seek. Speed multiplier scales how
// fast p advances — 20× default means 12 s total / 20 = 0.6 s real time.
function setupTrackAnim(nodes, speed = 20, { autoplay = true } = {}) {
  const ctrls = document.getElementById('track-anim');
  if (!ctrls || nodes.length < 2) return;

  // Cumulative geometry — progress maps to distance so the pace is spatially
  // uniform regardless of how long the ship lingered between fixes.
  const segs = [];
  let total = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const d = haversineM(a.latitude, a.longitude, b.latitude, b.longitude);
    segs.push({ i, d, cum: total });
    total += d;
  }
  if (total <= 0) return; // all positions coincide — nothing to animate

  const play = document.getElementById('track-play');
  const slider = document.getElementById('track-slider');
  const timeEl = document.getElementById('track-time');
  ctrls.classList.remove('hidden');

  const trail = L.polyline([latOf(0)], { color: '#3b82f6', weight: 3.5, opacity: 0.95 }).addTo(
    S.trackLayer
  );
  const ship = L.marker(latOf(0), { icon: SHIP_ICON, interactive: false, zIndexOffset: 1000 }).addTo(
    S.trackLayer
  );

  const A = { rafId: null, playing: false, p: 0, startTs: null, speed, play, slider, ship, trail };
  S.trackAnim = A;

  function latOf(i) {
    return [nodes[i].latitude, nodes[i].longitude];
  }

  // Render the scene at progress p∈[0,1].
  function render(p) {
    const dd = p * total;
    let s = segs[segs.length - 1];
    for (const seg of segs) {
      if (dd <= seg.cum + seg.d) {
        s = seg;
        break;
      }
    }
    const a = nodes[s.i];
    const b = nodes[s.i + 1];
    const lt = s.d > 0 ? (dd - s.cum) / s.d : 1;
    const lat = lerp(a.latitude, b.latitude, lt);
    const lon = lerp(a.longitude, b.longitude, lt);

    ship.setLatLng([lat, lon]);
    const hdg = cogValid(a.cog) ? a.cog : bearing(a.latitude, a.longitude, b.latitude, b.longitude);
    const rot = ship.getElement()?.querySelector('.track-ship-rot');
    if (rot) rot.style.transform = `rotate(${hdg}deg)`;

    const pts = nodes.slice(0, s.i + 1).map((n) => [n.latitude, n.longitude]);
    pts.push([lat, lon]);
    trail.setLatLngs(pts);

    const ta = new Date(a.received_at).getTime();
    const tb = new Date(b.received_at).getTime();
    timeEl.textContent = formatTime(new Date(lerp(ta, tb, lt)).toISOString());
    slider.value = String(Math.round(p * 1000));
  }

  function setPlaying(on) {
    A.playing = on;
    play.textContent = on ? '⏸' : '▶';
    play.title = on ? t('map.pause') : t('map.play');
  }

  function step(ts) {
    if (!A.playing) return;
    if (A.startTs == null) A.startTs = ts - (A.p * TRACK_DURATION_MS) / A.speed;
    A.p = Math.min(1, ((ts - A.startTs) * A.speed) / TRACK_DURATION_MS);
    render(A.p);
    if (A.p >= 1) {
      setPlaying(false);
      return;
    }
    A.rafId = requestAnimationFrame(step);
  }

  play.onclick = () => {
    if (A.playing) {
      if (A.rafId) cancelAnimationFrame(A.rafId);
      setPlaying(false);
      return;
    }
    if (A.p >= 1) A.p = 0; // replay from start
    A.startTs = null;
    setPlaying(true);
    A.rafId = requestAnimationFrame(step);
  };

  slider.oninput = () => {
    if (A.rafId) cancelAnimationFrame(A.rafId);
    setPlaying(false);
    A.p = Number(slider.value) / 1000;
    render(A.p);
  };

  // Autoplay (skipped on a background poll refresh so it doesn't restart the
  // animation under the user every 5 minutes).
  render(0);
  if (!autoplay) { setPlaying(false); return; }
  setPlaying(true);
  A.startTs = null;
  A.rafId = requestAnimationFrame(step);
}

// Reload the current ship's track on a background poll without disturbing the
// user's chosen window, pan/zoom, or playback state.
export function refreshTrack() {
  if (S.detailMmsi != null) loadTrack(S.detailMmsi, { ...(_lastTrackOpts || {}), keepView: true });
}

// ── Active-ships overview map ────────────────────────────────────────────────
export function initActiveMap() {
  if (S.activeMap) return;
  S.activeMap = L.map('active-map', { zoomControl: true }).setView([41.138, 16.843], 12);
  addBaseLayers(S.activeMap);
  S.activeMarkersLayer = L.layerGroup().addTo(S.activeMap);
  if (S.currentBbox) {
    const [[swLat, swLon], [neLat, neLon]] = S.currentBbox;
    S.activeMap.fitBounds([[swLat, swLon], [neLat, neLon]], { padding: [40, 40] });
  }
}

// Exposed globally for the inline onclick in map popups.
window.openShipDetail = function (mmsi) {
  S.activeMap.closePopup();
  S.detailFrom = 'active';
  showView('detail', mmsi, S.activeShipsCache.get(mmsi) || null);
};

// ── Followed-ships overview map ──────────────────────────────────────────────
// Followed ships are scattered across the open sea (not confined to one area),
// so this map frames the ships themselves rather than an area bounding box.
export function initFollowedMap() {
  if (S.followedMap) return;
  S.followedMap = L.map('followed-map', { zoomControl: true }).setView([41.138, 16.843], 6);
  addBaseLayers(S.followedMap);
  S.followedMarkersLayer = L.layerGroup().addTo(S.followedMap);
}

window.openFollowedShipDetail = function (mmsi) {
  S.followedMap.closePopup();
  S.detailFrom = 'followed';
  showView('detail', mmsi, S.followedShipsCache.get(mmsi) || null);
};

export function renderFollowedMap(ships) {
  initFollowedMap();
  S.followedMap.invalidateSize();
  S.followedMarkersLayer.clearLayers();
  S.followedShipsCache.clear();
  ships.forEach((s) => S.followedShipsCache.set(s.mmsi, s));

  // Display position per ship: a scraped fallback fix (SF/MST, AIS gone dark)
  // wins over a stale AIS position; otherwise the AIS last position. The marker
  // snaps back to AIS as soon as AIS re-acquires (backend drops fallback_* then).
  const displayPos = (s) =>
    s.fallback_lat != null && s.fallback_lon != null
      ? { ll: [s.fallback_lat, s.fallback_lon], fallback: true }
      : s.last_latitude != null && s.last_longitude != null
        ? { ll: [s.last_latitude, s.last_longitude], fallback: false }
        : null;
  const positioned = ships.filter((s) => displayPos(s));
  const searchingNoPos = ships.filter((s) => s.search_mode && !displayPos(s));
  const infoEl = document.getElementById('followed-map-info');
  if (infoEl) {
    infoEl.textContent = searchingNoPos.length
      ? `🔍 ${searchingNoPos.length} ${searchingNoPos.length === 1 ? t('follow.searchingNoPosOne') : t('follow.searchingNoPosMany')}`
      : '';
  }
  if (!positioned.length) return;

  const RISK_STYLE = {
    high: { radius: 9, color: '#f87171', fillColor: '#dc2626', weight: 3 },
    med: { radius: 8, color: '#fbbf24', fillColor: '#d97706', weight: 2.5 },
    low: { radius: 7, color: '#34d399', fillColor: '#059669', weight: 2 },
  };
  const GRAY_STYLE = { radius: 8, color: '#9ca3af', fillColor: '#6b7280', weight: 2.5 };

  const SRC_LABEL = { sf: 'ShipFinder', mst: 'MyShipTracking' };
  const latlngs = [];
  positioned.forEach((s) => {
    const dp = displayPos(s);
    const ll = dp.ll;
    latlngs.push(ll);
    // Grey when AIS-dark: hunting (search_mode) or plotting a scraped fallback fix.
    const style = s.search_mode || dp.fallback
      ? GRAY_STYLE
      : s.flagged
        ? { radius: 10, color: '#a78bfa', fillColor: '#7c3aed', weight: 3 }
        : RISK_STYLE[s.risk?.band] || RISK_STYLE.low;
    // When showing a scraped fix, the AIS SOG/COG/time don't match the marker —
    // show the scrape time and source instead.
    const posInfo = dp.fallback
      ? `🕐 ${formatTime(s.fallback_at)}<br>` +
        `<span style="color:#9ca3af;font-size:0.8rem">📡 via ${SRC_LABEL[s.fallback_source] || s.fallback_source}</span><br>`
      : `⚡ SOG: ${s.last_sog != null ? s.last_sog.toFixed(1) + ' kn' : '—'}` +
        `${s.last_cog != null && s.last_cog <= 360 ? `&nbsp;&nbsp;COG: ${s.last_cog.toFixed(0)}°` : ''}<br>` +
        `🕐 ${formatTime(s.last_seen_at)}<br>`;
    L.circleMarker(ll, { ...style, fillOpacity: 0.9 })
      .bindPopup(
        `<b style="font-size:1rem">${escHtml(s.ship_name || t('map.unknown'))}</b><br>` +
          `<span style="color:#9ca3af;font-size:0.8rem">MMSI: ${s.mmsi}</span><br><br>` +
          `🚢 ${shipTypeLabel(s.ship_type)}<br>` +
          `${t('map.risk')} ${riskBadge(s.risk)}<br>` +
          `📍 ${(s.destination_label || s.destination) ? escHtml(s.destination_label || s.destination) : '—'}<br>` +
          posInfo +
          `<div style="margin-top:8px;display:flex;gap:6px">` +
          `<button onclick="openFollowedShipDetail(${s.mmsi})" style="padding:4px 12px;cursor:pointer;border:1px solid #3b82f6;background:#1e40af;color:#fff;border-radius:4px;font-size:0.8rem;flex:1">${t('map.detail')}</button>` +
          `<a href="https://www.vesselfinder.com/vessels/details/${s.mmsi}" target="_blank" rel="noopener" style="padding:4px 10px;cursor:pointer;border:1px solid #374151;background:#1e2330;color:#9ca3af;border-radius:4px;font-size:0.8rem;text-decoration:none;display:flex;align-items:center" title="VesselFinder">⧉</a>` +
          `</div>`
      )
      .addTo(S.followedMarkersLayer);
  });

  const bounds = L.latLngBounds(latlngs);
  if (bounds.isValid()) S.followedMap.fitBounds(bounds, { padding: [50, 50], maxZoom: 13 });
}

export function renderActiveMap(ships) {
  initActiveMap();
  S.activeMap.invalidateSize();
  S.activeMarkersLayer.clearLayers();
  S.activeShipsCache.clear();
  ships.forEach((s) => S.activeShipsCache.set(s.mmsi, s));

  // OpenSeaMap official berths/moorings for the area (cached by bbox). Drawn
  // regardless of whether any ships are positioned, hence before the early bail.
  renderSeamarkBerths();

  const positioned = ships.filter((s) => s.last_latitude != null && s.last_longitude != null);
  if (!positioned.length) return;

  const latlngs = [];
  positioned.forEach((s) => {
    const ll = [s.last_latitude, s.last_longitude];
    latlngs.push(ll);
    // Marker colour: flagged ships → viola; otherwise the risk band
    // (verde ≤30 · giallo 31–70 · rosso 71–100).
    const RISK_STYLE = {
      high: { radius: 9, color: '#f87171', fillColor: '#dc2626', weight: 3 },
      med: { radius: 8, color: '#fbbf24', fillColor: '#d97706', weight: 2.5 },
      low: { radius: 7, color: '#34d399', fillColor: '#059669', weight: 2 },
    };
    const style = s.flagged
      ? { radius: 10, color: '#a78bfa', fillColor: '#7c3aed', weight: 3 }
      : RISK_STYLE[s.risk?.band] || RISK_STYLE.low;
    L.circleMarker(ll, { ...style, fillOpacity: 0.9 })
      .bindPopup(
        `<b style="font-size:1rem">${escHtml(s.ship_name || t('map.unknown'))}</b><br>` +
          `<span style="color:#9ca3af;font-size:0.8rem">MMSI: ${s.mmsi}</span><br><br>` +
          `🚢 ${shipTypeLabel(s.ship_type)}<br>` +
          `${t('map.risk')} ${riskBadge(s.risk)}<br>` +
          `📍 ${(s.destination_label || s.destination) ? escHtml(s.destination_label || s.destination) : '—'}<br>` +
          `⚡ SOG: ${s.last_sog != null ? s.last_sog.toFixed(1) + ' kn' : '—'}` +
          `${s.last_cog != null && s.last_cog <= 360 ? `&nbsp;&nbsp;COG: ${s.last_cog.toFixed(0)}°` : ''}<br>` +
          `${directionBadge(s.direction)}${s.in_port ? ` ${t('port.badge')}` : ''}<br>` +
          `🕐 ${formatTime(s.last_seen_at)}<br>` +
          `<div style="margin-top:8px;display:flex;gap:6px">` +
          `<button onclick="openShipDetail(${s.mmsi})" style="padding:4px 12px;cursor:pointer;border:1px solid #3b82f6;background:#1e40af;color:#fff;border-radius:4px;font-size:0.8rem;flex:1">${t('map.detail')}</button>` +
          `<a href="https://www.vesselfinder.com/vessels/details/${s.mmsi}" target="_blank" rel="noopener" style="padding:4px 10px;cursor:pointer;border:1px solid #374151;background:#1e2330;color:#9ca3af;border-radius:4px;font-size:0.8rem;text-decoration:none;display:flex;align-items:center" title="VesselFinder">⧉</a>` +
          `</div>`
      )
      .addTo(S.activeMarkersLayer);
  });

  // Frame the selected area's bounding box, not the ships, so the view stays
  // anchored to the chosen area even if a few (possibly mis-tagged) ships sit
  // outside it. Re-fit only when the area changed, to avoid snapping back on
  // every poll. Fall back to ship bounds only when no area box is known.
  if (S.currentBbox) {
    const key = JSON.stringify(S.currentBbox);
    if (key !== activeFitKey) {
      S.activeMap.fitBounds(S.currentBbox, { padding: [40, 40] });
      activeFitKey = key;
    }
  } else {
    const bounds = L.latLngBounds(latlngs);
    if (bounds.isValid()) S.activeMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }
}
