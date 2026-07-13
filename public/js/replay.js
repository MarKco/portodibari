import { S } from './store.js';
import { api } from './api.js';
import { escHtml, formatTime, shipTypeLabel } from './helpers.js';
import { initActiveMap } from './maps.js';
import { t } from './i18n.js';
import { showAlert } from './toast.js';
import { exportReplay } from './geoexport.js';

// ── Historical replay (time-scrubber on the area map) ────────────────────────
// Toggling "▶ Replay" on the active map enters replay mode: it fetches every
// position inside the selected area's bbox over a chosen window (grouped by
// ship), hides the live markers, and animates a global clock from window start
// to end. At clock time T each ship is drawn at its position interpolated
// between its surrounding fixes; when those fixes straddle a gap longer than
// replayMaxGapMin the ship is HELD at its last known position instead of
// interpolated (no fabricated motion across the gap, but it stays visible — a
// ship at anchor reporting every few hours must not vanish for most of the
// timeline). A ship is only hidden before its first / after its last fix in the
// window. A short fading trail (replayTailMin) shows recent path; markers are
// risk-band coloured and clickable. Speed multipliers + a scrubber drive the clock.

const RISK_STYLE = {
  high: { radius: 7, color: '#f87171', fillColor: '#dc2626', weight: 2.5 },
  med: { radius: 6, color: '#fbbf24', fillColor: '#d97706', weight: 2 },
  low: { radius: 5, color: '#34d399', fillColor: '#059669', weight: 1.5 },
};
const FLAG_STYLE = { radius: 7, color: '#a78bfa', fillColor: '#7c3aed', weight: 2.5 };

const lerp = (a, b, t2) => a + (b - a) * t2;

// ISO ↔ <input type="datetime-local"> (local wall-clock, minute precision).
function isoToLocalInput(iso) {
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
const localInputToIso = (v) => (v ? new Date(v).toISOString() : null);

let els = null;
function dom() {
  if (els) return els;
  const $ = (id) => document.getElementById(id);
  els = {
    bar: $('replay-bar'), toggle: $('replay-toggle'), close: $('replay-close'),
    area: $('replay-area'), from: $('replay-from'), to: $('replay-to'), apply: $('replay-apply'),
    play: $('replay-play'), slider: $('replay-slider'), time: $('replay-time'),
    count: $('replay-count'), status: $('replay-status'),
    useScraped: $('replay-use-scraped'), useScrapedWrap: $('replay-use-scraped-wrap'),
    wins: document.querySelectorAll('.replay-win'), speeds: document.querySelectorAll('.replay-speed'),
  };
  return els;
}

export function initReplay() {
  const e = dom();
  if (!e.toggle) return;
  e.toggle.addEventListener('click', () => (S.replay && S.replay.active ? exit() : enter()));
  e.close.addEventListener('click', exit);
  e.play.addEventListener('click', togglePlay);
  e.apply.addEventListener('click', () => {
    const from = localInputToIso(e.from.value), to = localInputToIso(e.to.value);
    if (from && to && from < to) load({ from, to });
  });
  e.wins.forEach((b) => b.addEventListener('click', () => {
    setActiveBtn(e.wins, b);
    load({ window: b.dataset.win });
  }));
  e.speeds.forEach((b) => b.addEventListener('click', () => {
    setActiveBtn(e.speeds, b);
    if (S.replay) S.replay.speed = Number(b.dataset.speed);
  }));
  e.slider.addEventListener('input', () => {
    const R = S.replay;
    if (!R) return;
    pause();
    R.clock = R.t0 + (Number(e.slider.value) / 1000) * (R.t1 - R.t0);
    renderFrame();
  });
  e.area.addEventListener('change', () => load({ window: currentWin() }));

  // "Includi SF/MST" — toggle scraped positions in the animated route, then
  // reload the current window so the change takes effect immediately.
  if (e.useScraped) e.useScraped.addEventListener('change', () => {
    S.replayUseScraped = e.useScraped.checked;
    reloadCurrent();
  });

  // Export the currently-loaded replay window as one LineString per ship.
  const replayExpSel = document.getElementById('replay-export-sel');
  if (replayExpSel) replayExpSel.addEventListener('change', (ev) => {
    const fmt = ev.target.value;
    if (!fmt) return;
    ev.target.value = '';
    const R = S.replay;
    if (!R || !R.ships.length) { showAlert(t('export.empty')); return; }
    if (!exportReplay({ ships: R.ships }, fmt, e.area.value || 'area')) showAlert(t('export.empty'));
  });
}

function setActiveBtn(group, btn) {
  group.forEach((b) => b.classList.toggle('active', b === btn));
}
function currentWin() {
  const on = [...dom().wins].find((b) => b.classList.contains('active'));
  return on ? on.dataset.win : '1h';
}

function enter() {
  const e = dom();
  initActiveMap();
  // Populate the area picker from the user's areas; default to the current one.
  const entries = Object.entries(S.presets || {});
  e.area.innerHTML = entries.map(([k, v]) => `<option value="${k}">${escHtml(v.name || k)}</option>`).join('');
  if (S.currentPreset && S.presets[S.currentPreset]) e.area.value = S.currentPreset;

  S.replay = {
    active: true, ships: [], t0: 0, t1: 0, clock: 0, playing: false, speed: 20,
    rafId: null, lastTs: null, layer: L.layerGroup().addTo(S.activeMap),
  };
  // Hide the live markers so they don't pile up under the replay.
  if (S.activeMarkersLayer) S.activeMap.removeLayer(S.activeMarkersLayer);
  e.bar.classList.remove('hidden');
  e.toggle.classList.add('active');
  setActiveBtn(e.wins, [...e.wins].find((b) => b.dataset.win === '1h'));
  setActiveBtn(e.speeds, [...e.speeds].find((b) => b.dataset.speed === '20'));
  load({ window: '1h' });
}

// Exported as exitReplay: also called from views.js (leaving the active view)
// and on area change, so the rAF loop and replay layer don't linger on a hidden
// map with the live markers stuck removed. Safe no-op when not in replay mode.
export function exit() {
  if (!S.replay) return;
  const e = dom();
  const R = S.replay;
  if (R.rafId) cancelAnimationFrame(R.rafId);
  if (R.layer && S.activeMap) S.activeMap.removeLayer(R.layer);
  S.replay = null;
  if (S.activeMarkersLayer && S.activeMap) S.activeMarkersLayer.addTo(S.activeMap); // restore live markers
  e.bar.classList.add('hidden');
  e.toggle.classList.remove('active');
}
export { exit as exitReplay };

// Re-run the most recent load (same window or custom range) — used when the
// "Includi SF/MST" toggle changes so it takes effect without losing the view.
function reloadCurrent() {
  const R = S.replay;
  if (!R) return;
  load(R.lastParams || { window: currentWin() });
}

async function load(params) {
  const R = S.replay;
  const e = dom();
  if (!R) return;
  R.lastParams = params;
  pause();
  const area = e.area.value;
  const q = new URLSearchParams();
  if (area) q.set('area', area);
  if (params.from && params.to) { q.set('from', params.from); q.set('to', params.to); }
  else q.set('window', params.window || '1h');
  // Ask the server to fold in SF/MST scraped positions when the toggle is on.
  if (S.replayUseScraped) q.set('scraped', '1');
  e.status.textContent = t('replay.loading');
  let data;
  try {
    data = await api(`/api/replay?${q.toString()}`);
  } catch {
    e.status.textContent = t('replay.error');
    return;
  }
  if (!S.replay) return; // exited while loading
  buildScene(data);
}

function buildScene(data) {
  const R = S.replay;
  const e = dom();
  R.layer.clearLayers();
  R.ships = [];

  const maxGapMs = (S.replayMaxGapMin || 30) * 60000;
  R.maxGapMs = maxGapMs;
  R.tailMs = (S.replayTailMin || 20) * 60000;

  for (const sh of data.ships || []) {
    const fixes = sh.fixes
      .map((f) => ({ ...f, ms: new Date(f.t).getTime() }))
      .filter((f) => Number.isFinite(f.ms))
      .sort((a, b) => a.ms - b.ms);
    if (!fixes.length) continue;
    const style = sh.flagged ? FLAG_STYLE : RISK_STYLE[sh.band] || RISK_STYLE.low;
    const marker = L.circleMarker([fixes[0].lat, fixes[0].lon], { ...style, fillOpacity: 0.9 });
    marker.bindTooltip(`${escHtml(sh.name || String(sh.mmsi))} · ${escHtml(shipTypeLabel(sh.type))}`);
    marker.on('click', () => window.openShipDetail && window.openShipDetail(sh.mmsi));
    const trail = L.polyline([], { color: style.fillColor, weight: 2.5, opacity: 0.5 });
    R.ships.push({ mmsi: sh.mmsi, name: sh.name, band: sh.band, fixes, marker, trail, shown: false, idx: 0 });
  }

  // Window bounds: from/to come back resolved+clamped from the server.
  R.t0 = new Date(data.from || (data.range && data.range.lo)).getTime();
  R.t1 = new Date(data.to || (data.range && data.range.hi)).getTime();
  if (!(R.t1 > R.t0)) R.t1 = R.t0 + 1;
  R.clock = R.t0;

  // Reflect the resolved window in the custom pickers + the available range.
  if (data.from) e.from.value = isoToLocalInput(data.from);
  if (data.to) e.to.value = isoToLocalInput(data.to);
  // Show the "Includi SF/MST" toggle only when scraped positions exist for this
  // window and the integrations are on (server reports extraAvailable).
  if (e.useScrapedWrap) {
    e.useScrapedWrap.classList.toggle('hidden', !data.extraAvailable);
    if (e.useScraped) e.useScraped.checked = S.replayUseScraped;
  }

  const avail = data.range
    ? `${formatTime(data.range.lo)} – ${formatTime(data.range.hi)}`
    : '';
  e.status.textContent = (R.ships.length
    ? t('replay.shipsLoaded', { n: R.ships.length })
    : t('replay.empty')) + (data.truncated ? ` · ${t('replay.truncated')}` : '') + (avail ? ` · ${avail}` : '');

  renderFrame();
  if (R.ships.length) play();
}

// Draw the scene at R.clock: place/hide each ship, update its trail.
function renderFrame() {
  const R = S.replay;
  if (!R) return;
  const e = dom();
  const T = R.clock;
  let visible = 0;

  for (const s of R.ships) {
    const f = s.fixes;
    let pos = null;
    if (T >= f[0].ms && T <= f[f.length - 1].ms) {
      if (f.length === 1) {
        pos = [f[0].lat, f[0].lon];
      } else {
        // Find the segment [a,b] straddling T (linear scan from the cached index).
        let i = Math.min(s.idx, f.length - 2);
        while (i > 0 && f[i].ms > T) i--;
        while (i < f.length - 2 && f[i + 1].ms < T) i++;
        s.idx = i;
        const a = f[i], b = f[i + 1];
        const gap = b.ms - a.ms;
        if (gap <= R.maxGapMs) {
          const lt = gap > 0 ? (T - a.ms) / gap : 1;
          pos = [lerp(a.lat, b.lat, lt), lerp(a.lon, b.lon, lt)];
        } else {
          // Gap too large to fabricate motion between a and b: instead of hiding
          // the ship (which made slow/anchored ships that report every few hours
          // vanish for most of the timeline), HOLD it at the last known position
          // at-or-before T. No fabricated glide; the ship stays present until its
          // next fix, then jumps there. Matches "who was here at time T".
          pos = [a.lat, a.lon];
        }
      }
    }

    if (pos) {
      if (!s.shown) { s.marker.addTo(R.layer); s.trail.addTo(R.layer); s.shown = true; }
      s.marker.setLatLng(pos);
      // Trail: fixes within the trailing window + the interpolated head.
      const tailPts = f.filter((p) => p.ms >= T - R.tailMs && p.ms <= T).map((p) => [p.lat, p.lon]);
      tailPts.push(pos);
      s.trail.setLatLngs(tailPts);
      visible++;
    } else if (s.shown) {
      R.layer.removeLayer(s.marker);
      R.layer.removeLayer(s.trail);
      s.shown = false;
    }
  }

  e.slider.value = String(R.t1 > R.t0 ? Math.round(((T - R.t0) / (R.t1 - R.t0)) * 1000) : 0);
  e.time.textContent = formatTime(new Date(T).toISOString());
  e.count.textContent = t('replay.count', { n: visible });
}

function step(ts) {
  const R = S.replay;
  if (!R || !R.playing) return;
  if (R.lastTs == null) R.lastTs = ts;
  const dt = ts - R.lastTs;
  R.lastTs = ts;
  R.clock += dt * R.speed; // speed × real time
  if (R.clock >= R.t1) { R.clock = R.t1; renderFrame(); pause(); return; }
  renderFrame();
  R.rafId = requestAnimationFrame(step);
}

function play() {
  const R = S.replay;
  if (!R) return;
  if (R.clock >= R.t1) R.clock = R.t0; // replay from start
  R.playing = true;
  R.lastTs = null;
  dom().play.textContent = '⏸';
  dom().play.title = t('map.pause');
  R.rafId = requestAnimationFrame(step);
}
function pause() {
  const R = S.replay;
  if (!R) return;
  R.playing = false;
  if (R.rafId) cancelAnimationFrame(R.rafId);
  dom().play.textContent = '▶';
  dom().play.title = t('map.play');
}
function togglePlay() {
  const R = S.replay;
  if (!R) return;
  R.playing ? pause() : play();
}
