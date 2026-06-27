// Coverage heatmap view ("mappa delle zone coperte"). A world Leaflet map whose
// cells are colour-coded by AIS message density (log scale). The map + current
// data are visible to ALL users; collection control + live connection stats are
// admin-only (the server enforces this too — non-admins can't reach those
// endpoints). The live-stats SSE is opened only for admins (it's admin-gated).

import { S } from './store.js';
import { addBaseLayers } from './tiles.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

let GRID = 0.5;
let sse = null;
let cellTimer = null;
let isAdmin = false;
let collecting = false;

function msg(text, kind) {
  const el = $('cov-msg');
  if (!el) return;
  el.className = 'coverage-msg' + (kind ? ' ' + kind : '');
  el.textContent = text || '';
}

async function api(method, url) {
  const r = await fetch(url, { method });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Operazione non riuscita');
  return data;
}

// ── Formatting ──────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function fmtNum(n) { return (n || 0).toLocaleString(); }
function fmtDur(s) {
  s = Math.round(s || 0);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60); const sec = s % 60;
  if (m < 60) return m + 'm ' + sec + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

// ── Map + grid overlay ────────────────────────────────────────────────────────
function initMap() {
  if (S.coverageMap) return;
  S.coverageMap = L.map('coverage-map', { worldCopyJump: true, minZoom: 2, zoomControl: true }).setView([25, 10], 2);
  addBaseLayers(S.coverageMap, 12);
  S.coverageRenderer = L.canvas({ padding: 0.5 }); // canvas keeps thousands of cells fast
  S.coverageLayer = L.layerGroup().addTo(S.coverageMap);
}

// Interpolate blue→cyan→green→yellow→red at t∈[0,1].
function color(tt) {
  const stops = [[30, 58, 138], [6, 182, 212], [34, 197, 94], [234, 179, 8], [239, 68, 68]];
  tt = Math.max(0, Math.min(1, tt));
  const x = tt * (stops.length - 1);
  const i = Math.floor(x); const f = x - i;
  const a = stops[i]; const b = stops[Math.min(i + 1, stops.length - 1)];
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function renderCells(gridDeg, cells) {
  GRID = gridDeg || GRID;
  S.coverageLayer.clearLayers();
  let max = 1;
  for (const c of cells) if (c.c > max) max = c.c;
  const lmax = Math.log1p(max);
  for (const cell of cells) {
    const lat0 = cell.a * GRID; const lon0 = cell.o * GRID;
    const tt = Math.log1p(cell.c) / lmax;
    L.rectangle([[lat0, lon0], [lat0 + GRID, lon0 + GRID]], {
      renderer: S.coverageRenderer, stroke: false, fill: true, fillColor: color(tt), fillOpacity: 0.6, interactive: false,
    }).addTo(S.coverageLayer);
  }
  const legend = $('cov-legend-max');
  if (legend) legend.textContent = cells.length ? t('coverage.legendCells', { n: fmtNum(cells.length), max: fmtNum(max) }) : t('coverage.legendEmpty');
}

async function loadCells() {
  try {
    const d = await api('GET', '/api/heatmap/cells');
    renderCells(d.gridDeg, d.cells || []);
  } catch (e) { msg(e.message, 'err'); }
}

// ── Live stats (admin SSE) ──────────────────────────────────────────────────────
function applyStats(st) {
  collecting = !!st.collecting;
  const state = $('cov-state');
  if (state) {
    if (!st.enabled) { state.textContent = t('coverage.state.disabled'); msg(t('coverage.noKey'), 'err'); }
    else if (st.collecting) { state.textContent = t('coverage.state.collecting'); msg('', 'ok'); }
    else if (st.consecutiveFailures >= 3 && st.lastError) { state.textContent = t('coverage.state.error'); msg(st.lastError, 'err'); }
    else if (st.desired) { state.textContent = t('coverage.state.connecting'); }
    else { state.textContent = t('coverage.state.off'); }
  }
  const set = (id, html) => { const e = $(id); if (e) e.innerHTML = html; };
  set('cov-bps', fmtBytes(st.bytesPerSec) + '<small>/s</small>');
  set('cov-bytes', fmtBytes(st.bytesReceived));
  set('cov-mps', fmtNum(st.msgPerSec));
  set('cov-msgs', fmtNum(st.msgReceived));
  set('cov-up', st.connected ? fmtDur(st.uptimeSec) + (st.reconnectCount ? ` <small>(${st.reconnectCount}×)</small>` : '') : '—');
  set('cov-cells', fmtNum(st.storedCells) + (st.pendingCells ? ` <small>(+${fmtNum(st.pendingCells)})</small>` : ''));
  set('cov-total', fmtNum(st.totalMessages));
  const btn = $('btn-cov-toggle');
  if (btn) { btn.textContent = collecting ? t('coverage.stop') : t('coverage.start'); btn.disabled = !st.enabled; }
}

function openStats() {
  if (sse) return;
  sse = new EventSource('/api/heatmap/stats');
  sse.onmessage = (ev) => { try { applyStats(JSON.parse(ev.data)); } catch { /* ignore */ } };
  sse.onerror = () => { /* browser auto-reconnects */ };
}
function closeStats() {
  if (sse) { sse.close(); sse = null; }
}

// ── View lifecycle (called by views.js) ─────────────────────────────────────────
export function enterCoverageView() {
  initMap();
  // Container was just un-hidden — Leaflet needs a size recalc.
  setTimeout(() => S.coverageMap && S.coverageMap.invalidateSize(), 0);
  loadCells();
  clearInterval(cellTimer);
  cellTimer = setInterval(() => { if (!document.hidden) loadCells(); }, 15000);
  if (isAdmin) openStats();
}

export function leaveCoverageView() {
  clearInterval(cellTimer);
  cellTimer = null;
  closeStats();
}

// ── Wiring (called once at startup) ──────────────────────────────────────────────
export async function initCoverage() {
  try {
    const me = await fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null));
    isAdmin = !!(me && me.isAdmin);
  } catch { isAdmin = false; }

  // Admin-only block (controls + stats + warning). Hidden for normal users.
  if (isAdmin) {
    $('coverage-admin')?.classList.remove('hidden');
    $('coverage-warn')?.classList.remove('hidden');
  }

  $('btn-cov-toggle')?.addEventListener('click', async () => {
    try {
      if (collecting) { await api('POST', '/api/heatmap/stop'); msg(t('coverage.stopped'), 'ok'); }
      else { await api('POST', '/api/heatmap/start'); msg(t('coverage.started'), 'ok'); }
    } catch (e) { msg(e.message, 'err'); }
  });
  $('btn-cov-refresh')?.addEventListener('click', loadCells);
  $('btn-cov-reset')?.addEventListener('click', async () => {
    if (!confirm(t('coverage.confirmReset'))) return;
    try {
      const d = await api('POST', '/api/heatmap/reset');
      msg(t('coverage.resetDone', { n: fmtNum(d.removed) }), 'ok');
      renderCells(GRID, []);
    } catch (e) { msg(e.message, 'err'); }
  });
}
