// Areas screen: list every monitoring area, visualise them on a map, add a new
// one (by typing GPS coordinates in decimal degrees, or by framing it on the
// map and capturing the current view) and delete one with a 10s undo window.
import { el } from './dom.js';
import { S } from './store.js';
import { api } from './api.js';
import { escHtml, fmtUptime } from './helpers.js';
import { showUndoToast, showAlert } from './toast.js';
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

// One row per area. Port discovery (services/port-discovery.js) still runs in
// the background per area (on creation, at boot backfill) — its results are
// not surfaced here; see Settings → Diagnostica AIS for the manual re-run
// control. This screen used to also render a per-area ports panel, removed
// because "one berth = one port" was the wrong granularity for that UI (a
// real port is a cluster of many berths) and the underlying data wasn't
// ready to be admin-facing yet — kept purely backend-side until Plan 2 needs it.
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
        // fallbackEnabled/fallbackSilent/portStatus are only present for admins
        // (see GET /areas) — the cell renders empty for everyone else, matching
        // the header column auth-ui.js hides for non-admins.
        let fallbackCell = '';
        if (a.fallbackEnabled !== undefined) {
          // Live silent-fallback state (services/fallback-mode.js), right here
          // instead of only in Impostazioni → Diagnostica AIS — an admin
          // wondering "is fallback actually doing anything for this area"
          // shouldn't have to jump screens to find out.
          const liveDot = a.fallbackEnabled
            ? (a.fallbackSilent
                ? `<span class="area-fallback-live is-silent" data-tip="${escHtml(a.fallbackSilentSince ? t('areas.fallbackSilentTip') : t('areas.fallbackForcedTip'))}">🔴 ${t('areas.fallbackLiveLabel')}${a.fallbackSilentSince ? ` · ${fmtUptime(Math.max(0, Math.round((Date.now() - new Date(a.fallbackSilentSince).getTime()) / 1000)))}` : ` (${t('areas.fallbackForcedLabel')})`}</span>`
                : `<span class="area-fallback-live is-ok" data-tip="${escHtml(t('areas.fallbackOkTip'))}">🟢 ${t('areas.aisLiveLabel')}</span>`)
            : '';
          // Two distinct states, not one: a port never found at all (nothing to
          // resolve, retrying discovery won't help unless real data changes) is
          // a different problem from a confirmed port not yet resolved on MST
          // (worth re-running discovery for).
          let portBadge = '';
          if (a.fallbackEnabled && a.portStatus === 'unresolved') {
            portBadge = `<span class="area-badge-warn" data-tip="${escHtml(t('areas.fallbackUnresolvedPortTip'))}">⚠ ${t('areas.portUnresolvedLabel')}</span>`;
          } else if (a.fallbackEnabled && a.portStatus === 'none') {
            portBadge = `<span class="area-badge-info" data-tip="${escHtml(t('areas.fallbackNoPortTip'))}">ℹ ${t('areas.portNoneLabel')}</span>`;
          }
          // Force toggle only makes sense while fallback itself is on — an admin
          // who knows this bbox has thin real AIS coverage (few AIS-equipped
          // ships passing through) can flip it without waiting for a genuine
          // AREA_SILENT_THRESHOLD_MIN silence that may never happen on its own.
          const forceToggle = a.fallbackEnabled
            ? `<label class="toggle" data-tip="${escHtml(t('areas.fallbackForceToggleTip'))}">
                 <input type="checkbox" class="area-fallback-force-toggle" data-key="${escHtml(a.key)}"${a.fallbackForced ? ' checked' : ''}>
                 <span class="toggle-slider"></span>
               </label>⚡`
            : '';
          fallbackCell = `
          <label class="toggle" title="${escHtml(t('areas.fallbackToggleTip'))}">
            <input type="checkbox" class="area-fallback-toggle" data-key="${escHtml(a.key)}"${a.fallbackEnabled ? ' checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          ${forceToggle}
          ${liveDot}${portBadge}`;
        }
        return `<tr class="area-row ${cls}" data-key="${escHtml(a.key)}" title="${escHtml(t('areas.rowHint'))}">
          <td>${escHtml(a.name)}${a.current ? ` <span class="area-current-tag" data-i18n="areas.inUse">${t('areas.inUse')}</span>` : ''}</td>
          <td class="mono">${swLat.toFixed(4)}, ${swLon.toFixed(4)}</td>
          <td class="mono">${neLat.toFixed(4)}, ${neLon.toFixed(4)}</td>
          <td>${a.keyword ? escHtml(a.keyword) : '—'}</td>
          <td>${dot} ${statusTxt}</td>
          <td>${fallbackCell}</td>
          <td class="area-data-cell">${dataTxt}</td>
          <td>
            ${a.fallbackEnabled !== undefined ? `<button class="btn btn-secondary btn-sm area-ports-btn" data-key="${escHtml(a.key)}" data-name="${escHtml(a.name)}" title="${escHtml(t('areas.ports.button'))}">⚓</button>` : ''}
            <button class="btn btn-clear btn-sm area-del-btn" data-key="${escHtml(a.key)}" data-name="${escHtml(a.name)}"${disabled} title="${escHtml(t('areas.delete'))}">🗑</button>
          </td>
        </tr>`;
      })
      .join('') ||
    `<tr><td colspan="8" class="empty">${t('areas.none')}</td></tr>`;
}

// ── Ports panel (per-area port catalog: services/port-discovery.js) ──────────
// Reuses the shared #modal-overlay for the list (see CLAUDE.md on the two
// overlay patterns — this one is mobile-safe, unlike the draggable log
// windows) and the already-on-screen areas-map for "evidenziazione sulla
// mappa" instead of embedding a second Leaflet instance in the modal.
const PORT_STATUS_COLOR = { confirmed: '#34d399', review: '#fbbf24', rejected: '#ef4444' };

function renderPortsList(areaKey, ports) {
  if (!ports.length) return `<p class="vf-empty">${t('areas.ports.empty')}</p>`;
  return `<p class="health-note">${t('areas.ports.decisionNote')}</p>
  <table class="area-ports-table">
    <thead><tr>
      <th>${t('areas.ports.colName')}</th>
      <th>${t('areas.ports.colCoords')}</th>
      <th>${t('areas.ports.colStatus')}</th>
      <th>${t('areas.ports.colSources')}</th>
      <th></th>
    </tr></thead>
    <tbody>
      ${ports
        .map(
          (p) => `
        <tr>
          <td>${escHtml(p.name)}</td>
          <td class="mono">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</td>
          <td><span class="badge ${p.status}" title="${escHtml(t('areas.ports.statusTip.' + p.status))}">${t('areas.ports.status.' + p.status)}</span></td>
          <td>${(p.sources || []).map(escHtml).join(', ') || '—'}</td>
          <td>${
            p.status === 'review'
              ? `<button class="btn btn-sm area-port-confirm" data-id="${p.id}" title="${escHtml(t('areas.ports.confirmTip'))}">${t('areas.ports.confirm')}</button>
                 <button class="btn btn-sm btn-clear area-port-reject" data-id="${p.id}" title="${escHtml(t('areas.ports.rejectTip'))}">${t('areas.ports.reject')}</button>`
              : ''
          }</td>
        </tr>`
        )
        .join('')}
    </tbody>
  </table>`;
}

function highlightPortsOnMap(areaKey, ports) {
  if (!S.areasMap) return;
  if (!S.areaPortsLayer) S.areaPortsLayer = L.layerGroup().addTo(S.areasMap);
  S.areaPortsLayer.clearLayers();
  const area = S.areasList.find((a) => a.key === areaKey);
  if (area) frameBbox(area.bbox);
  for (const p of ports) {
    L.circleMarker([p.lat, p.lon], {
      radius: 8,
      color: PORT_STATUS_COLOR[p.status] || '#3b82f6',
      weight: 2,
      fillOpacity: 0.5,
    })
      .bindTooltip(escHtml(p.name), { permanent: false })
      .addTo(S.areaPortsLayer);
  }
}

// The shared modal has no "on close" hook of its own (see main.js: closing
// just toggles the hidden class) — watch for that class change instead of
// duplicating close-button/backdrop/Escape wiring here, so the port markers
// come off the areas-map whichever way the admin closes it.
function watchModalClose(cleanup) {
  const obs = new MutationObserver(() => {
    if (el.modalOverlay.classList.contains('hidden')) {
      cleanup();
      obs.disconnect();
    }
  });
  obs.observe(el.modalOverlay, { attributes: true, attributeFilter: ['class'] });
}

async function refreshPortsPanel(areaKey) {
  const { ports } = await api(`/api/areas/${encodeURIComponent(areaKey)}/ports`);
  highlightPortsOnMap(areaKey, ports);
  const list = document.getElementById('area-ports-list');
  if (list) list.innerHTML = renderPortsList(areaKey, ports);
}

async function openPortsPanel(areaKey, areaName) {
  try {
    const { ports } = await api(`/api/areas/${encodeURIComponent(areaKey)}/ports`);
    highlightPortsOnMap(areaKey, ports);
    el.modalTitle.textContent = t('areas.ports.title', { name: areaName });
    el.modalBody.innerHTML = `
      <p class="health-note" style="margin-top:0">${t('areas.ports.desc')}</p>
      <div style="text-align:right;margin-bottom:0.6rem">
        <button id="btn-area-ports-discover" class="btn btn-secondary btn-sm">${t('areas.ports.discoverNow')}</button>
      </div>
      <div id="area-ports-list">${renderPortsList(areaKey, ports)}</div>`;
    el.modalOverlay.classList.remove('hidden');
    watchModalClose(() => {
      if (S.areaPortsLayer) S.areaPortsLayer.clearLayers();
      renderAreaRectangles();
    });

    document.getElementById('btn-area-ports-discover')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api(`/api/areas/${encodeURIComponent(areaKey)}/discover-ports`, 'POST');
        showAlert(t('areas.ports.title', { name: areaName }), t('health.portDiscoveryStarted'));
      } catch {
        showAlert(t('areas.ports.title', { name: areaName }), t('health.portDiscoveryError'));
      } finally {
        e.target.disabled = false;
      }
    });

    document.getElementById('area-ports-list')?.addEventListener('click', async (e) => {
      const confirmBtn = e.target.closest('.area-port-confirm');
      const rejectBtn = e.target.closest('.area-port-reject');
      const btn = confirmBtn || rejectBtn;
      if (!btn) return;
      btn.disabled = true;
      try {
        await api(`/api/areas/${encodeURIComponent(areaKey)}/ports/${btn.dataset.id}/${confirmBtn ? 'confirm' : 'reject'}`, 'POST');
        await refreshPortsPanel(areaKey);
      } catch {
        btn.disabled = false;
      }
    });
  } catch {
    showAlert(t('areas.ports.title', { name: areaName }), t('areas.ports.loadError'));
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

  el.areasBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.area-del-btn');
    if (btn) {
      if (!btn.disabled) requestDelete(btn.dataset.key, btn.dataset.name);
      return;
    }
    const portsBtn = e.target.closest('.area-ports-btn');
    if (portsBtn) {
      openPortsPanel(portsBtn.dataset.key, portsBtn.dataset.name);
      return;
    }
    if (e.target.closest('.area-fallback-toggle') || e.target.closest('.area-fallback-force-toggle')) return; // handled by the change listener below
    const row = e.target.closest('tr.area-row');
    if (row) startEdit(row.dataset.key);
  });

  // Per-area silent-fallback toggle (admin-only, see auth-ui.js which hides the
  // whole column for everyone else). Separate from submitForm(): this isn't
  // part of the shared add/edit form, any co-owner's name/keyword/bbox changes
  // never touch it.
  el.areasBody.addEventListener('change', async (e) => {
    const cb = e.target.closest('.area-fallback-toggle');
    if (!cb) return;
    const key = cb.dataset.key;
    const enabled = cb.checked;
    try {
      await api(`/api/areas/${encodeURIComponent(key)}/fallback`, 'PATCH', { enabled });
      const a = S.areasList.find((x) => x.key === key);
      if (a) a.fallbackEnabled = enabled;
      renderAreasList(); // toggling off also hides the force toggle for this row
    } catch {
      cb.checked = !enabled; // revert on failure
    }
  });

  // Per-area "force" override: same admin-only gate, see setAreaFallbackForced.
  el.areasBody.addEventListener('change', async (e) => {
    const cb = e.target.closest('.area-fallback-force-toggle');
    if (!cb) return;
    const key = cb.dataset.key;
    const forced = cb.checked;
    try {
      await api(`/api/areas/${encodeURIComponent(key)}/fallback`, 'PATCH', { forced });
      const a = S.areasList.find((x) => x.key === key);
      if (a) a.fallbackForced = forced;
    } catch {
      cb.checked = !forced; // revert on failure
    }
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
