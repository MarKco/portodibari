// Areas screen: list every monitoring area, visualise them on a map, add a new
// one (by typing GPS coordinates in decimal degrees, or by framing it on the
// map and capturing the current view) and delete one with a 10s undo window.
import { el } from './dom.js';
import { S } from './store.js';
import { api } from './api.js';
import { escHtml } from './helpers.js';
import { showUndoToast } from './toast.js';
import { t } from './i18n.js';
import { addBaseLayers } from './tiles.js';

// ── Map ───────────────────────────────────────────────────────────────────────
function initAreasMap() {
  if (S.areasMap) return;
  S.areasMap = L.map('areas-map', { zoomControl: true }).setView([41.138, 16.843], 6);
  addBaseLayers(S.areasMap);
  S.areasLayer = L.layerGroup().addTo(S.areasMap);
  S.areaCandidateLayer = L.layerGroup().addTo(S.areasMap);
}

// Draw a rectangle per existing area; green = stream active, violet = the area
// currently in view, blue otherwise. Frames the map to contain them all — except
// while an area is being edited, where the map stays framed on that one area.
function renderAreaRectangles() {
  if (!S.areasLayer) return;
  S.areasLayer.clearLayers();
  const bounds = [];
  for (const a of S.areasList) {
    if (S.pendingDelete && S.pendingDelete.key === a.key) continue; // hide the one being deleted
    if (S.areaEditKey === a.key) continue; // the dashed candidate rectangle stands in for it
    const [[swLat, swLon], [neLat, neLon]] = a.bbox;
    const color = a.current ? '#a78bfa' : a.active ? '#34d399' : '#3b82f6';
    L.rectangle([[swLat, swLon], [neLat, neLon]], { color, weight: 2, fillOpacity: 0.08 })
      .bindTooltip(escHtml(a.name), { permanent: false, direction: 'center' })
      .addTo(S.areasLayer);
    bounds.push([swLat, swLon], [neLat, neLon]);
  }
  if (bounds.length && !S.areaEditKey) {
    const b = L.latLngBounds(bounds);
    if (b.isValid()) S.areasMap.fitBounds(b, { padding: [40, 40], maxZoom: 11 });
  }
}

// Zoom the map onto one bbox (used when an area is picked from the list).
function frameBbox(bbox) {
  if (!S.areasMap) return;
  const b = L.latLngBounds(bbox);
  if (b.isValid()) S.areasMap.fitBounds(b, { padding: [40, 40], maxZoom: 12 });
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

// One row per area, followed by a full-width row holding its ports panel
// (list of discovered ports + manual "search now" trigger). The panel's own
// content is filled in separately by loadAreaPorts, once per render.
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
        const cls = [pending ? 'area-row-pending' : '', S.areaEditKey === a.key ? 'area-row-editing' : '']
          .filter(Boolean)
          .join(' ');
        return `<tr class="area-row ${cls}" data-key="${escHtml(a.key)}" title="${escHtml(t('areas.rowHint'))}">
          <td>${escHtml(a.name)}${a.current ? ` <span class="area-current-tag" data-i18n="areas.inUse">${t('areas.inUse')}</span>` : ''}</td>
          <td class="mono">${swLat.toFixed(4)}, ${swLon.toFixed(4)}</td>
          <td class="mono">${neLat.toFixed(4)}, ${neLon.toFixed(4)}</td>
          <td>${a.keyword ? escHtml(a.keyword) : '—'}</td>
          <td>${dot} ${statusTxt}</td>
          <td class="area-data-cell">${dataTxt}</td>
          <td><button class="btn btn-clear btn-sm area-del-btn" data-key="${escHtml(a.key)}" data-name="${escHtml(a.name)}"${disabled} title="${escHtml(t('areas.delete'))}">🗑</button></td>
        </tr>
        <tr class="area-ports-row">
          <td colspan="7">
            <div class="area-ports" data-area-key="${escHtml(a.key)}">
              <button class="btn btn-sm btn-secondary area-ports-refresh" data-i18n="areas.ports.refresh">${escHtml(t('areas.ports.refresh'))}</button>
              <ul class="area-ports-list"></ul>
            </div>
          </td>
        </tr>`;
      })
      .join('') ||
    `<tr><td colspan="7" class="empty">${t('areas.none')}</td></tr>`;
  el.areasBody
    .querySelectorAll('.area-ports')
    .forEach((c) => loadAreaPorts(c.dataset.areaKey, c.querySelector('.area-ports-list')));
}

// Fetch and render the discovered-ports list for one area. Re-called after
// every render (list rebuilt from scratch) and after any confirm/reject/
// manual-refresh action, so it always reflects the latest server state.
async function loadAreaPorts(areaKey, listEl) {
  if (!listEl) return;
  try {
    const { ports } = await api(`/api/areas/${encodeURIComponent(areaKey)}/ports`);
    listEl.innerHTML = ports.length
      ? ports
          .map(
            (p) => `
        <li data-id="${p.id}">
          <strong>${escHtml(p.name)}</strong>
          <span class="badge ${p.status}">${escHtml(t(`areas.ports.${p.status}`))}</span>
          <small>${escHtml(t('areas.ports.sources', { list: p.sources.join(', ') }))}</small>
          ${
            p.status === 'review'
              ? `
            <button class="btn btn-sm area-port-confirm" data-id="${p.id}">${escHtml(t('areas.ports.confirm'))}</button>
            <button class="btn btn-sm btn-clear area-port-reject" data-id="${p.id}">${escHtml(t('areas.ports.reject'))}</button>
          `
              : ''
          }
        </li>`
          )
          .join('')
      : `<li class="health-muted">${escHtml(t('areas.ports.empty'))}</li>`;
  } catch {
    /* leave list as-is on failure */
  }
}

export async function loadAreas() {
  try {
    const data = await api('/api/areas');
    S.areasList = data.areas || [];
    // The edited area may have disappeared meanwhile (deleted here or by a
    // group co-member) → fall back to "add" mode instead of editing a ghost.
    if (S.areaEditKey && !S.areasList.some((a) => a.key === S.areaEditKey)) {
      setEditMode(null);
      clearForm();
      updateCandidate();
    }
    renderAreasList();
    renderAreaRectangles();
  } catch {
    /* ignore */
  }
}

// ── Add / edit ────────────────────────────────────────────────────────────────
function showAddError(msg) {
  el.areaAddError.textContent = msg;
  el.areaAddError.classList.toggle('hidden', !msg);
}

function clearForm() {
  [el.areaName, el.areaKeyword, el.areaSwLat, el.areaSwLon, el.areaNeLat, el.areaNeLon].forEach(
    (i) => (i.value = '')
  );
}

// The single form doubles as the editor: switching mode only swaps its labels
// (and the visibility of the cancel button), so the map preview and the
// coordinate validation stay shared between "add" and "edit".
function setEditMode(area) {
  S.areaEditKey = area ? area.key : null;
  el.areasFormTitle.textContent = area ? t('areas.editTitle', { name: area.name }) : t('areas.addTitle');
  el.areasFormHint.textContent = t(area ? 'areas.editHint' : 'areas.addHint');
  el.btnAreaAdd.textContent = t(area ? 'areas.save' : 'areas.add');
  el.btnAreaCancel.classList.toggle('hidden', !area);
}

// Tap on a list row → load that area into the form, frame it on the map.
function startEdit(key) {
  const a = S.areasList.find((x) => x.key === key);
  if (!a) return;
  if (S.pendingDelete && S.pendingDelete.key === key) return; // being deleted — nothing to edit
  if (S.areaEditKey === key) return cancelEdit(); // tapping the same row again closes the editor
  const [[swLat, swLon], [neLat, neLon]] = a.bbox;
  el.areaName.value = a.name;
  el.areaKeyword.value = a.keyword || '';
  el.areaSwLat.value = swLat;
  el.areaSwLon.value = swLon;
  el.areaNeLat.value = neLat;
  el.areaNeLon.value = neLon;
  showAddError('');
  setEditMode(a);
  if (a.sharedWith > 0) el.areasFormHint.textContent += ' ' + t('areas.editSharedHint', { count: a.sharedWith });
  updateCandidate();
  renderAreasList();
  renderAreaRectangles();
  frameBbox(a.bbox);
  el.areasFormTitle.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelEdit() {
  if (!S.areaEditKey) return;
  setEditMode(null);
  clearForm();
  showAddError('');
  updateCandidate();
  renderAreasList();
  renderAreaRectangles();
}

async function submitForm() {
  const name = el.areaName.value.trim();
  if (!name) return showAddError(t('areas.errName'));
  const c = readCandidate();
  if (!c) return showAddError(t('areas.errCoords'));
  const editKey = S.areaEditKey;
  // Editing an area other users monitor moves it for them too (the catalog is
  // global) — ask twice, then let the server notify them.
  if (editKey) {
    const shared = S.areasList.find((a) => a.key === editKey)?.sharedWith || 0;
    if (shared > 0) {
      if (!window.confirm(t('areas.editSharedConfirm1', { count: shared }))) return;
      if (!window.confirm(t('areas.editSharedConfirm2'))) return;
    }
  }
  showAddError('');
  el.btnAreaAdd.disabled = true;
  try {
    const body = { name, keyword: el.areaKeyword.value.trim() || null, sw: c[0], ne: c[1] };
    if (editKey) await api(`/api/areas/${encodeURIComponent(editKey)}`, 'PATCH', body);
    else await api('/api/areas', 'POST', body);
    setEditMode(null);
    clearForm();
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
  if (S.areaEditKey === key) cancelEdit(); // don't keep editing what's going away

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
  cancelEdit(); // always land on the plain "add" form
  initAreasMap();
  // Map container was hidden until now; let Leaflet recompute its size.
  setTimeout(() => S.areasMap && S.areasMap.invalidateSize(), 60);
  loadAreas();
}

export function initAreas() {
  el.btnAreaCapture.addEventListener('click', captureView);
  el.btnAreaAdd.addEventListener('click', submitForm);
  el.btnAreaCancel.addEventListener('click', cancelEdit);
  [el.areaSwLat, el.areaSwLon, el.areaNeLat, el.areaNeLon].forEach((i) =>
    i.addEventListener('input', updateCandidate)
  );

  el.areasBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('.area-del-btn');
    if (btn) {
      if (!btn.disabled) requestDelete(btn.dataset.key, btn.dataset.name);
      return;
    }
    // Ports panel: manual "search now" kicks off a fire-and-forget background
    // scan on the server (POST returns immediately) — re-fetch the list right
    // after, which mostly just reflects the unchanged state until the scan
    // finishes; that's expected, not something to poll/retry for here.
    const refreshBtn = e.target.closest('.area-ports-refresh');
    if (refreshBtn) {
      const container = refreshBtn.closest('.area-ports');
      try {
        await api(`/api/areas/${encodeURIComponent(container.dataset.areaKey)}/discover-ports`, 'POST');
      } catch {
        /* ignore */
      }
      await loadAreaPorts(container.dataset.areaKey, container.querySelector('.area-ports-list'));
      return;
    }
    const confirmBtn = e.target.closest('.area-port-confirm');
    const rejectBtn = e.target.closest('.area-port-reject');
    if (confirmBtn || rejectBtn) {
      const li = (confirmBtn || rejectBtn).closest('li');
      const container = (confirmBtn || rejectBtn).closest('.area-ports');
      const action = confirmBtn ? 'confirm' : 'reject';
      try {
        await api(
          `/api/areas/${encodeURIComponent(container.dataset.areaKey)}/ports/${li.dataset.id}/${action}`,
          'POST'
        );
      } catch {
        /* ignore */
      }
      await loadAreaPorts(container.dataset.areaKey, container.querySelector('.area-ports-list'));
      return;
    }
    const row = e.target.closest('tr.area-row');
    if (row) startEdit(row.dataset.key);
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
