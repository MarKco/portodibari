// Ship search ("Cerca e segui una nave"). Lives in the Navi seguite tab. The user
// searches by name or MMSI; we look the ship up across the local fleet +
// MarineTraffic, then recover its live position from AISstream via an SSE stream
// (see GET /api/ships/search/recover). The results window stays open with a
// loading state and fills in progressively as each source answers. "Segui nave"
// is enabled only once a position is recovered. Closing the window / Cancel
// closes the SSE connection, which aborts the worldwide AISstream lookup
// server-side (req.on('close')).

import { el } from './dom.js';
import { api } from './api.js';
import { showAlert } from './toast.js';
import { t, getLang } from './i18n.js';
import { escHtml } from './helpers.js';
import { loadFollowedActive, loadFollowedPast } from './followed.js';

let es = null; // active recover EventSource
let current = null; // chosen candidate
let mergedFields = {}; // label → value, merged across sources
let map = null;
let marker = null;
let hasPosition = false;

// ── Modal open / close (close === cancel) ────────────────────────────────────
function openModal() {
  el.searchModal.classList.remove('hidden');
}

function closeModal() {
  abortRecover();
  el.searchModal.classList.add('hidden');
  if (map) { map.remove(); map = null; marker = null; }
}

function abortRecover() {
  if (es) { es.close(); es = null; } // closing the SSE aborts the server lookup
}

// ── Step 0: run the text search → candidates ─────────────────────────────────
async function runSearch(q) {
  current = null;
  abortRecover();
  el.searchDetail.classList.add('hidden');
  el.searchCandidates.classList.add('hidden');
  el.searchCandidates.innerHTML = '';
  el.searchMessage.textContent = t('search.searching');
  openModal();
  let data;
  try {
    data = await api(`/api/ships/search/candidates?q=${encodeURIComponent(q)}`);
  } catch {
    el.searchMessage.textContent = t('search.error');
    return;
  }
  const list = data.candidates || [];
  if (!list.length) {
    el.searchMessage.textContent = t('search.noResults');
    return;
  }
  if (list.length === 1) {
    el.searchMessage.textContent = '';
    pickCandidate(list[0]);
    return;
  }
  el.searchMessage.textContent = t('search.pick');
  renderCandidates(list);
}

function sourceTag(src) {
  if (src === 'local') return `<span class="src-tag src-local">${t('search.srcLocal')}</span>`;
  if (src === 'mt') return `<span class="src-tag src-mt">MarineTraffic</span>`;
  if (src === 'mmsi') return `<span class="src-tag">MMSI</span>`;
  return `<span class="src-tag">${escHtml(src)}</span>`;
}

function renderCandidates(list) {
  el.searchCandidates.classList.remove('hidden');
  el.searchCandidates.innerHTML = list
    .map((c, i) => `
      <button class="search-cand" data-i="${i}">
        <span class="search-cand-name">${escHtml(c.name) || t('search.unknownName')}</span>
        <span class="search-cand-meta mono">${c.mmsi || '—'}${c.imo ? ' · IMO ' + c.imo : ''}${c.flag ? ' · ' + escHtml(c.flag) : ''}</span>
        <span class="search-cand-src">${(c.sources || []).map(sourceTag).join('')}${c.hasLocalPos ? `<span class="src-tag src-pos">${t('search.hasPos')}</span>` : ''}</span>
      </button>`)
    .join('');
  for (const btn of el.searchCandidates.querySelectorAll('.search-cand')) {
    btn.addEventListener('click', () => {
      el.searchCandidates.classList.add('hidden');
      el.searchMessage.textContent = '';
      pickCandidate(list[Number(btn.dataset.i)]);
    });
  }
}

// ── Step 1: chosen a ship → open the recover SSE stream ──────────────────────
function pickCandidate(c) {
  current = c;
  hasPosition = false;
  mergedFields = {};
  el.searchDetail.classList.remove('hidden');
  el.searchDetailName.textContent = c.name || t('search.unknownName');
  el.searchDetailMmsi.textContent = c.mmsi ? `MMSI ${c.mmsi}` : '';
  el.searchSources.innerHTML = '';
  el.searchScreening.innerHTML = '';
  el.searchFields.innerHTML = '';
  el.searchMap.classList.add('hidden');
  el.searchRetry.classList.add('hidden');
  el.searchFollow.disabled = true;
  setPosStatus('recovering');
  startRecover(c);
}

function setPosStatus(kind) {
  if (kind === 'recovering') {
    el.searchPosStatus.className = 'search-pos-status';
    el.searchPosStatus.innerHTML = `<span class="search-spinner" aria-hidden="true"></span><span>${t('search.recovering')}</span>`;
  } else if (kind === 'found') {
    el.searchPosStatus.className = 'search-pos-status ok';
    el.searchPosStatus.innerHTML = `<span>📍 ${t('search.posFound')}</span>`;
  } else if (kind === 'timeout') {
    el.searchPosStatus.className = 'search-pos-status warn';
    el.searchPosStatus.innerHTML = `<span>⚠ ${t('search.noSignal')}</span>`;
  }
}

function startRecover(c) {
  abortRecover();
  const p = new URLSearchParams();
  if (c.mmsi) p.set('mmsi', c.mmsi);
  else if (c.mtShipId) p.set('mtShipId', c.mtShipId);
  if (c.imo) p.set('imo', c.imo);
  if (c.name) p.set('name', c.name);
  p.set('lang', getLang());
  es = new EventSource(`/api/ships/search/recover?${p.toString()}`);

  es.addEventListener('identity', (e) => {
    const d = JSON.parse(e.data);
    if (d.mmsi) { current.mmsi = d.mmsi; el.searchDetailMmsi.textContent = `MMSI ${d.mmsi}`; }
    if (d.name) el.searchDetailName.textContent = d.name;
    addSourceBadge('local', d.local ? 'ok' : 'miss');
    if (d.risk) {
      el.searchScreening.insertAdjacentHTML('beforeend',
        `<span class="screen-badge band-${d.risk.band}">${t('search.risk')}: ${d.risk.score}</span>`);
    }
  });

  es.addEventListener('source', (e) => {
    const d = JSON.parse(e.data);
    addSourceBadge(d.source, d.ok ? (d.notFound ? 'miss' : 'ok') : 'err', d.error);
    if (d.ok && d.data && typeof d.data === 'object') mergeFields(d.data);
    if (d.flagPerf) addFlagBadge(d.flagPerf);
  });

  es.addEventListener('screening', (e) => {
    const d = JSON.parse(e.data);
    if (d.sanctioned) {
      el.searchScreening.insertAdjacentHTML('beforeend',
        `<a class="screen-badge danger" href="${escHtml(d.sanctioned.url) || '#'}" target="_blank" rel="noopener">⛔ ${t('search.sanctioned')} (${escHtml(d.sanctioned.matchedOn)})</a>`);
    }
    if (d.banned) {
      el.searchScreening.insertAdjacentHTML('beforeend',
        `<span class="screen-badge danger">🚫 ${t('search.banned')}</span>`);
    }
  });

  es.addEventListener('position', (e) => {
    const d = JSON.parse(e.data);
    onPosition(d);
  });

  es.addEventListener('timeout', () => {
    if (!hasPosition) {
      setPosStatus('timeout');
      el.searchRetry.classList.remove('hidden');
    }
  });

  es.addEventListener('error', (e) => {
    // Named server error (e.g. MMSI unresolvable). Transport drops have no data.
    try {
      const d = JSON.parse(e.data);
      if (d && d.message) { el.searchMessage.textContent = d.message; abortRecover(); }
    } catch { /* transport-level error: EventSource will retry on its own */ }
  });

  es.addEventListener('done', () => abortRecover());
}

function addSourceBadge(source, kind, error) {
  const labels = { local: t('search.srcLocal'), vf: 'VesselFinder', mt: 'MarineTraffic', gfw: 'GFW', sf: 'ShipFinder', mst: 'MyShipTracking' };
  const label = labels[source] || source;
  const icon = kind === 'ok' ? '✓' : kind === 'miss' ? '–' : '✕';
  const existing = el.searchSources.querySelector(`[data-src="${source}"]`);
  const html = `<span class="src-badge ${kind}" data-src="${source}"${error ? ` title="${escHtml(error)}"` : ''}>${icon} ${escHtml(label)}</span>`;
  if (existing) existing.outerHTML = html;
  else el.searchSources.insertAdjacentHTML('beforeend', html);
}

function addFlagBadge(perf) {
  const cls = perf === 'black' ? 'danger' : perf === 'grey' ? 'warn' : 'ok';
  el.searchScreening.insertAdjacentHTML('beforeend',
    `<span class="screen-badge ${cls}">${t('search.flagPerf')}: ${escHtml(perf)}</span>`);
}

function mergeFields(data) {
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === '' || typeof v === 'object') continue;
    if (!mergedFields[k]) mergedFields[k] = String(v);
  }
  renderFields();
}

function renderFields() {
  const keys = Object.keys(mergedFields);
  if (!keys.length) { el.searchFields.innerHTML = ''; return; }
  el.searchFields.innerHTML = keys
    .map((k) => `<div class="search-field"><span class="sf-k">${escHtml(k)}</span><span class="sf-v">${escHtml(mergedFields[k])}</span></div>`)
    .join('');
}

function onPosition(d) {
  if (d.lat == null || d.lon == null) return;
  hasPosition = true;
  el.searchRetry.classList.add('hidden');
  setPosStatus('found');
  el.searchFollow.disabled = false;
  el.searchMap.classList.remove('hidden');
  if (!map) {
    map = L.map(el.searchMap, { zoomControl: true }).setView([d.lat, d.lon], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '© OpenStreetMap',
    }).addTo(map);
  }
  map.setView([d.lat, d.lon], map.getZoom() < 6 ? 8 : map.getZoom());
  if (marker) marker.setLatLng([d.lat, d.lon]);
  else marker = L.marker([d.lat, d.lon]).addTo(map);
  const srcName = d.source === 'sf' ? 'ShipFinder' : d.source === 'mst' ? 'MyShipTracking' : null;
  const when = d.cached && d.time ? ` · ${t('search.lastKnown')}${srcName ? ` (${srcName})` : ''}` : '';
  marker.bindPopup(`${escHtml(d.name || current.name || '')}<br>${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}${when}`);
  // The modal was hidden when Leaflet sized itself; nudge it once visible.
  setTimeout(() => map && map.invalidateSize(), 60);
}

// ── Follow ───────────────────────────────────────────────────────────────────
async function followShip() {
  if (!current || !current.mmsi) return;
  el.searchFollow.disabled = true;
  try {
    await api(`/api/ships/${current.mmsi}/follow`, 'PATCH', { followed: true });
    showAlert(`🗺 ${t('search.nowFollowing')}`, escHtml(current.name || `MMSI ${current.mmsi}`));
    closeModal();
    loadFollowedActive();
    loadFollowedPast();
  } catch {
    el.searchFollow.disabled = false;
    showAlert(t('search.error'), '');
  }
}

// ── Wiring (run once at module load) ─────────────────────────────────────────
if (el.shipSearchBar) {
  el.shipSearchBar.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = (el.shipSearchInput.value || '').trim();
    if (q.length >= 2) runSearch(q);
  });
}
if (el.searchModalClose) el.searchModalClose.addEventListener('click', closeModal);
if (el.searchCancel) el.searchCancel.addEventListener('click', closeModal);
if (el.searchFollow) el.searchFollow.addEventListener('click', followShip);
if (el.searchRetry) el.searchRetry.addEventListener('click', () => { if (current) pickCandidate(current); });
if (el.searchModal) {
  el.searchModal.addEventListener('click', (e) => { if (e.target === el.searchModal) closeModal(); });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.searchModal && !el.searchModal.classList.contains('hidden')) closeModal();
});
