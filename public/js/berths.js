// Berths: the mooring-characterization overlay on the overview map plus the
// management panel (rename, override category, merge, delete, recompute).
import { S } from './store.js';
import { api } from './api.js';
import { el } from './dom.js';
import { escHtml, haversineM } from './helpers.js';
import { showAlert } from './toast.js';
import { t } from './i18n.js';
import { showView } from './views.js';
import { loadActive } from './ships.js';
import { primeActiveFit } from './maps.js';

// Leaflet layer (centroid marker) per berth id, so the manager list can focus
// a berth on the map and open its popup. Rebuilt on every overlay render.
const berthLayers = new Map();

// Broad category → overlay colour. Keep in sync with src/services/ship-categories.js.
const CATEGORY_COLORS = {
  cargo: '#3b82f6',
  tanker: '#ef4444',
  passenger: '#10b981',
  fishing: '#06b6d4',
  service: '#f59e0b',
  military: '#64748b',
  pleasure: '#a78bfa',
  highspeed: '#ec4899',
  other: '#9ca3af',
  unknown: '#6b7280',
  mixed: '#9ca3af',
};

// Categories a user can pick as a manual override.
const OVERRIDE_CATEGORIES = [
  'cargo',
  'tanker',
  'passenger',
  'fishing',
  'service',
  'military',
  'pleasure',
  'highspeed',
  'other',
  'mixed',
];

function categoryColor(label) {
  return CATEGORY_COLORS[label] || '#94a3b8';
}

function categoryLabel(label) {
  if (!label) return t('berth.uncharacterized');
  return t(`berthcat.${label}`);
}

// ── Overlay ────────────────────────────────────────────────────────────────
export function renderBerthsOverlay() {
  if (!S.activeMap) return;
  // Dedicated pane below the default overlay pane (z 400) so berth polygons
  // never sit on top of the ship markers and steal their clicks.
  if (!S.activeMap.getPane('berths')) {
    const pane = S.activeMap.createPane('berths');
    pane.style.zIndex = 350;
  }
  if (!S.berthsLayer) S.berthsLayer = L.layerGroup().addTo(S.activeMap);
  S.berthsLayer.clearLayers();
  berthLayers.clear();
  if (!S.showBerths) return;

  for (const b of S.berthsList) {
    if (!b.polygon || b.polygon.length < 3) continue;
    const characterized = !!b.label;
    const color = characterized ? categoryColor(b.label) : '#64748b';
    const tip = b.name ? escHtml(b.name) : t('berth.unnamed');

    L.polygon(b.polygon, {
      pane: 'berths',
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: characterized ? 0.35 : 0.12,
      dashArray: characterized ? null : '5,5',
    })
      .bindPopup(berthPopup(b))
      .addTo(S.berthsLayer);

    // A constant-size centroid marker so the berth stays visible even when its
    // ~80 m polygon shrinks to a few pixels at the area-wide zoom level.
    const marker = L.circleMarker(b.centroid, {
      radius: characterized ? 7 : 5,
      color: '#0b0e14',
      weight: 1.5,
      fillColor: color,
      fillOpacity: characterized ? 0.95 : 0.6,
    })
      .bindTooltip(tip, { direction: 'top' })
      .bindPopup(berthPopup(b))
      .addTo(S.berthsLayer);
    berthLayers.set(b.id, marker);
  }
}

// Pan/zoom the overview map to a berth and open its popup. Turns the overlay on
// if it was hidden so the berth is actually visible.
// Resolve which berth a notification points at. The stored id is reassigned on
// every cluster recompute, so it usually no longer matches; fall back to the
// nearest current berth to the captured centroid (within ~100 m).
function resolveBerth(id, lat, lon) {
  const b = id != null ? S.berthsList.find((x) => x.id === id) : null;
  if (b) return b;
  if (lat == null || lon == null) return null;
  let best = null;
  let bestD = Infinity;
  for (const x of S.berthsList) {
    if (!x.centroid || x.centroid[0] == null) continue;
    const d = haversineM(lat, lon, x.centroid[0], x.centroid[1]);
    if (d < bestD) {
      bestD = d;
      best = x;
    }
  }
  return bestD <= 100 ? best : null;
}

// Pan/zoom the overview map to a berth and open its popup. `lat`/`lon` are the
// centroid captured when the notification fired — used to locate the berth when
// its id has since been renumbered, or to pan there if no berth resolves.
export function focusBerth(id, lat = null, lon = null) {
  el.modalOverlay.classList.add('hidden');
  if (!S.showBerths) {
    S.showBerths = true;
    if (el.berthsToggle) el.berthsToggle.checked = true;
    localStorage.setItem('showBerths', 'true');
    renderBerthsOverlay();
  }
  if (!S.activeMap) return;
  S.activeMap.invalidateSize();
  const b = resolveBerth(id, lat, lon);
  if (b && b.polygon && b.polygon.length >= 2) {
    S.activeMap.fitBounds(L.latLngBounds(b.polygon).pad(0.5), { maxZoom: 18 });
  } else if (b && b.centroid && b.centroid[0] != null) {
    S.activeMap.setView(b.centroid, 17);
  } else if (lat != null && lon != null) {
    // No live berth matched (e.g. an old notification, or the cluster vanished)
    // — at least pan to where it was so the tap does something.
    S.activeMap.setView([lat, lon], 17);
    return;
  } else if (S.currentBbox) {
    // Legacy notification with neither a live id nor coordinates: fall back to
    // framing the area so the tap still navigates somewhere sensible.
    S.activeMap.fitBounds(S.currentBbox, { padding: [40, 40] });
    return;
  } else {
    return;
  }
  const marker = berthLayers.get(b.id);
  if (marker) setTimeout(() => marker.openPopup(), 250);
}

// Navigate from a notification (any area) to a specific berth: switch the view
// to the berth's area if needed, open the active view, load that area's berths
// and focus the one tapped. Used by the notifications feed.
export async function goToBerth(area, id, lat = null, lon = null) {
  if (el.modalOverlay) el.modalOverlay.classList.add('hidden');
  if (area && area !== S.currentPreset) {
    try {
      const result = await api('/api/settings', 'POST', { preset: area });
      S.currentPreset = area;
      S.currentBbox = result.bbox;
      S.berthsList = [];
      if (el.bboxSelect) el.bboxSelect.value = area;
      const name = result.name || S.presets[area]?.name;
      if (name && el.appTitle) {
        el.appTitle.textContent = `${t('app.title')} - ${name}`;
        document.title = el.appTitle.textContent;
      }
    } catch {
      /* stay where we are; still try to focus below */
    }
  }
  showView('active');
  // Suppress the area-bbox fit: renderActiveMap (run by loadActive) would
  // otherwise fitBounds to the area box, and that animation fights focusBerth's
  // — Leaflet drops the later setView mid-animation, so the berth zoom is lost.
  // Priming activeFitKey to the current bbox makes renderActiveMap skip its fit,
  // leaving focusBerth the sole controller of the view.
  primeActiveFit();
  await Promise.all([loadActive(), loadBerths(S.currentPreset)]);
  // Focus once the map is mounted and laid out. whenReady fires immediately if
  // it's already ready; the rAF gives the container its final size first.
  const focus = () => {
    if (S.activeMap) {
      S.activeMap.invalidateSize();
      window.requestAnimationFrame(() => focusBerth(id, lat, lon));
    } else {
      setTimeout(() => focusBerth(id, lat, lon), 150);
    }
  };
  if (S.activeMap) S.activeMap.whenReady(focus);
  else setTimeout(focus, 150);
}

function distBars(b) {
  if (!b.dist || !b.dist.length) return '';
  return (
    `<div class="berth-dist">` +
    b.dist
      .map(
        (d) =>
          `<div class="berth-dist-row">` +
          `<span class="berth-dot" style="background:${categoryColor(d.category)}"></span>` +
          `<span class="berth-dist-cat">${escHtml(categoryLabel(d.category))}</span>` +
          `<span class="berth-dist-bar"><span style="width:${d.pct}%;background:${categoryColor(d.category)}"></span></span>` +
          `<span class="berth-dist-pct">${d.pct}% (${d.n})</span>` +
          `</div>`
      )
      .join('') +
    `</div>`
  );
}

function berthPopup(b) {
  const name = b.name || t('berth.unnamed');
  const labelTxt = b.label
    ? `<span class="berth-label" style="background:${categoryColor(b.label)}">${escHtml(categoryLabel(b.label))}</span>`
    : `<span class="berth-label berth-label-none">${escHtml(t('berth.uncharacterized'))}</span>`;
  const overrideMark = b.override
    ? ` <span title="${escHtml(t('berth.overridden'))}">✎</span>`
    : '';
  const hazmat =
    b.hazmatPct > 0
      ? `<div class="berth-hazmat">☢ ${t('berth.hazmat', { pct: b.hazmatPct })}</div>`
      : '';
  const note =
    !b.label && b.count < S.berthsMinMoorings
      ? `<div class="berth-note">${escHtml(t('berth.needMore', { have: b.count, need: S.berthsMinMoorings }))}</div>`
      : '';
  return (
    `<div class="berth-popup">` +
    `<b style="font-size:1rem">⚓ ${escHtml(name)}</b>${overrideMark}<br>` +
    `${labelTxt}<br>` +
    `<div class="berth-count">${t('berth.moorings', { n: b.count })}</div>` +
    hazmat +
    distBars(b) +
    note +
    `</div>`
  );
}

// ── Data ─────────────────────────────────────────────────────────────────────
export async function loadBerths(area) {
  const a = area || S.currentPreset;
  try {
    const r = await api(`/api/berths?area=${encodeURIComponent(a || '')}`);
    S.berthsList = r.berths || [];
    if (r.minMoorings != null) S.berthsMinMoorings = r.minMoorings;
    if (r.dominantPct != null) S.berthsDominantPct = r.dominantPct;
    renderBerthsOverlay();
  } catch {
    /* ignore — overlay just stays empty */
  }
}

function applyList(r) {
  if (!r) return;
  S.berthsList = r.berths || [];
  if (r.minMoorings != null) S.berthsMinMoorings = r.minMoorings;
  renderBerthsOverlay();
}

// ── Manager modal ────────────────────────────────────────────────────────────
function managerRow(b) {
  const checked = S.berthMergeSel.has(b.id) ? ' checked' : '';
  const options = ['']
    .concat(OVERRIDE_CATEGORIES)
    .map((c) => {
      const sel = b.override === c ? ' selected' : '';
      const text = c === '' ? t('berth.auto') : categoryLabel(c);
      return `<option value="${c}"${sel}>${escHtml(text)}</option>`;
    })
    .join('');
  const labelBadge = b.label
    ? `<span class="berth-label" style="background:${categoryColor(b.label)}">${escHtml(categoryLabel(b.label))}</span>`
    : `<span class="berth-label berth-label-none">${escHtml(t('berth.uncharacterized'))}</span>`;
  const manualTag = b.manual
    ? ` <span class="berth-manual-tag" title="${escHtml(t('berth.manualGeom'))}">✏</span>`
    : '';
  return `<tr data-id="${b.id}" title="${escHtml(t('berth.locateHint'))}">
    <td><input type="checkbox" class="berth-merge-check" data-id="${b.id}"${checked}></td>
    <td><input type="text" class="berth-name-input" data-id="${b.id}" value="${escHtml(b.name || '')}" placeholder="${escHtml(t('berth.unnamed'))}"></td>
    <td>${labelBadge}${manualTag}</td>
    <td class="berth-count-cell">${b.count}</td>
    <td><select class="berth-override-select" data-id="${b.id}">${options}</select></td>
    <td><button class="btn-mini btn-mini-clear berth-delete-btn" data-id="${b.id}">🗑</button></td>
  </tr>`;
}

function renderManager() {
  const rows = S.berthsList.length
    ? S.berthsList.map(managerRow).join('')
    : `<tr><td colspan="6" class="empty">${escHtml(t('berth.empty'))}</td></tr>`;
  const selCount = S.berthMergeSel.size;
  el.modalBody.innerHTML = `
    <div class="berth-manager-toolbar">
      <button id="berth-recompute" class="btn btn-secondary btn-sm">🔄 ${escHtml(t('berth.recompute'))}</button>
      <button id="berth-merge" class="btn btn-secondary btn-sm" ${selCount < 2 ? 'disabled' : ''}>⛓ ${escHtml(t('berth.merge', { n: selCount }))}</button>
      <span class="berth-manager-hint">${escHtml(t('berth.managerHint', { pct: S.berthsDominantPct, n: S.berthsMinMoorings }))}</span>
    </div>
    <table class="berth-manager-table">
      <thead><tr>
        <th></th>
        <th>${escHtml(t('berth.colName'))}</th>
        <th>${escHtml(t('berth.colChar'))}</th>
        <th>${escHtml(t('berth.colCount'))}</th>
        <th>${escHtml(t('berth.colOverride'))}</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  wireManager();
}

function wireManager() {
  const area = S.currentPreset;

  document.getElementById('berth-recompute')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api(`/api/berths/recompute?area=${encodeURIComponent(area || '')}`, 'POST');
      applyList(r);
      renderManager();
      showAlert(t('berth.recomputed'), '');
    } catch (err) {
      alert(t('berth.recomputeFail') + (err.message || err));
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('berth-merge')?.addEventListener('click', async () => {
    const ids = [...S.berthMergeSel];
    if (ids.length < 2) return;
    try {
      const r = await api('/api/berths/merge', 'POST', { ids });
      S.berthMergeSel.clear();
      applyList(r);
      renderManager();
    } catch (err) {
      alert(t('berth.mergeFail') + (err.message || err));
    }
  });

  el.modalBody.querySelectorAll('.berth-merge-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) S.berthMergeSel.add(id);
      else S.berthMergeSel.delete(id);
      const mergeBtn = document.getElementById('berth-merge');
      if (mergeBtn) {
        mergeBtn.disabled = S.berthMergeSel.size < 2;
        mergeBtn.textContent = `⛓ ${t('berth.merge', { n: S.berthMergeSel.size })}`;
      }
    });
  });

  el.modalBody.querySelectorAll('.berth-name-input').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const id = Number(inp.dataset.id);
      try {
        const r = await api(`/api/berths/${id}`, 'PATCH', { name: inp.value });
        applyList(r);
      } catch (err) {
        alert(t('berth.saveFail') + (err.message || err));
      }
    });
  });

  el.modalBody.querySelectorAll('.berth-override-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const id = Number(sel.dataset.id);
      try {
        const r = await api(`/api/berths/${id}`, 'PATCH', { override: sel.value || null });
        applyList(r);
        renderManager();
      } catch (err) {
        alert(t('berth.saveFail') + (err.message || err));
      }
    });
  });

  el.modalBody.querySelectorAll('.berth-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      if (!confirm(t('berth.deleteConfirm'))) return;
      try {
        const r = await api(`/api/berths/${id}`, 'DELETE');
        S.berthMergeSel.delete(id);
        applyList(r);
        renderManager();
      } catch (err) {
        alert(t('berth.deleteFail') + (err.message || err));
      }
    });
  });

  // Click a row (outside its inputs/controls) → focus that berth on the map.
  el.modalBody.querySelectorAll('tr[data-id]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('input, select, button, label')) return;
      focusBerth(Number(row.dataset.id));
    });
  });
}

export async function openBerthsManager() {
  S.berthMergeSel.clear();
  await loadBerths(S.currentPreset);
  el.modalTitle.textContent = t('berth.managerTitle', {
    area: S.presets[S.currentPreset]?.name || S.currentPreset,
  });
  renderManager();
  el.modalOverlay.classList.remove('hidden');
}

// ── Init ─────────────────────────────────────────────────────────────────────
export function initBerths() {
  // Restore the overlay toggle from localStorage.
  S.showBerths = localStorage.getItem('showBerths') === 'true';
  if (el.berthsToggle) el.berthsToggle.checked = S.showBerths;

  if (el.berthsToggle) {
    el.berthsToggle.addEventListener('change', () => {
      S.showBerths = el.berthsToggle.checked;
      localStorage.setItem('showBerths', S.showBerths ? 'true' : 'false');
      if (S.showBerths) loadBerths(S.currentPreset);
      else renderBerthsOverlay(); // clears the layer
    });
  }

  if (el.btnBerthsManage) {
    el.btnBerthsManage.addEventListener('click', openBerthsManager);
  }
}
