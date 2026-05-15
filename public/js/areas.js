// Areas screen: list every monitoring area, visualise them on a map, add a new
// one (by typing GPS coordinates in decimal degrees, or by framing it on the
// map and capturing the current view) and delete one with a 10s undo window.
import { el } from './dom.js';
import { S } from './store.js';
import { api } from './api.js';
import { escHtml } from './helpers.js';
import { showUndoToast } from './toast.js';
import { t } from './i18n.js';

const OSM_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// ── Map ───────────────────────────────────────────────────────────────────────
function initAreasMap() {
  if (S.areasMap) return;
  S.areasMap = L.map('areas-map', { zoomControl: true }).setView([41.138, 16.843], 6);
  L.tileLayer(OSM_TILES, { attribution: OSM_ATTR, maxZoom: 19 }).addTo(S.areasMap);
  S.areasLayer = L.layerGroup().addTo(S.areasMap);
  S.areaCandidateLayer = L.layerGroup().addTo(S.areasMap);
}

// Draw a rectangle per existing area; green = stream active, violet = the area
// currently in view, blue otherwise. Frames the map to contain them all.
function renderAreaRectangles() {
  if (!S.areasLayer) return;
  S.areasLayer.clearLayers();
  const bounds = [];
  for (const a of S.areasList) {
    if (S.pendingDelete && S.pendingDelete.key === a.key) continue; // hide the one being deleted
    const [[swLat, swLon], [neLat, neLon]] = a.bbox;
    const color = a.current ? '#a78bfa' : a.active ? '#34d399' : '#3b82f6';
    L.rectangle([[swLat, swLon], [neLat, neLon]], { color, weight: 2, fillOpacity: 0.08 })
      .bindTooltip(escHtml(a.name), { permanent: false, direction: 'center' })
      .addTo(S.areasLayer);
    bounds.push([swLat, swLon], [neLat, neLon]);
  }
  if (bounds.length) {
    const b = L.latLngBounds(bounds);
    if (b.isValid()) S.areasMap.fitBounds(b, { padding: [40, 40], maxZoom: 11 });
  }
}

// Read the four coordinate inputs → [[swLat,swLon],[neLat,neLon]] or null.
function readCandidate() {
  const vals = [el.areaSwLat, el.areaSwLon, el.areaNeLat, el.areaNeLon].map((i) => parseFloat(i.value));
  if (vals.some((v) => !Number.isFinite(v))) return null;
  const [swLat, swLon, neLat, neLon] = vals;
  const lo = [Math.min(swLat, neLat), Math.min(swLon, neLon)];
  const hi = [Math.max(swLat, neLat), Math.max(swLon, neLon)];
  if (lo[0] === hi[0] || lo[1] === hi[1]) return null;
  if (lo[0] < -90 || hi[0] > 90 || lo[1] < -180 || hi[1] > 180) return null;
  return [lo, hi];
}

// Dashed amber preview of the area about to be added.
function updateCandidate() {
  if (!S.areaCandidateLayer) return;
  S.areaCandidateLayer.clearLayers();
  const c = readCandidate();
  if (!c) return;
  L.rectangle(c, { color: '#fbbf24', weight: 2, dashArray: '6 4', fillOpacity: 0.05 }).addTo(
    S.areaCandidateLayer
  );
}

// Fill the coordinate inputs from the map's current viewport (zoom to frame the
// area, then capture). Decimal degrees, the simple GPS standard used here.
function captureView() {
  const b = S.areasMap.getBounds();
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();
  el.areaSwLat.value = sw.lat.toFixed(5);
  el.areaSwLon.value = sw.lng.toFixed(5);
  el.areaNeLat.value = ne.lat.toFixed(5);
  el.areaNeLon.value = ne.lng.toFixed(5);
  updateCandidate();
}

// ── List ──────────────────────────────────────────────────────────────────────
function fmtCount(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function renderAreasList() {
  const only = S.areasList.length <= 1;
  el.areasBody.innerHTML =
    S.areasList
      .map((a) => {
        const pending = S.pendingDelete && S.pendingDelete.key === a.key;
        const [[swLat, swLon], [neLat, neLon]] = a.bbox;
        const dot = a.active ? '🟢' : '⚪';
        const statusTxt = a.active ? t('area.active') : t('area.inactive');
        const c = a.counts || { readings: 0, ships: 0, events: 0 };
        const dataTxt = t('areas.dataSummary', {
          readings: fmtCount(c.readings),
          ships: fmtCount(c.ships),
        });
        const disabled = only || pending ? ' disabled' : '';
        return `<tr class="${pending ? 'area-row-pending' : ''}">
          <td>${escHtml(a.name)}${a.current ? ` <span class="area-current-tag" data-i18n="areas.inUse">${t('areas.inUse')}</span>` : ''}</td>
          <td class="mono">${swLat.toFixed(4)}, ${swLon.toFixed(4)}</td>
          <td class="mono">${neLat.toFixed(4)}, ${neLon.toFixed(4)}</td>
          <td>${a.keyword ? escHtml(a.keyword) : '—'}</td>
          <td>${dot} ${statusTxt}</td>
          <td class="area-data-cell">${dataTxt}</td>
          <td><button class="btn btn-clear btn-sm area-del-btn" data-key="${escHtml(a.key)}" data-name="${escHtml(a.name)}"${disabled} title="${escHtml(t('areas.delete'))}">🗑</button></td>
        </tr>`;
      })
      .join('') ||
    `<tr><td colspan="7" class="empty">${t('areas.none')}</td></tr>`;
}

export async function loadAreas() {
  try {
    const data = await api('/api/areas');
    S.areasList = data.areas || [];
    renderAreasList();
    renderAreaRectangles();
  } catch {
    /* ignore */
  }
}

// ── Add ───────────────────────────────────────────────────────────────────────
function showAddError(msg) {
  el.areaAddError.textContent = msg;
  el.areaAddError.classList.toggle('hidden', !msg);
}

async function submitAdd() {
  const name = el.areaName.value.trim();
  if (!name) return showAddError(t('areas.errName'));
  const c = readCandidate();
  if (!c) return showAddError(t('areas.errCoords'));
  showAddError('');
  el.btnAreaAdd.disabled = true;
  try {
    await api('/api/areas', 'POST', {
      name,
      keyword: el.areaKeyword.value.trim() || null,
      sw: c[0],
      ne: c[1],
    });
    // Reset form
    [el.areaName, el.areaKeyword, el.areaSwLat, el.areaSwLon, el.areaNeLat, el.areaNeLon].forEach(
      (i) => (i.value = '')
    );
    updateCandidate();
    await loadAreas();
    window.dispatchEvent(new CustomEvent('areas-changed'));
  } catch (e) {
    showAddError((e && e.message) || String(e));
  } finally {
    el.btnAreaAdd.disabled = false;
  }
}

// ── Delete with 10s undo ──────────────────────────────────────────────────────
// The actual DELETE (which wipes the area and all its history) is deferred until
// the undo window elapses or the user leaves the page. Undo cancels it entirely.
function requestDelete(key, name) {
  if (S.areasList.length <= 1) return; // never drop the last area
  commitPendingDelete(); // flush any previous pending deletion first

  const toast = showUndoToast({
    message: t('areas.deleting', { name }),
    seconds: 10,
    onUndo: undoPendingDelete,
  });
  const timer = setTimeout(commitPendingDelete, 10000);
  S.pendingDelete = { key, name, timer, toast };

  // Reflect the pending state immediately (row struck out, rectangle hidden).
  renderAreasList();
  renderAreaRectangles();
}

export function commitPendingDelete() {
  const p = S.pendingDelete;
  if (!p) return;
  S.pendingDelete = null;
  clearTimeout(p.timer);
  p.toast.cancel();
  api(`/api/areas/${encodeURIComponent(p.key)}`, 'DELETE')
    .then(() => {
      loadAreas();
      window.dispatchEvent(new CustomEvent('areas-changed'));
    })
    .catch(() => {});
}

function undoPendingDelete() {
  const p = S.pendingDelete;
  if (!p) return;
  S.pendingDelete = null;
  clearTimeout(p.timer);
  renderAreasList();
  renderAreaRectangles();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export function enterAreasView() {
  initAreasMap();
  // Map container was hidden until now; let Leaflet recompute its size.
  setTimeout(() => S.areasMap && S.areasMap.invalidateSize(), 60);
  loadAreas();
}

export function initAreas() {
  el.btnAreaCapture.addEventListener('click', captureView);
  el.btnAreaAdd.addEventListener('click', submitAdd);
  [el.areaSwLat, el.areaSwLon, el.areaNeLat, el.areaNeLon].forEach((i) =>
    i.addEventListener('input', updateCandidate)
  );

  el.areasBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.area-del-btn');
    if (!btn || btn.disabled) return;
    requestDelete(btn.dataset.key, btn.dataset.name);
  });

  // Browser close / reload during the undo window → commit immediately so the
  // promised deletion still happens. keepalive lets the request outlive the page.
  window.addEventListener('beforeunload', () => {
    const p = S.pendingDelete;
    if (!p) return;
    clearTimeout(p.timer);
    try {
      fetch(`/api/areas/${encodeURIComponent(p.key)}`, { method: 'DELETE', keepalive: true });
    } catch {
      /* best effort */
    }
    S.pendingDelete = null;
  });
}
