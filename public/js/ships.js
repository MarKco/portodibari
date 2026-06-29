import { el } from './dom.js';
import { S, PAGE_SIZE, saveShipFilters } from './store.js';
import { api } from './api.js';
import { showAlert } from './toast.js';
import { renderActiveMap, renderSfPositions } from './maps.js';
import { showView } from './views.js';
import { t, getLang } from './i18n.js';
import { exportShips, exportTrack, exportBerths } from './geoexport.js';
import {
  escHtml,
  formatTime,
  formatDuration,
  shortType,
  navStatus,
  directionBadge,
  shipTypeLabel,
  shipTypeBadge,
  riskBadge,
  riskClass,
  cargoTypeHtml,
  loadStateHtml,
  infoIcon,
} from './helpers.js';

// ── Detail header buttons ────────────────────────────────────────────────────
export function updateDetailFlagBtn(flagged) {
  el.btnFlagDetail.dataset.flagged = flagged ? '1' : '0';
  el.btnFlagDetail.classList.toggle('flagged', !!flagged);
  el.btnFlagDetail.textContent = flagged ? '★' : '☆';
  el.btnFlagDetail.title = flagged ? t('detail.flagRemove') : t('detail.flagAdd');
}

export function updateDetailSeenBtn(seen) {
  el.btnSeenDetail.dataset.seen = seen ? '1' : '0';
  el.btnSeenDetail.classList.toggle('seen', !!seen);
  el.btnSeenDetail.title = seen ? t('detail.seenRemove') : t('detail.seenAdd');
}

export function updateDetailFollowBtn(followed) {
  if (!el.btnFollowDetail) return;
  el.btnFollowDetail.dataset.followed = followed ? '1' : '0';
  el.btnFollowDetail.classList.toggle('followed', !!followed);
  el.btnFollowDetail.title = followed ? t('detail.followRemove') : t('detail.followAdd');
}

export function updateDetailFollowStatus(shipData) {
  const badge = document.getElementById('follow-status-detail');
  if (!badge) return;
  const searching = shipData.followed && shipData.search_mode;
  badge.classList.toggle('hidden', !searching);
  if (searching) {
    const months = Math.round(S.followStaleHours / 24 / 30);
    badge.dataset.tip = `Nessun segnale AIS ricevuto. La nave viene cercata in tutto il mondo per un massimo di ${months} mesi. Se riprende a trasmettere riceverai una notifica.`;
  }
  // Dedicated, separate ShipFinder indicator: shown alongside "in ricerca" when we
  // have a scraped last-known position — distinguishes "located on ShipFinder" from
  // a live AIS re-acquisition (the ship is still AIS-dark).
  const sfBadge = document.getElementById('sf-status-detail');
  if (sfBadge) {
    const hasSf = !!(shipData.followed && shipData.sf_last_at);
    sfBadge.classList.toggle('hidden', !hasSf);
    if (hasSf) sfBadge.textContent = `📍 ${t('follow.sfSeen', { time: formatTime(shipData.sf_last_at) })}`;
  }
}

export function updateDetailMilitaryBtn(isMilitary) {
  el.btnMilitaryDetail.dataset.military = isMilitary ? '1' : '0';
  el.btnMilitaryDetail.classList.toggle('active', !!isMilitary);
  const label = isMilitary ? t('detail.militaryActive') : t('detail.militaryAdd');
  el.btnMilitaryDetail.title = isMilitary ? t('detail.militaryRemove') : t('detail.militaryAdd');
  document.getElementById('military-btn-label').textContent = label;
}

export function updateDetailNotifMuteBtn(muted) {
  el.btnNotifMuteDetail.dataset.muted = muted ? '1' : '0';
  el.btnNotifMuteDetail.classList.toggle('muted', !!muted);
  el.btnNotifMuteDetail.textContent = muted ? '🔕' : '🔔';
  el.btnNotifMuteDetail.title = muted ? t('detail.notifMuteRemove') : t('detail.notifMuteAdd');
}

el.btnNotifMuteDetail.addEventListener('click', async () => {
  if (S.detailMmsi == null) return;
  const newMuted = el.btnNotifMuteDetail.dataset.muted === '1' ? 0 : 1;
  await api(`/api/ships/${S.detailMmsi}/notif-muted`, 'PATCH', { notif_muted: newMuted });
  updateDetailNotifMuteBtn(newMuted);
  if (S.detailShipData) S.detailShipData.notif_muted = newMuted;
});

el.btnFlagDetail.addEventListener('click', async () => {
  if (S.detailMmsi == null) return;
  const newFlag = el.btnFlagDetail.dataset.flagged === '1' ? 0 : 1;
  await api(`/api/ships/${S.detailMmsi}/flag`, 'PATCH', { flagged: newFlag });
  updateDetailFlagBtn(newFlag);
  if (S.detailShipData) S.detailShipData.flagged = newFlag;
});

el.btnSeenDetail.addEventListener('click', async () => {
  if (S.detailMmsi == null) return;
  const newSeen = el.btnSeenDetail.dataset.seen === '1' ? 0 : 1;
  await api(`/api/ships/${S.detailMmsi}/seen`, 'PATCH', { seen: newSeen });
  updateDetailSeenBtn(newSeen);
  if (S.detailShipData) S.detailShipData.seen = newSeen;
});

if (el.btnFollowDetail) {
  el.btnFollowDetail.addEventListener('click', async () => {
    if (S.detailMmsi == null) return;
    const newFollow = el.btnFollowDetail.dataset.followed === '1' ? 0 : 1;
    const res = await api(`/api/ships/${S.detailMmsi}/follow`, 'PATCH', { followed: newFollow });
    updateDetailFollowBtn(newFollow);
    if (S.detailShipData) {
      S.detailShipData.followed = newFollow;
      if (!newFollow) S.detailShipData.search_mode = 0;
    }
    updateDetailFollowStatus(S.detailShipData || { followed: newFollow, search_mode: 0 });
    // Re-follow of a ship with a stale position runs a background worldwide
    // re-acquisition (up to ~90s). Tell the user it's underway and may revert.
    if (newFollow && res && res.reacquiring) {
      showAlert(t('search.reacquiring'), t('search.reacquiringHint'));
    }
  });
}

el.btnMilitaryDetail.addEventListener('click', async () => {
  if (S.detailMmsi == null) return;
  const newMilitary = el.btnMilitaryDetail.dataset.military === '1' ? 0 : 1;
  await api(`/api/ships/${S.detailMmsi}/military`, 'PATCH', { is_military: newMilitary });
  updateDetailMilitaryBtn(newMilitary);
  if (S.detailShipData) S.detailShipData.is_military = newMilitary;
});

if (el.btnReportDetail) {
  el.btnReportDetail.addEventListener('click', () => {
    if (S.detailMmsi != null) generateReport(S.detailMmsi);
  });
}

// Track export (GeoJSON/KML): fetch the full track and emit a LineString + per-fix points.
const trackGeo = (fmt) => async () => {
  if (S.detailMmsi == null) return;
  try {
    const r = await api(`/api/ships/${S.detailMmsi}/track`);
    const name = S.detailShipData?.ship_name || el.detailName?.textContent || '';
    if (!exportTrack(r.points || [], { mmsi: S.detailMmsi, name }, fmt)) showAlert(t('export.emptyTrack'));
  } catch {
    showAlert(t('export.emptyTrack'));
  }
};
const trackExpSel = document.getElementById('track-export-sel');
if (trackExpSel) trackExpSel.addEventListener('change', async (e) => {
  const fmt = e.target.value;
  if (!fmt) return;
  e.target.value = '';
  await trackGeo(fmt)();
});

el.btnSaveNotes.addEventListener('click', async () => {
  if (S.detailMmsi == null) return;
  try {
    await api(`/api/ships/${S.detailMmsi}/notes`, 'PATCH', { notes: el.detailNotesEl.value });
    el.btnSaveNotes.textContent = t('detail.notesSaved');
    setTimeout(() => {
      el.btnSaveNotes.textContent = t('detail.notesSave');
    }, 2000);
  } catch {
    /* ignore */
  }
});

// ── Active table sort ─────────────────────────────────────────────────────────
let activeShipsData = [];
let activeSort = { col: null, dir: 'asc' };
let pastShipsData = [];
let pastSort = { col: null, dir: 'asc' };

export function sortShips(ships, col, dir) {
  if (!col) return ships;
  return [...ships].sort((a, b) => {
    let va, vb;
    if (col === 'risk') {
      va = a.risk?.score ?? -1;
      vb = b.risk?.score ?? -1;
      return dir === 'asc' ? va - vb : vb - va;
    }
    if (col === 'duration_ms') {
      va = a.last_seen_at && a.first_seen_at ? new Date(a.last_seen_at) - new Date(a.first_seen_at) : -1;
      vb = b.last_seen_at && b.first_seen_at ? new Date(b.last_seen_at) - new Date(b.first_seen_at) : -1;
      return dir === 'asc' ? va - vb : vb - va;
    }
    if (col === 'last_sog' || col === 'mmsi' || col === 'ship_type') {
      va = a[col] ?? -1;
      vb = b[col] ?? -1;
      return dir === 'asc' ? va - vb : vb - va;
    }
    va = (a[col] ?? '').toString();
    vb = (b[col] ?? '').toString();
    const cmp = va.localeCompare(vb);
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ── List filters (client-side) ─────────────────────────────────────────────────
export function filterShips(ships, f, opts = {}) {
  const q = (f.q || '').trim().toLowerCase();
  return ships.filter((s) => {
    if (f.band && s.risk?.band !== f.band) return false;
    if (f.flagged && !s.flagged) return false;
    // Ships marked as seen are hidden unless the "viste" toggle is on; flagged
    // ships are always kept (segnalate hanno priorità). Only filters that opt in
    // (active/past, which carry a showSeen field) apply this — the followed lists
    // have no such field and keep showing seen ships.
    if ('showSeen' in f && !f.showSeen && s.seen && !s.flagged) return false;
    if (opts.inPort && f.inPort && !s.in_port) return false;
    if (q) {
      const hay = [s.ship_name, s.mmsi, s.imo_number, s.destination, s.call_sign]
        .map((v) => (v == null ? '' : String(v).toLowerCase()))
        .join(' ');
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function updateFilterCount(elId, shown, total) {
  const node = document.getElementById(elId);
  if (!node) return;
  node.textContent = shown === total ? '' : t('filter.count', { shown, total });
}

// How many ships the "viste" toggle is currently hiding: the marginal difference
// between what would show with seen ships included and what shows now (so other
// active filters are accounted for). Zero when the toggle is on.
export function countHiddenSeen(ships, f, opts = {}) {
  if (f.showSeen) return 0;
  const withSeen = filterShips(ships, { ...f, showSeen: true }, opts);
  const without = filterShips(ships, f, opts);
  return withSeen.length - without.length;
}

export function updateSeenHidden(elId, count) {
  const node = document.getElementById(elId);
  if (!node) return;
  if (count > 0) {
    node.innerHTML = escHtml(t('filter.seenHidden', { n: count })) + infoIcon(t('filter.showSeen'), t('filter.seenHiddenInfo'));
  } else {
    node.innerHTML = '';
  }
}

// ── CSV export (client-side, current filtered + sorted view) ───────────────────
function downloadCsv(filename, headers, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))];
  // BOM so Excel detects UTF-8.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportShipsCsv(ships, prefix) {
  const headers = [
    'MMSI', 'Nome', 'Tipo (codice)', 'Destinazione', 'SOG (kn)', 'COG',
    'In porto', 'Score rischio', 'Fascia', 'Segnalata', 'Militare',
    'Primo contatto', 'Ultimo contatto', 'Call sign', 'IMO', 'Lat', 'Lon',
  ];
  const rows = ships.map((s) => [
    s.mmsi, s.ship_name, s.ship_type, s.destination, s.last_sog, s.last_cog,
    s.in_port ? 'sì' : 'no', s.risk?.score, s.risk?.band, s.flagged ? 'sì' : 'no',
    s.is_military ? 'sì' : 'no', s.first_seen_at, s.last_seen_at, s.call_sign,
    s.imo_number, s.last_latitude, s.last_longitude,
  ]);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadCsv(`${prefix}-${ts}.csv`, headers, rows);
}

function applyActiveSortHeader() {
  const thead = el.activeBody.closest('table').tHead;
  for (const th of thead.querySelectorAll('th[data-col]')) {
    th.classList.toggle('sort-asc', th.dataset.col === activeSort.col && activeSort.dir === 'asc');
    th.classList.toggle('sort-desc', th.dataset.col === activeSort.col && activeSort.dir === 'desc');
  }
}

function applyPastSortHeader() {
  const thead = el.pastBody.closest('table').tHead;
  for (const th of thead.querySelectorAll('th[data-col]')) {
    th.classList.toggle('sort-asc', th.dataset.col === pastSort.col && pastSort.dir === 'asc');
    th.classList.toggle('sort-desc', th.dataset.col === pastSort.col && pastSort.dir === 'desc');
  }
}

// ── Active ships ─────────────────────────────────────────────────────────────
export async function loadActive() {
  try {
    const area = encodeURIComponent(S.currentPreset || '');
    const [data, alertsData] = await Promise.all([
      api(`/api/ships/active${area ? `?area=${area}` : ''}`),
      api('/api/alerts').catch(() => null),
    ]);
    if (alertsData?.alerts?.length) {
      for (const a of alertsData.alerts) {
        const name = a.ship_name || `MMSI ${a.mmsi}`;
        showAlert(
          t('alert.flagged'),
          `<strong>${escHtml(name)}</strong><br>${shipTypeLabel(a.ship_type)}`,
          10000
        );
      }
    }
    const ships = data.ships || [];
    el.activeCount.textContent = ships.length;
    renderActiveTable(ships);
  } catch {
    /* ignore */
  }
}

export function flagSeenButtonsHtml(s) {
  return `
    <button class="flag-btn ${s.flagged ? 'flagged' : ''}"
            data-mmsi="${s.mmsi}" data-flagged="${s.flagged}"
            title="${s.flagged ? t('detail.flagRemove') : t('detail.flagAdd')}">
      ${s.flagged ? '★' : '☆'}
    </button>
    <button class="seen-btn ${s.seen ? 'seen' : ''}"
            data-mmsi="${s.mmsi}" data-seen="${s.seen}"
            title="${s.seen ? t('detail.seenRemove') : t('detail.seenAdd')}">
      ✓
    </button>
    <button class="follow-btn ${s.followed ? 'followed' : ''}"
            data-mmsi="${s.mmsi}" data-followed="${s.followed ? 1 : 0}"
            title="${s.followed ? t('detail.followRemove') : t('detail.followAdd')}">
      🗺
    </button>
    <a class="vf-link" href="https://www.vesselfinder.com/vessels/details/${s.mmsi}"
       target="_blank" rel="noopener" title="${t('detail.vfLink')}">⧉</a>`;
}

export function bindFlagSeenButtons(tbody, reload) {
  tbody.querySelectorAll('.flag-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const mmsi = Number(btn.dataset.mmsi);
      const newFlag = Number(btn.dataset.flagged) ? 0 : 1;
      await api(`/api/ships/${mmsi}/flag`, 'PATCH', { flagged: newFlag });
      reload();
    });
  });
  tbody.querySelectorAll('.seen-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const mmsi = Number(btn.dataset.mmsi);
      const newSeen = Number(btn.dataset.seen) ? 0 : 1;
      await api(`/api/ships/${mmsi}/seen`, 'PATCH', { seen: newSeen });
      reload();
    });
  });
  tbody.querySelectorAll('.follow-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const mmsi = Number(btn.dataset.mmsi);
      const newFollow = Number(btn.dataset.followed) ? 0 : 1;
      await api(`/api/ships/${mmsi}/follow`, 'PATCH', { followed: newFollow });
      reload();
    });
  });
}

function renderActiveTable(ships) {
  activeShipsData = ships;
  const filtered = filterShips(ships, S.activeFilter, { inPort: true });
  renderActiveMap(filtered);
  updateFilterCount('active-filter-count', filtered.length, ships.length);
  updateSeenHidden('active-seen-hidden', countHiddenSeen(ships, S.activeFilter, { inPort: true }));
  const sorted = sortShips(filtered, activeSort.col, activeSort.dir);
  if (!sorted.length) {
    el.activeBody.innerHTML =
      `<tr><td colspan="9" class="empty">${ships.length ? t('filter.noMatch') : t('empty.active')}</td></tr>`;
    applyActiveSortHeader();
    return;
  }
  el.activeBody.innerHTML = sorted
    .map(
      (s) => `
    <tr class="ship-row ${s.is_military ? 'military-row' : s.risk?.band === 'high' ? 'risk-row' : ''} ${s.flagged ? 'flagged-row' : ''} ${s.seen ? 'seen-row' : ''}" data-mmsi="${s.mmsi}">
      <td class="col-flags">${flagSeenButtonsHtml(s)}</td>
      <td>${formatTime(s.last_seen_at)}</td>
      <td class="ship-name">${escHtml(s.ship_name) || '—'}${s.in_port ? ` <span class="port-badge">${t('port.badge')}</span>` : ''}</td>
      <td class="mono">${s.mmsi}</td>
      <td>${shipTypeBadge(s.ship_type)}</td>
      <td class="destination">${escHtml(s.destination_label || s.destination) || '—'}</td>
      <td>${s.last_sog != null ? s.last_sog.toFixed(1) + ' kn' : '—'}</td>
      <td>${directionBadge(s.direction)}</td>
      <td class="col-risk">${riskBadge(s.risk)}</td>
    </tr>
  `
    )
    .join('');
  bindShipRows(el.activeBody, 'active', sorted);
  bindFlagSeenButtons(el.activeBody, loadActive);
  applyActiveSortHeader();
}

// Bind sort click handlers once at module load (thead is static HTML).
{
  const thead = document.querySelector('#view-active thead');
  if (thead) {
    for (const th of thead.querySelectorAll('th[data-col]')) {
      th.addEventListener('click', () => {
        if (activeSort.col === th.dataset.col) {
          activeSort.dir = activeSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          activeSort.col = th.dataset.col;
          activeSort.dir = 'asc';
        }
        renderActiveTable(activeShipsData);
      });
    }
  }
}

{
  const thead = document.querySelector('#view-past thead');
  if (thead) {
    for (const th of thead.querySelectorAll('th[data-col]')) {
      th.addEventListener('click', () => {
        if (pastSort.col === th.dataset.col) {
          pastSort.dir = pastSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          pastSort.col = th.dataset.col;
          pastSort.dir = 'asc';
        }
        renderPastTable(pastShipsData);
      });
    }
  }
}

// ── Filter / export toolbar wiring ─────────────────────────────────────────────
{
  const a = {
    search: document.getElementById('active-search'),
    band: document.getElementById('active-band'),
    inport: document.getElementById('active-inport'),
    flagged: document.getElementById('active-flagged'),
    seen: document.getElementById('active-seen'),
  };
  // Reflect the persisted filter state on the controls before wiring handlers.
  if (a.search) a.search.value = S.activeFilter.q || '';
  if (a.band) a.band.value = S.activeFilter.band || '';
  if (a.inport) a.inport.checked = !!S.activeFilter.inPort;
  if (a.flagged) a.flagged.checked = !!S.activeFilter.flagged;
  if (a.seen) a.seen.checked = !!S.activeFilter.showSeen;
  if (a.search) a.search.addEventListener('input', () => { S.activeFilter.q = a.search.value; saveShipFilters(); renderActiveTable(activeShipsData); });
  if (a.band) a.band.addEventListener('change', () => { S.activeFilter.band = a.band.value; saveShipFilters(); renderActiveTable(activeShipsData); });
  if (a.inport) a.inport.addEventListener('change', () => { S.activeFilter.inPort = a.inport.checked; saveShipFilters(); renderActiveTable(activeShipsData); });
  if (a.flagged) a.flagged.addEventListener('change', () => { S.activeFilter.flagged = a.flagged.checked; saveShipFilters(); renderActiveTable(activeShipsData); });
  if (a.seen) a.seen.addEventListener('change', () => { S.activeFilter.showSeen = a.seen.checked; saveShipFilters(); renderActiveTable(activeShipsData); });
  const activeExpSel = document.getElementById('active-export-sel');
  if (activeExpSel) activeExpSel.addEventListener('change', (e) => {
    const fmt = e.target.value;
    if (!fmt) return;
    e.target.value = '';
    const sorted = sortShips(filterShips(activeShipsData, S.activeFilter, { inPort: true }), activeSort.col, activeSort.dir);
    if (fmt === 'csv') exportShipsCsv(sorted, 'navi-presenti');
    else if (!exportShips(sorted, fmt, 'navi-presenti')) showAlert(t('export.empty'));
  });
  const berthsExpSel = document.getElementById('berths-export-sel');
  if (berthsExpSel) berthsExpSel.addEventListener('change', (e) => {
    const fmt = e.target.value;
    if (!fmt) return;
    e.target.value = '';
    if (!exportBerths(S.berthsList, fmt, S.currentPreset || 'area')) showAlert(t('export.emptyBerths'));
  });

  const p = {
    search: document.getElementById('past-search'),
    band: document.getElementById('past-band'),
    flagged: document.getElementById('past-flagged'),
    seen: document.getElementById('past-seen'),
  };
  if (p.search) p.search.value = S.pastFilter.q || '';
  if (p.band) p.band.value = S.pastFilter.band || '';
  if (p.flagged) p.flagged.checked = !!S.pastFilter.flagged;
  if (p.seen) p.seen.checked = !!S.pastFilter.showSeen;
  if (p.search) p.search.addEventListener('input', () => { S.pastFilter.q = p.search.value; saveShipFilters(); renderPastTable(pastShipsData); });
  if (p.band) p.band.addEventListener('change', () => { S.pastFilter.band = p.band.value; saveShipFilters(); renderPastTable(pastShipsData); });
  if (p.flagged) p.flagged.addEventListener('change', () => { S.pastFilter.flagged = p.flagged.checked; saveShipFilters(); renderPastTable(pastShipsData); });
  if (p.seen) p.seen.addEventListener('change', () => { S.pastFilter.showSeen = p.seen.checked; saveShipFilters(); renderPastTable(pastShipsData); });
  const pastExpSel = document.getElementById('past-export-sel');
  if (pastExpSel) pastExpSel.addEventListener('change', (e) => {
    const fmt = e.target.value;
    if (!fmt) return;
    e.target.value = '';
    const sorted = sortShips(filterShips(pastShipsData, S.pastFilter), pastSort.col, pastSort.dir);
    if (fmt === 'csv') exportShipsCsv(sorted, 'navi-passate');
    else if (!exportShips(sorted, fmt, 'navi-passate')) showAlert(t('export.empty'));
  });
}

// ── Past ships ───────────────────────────────────────────────────────────────
export async function loadPastCount() {
  try {
    const area = encodeURIComponent(S.currentPreset || '');
    const data = await api(`/api/ships/past/count${area ? `?area=${area}` : ''}`);
    el.pastCount.textContent = data.count ?? 0;
  } catch {
    /* ignore */
  }
}

export async function loadPast() {
  try {
    const area = encodeURIComponent(S.currentPreset || '');
    const data = await api(`/api/ships/past${area ? `?area=${area}` : ''}`);
    const ships = data.ships || [];
    el.pastCount.textContent = ships.length;
    renderPastTable(ships);
  } catch {
    /* ignore */
  }
}

function renderPastTable(ships) {
  pastShipsData = ships;
  const filtered = filterShips(ships, S.pastFilter);
  updateFilterCount('past-filter-count', filtered.length, ships.length);
  updateSeenHidden('past-seen-hidden', countHiddenSeen(ships, S.pastFilter));
  const sorted = sortShips(filtered, pastSort.col, pastSort.dir);
  if (!sorted.length) {
    el.pastBody.innerHTML = `<tr><td colspan="8" class="empty">${ships.length ? t('filter.noMatch') : t('empty.past')}</td></tr>`;
    applyPastSortHeader();
    return;
  }
  el.pastBody.innerHTML = sorted
    .map(
      (s) => `
    <tr class="ship-row ${s.is_military ? 'military-row' : s.risk?.band === 'high' ? 'risk-row' : ''} ${s.flagged ? 'flagged-row' : ''} ${s.seen ? 'seen-row' : ''}" data-mmsi="${s.mmsi}" data-name="${escHtml(s.ship_name || '')}">
      <td class="col-flags">${flagSeenButtonsHtml(s)}</td>
      <td class="ship-name">${escHtml(s.ship_name) || '—'}</td>
      <td class="mono">${s.mmsi}</td>
      <td>${formatTime(s.last_seen_at)}</td>
      <td>${formatTime(s.first_seen_at)}</td>
      <td>${formatDuration(new Date(s.last_seen_at) - new Date(s.first_seen_at))}</td>
      <td>${s.last_sog != null ? s.last_sog.toFixed(1) + ' kn' : '—'}</td>
      <td class="col-risk">${riskBadge(s.risk)}</td>
    </tr>
  `
    )
    .join('');
  bindShipRows(el.pastBody, 'past', sorted);
  bindFlagSeenButtons(el.pastBody, loadPast);
  applyPastSortHeader();
}

export function bindShipRows(tbody, fromView, ships) {
  tbody.querySelectorAll('.ship-row').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.flag-btn') || e.target.closest('.seen-btn') || e.target.closest('.follow-btn') || e.target.closest('.vf-link'))
        return;
      S.detailFrom = fromView;
      const mmsi = Number(tr.dataset.mmsi);
      const ship = ships?.find((s) => s.mmsi === mmsi) || null;
      showView('detail', mmsi, ship);
    });
  });
}

// ── Ship detail ──────────────────────────────────────────────────────────────
export async function loadDetail() {
  if (S.detailMmsi == null) return;
  try {
    const [data, shipData, eventsData, historyData, rdvData] = await Promise.all([
      api(`/api/ships/${S.detailMmsi}/readings?limit=${PAGE_SIZE}&offset=${S.detailPage * PAGE_SIZE}`),
      api(`/api/ships/${S.detailMmsi}`).catch(() => null),
      api(`/api/ships/${S.detailMmsi}/events`).catch(() => null),
      api(`/api/ships/${S.detailMmsi}/risk-history`).catch(() => null),
      api(`/api/ships/${S.detailMmsi}/rendezvous`).catch(() => null),
    ]);
    renderRiskHistory(historyData?.history || []);
    renderRendezvous(rdvData?.rendezvous || []);
    if (shipData) {
      S.detailShipData = shipData;
      if (shipData.ship_name) el.detailName.textContent = shipData.ship_name;
      updateDetailFlagBtn(shipData.flagged);
      updateDetailSeenBtn(shipData.seen);
      updateDetailFollowBtn(shipData.followed);
      updateDetailFollowStatus(shipData);
      updateDetailMilitaryBtn(shipData.is_military);
      updateDetailNotifMuteBtn(shipData.notif_muted);
      if (el.detailNotesEl !== document.activeElement) {
        el.detailNotesEl.value = shipData.notes || '';
      }
      const events = eventsData?.events || [];
      const latestArrival = events.find((e) => e.event_type === 'arrived');
      renderDetailInfoBar(shipData, latestArrival);
      renderSanctionsSection(shipData.risk);
      renderDetailEvents(events);
    }
    S.detailTotal = data.total;
    renderDetailTable(data.rows);
    updateDetailPagination();
  } catch {
    /* ignore */
  }
}

function renderDetailTable(rows) {
  if (!rows.length) {
    el.detailBody.innerHTML = `<tr><td colspan="8" class="empty">${t('empty.readings')}</td></tr>`;
    return;
  }
  if (!el.detailName.textContent && rows[0].ship_name) {
    el.detailName.textContent = rows[0].ship_name;
  }
  el.detailBody.innerHTML = rows
    .map(
      (r) => `
    <tr class="reading-row" data-id="${r.id}">
      <td>${formatTime(r.received_at)}</td>
      <td><span class="type-badge ${r.message_type}">${shortType(r.message_type)}</span></td>
      <td>${r.sog != null ? r.sog.toFixed(1) + ' kn' : '—'}</td>
      <td>${r.cog != null ? r.cog.toFixed(1) + '°' : '—'}</td>
      <td>${r.true_heading != null ? r.true_heading + '°' : '—'}</td>
      <td>${r.latitude != null ? r.latitude.toFixed(5) : '—'}</td>
      <td>${r.longitude != null ? r.longitude.toFixed(5) : '—'}</td>
      <td>${navStatus(r.navigational_status)}</td>
    </tr>
  `
    )
    .join('');
  el.detailBody.querySelectorAll('.reading-row').forEach((tr) => {
    tr.addEventListener('click', () => openReadingModal(Number(tr.dataset.id)));
  });
}

function updateDetailPagination() {
  const totalPages = Math.max(1, Math.ceil(S.detailTotal / PAGE_SIZE));
  el.detailPageInfo.textContent = t('page.info', { page: S.detailPage + 1, total: totalPages });
  el.detailPrev.disabled = S.detailPage === 0;
  el.detailNext.disabled = (S.detailPage + 1) * PAGE_SIZE >= S.detailTotal;
}

function renderDetailEvents(events) {
  const tbody = document.getElementById('detail-events-body');
  if (!events.length) {
    tbody.innerHTML =
      `<tr><td colspan="5" class="empty">${t('empty.eventsShip')}</td></tr>`;
    return;
  }

  const visits = [];
  const asc = [...events].reverse();
  let pending = null;
  for (const ev of asc) {
    if (ev.event_type === 'arrived') {
      pending = ev;
    } else if (ev.event_type === 'departed' && pending) {
      const ms = new Date(ev.ts) - new Date(pending.ts);
      const delta =
        ev.draught != null && pending.draught != null ? ev.draught - pending.draught : null;
      visits.push({ arrival: pending, departure: ev, ms, delta });
      pending = null;
    }
  }
  if (pending) visits.push({ arrival: pending, departure: null, ms: null, delta: null });
  visits.reverse();

  tbody.innerHTML = visits
    .map(({ arrival, departure, ms, delta }) => {
      let draughtStr = '—';
      if (delta != null) {
        const val = delta.toFixed(1);
        draughtStr =
          delta > 0
            ? `<span class="delta-up">${t('draught.load', { val: '+' + val })}</span>`
            : `<span class="delta-down">${t('draught.unload', { val })}</span>`;
      }
      const depRow = departure
        ? `
      <tr>
        <td><span class="event-badge departed">${t('event.departed')}</span></td>
        <td>${formatTime(departure.ts)}</td>
        <td>${escHtml(departure.destination_label || departure.destination) || '—'}</td>
        <td>${departure.draught != null ? departure.draught.toFixed(1) + ' m' : '—'} ${draughtStr}</td>
        <td>—</td>
      </tr>`
        : '';
      return `
      <tr>
        <td><span class="event-badge arrived">${t('event.arrived')}</span></td>
        <td>${formatTime(arrival.ts)}</td>
        <td>${escHtml(arrival.destination_label || arrival.destination) || '—'}</td>
        <td>${arrival.draught != null ? arrival.draught.toFixed(1) + ' m' : '—'}</td>
        <td>${departure ? formatDuration(ms) : `<span class="in-porto">${t('event.inPort')}</span>`}</td>
      </tr>${depRow}`;
    })
    .join('');
}

// Confirmed ship-to-ship rendezvous involving this vessel. Hidden when none.
// Each row links to the partner ship's detail view.
function renderRendezvous(list) {
  const section = document.getElementById('rendezvous-section');
  const tbody = document.getElementById('detail-rendezvous-body');
  if (!section || !tbody) return;
  if (!list.length) {
    section.classList.add('hidden');
    tbody.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');
  tbody.innerHTML = list
    .map((r) => {
      const dist = r.min_dist_m != null ? `${Math.round(r.min_dist_m)} m` : '—';
      const ongoing = r.ended_at ? '' : ` <span class="in-porto">(${t('rendezvous.ongoing')})</span>`;
      const name = escHtml(r.other_name || String(r.other));
      return `
      <tr class="rdv-row" data-other="${r.other}" style="cursor:pointer">
        <td>${name} <span class="detail-mmsi">${r.other}</span></td>
        <td>${formatTime(r.started_at)}${ongoing}</td>
        <td>${dist}</td>
        <td>${escHtml(r.area)}</td>
      </tr>`;
    })
    .join('');
  tbody.querySelectorAll('.rdv-row').forEach((tr) => {
    tr.addEventListener('click', () => {
      const other = Number(tr.dataset.other);
      if (Number.isFinite(other)) showView('detail', other);
    });
  });
}

export function renderDetailInfoBar(ship, latestArrival) {
  if (!ship) {
    el.detailInfoBar.innerHTML = '';
    return;
  }
  const posVal =
    ship.last_latitude != null && ship.last_longitude != null
      ? `${ship.last_latitude.toFixed(5)}°N, ${ship.last_longitude.toFixed(5)}°E`
      : '—';
  const dimLen = ship.dim_bow != null && ship.dim_stern != null ? ship.dim_bow + ship.dim_stern + ' m' : '—';
  const dimBeam =
    ship.dim_port != null && ship.dim_starboard != null ? ship.dim_port + ship.dim_starboard + ' m' : '—';
  const stayDuration = latestArrival
    ? formatDuration(new Date(ship.last_seen_at) - new Date(latestArrival.ts))
    : '—';
  const typeHtml = shipTypeBadge(ship.ship_type);

  const items = [
    [t('info.riskScore'),  riskBadge(ship.risk)],
    [t('info.shipType'),   typeHtml],
    [t('info.cargoType') + eqInfoIcon(t('info.cargoType'), t('info.cargoTypeHelp')),  cargoTypeHtml(ship.risk?.cargo)],
    [t('info.loadState') + eqInfoIcon(t('info.loadState'), t('info.loadStateHelp')),  loadStateHtml(ship.risk?.cargo?.loadState)],
    [t('info.callSign'),   escHtml(ship.call_sign) || '—'],
    [t('info.imo'),        ship.imo_number || '—'],
    [t('info.dest'),       escHtml(ship.destination_label || ship.destination) || '—'],
    [t('info.eta'),        escHtml(ship.eta) || '—'],
    [t('info.maxDraught'), ship.max_draught != null ? ship.max_draught.toFixed(1) + ' m' : '—'],
    [t('info.length'),     dimLen],
    [t('info.beam'),       dimBeam],
    [t('info.sog'),        ship.last_sog != null ? ship.last_sog.toFixed(1) + ' kn' : '—'],
    [t('info.cog'),        ship.last_cog != null ? ship.last_cog.toFixed(1) + '°' : '—'],
    [t('info.navStatus'),  navStatus(ship.last_navigational_status)],
    [t('info.direction'),  directionBadge(ship.direction)],
    [t('info.inPort'),     ship.in_port ? `<span class="port-badge">${t('info.inPortYes')}</span>` : t('info.inPortNo')],
    [t('info.position'),   posVal],
    [t('info.stayDur'),    stayDuration],
    [t('info.firstSeen'),  formatTime(ship.first_seen_at)],
    [t('info.lastSeen'),   formatTime(ship.last_seen_at)],
  ];
  el.detailInfoBar.innerHTML =
    items
      .map(
        ([label, val]) => `
    <div class="info-item">
      <span class="info-label">${label}</span>
      <span class="info-val">${val}</span>
    </div>
  `
      )
      .join('') + riskFactorsHtml(ship.risk);
}

// ── Risk-score history chart ───────────────────────────────────────────────────
function renderRiskHistory(history) {
  const elc = document.getElementById('risk-history-chart');
  if (!elc) return;
  if (!history || history.length < 2) {
    elc.innerHTML = `<p class="empty">${t('detail.riskHistoryEmpty')}</p>`;
    return;
  }
  const bars = history
    .map((h) => {
      const cls = riskClass(h.score);
      const ht = Math.max(2, Math.min(100, Math.round(h.score)));
      return `<div class="rh-bar-wrap" title="${escHtml(formatTime(h.ts))} · ${h.score}/100">
        <div class="rh-bar ${cls}" style="height:${ht}%"></div>
      </div>`;
    })
    .join('');
  const first = history[0];
  const last = history[history.length - 1];
  const delta = last.score - first.score;
  const trendStr = delta > 0 ? `▲ +${delta}` : delta < 0 ? `▼ ${delta}` : '▬ 0';
  const trendCls = delta > 0 ? 'rh-up' : delta < 0 ? 'rh-down' : '';
  elc.innerHTML = `<div class="rh-bars">${bars}</div>
    <div class="rh-legend">
      <span>${formatTime(first.ts)}</span>
      <span class="rh-trend ${trendCls}">${t('detail.riskTrend', { trend: trendStr })}</span>
      <span>${formatTime(last.ts)}</span>
    </div>`;
}

function riskFactorsHtml(risk) {
  if (!risk) return '';
  const factors = risk.factors || [];
  const body = factors.length
    ? factors
        .map(
          (f) =>
            `<li><span class="rf-pts ${riskClass(risk.score)}">+${f.points}</span> ${escHtml(f.label)}</li>`
        )
        .join('')
    : `<li class="rf-none">${t('risk.noAnomalies')}</li>`;
  return `
    <div class="info-item risk-factors">
      <span class="info-label">${t('info.riskLabel', { score: risk.score })}</span>
      <ul class="rf-list">${body}</ul>
    </div>`;
}

// ── Sanctions match detail panel ─────────────────────────────────────────────
// Shown only when the vessel is actually listed (risk.sanctionMatch present).
// Combines the concrete match (source / programme / matched field) with a short
// explanation of the regime and a reliability disclaimer, plus a deep link to
// the official entity profile when we captured its id.
export function renderSanctionsSection(risk) {
  const sec = el.sanctionsDataSection;
  if (!sec) return;
  const m = risk && risk.sanctionMatch;
  if (!m) {
    sec.classList.add('hidden');
    el.sanctionsDataBody.innerHTML = '';
    return;
  }
  const rows = [
    [t('sanctions.list'), m.source],
    [t('sanctions.program'), m.program],
    [t('sanctions.matchedOn'), m.matchedOnLabel || m.matchedOn],
    [t('sanctions.listedName'), m.listedName],
    [t('sanctions.flag'), m.flag],
    [t('sanctions.owner'), m.owner],
  ];
  if (m.aliases && m.aliases.length) rows.push([t('sanctions.aliases'), m.aliases.join(', ')]);
  const table =
    `<table class="vf-table">${rows
      .map(
        ([label, value]) =>
          `<tr><td class="vf-td-label">${escHtml(label)}</td><td class="vf-td-val">${escHtml(value) || '—'}</td></tr>`
      )
      .join('')}</table>`;
  // Regime explanation: regime-specific text when known, generic fallback otherwise.
  const known = ['ofac', 'eu', 'uk', 'un'];
  const concept = t(known.includes(m.sourceKey) ? `sanctions.concept.${m.sourceKey}` : 'sanctions.concept.generic');
  // Disclaimer: a name-only match is the weakest signal (homonyms → false positives).
  const disclaimer =
    m.matchedOn === 'name' ? t('sanctions.disclaimerName') : t('sanctions.disclaimerStrong');
  const link = m.url
    ? `<a class="btn btn-secondary btn-sm sanction-link" href="${escHtml(m.url)}" target="_blank" rel="noopener noreferrer">${t('sanctions.openProfile')} ↗</a>`
    : '';
  el.sanctionsDataBody.innerHTML = `
    <p class="sanction-lead">${t('sanctions.lead')}</p>
    ${table}
    <p class="sanction-concept">${concept}</p>
    <p class="sanction-disclaimer">⚠ ${disclaimer}</p>
    ${link}`;
  sec.classList.remove('hidden');
}

// ── Scraped data (VesselFinder / MarineTraffic) ──────────────────────────────
function invalidateDetailMap() {
  setTimeout(() => { if (S.aisMap) S.aisMap.invalidateSize(); }, 50);
}

export async function loadVfData(mmsi) {
  if (!S.importVfData) {
    el.vfDataSection.classList.add('hidden');
    return;
  }
  el.vfDataSection.classList.remove('hidden');
  invalidateDetailMap();
  el.vfCacheBadge.classList.add('hidden');
  el.vfDataBody.innerHTML = `<p class="vf-loading">${t('scrape.loadingVf')}</p>`;
  try {
    const result = await api(`/api/ships/${mmsi}/vfdata`);
    if (!result.enabled) {
      el.vfDataSection.classList.add('hidden');
      invalidateDetailMap();
      return;
    }
    if (result.error && !result.data) {
      el.vfDataBody.innerHTML = `<p class="vf-error">${t('scrape.errorFmt', { msg: escHtml(result.error) })}</p>`;
      return;
    }
    if (result.cachedAt) {
      el.vfCacheBadge.textContent = `${result.cached ? t('scrape.cache') : t('scrape.updated')} · ${formatTime(result.cachedAt)}`;
      el.vfCacheBadge.classList.remove('hidden');
    }
    renderScrapedData(el.vfDataBody, result.data);
    invalidateDetailMap();
  } catch {
    el.vfDataBody.innerHTML = `<p class="vf-error">${t('scrape.error')}</p>`;
  }
}

export async function loadMtData(mmsi) {
  if (!S.importMtData) {
    el.mtDataSection.classList.add('hidden');
    return;
  }
  el.mtDataSection.classList.remove('hidden');
  el.mtCacheBadge.classList.add('hidden');
  el.mtDataBody.innerHTML = `<p class="vf-loading">${t('scrape.loadingMt')}</p>`;
  try {
    const result = await api(`/api/ships/${mmsi}/mtdata`);
    if (!result.enabled) {
      el.mtDataSection.classList.add('hidden');
      return;
    }
    if (result.shipId && S.detailMmsi === mmsi) {
      el.btnMtDetail.href = `https://www.marinetraffic.com/it/ais/details/ships/shipid:${result.shipId}`;
    }
    if (result.error && !result.data) {
      el.mtDataBody.innerHTML = `<p class="vf-error">${t('scrape.errorFmt', { msg: escHtml(result.error) })}</p>`;
      return;
    }
    if (result.cachedAt) {
      el.mtCacheBadge.textContent = `${result.cached ? t('scrape.cache') : t('scrape.updated')} · ${formatTime(result.cachedAt)}`;
      el.mtCacheBadge.classList.remove('hidden');
    }
    renderScrapedData(el.mtDataBody, result.data);
    invalidateDetailMap();
  } catch {
    el.mtDataBody.innerHTML = `<p class="vf-error">${t('scrape.error')}</p>`;
  }
}

// ── ShipFinder data (static fallback + last-known scraped positions) ─────────
// Renders the static panel like VF/MT, and draws any stored scraped positions as
// distinct markers on the detail map. Does NOT force a fresh position scrape — the
// "Localizza" button (locateSf) and the background stale-follow sweep do that.
export async function loadSfData(mmsi) {
  if (!S.importSfData) {
    el.sfDataSection.classList.add('hidden');
    if (el.btnSfDetail) el.btnSfDetail.classList.add('hidden');
    return;
  }
  el.sfDataSection.classList.remove('hidden');
  if (el.btnSfDetail) {
    el.btnSfDetail.href = `https://www.shipfinder.com/ship/detail/mmsi/${mmsi}`;
    el.btnSfDetail.classList.remove('hidden');
  }
  el.sfCacheBadge.classList.add('hidden');
  el.sfDataBody.innerHTML = `<p class="vf-loading">${t('scrape.loadingSf')}</p>`;
  try {
    const result = await api(`/api/ships/${mmsi}/sfdata`);
    if (!result.enabled) {
      el.sfDataSection.classList.add('hidden');
      return;
    }
    if (S.detailMmsi === mmsi) renderSfPositions(result.positions);
    if (result.error && !result.data) {
      el.sfDataBody.innerHTML = `<p class="vf-error">${t('scrape.errorFmt', { msg: escHtml(result.error) })}</p>`;
      return;
    }
    if (result.cachedAt) {
      el.sfCacheBadge.textContent = `${result.cached ? t('scrape.cache') : t('scrape.updated')} · ${formatTime(result.cachedAt)}`;
      el.sfCacheBadge.classList.remove('hidden');
    }
    renderScrapedData(el.sfDataBody, result.data);
    renderSfPositionBlock(result.positions); // show last-known position at top of panel
    invalidateDetailMap();
  } catch {
    el.sfDataBody.innerHTML = `<p class="vf-error">${t('scrape.error')}</p>`;
  }
}

// Latest scraped position rendered as a readable line at the top of the SF panel,
// so the user sees the coordinates (and that the lookup succeeded), not just a map
// marker. Replaces any previous block. Returns '' when there's no position.
function sfPositionHtml(positions) {
  if (!positions || !positions.length) return '';
  const p = positions[positions.length - 1];
  if (p.lat == null || p.lon == null) return '';
  const sog = p.sog != null ? `${Number(p.sog).toFixed(1)} kn` : '—';
  const cog = p.cog != null && p.cog <= 360 ? `${Number(p.cog).toFixed(0)}°` : '—';
  return `<div id="sf-position-block" class="sf-position">
    <span class="sf-position-label">📍 ${t('scrape.sfPosition')}</span>
    <span class="sf-position-coords">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span>
    <span class="sf-position-meta">SOG ${sog} · COG ${cog} · ${formatTime(p.received_at)}</span>
  </div>`;
}

function renderSfPositionBlock(positions) {
  const existing = document.getElementById('sf-position-block');
  if (existing) existing.remove();
  const html = sfPositionHtml(positions);
  if (html) el.sfDataBody.insertAdjacentHTML('afterbegin', html);
}

// Manual "Localizza via ShipFinder": force a live position scrape, drop the fresh
// marker on the map, update the panel position block, and toast the outcome.
export async function locateSf(mmsi) {
  if (!S.importSfData || mmsi == null) return;
  el.btnSfLocate.disabled = true;
  const prev = el.btnSfLocate.textContent;
  el.btnSfLocate.textContent = t('scrape.locating');
  try {
    const result = await api(`/api/ships/${mmsi}/sflocate`, 'POST');
    if (result.error) {
      showAlert(t('scrape.sfLocateFailed'), escHtml(result.error));
      return;
    }
    if (!result.position) {
      showAlert(t('scrape.sfLocateFailed'), t('scrape.sfNoPosition'));
      return;
    }
    const p = result.position;
    if (S.detailMmsi === mmsi) {
      renderSfPositions(result.positions, { focus: true });
      renderSfPositionBlock(result.positions);
    }
    showAlert(
      t('scrape.sfLocated'),
      `${Number(p.lat).toFixed(5)}, ${Number(p.lon).toFixed(5)} · ${formatTime(p.received_at)}`
    );
  } catch {
    showAlert(t('scrape.sfLocateFailed'), t('scrape.error'));
  } finally {
    el.btnSfLocate.disabled = false;
    el.btnSfLocate.textContent = prev;
  }
}

// ── Equasis ownership data (manual, button-triggered) ────────────────────────
// `doFetch=false` (detail open): show cached data only, no network. If nothing
// is cached, just expose the fetch button. `doFetch=true` (button): run the live
// lookup, which the server caches permanently.
export async function loadEquasisData(mmsi, doFetch = false) {
  if (!S.importEquasis) {
    el.equasisDataSection.classList.add('hidden');
    return;
  }
  el.equasisDataSection.classList.remove('hidden');
  el.equasisCacheBadge.classList.add('hidden');
  if (doFetch) {
    el.btnEquasisFetch.disabled = true;
    el.equasisDataBody.innerHTML = `<p class="vf-loading">${t('scrape.loadingEquasis')}</p>`;
  }
  try {
    const result = await api(`/api/ships/${mmsi}/equasis${doFetch ? '?fetch=1' : ''}`);
    if (!result.enabled) {
      el.equasisDataSection.classList.add('hidden');
      return;
    }
    if (result.noImo) {
      // Ship never broadcast an IMO via AIS — Equasis can only query by IMO.
      // Hide the button: clicking it would only dead-end on the same error.
      el.equasisDataBody.innerHTML = `<p class="vf-empty">${t('scrape.equasisNoImo')}</p>`;
      el.btnEquasisFetch.classList.add('hidden');
      return;
    }
    if (result.error) {
      el.equasisDataBody.innerHTML = `<p class="vf-error">${t('scrape.errorFmt', { msg: escHtml(result.error) })}</p>`;
      el.btnEquasisFetch.classList.remove('hidden');
      return;
    }
    if (!result.data) {
      // Nothing cached yet — invite the user to fetch.
      el.equasisDataBody.innerHTML = `<p class="vf-empty">${t('scrape.equasisHint')}</p>`;
      el.btnEquasisFetch.classList.remove('hidden');
      return;
    }
    if (result.cachedAt) {
      el.equasisCacheBadge.textContent = `${t('scrape.stored')} · ${formatTime(result.cachedAt)}`;
      el.equasisCacheBadge.classList.remove('hidden');
    }
    // Already have data: hide the button (lookup is "once").
    el.btnEquasisFetch.classList.add('hidden');
    renderEquasisData(el.equasisDataBody, result.data);
    el.equasisDataSection.classList.remove('collapsed');
  } catch {
    el.equasisDataBody.innerHTML = `<p class="vf-error">${t('scrape.error')}</p>`;
    el.btnEquasisFetch.classList.remove('hidden');
  } finally {
    el.btnEquasisFetch.disabled = false;
  }
}

// One label/value <table> from a {label: value} map (used for particulars + risk).
// Glossary for the Equasis "Dati nave" (particulars) and "Performance / rischio"
// tables. Keys are the exact labels emitted by the scraper (see
// src/services/scrapers/equasis.js: PARTICULAR_LABELS, parseHeader, parseRisk).
// Each entry becomes a hover "ⓘ" next to the label explaining the abbreviation.
const EQ_LABEL_GLOSSARY = {
  Name: 'Nome attuale della nave. Può cambiare nel tempo, a differenza del numero IMO che resta invariato.',
  'IMO number': 'Numero IMO: identificativo univoco a 7 cifre assegnato dall’Organizzazione Marittima Internazionale. Non cambia mai per tutta la vita della nave, anche se cambiano nome o bandiera.',
  Flag: 'Stato di bandiera: il Paese in cui la nave è registrata e di cui batte bandiera. Ne determina giurisdizione, regole applicabili e regime di ispezione.',
  'Call Sign': 'Nominativo internazionale (call sign): codice radio univoco assegnato alla nave per le comunicazioni.',
  MMSI: 'Maritime Mobile Service Identity: identificativo numerico a 9 cifre usato da AIS e dagli apparati radio VHF/DSC. Può cambiare se cambia la bandiera.',
  'Gross tonnage': 'Stazza lorda (GT): misura adimensionale del volume interno totale della nave. Usata per tasse, normative e dimensionamento dell’equipaggio. Non è un peso.',
  DWT: 'Deadweight tonnage: portata lorda in tonnellate, ovvero il peso massimo trasportabile (carico + combustibile + provviste + equipaggio).',
  'Type of ship': 'Tipo di nave secondo la classificazione Equasis (es. petroliera, portarinfuse, portacontainer, bettolina di bunkeraggio).',
  'Year of build': 'Anno di costruzione (consegna) della nave. L’età incide su livello di rischio e frequenza delle ispezioni.',
  Status: 'Stato operativo della nave secondo Equasis (es. In service/commission = in servizio, Laid up = in disarmo, Broken up = demolita).',
  'Port of registry': 'Porto di immatricolazione: porto presso cui la nave è registrata, riportato sullo scafo.',
  'Detenzioni (36 mesi)': 'Percentuale di ispezioni Port State Control che negli ultimi 36 mesi si sono concluse con un fermo (detention) della nave. Più è alta, peggiore è lo storico.',
  'Società di classe IACS': 'Indica se la nave è classificata da almeno una società membro IACS (International Association of Classification Societies), le principali società di classifica riconosciute a livello mondiale.',
  'Performance Paris MOU': 'Posizione della bandiera nella White/Grey/Black List del Paris MoU, il regime di Port State Control di Europa e Nord Atlantico.',
  'Performance Tokyo MOU': 'Posizione della bandiera nella White/Grey/Black List del Tokyo MoU, il regime di Port State Control dell’area Asia-Pacifico.',
  'Targeting USCG': 'Stato di targeting della US Coast Guard: indica se bandiera o nave rientrano tra i bersagli prioritari per le ispezioni nei porti USA, secondo la matrice di rischio USCG.',
};

// Glossary for cell *values* (open-set strings coming straight from Equasis).
// Scanned in order; the first matching regex wins, so more specific patterns
// (e.g. "non targeted", "Priority II") must precede the looser ones.
const EQ_VALUE_GLOSSARY = [
  { re: /(not|non)[-\s]?targeted/i, term: 'Non targeted', def: 'La bandiera non figura nelle liste di targeting USCG: nessun fattore di rischio aggiuntivo derivante dallo Stato di bandiera.' },
  { re: /priority\s*(ii|2)\b/i, term: 'Priority II (USCG)', def: 'Rischio medio: 7–16 punti nella matrice USCG. Le operazioni di carico o l’attività passeggeri possono essere limitate finché la Guardia Costiera non ispeziona la nave.' },
  { re: /priority\s*(i|1)\b/i, term: 'Priority I (USCG)', def: 'Rischio alto: ≥17 punti nella matrice USCG. L’ingresso in porto può essere vietato finché la Guardia Costiera non ispeziona la nave.' },
  { re: /targeted/i, term: 'Targeted flag', def: 'La bandiera figura in una lista di targeting USCG per scarse prestazioni (alto tasso di fermi): aumenta la priorità di ispezione della nave nei porti USA.' },
  { re: /bunkering/i, term: 'Bunkering Tanker', def: 'Bettolina di bunkeraggio: nave cisterna che rifornisce di combustibile (bunker) altre navi. Tipo soggetto a maggiore attenzione ispettiva.' },
  { re: /\bwhite\b/i, term: 'White List', def: 'White List: bandiera con buone prestazioni e basso tasso di fermi. Rischio basso, ispezioni meno frequenti.' },
  { re: /\bgr[ae]y\b/i, term: 'Grey List', def: 'Grey List: bandiera con prestazioni intermedie, tra White List e Black List.' },
  { re: /\bblack\b/i, term: 'Black List', def: 'Black List: bandiera con alto tasso di fermi e prestazioni scarse. Rischio alto, ispezioni più frequenti.' },
];

function eqInfoIcon(term, def) {
  if (!def) return '';
  return ` <span class="eq-info" data-term="${escHtml(term)}" data-tip="${escHtml(def)}" aria-label="${escHtml(term)}: ${escHtml(def)}" role="img">ⓘ</span>`;
}
function eqLabelInfo(label) {
  return eqInfoIcon(label, EQ_LABEL_GLOSSARY[label]);
}
function eqValueInfo(value) {
  if (!value) return '';
  const hit = EQ_VALUE_GLOSSARY.find((g) => g.re.test(value));
  return hit ? eqInfoIcon(hit.term, hit.def) : '';
}

function eqKvTable(titleKey, map) {
  const entries = Object.entries(map || {});
  if (!entries.length) return '';
  const rows = entries
    .map(
      ([label, value]) => `
      <tr>
        <td class="vf-td-label">${escHtml(label)}${eqLabelInfo(label)}</td>
        <td class="vf-td-val">${escHtml(value)}${eqValueInfo(value)}</td>
      </tr>`
    )
    .join('');
  return `<h4 class="eq-subtitle">${t(titleKey)}</h4><table class="vf-table">${rows}</table>`;
}

function renderEquasisData(container, data) {
  const mgmt = (data && data.management) || [];
  const particulars = (data && data.particulars) || {};
  const classification = (data && data.classification) || [];
  const pi = (data && data.pi) || [];
  const risk = (data && data.risk) || {};
  const positions = (data && data.positions) || [];
  const anything = mgmt.length || Object.keys(particulars).length || classification.length
    || pi.length || Object.keys(risk).length || positions.length;
  if (!anything) {
    container.innerHTML = `<p class="vf-empty">${t('scrape.noData')}</p>`;
    return;
  }
  let html = '';
  if (mgmt.length) {
    const rows = mgmt
      .map(
        (m) => `
      <tr>
        <td class="vf-td-label">${escHtml(m.role)}</td>
        <td class="vf-td-val">${escHtml(m.company)}${m.address ? `<br><span class="eq-addr">${escHtml(m.address)}</span>` : ''}${m.date ? `<br><span class="eq-date">${escHtml(m.date)}</span>` : ''}</td>
      </tr>`
      )
      .join('');
    html += `<h4 class="eq-subtitle">${t('scrape.equasisMgmt')}</h4><table class="vf-table">${rows}</table>`;
  }
  html += eqKvTable('scrape.equasisParticulars', particulars);
  if (classification.length) {
    const rows = classification
      .map(
        (c) => `
      <tr>
        <td class="vf-td-label">${escHtml(c.society)}</td>
        <td class="vf-td-val">${escHtml(c.status)}${c.date ? `<br><span class="eq-date">${escHtml(c.date)}</span>` : ''}${c.reason ? `<br><span class="eq-addr">${escHtml(c.reason)}</span>` : ''}</td>
      </tr>`
      )
      .join('');
    html += `<h4 class="eq-subtitle">${t('scrape.equasisClass')}</h4><table class="vf-table">${rows}</table>`;
  }
  if (pi.length) {
    const rows = pi
      .map(
        (c) => `
      <tr>
        <td class="vf-td-label">${escHtml(c.club)}</td>
        <td class="vf-td-val">${c.date ? escHtml(c.date) : ''}</td>
      </tr>`
      )
      .join('');
    html += `<h4 class="eq-subtitle">${t('scrape.equasisPI')}</h4><table class="vf-table">${rows}</table>`;
  }
  html += eqKvTable('scrape.equasisRisk', risk);
  if (positions.length) {
    const rows = positions
      .map(
        (p) => `
      <tr>
        <td class="vf-td-label">${escHtml(p.date)}</td>
        <td class="vf-td-val">${escHtml(p.area)}${p.source ? `<br><span class="eq-addr">${escHtml(p.source)}</span>` : ''}</td>
      </tr>`
      )
      .join('');
    html += `<h4 class="eq-subtitle">${t('scrape.equasisPositions')}</h4><table class="vf-table">${rows}</table>`;
  }
  container.innerHTML = html;
}

// ── Global Fishing Watch data (proactive: identity + behavioural events) ─────
// Loaded automatically on detail open (like VF/MT). The server serves the cache
// the background enrichment built and only fetches live on a cache miss.
export async function loadGfwData(mmsi) {
  if (!S.importGfw) {
    el.gfwDataSection.classList.add('hidden');
    return;
  }
  el.gfwDataSection.classList.remove('hidden');
  el.gfwCacheBadge.classList.add('hidden');
  el.gfwDataBody.innerHTML = `<p class="vf-loading">${t('scrape.loadingGfw')}</p>`;
  try {
    const result = await api(`/api/ships/${mmsi}/gfwdata`);
    if (!result.enabled) {
      el.gfwDataSection.classList.add('hidden');
      return;
    }
    if (result.error && !result.data) {
      el.gfwDataBody.innerHTML = `<p class="vf-error">${t('scrape.errorFmt', { msg: escHtml(result.error) })}</p>`;
      return;
    }
    if (result.notFound) {
      el.gfwDataBody.innerHTML = `<p class="vf-empty">${t('scrape.gfwNotFound')}</p>`;
      return;
    }
    if (!result.data) {
      el.gfwDataSection.classList.add('hidden');
      return;
    }
    if (result.cachedAt) {
      el.gfwCacheBadge.textContent = `${result.cached ? t('scrape.cache') : t('scrape.updated')} · ${formatTime(result.cachedAt)}`;
      el.gfwCacheBadge.classList.remove('hidden');
    }
    renderGfwData(el.gfwDataBody, result.data);
  } catch {
    el.gfwDataBody.innerHTML = `<p class="vf-error">${t('scrape.error')}</p>`;
  }
}

// Glossary for the GFW identity field labels and event-section titles. Like the
// Equasis glossary above, the explanations are in Italian regardless of UI
// language (same convention as EQ_LABEL_GLOSSARY / SCRAPE_LABEL_GLOSSARY).
const GFW_IDENTITY_GLOSSARY = {
  flag: 'Stato di bandiera registrato in GFW (derivato dal codice MMSI e dai registri navali).',
  type: 'Tipo di nave o attrezzo da pesca secondo la classificazione di Global Fishing Watch.',
  year: 'Anno di costruzione (consegna) della nave secondo i dati GFW.',
  callsign: 'Nominativo radio internazionale (call sign): codice radio univoco della nave.',
  imo: 'Numero IMO: identificativo univoco a 7 cifre, permanente per tutta la vita della nave.',
  mmsi: 'MMSI: identificativo AIS a 9 cifre. Le prime 3 cifre (MID) indicano il Paese di bandiera.',
};
const GFW_SECTION_GLOSSARY = {
  'scrape.gfwEncounters': 'Incontro in mare: GFW ha rilevato due navi ravvicinate e quasi ferme in mare aperto per un periodo prolungato. È la firma classica di un trasbordo nave-a-nave (ship-to-ship), tecnica usata anche per eludere i controlli.',
  'scrape.gfwLoitering': 'Loitering: la nave è rimasta a lungo quasi ferma in mare aperto, lontano dai porti. Comportamento anomalo per una nave da trasporto.',
  'scrape.gfwPortVisits': 'Scalo in porto ricostruito da GFW dall’analisi delle tracce AIS (ingresso, sosta, uscita). Confrontato con la lista dei porti ad alto rischio.',
  'scrape.gfwGaps': 'Evento AIS spento ("gap" / dark activity): la nave ha interrotto la trasmissione AIS mentre era in navigazione, riapparendo poi altrove. Può indicare la volontà di non farsi tracciare.',
};

// Localised label for GFW identity rows (reuses generic detail keys where they
// exist; falls back to a capitalised field name otherwise).
const GFW_IDENTITY_LABEL = {
  flag: 'Bandiera', type: 'Tipo', year: 'Anno di costruzione',
  callsign: 'Call sign', imo: 'IMO', mmsi: 'MMSI', shipname: 'Nome',
};

function gfwPos(lat, lon) {
  if (lat == null || lon == null) return '';
  return `${Number(lat).toFixed(3)}, ${Number(lon).toFixed(3)}`;
}
function gfwDur(h) {
  return h == null ? '' : t('scrape.gfwHours', { h: Math.round(h) });
}

// One event table; `cols` is an array of { key (i18n), get (row→cell html) }.
function gfwEventTable(titleKey, rows, cols) {
  if (!rows || !rows.length) return '';
  const head = cols.map((c) => `<th>${t(c.key)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${cols.map((c) => `<td>${c.get(r)}</td>`).join('')}</tr>`)
    .join('');
  const info = eqInfoIcon(t(titleKey), GFW_SECTION_GLOSSARY[titleKey]);
  return `<h4 class="eq-subtitle">${t(titleKey)}${info}</h4><table class="vf-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderGfwData(container, data) {
  const identity = (data && data.identity) || {};
  const events = (data && data.events) || {};
  const enc = events.encounters || [];
  const loi = events.loitering || [];
  const prt = events.portVisits || [];
  const gaps = events.gaps || [];

  let html = '';

  // Identity table (only the fields GFW actually returned), each with a ⓘ hint.
  const idRows = Object.keys(GFW_IDENTITY_LABEL)
    .filter((k) => identity[k] != null && identity[k] !== '')
    .map((k) => {
      const info = eqInfoIcon(GFW_IDENTITY_LABEL[k], GFW_IDENTITY_GLOSSARY[k]);
      return `<tr><td class="vf-td-label">${escHtml(GFW_IDENTITY_LABEL[k])}${info}</td><td class="vf-td-val">${escHtml(String(identity[k]))}</td></tr>`;
    })
    .join('');
  if (idRows) {
    html += `<h4 class="eq-subtitle">${t('scrape.gfwIdentity')}</h4><table class="vf-table">${idRows}</table>`;
  }

  // Event tables (newest GFW returns first).
  html += gfwEventTable('scrape.gfwEncounters', enc, [
    { key: 'scrape.gfwColDate', get: (r) => escHtml(formatTime(r.start)) },
    { key: 'scrape.gfwColDuration', get: (r) => escHtml(gfwDur(r.durationH)) },
    { key: 'scrape.gfwColWith', get: (r) => escHtml(r.withName || r.withMmsi || '—') },
    { key: 'scrape.gfwColPos', get: (r) => escHtml(gfwPos(r.lat, r.lon)) },
  ]);
  html += gfwEventTable('scrape.gfwLoitering', loi, [
    { key: 'scrape.gfwColDate', get: (r) => escHtml(formatTime(r.start)) },
    { key: 'scrape.gfwColDuration', get: (r) => escHtml(gfwDur(r.durationH)) },
    { key: 'scrape.gfwColPos', get: (r) => escHtml(gfwPos(r.lat, r.lon)) },
  ]);
  html += gfwEventTable('scrape.gfwPortVisits', prt, [
    { key: 'scrape.gfwColDate', get: (r) => escHtml(formatTime(r.start)) },
    { key: 'scrape.gfwColPort', get: (r) => escHtml([r.port, r.country].filter(Boolean).join(', ') || '—') },
  ]);
  html += gfwEventTable('scrape.gfwGaps', gaps, [
    { key: 'scrape.gfwColDate', get: (r) => escHtml(formatTime(r.start)) },
    { key: 'scrape.gfwColDuration', get: (r) => escHtml(gfwDur(r.durationH)) },
    { key: 'scrape.gfwColPos', get: (r) => escHtml(gfwPos(r.lat, r.lon)) },
  ]);

  if (!enc.length && !loi.length && !prt.length && !gaps.length) {
    html += `<p class="vf-empty">${t('scrape.gfwNoEvents')}</p>`;
  }
  container.innerHTML = html;
}

// Glossary for the VesselFinder / MarineTraffic scraped tables. Labels are
// open-set (parseShipHtml in src/services/scrapers/http.js grabs every
// <tr><td>label</td><td>value</td></tr> on the page), so we match on a
// normalised key: lowercased, unit suffixes like "(m)" / "(t)" stripped,
// whitespace collapsed. See scrapeNormLabel.
const SCRAPE_LABEL_GLOSSARY = {
  'imo number': 'Numero IMO: identificativo univoco a 7 cifre dell’Organizzazione Marittima Internazionale. Non cambia mai, anche se cambiano nome o bandiera.',
  'imo / mmsi': 'Due identificativi: il numero IMO (7 cifre, permanente) e l’MMSI (9 cifre, usato da AIS/radio, può cambiare con la bandiera).',
  mmsi: 'Maritime Mobile Service Identity: identificativo numerico a 9 cifre usato da AIS e radio VHF/DSC. Le prime 3 cifre (MID) indicano il Paese.',
  'vessel name': 'Nome attuale della nave. Può cambiare nel tempo, a differenza del numero IMO.',
  'ship type': 'Tipo di nave secondo il database VesselFinder (es. portarinfuse, petroliera, portacontainer).',
  'ais type': 'Tipo di nave come trasmesso nel messaggio AIS (codice impostato a bordo). Può differire dal tipo reale del database.',
  flag: 'Stato di bandiera: il Paese in cui la nave è registrata. Determina giurisdizione e regole applicabili.',
  'ais flag': 'Bandiera dedotta dal codice MID (prime 3 cifre dell’MMSI) trasmesso via AIS.',
  'year of build': 'Anno di costruzione (consegna) della nave. L’età incide su rischio e frequenza delle ispezioni.',
  'length overall': 'LOA (Length Overall): lunghezza massima della nave da prua a poppa, in metri.',
  'length bp': 'LBP (Length Between Perpendiculars): lunghezza tra le perpendicolari (ruota di prua e asse del timone). Sempre minore della LOA.',
  beam: 'Baglio: larghezza massima dello scafo, in metri.',
  draught: 'Pescaggio di progetto: profondità a cui lo scafo si immerge in condizioni di pieno carico, in metri.',
  'current draught': 'Pescaggio attuale dichiarato dall’equipaggio via AIS, in metri. Indica quanto è carica la nave in questo momento.',
  depth: 'Altezza di costruzione (moulded depth): distanza verticale dalla chiglia al ponte principale, in metri.',
  'gross tonnage': 'Stazza lorda (GT): misura adimensionale del volume interno totale. Usata per tasse e normative. Non è un peso.',
  'net tonnage': 'Stazza netta (NT): volume degli spazi destinati al carico/passeggeri. Sempre minore della stazza lorda.',
  deadweight: 'Deadweight (DWT): portata lorda in tonnellate, ovvero il peso massimo trasportabile (carico + combustibile + provviste + equipaggio).',
  teu: 'TEU (Twenty-foot Equivalent Unit): capacità in container standard da 20 piedi. Tipico delle portacontainer.',
  'crude oil': 'Capacità di trasporto petrolio greggio, in barili (bbl).',
  gas: 'Capacità di trasporto gas, in metri cubi.',
  grain: 'Capacità delle stive misurata a grano (grain), in metri cubi: volume con il carico che riempie anche gli interstizi.',
  bale: 'Capacità delle stive misurata a balla (bale), in metri cubi: volume utile con carico in colli, esclusi gli interstizi tra le strutture.',
  'ballast water': 'Capacità di acqua di zavorra, in metri cubi.',
  'fresh water': 'Capacità di acqua dolce, in metri cubi.',
  builder: 'Cantiere navale che ha costruito la nave.',
  'place of build': 'Località di costruzione della nave.',
  hull: 'Numero di scafo (hull number) assegnato dal cantiere.',
  material: 'Materiale dello scafo (es. acciaio).',
  'engine builder': 'Costruttore del motore principale.',
  'engine type': 'Modello/tipo del motore principale.',
  'engine power': 'Potenza del motore principale, in kW.',
  'fuel type': 'Tipo di combustibile utilizzato dalla nave.',
  'service speed': 'Velocità di servizio: andatura di crociera economica di progetto, in nodi (kn).',
  propeller: 'Numero/tipo di eliche.',
  callsign: 'Nominativo internazionale (call sign): codice radio univoco per le comunicazioni.',
  'navigation status': 'Stato di navigazione trasmesso via AIS (es. Under way using engine = in navigazione a motore, At anchor = alla fonda, Moored = ormeggiata).',
  destination: 'Porto di destinazione dichiarato dall’equipaggio via AIS. Inserito manualmente, può essere impreciso o obsoleto.',
  eta: 'ETA (Estimated Time of Arrival): orario di arrivo stimato dichiarato dall’equipaggio via AIS.',
  'predicted eta': 'Stima dell’orario di arrivo calcolata da VesselFinder in base a rotta e velocità, indipendente dal dato AIS dell’equipaggio.',
  'distance / time': 'Distanza residua e tempo stimato fino alla destinazione.',
  'distance / time to go': 'Distanza residua e tempo stimato fino alla destinazione.',
  'course / speed': 'COG (Course Over Ground = rotta rispetto al fondo) e SOG (Speed Over Ground = velocità rispetto al fondo), da AIS.',
  'position received': 'Data e ora dell’ultima posizione AIS ricevuta. Indica quanto è recente il dato.',
  'last port': 'Ultimo porto in cui la nave ha fatto scalo.',
  atd: 'ATD (Actual Time of Departure): orario effettivo di partenza dall’ultimo porto.',
  // MarineTraffic uses its own fixed Italian labels (see MT_FIELD_LABELS in
  // src/services/scrapers/marinetraffic.js), distinct from VesselFinder's.
  // 'mmsi' is already covered above and must not be repeated here.
  nome: 'Nome attuale della nave. Può cambiare nel tempo, a differenza del numero IMO.',
  imo: 'Numero IMO: identificativo univoco a 7 cifre dell’Organizzazione Marittima Internazionale. Non cambia mai per tutta la vita della nave.',
  nominativo: 'Nominativo internazionale (call sign): codice radio univoco assegnato alla nave per le comunicazioni.',
  bandiera: 'Stato di bandiera: il Paese in cui la nave è registrata. Determina giurisdizione e regole applicabili.',
  tipo: 'Tipo di nave secondo il database MarineTraffic.',
  'stazza lorda': 'Stazza lorda (GT): misura adimensionale del volume interno totale della nave. Usata per tasse e normative; non è un peso.',
  'portata lorda': 'Portata lorda (DWT, deadweight): peso massimo trasportabile in tonnellate (carico + combustibile + provviste + equipaggio).',
  lunghezza: 'Lunghezza fuori tutto (LOA): lunghezza massima della nave da prua a poppa, in metri.',
  larghezza: 'Baglio: larghezza massima dello scafo, in metri.',
  'anno costruzione': 'Anno di costruzione (consegna) della nave. L’età incide su rischio e frequenza delle ispezioni.',
  stato: 'Stato operativo della nave secondo MarineTraffic (es. in servizio, in disarmo).',
  'porto di armamento': 'Home port: porto di armamento, base amministrativa della nave. Non indica necessariamente dove si trova ora.',
};

function scrapeNormLabel(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '') // drop unit suffixes like "(m)", "(t)", "(kn)"
    .replace(/[:\s]+/g, ' ')
    .trim();
}
function scrapeLabelInfo(label) {
  return eqInfoIcon(label, SCRAPE_LABEL_GLOSSARY[scrapeNormLabel(label)]);
}

function renderScrapedData(container, data) {
  if (!data || !Object.keys(data).length) {
    container.innerHTML = `<p class="vf-empty">${t('scrape.noData')}</p>`;
    return;
  }
  const photo = data._photo;
  const photoHtml = photo
    ? `<img src="${escHtml(photo)}" class="vf-photo" alt="${t('scrape.photo')}" loading="lazy" onerror="this.style.display='none'">`
    : '';
  const entries = Object.entries(data).filter(([k]) => !k.startsWith('_'));
  const rows = entries
    .map(
      ([label, value]) => `
    <tr>
      <td class="vf-td-label">${escHtml(label)}${scrapeLabelInfo(label)}</td>
      <td class="vf-td-val">${escHtml(value)}${eqValueInfo(value)}</td>
    </tr>`
    )
    .join('');
  container.innerHTML = `${photoHtml}<table class="vf-table">${rows}</table>`;
}

// ── Printable ship report (PDF via browser print) ──────────────────────────────
async function generateReport(mmsi) {
  const prev = el.btnReportDetail?.textContent;
  if (el.btnReportDetail) el.btnReportDetail.disabled = true;
  try {
    const [ship, eventsData, historyData] = await Promise.all([
      api(`/api/ships/${mmsi}`),
      api(`/api/ships/${mmsi}/events`).catch(() => ({ events: [] })),
      api(`/api/ships/${mmsi}/risk-history`).catch(() => ({ history: [] })),
    ]);
    const risk = ship.risk || {};
    const bandLabel = { low: t('risk.lowLabel'), med: t('risk.medLabel'), high: t('risk.highLabel') }[risk.band] || '—';
    const bandColor = { low: '#1a7f37', med: '#9a6700', high: '#cf222e' }[risk.band] || '#666';

    const row = (label, val) => `<tr><th>${escHtml(label)}</th><td>${val == null || val === '' ? '—' : escHtml(val)}</td></tr>`;
    const dimLen = ship.dim_bow != null && ship.dim_stern != null ? ship.dim_bow + ship.dim_stern + ' m' : '—';
    const dimBeam = ship.dim_port != null && ship.dim_starboard != null ? ship.dim_port + ship.dim_starboard + ' m' : '—';
    const pos = ship.last_latitude != null && ship.last_longitude != null
      ? `${ship.last_latitude.toFixed(5)}, ${ship.last_longitude.toFixed(5)}`
      : '—';

    const infoRows = [
      row(t('info.shipType'), shipTypeLabel(ship.ship_type)),
      row(t('info.callSign'), ship.call_sign),
      row(t('info.imo'), ship.imo_number),
      row(t('info.dest'), ship.destination_label || ship.destination),
      row(t('info.eta'), ship.eta),
      row(t('info.maxDraught'), ship.max_draught != null ? ship.max_draught.toFixed(1) + ' m' : '—'),
      row(t('info.length'), dimLen),
      row(t('info.beam'), dimBeam),
      row(t('info.sog'), ship.last_sog != null ? ship.last_sog.toFixed(1) + ' kn' : '—'),
      row(t('info.cog'), ship.last_cog != null ? ship.last_cog.toFixed(1) + '°' : '—'),
      row(t('info.navStatus'), navStatus(ship.last_navigational_status)),
      row(t('info.inPort'), ship.in_port ? t('info.inPortYes') : t('info.inPortNo')),
      row(t('info.position'), pos),
      row(t('info.firstSeen'), formatTime(ship.first_seen_at)),
      row(t('info.lastSeen'), formatTime(ship.last_seen_at)),
    ].join('');

    const factors = (risk.factors || [])
      .map((f) => `<li><strong>+${f.points}</strong> ${escHtml(f.label)}</li>`)
      .join('') || `<li>${escHtml(t('risk.noAnomalies'))}</li>`;

    const events = eventsData?.events || [];
    const eventsRows = events.length
      ? events
          .map(
            (e) => `<tr>
              <td>${e.event_type === 'arrived' ? t('event.arrived') : t('event.departed')}</td>
              <td>${escHtml(formatTime(e.ts))}</td>
              <td>${escHtml(e.destination) || '—'}</td>
              <td>${e.draught != null ? e.draught.toFixed(1) + ' m' : '—'}</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="4">${escHtml(t('empty.eventsShip'))}</td></tr>`;

    const history = historyData?.history || [];
    const histNote = history.length >= 2
      ? `${escHtml(formatTime(history[0].ts))} → ${escHtml(formatTime(history[history.length - 1].ts))}: ${history[0].score} → ${history[history.length - 1].score}/100`
      : t('detail.riskHistoryEmpty');

    const name = ship.ship_name || `MMSI ${mmsi}`;
    const html = `<!DOCTYPE html><html lang="${getLang()}"><head><meta charset="utf-8">
      <title>${t('report.title', { ship: escHtml(name) })}</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #1a1a1a; margin: 32px; }
        h1 { font-size: 20px; margin: 0 0 2px; }
        .sub { color: #666; font-size: 12px; margin-bottom: 18px; }
        h2 { font-size: 14px; border-bottom: 2px solid #ddd; padding-bottom: 4px; margin: 22px 0 10px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
        table.info th { width: 38%; color: #555; font-weight: 600; }
        .risk-banner { display: inline-block; padding: 8px 14px; border-radius: 8px; color: #fff; font-weight: 700; font-size: 15px; background: ${bandColor}; }
        ul.factors { margin: 8px 0 0; padding-left: 18px; font-size: 12px; }
        ul.factors li { margin: 2px 0; }
        .foot { margin-top: 28px; color: #999; font-size: 10px; border-top: 1px solid #eee; padding-top: 8px; }
        @media print { body { margin: 12mm; } }
      </style></head><body>
      <h1>${t('report.title', { ship: escHtml(name) })}</h1>
      <div class="sub">MMSI ${mmsi} · ${t('report.generated', { date: escHtml(formatTime(new Date().toISOString())) })}</div>

      <h2>${t('report.riskSection')}</h2>
      <p><span class="risk-banner">${risk.score != null ? risk.score : '—'}/100 — ${escHtml(bandLabel)}</span></p>
      <ul class="factors">${factors}</ul>
      <p class="sub">${t('detail.riskHistoryTitle')}: ${histNote}</p>

      <h2>${t('report.infoSection')}</h2>
      <table class="info">${infoRows}</table>

      <h2>${t('detail.eventsTitle')}</h2>
      <table>
        <thead><tr><th>${t('events.col.event')}</th><th>${t('events.col.datetime')}</th><th>${t('events.col.dest')}</th><th>${t('events.col.draught')}</th></tr></thead>
        <tbody>${eventsRows}</tbody>
      </table>

      ${ship.notes ? `<h2>${t('detail.notesTitle')}</h2><p style="font-size:12px;white-space:pre-wrap">${escHtml(ship.notes)}</p>` : ''}

      <div class="foot">${t('report.disclaimer')}</div>
      <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 150); };<\/script>
      </body></html>`;

    const win = window.open('', '_blank');
    if (!win) {
      showAlert(t('report.popupBlocked'), '');
      return;
    }
    win.document.write(html);
    win.document.close();
  } catch {
    showAlert(t('report.error'), '');
  } finally {
    if (el.btnReportDetail) {
      el.btnReportDetail.disabled = false;
      if (prev != null) el.btnReportDetail.textContent = prev;
    }
  }
}

// ── Reading modal ────────────────────────────────────────────────────────────
async function openReadingModal(id) {
  try {
    const row = await api(`/api/readings/${id}`);
    let raw = {};
    try {
      raw = JSON.parse(row.raw_json);
    } catch {
      /* keep empty */
    }

    el.modalTitle.textContent = `${row.ship_name || t('detail.unknown')} — ${row.message_type}`;

    const fields = [
      [t('reading.mmsi'),      row.mmsi],
      [t('reading.name'),      row.ship_name],
      [t('reading.msgType'),   row.message_type],
      [t('reading.received'),  formatTime(row.received_at)],
      [t('reading.lat'),       row.latitude?.toFixed(6)],
      [t('reading.lon'),       row.longitude?.toFixed(6)],
      [t('reading.navStatus'), row.navigational_status],
      [t('reading.sog'),       row.sog != null ? row.sog + ' kn' : null],
      [t('reading.cog'),       row.cog != null ? row.cog + '°' : null],
      [t('reading.heading'),   row.true_heading != null ? row.true_heading + '°' : null],
    ];

    const grid = fields
      .map(
        ([label, val]) => `
      <div class="detail-item">
        <label>${label}</label>
        <span>${val == null ? '—' : escHtml(val)}</span>
      </div>
    `
      )
      .join('');

    el.modalBody.innerHTML = `
      <div class="detail-grid">${grid}</div>
      <div class="raw-section">
        <h3>${t('detail.rawData')}</h3>
        <pre>${escHtml(JSON.stringify(raw, null, 2))}</pre>
      </div>
    `;
    el.modalOverlay.classList.remove('hidden');
  } catch {
    /* ignore */
  }
}
