// "Navi seguite" section — ships actively followed via the dedicated AISstream
// follow connection. Mirrors the Monitoraggi active/past lists (same filters,
// sort, CSV export, map) but scoped to followed ships and without the Traffico
// tab. Reuses the shared list helpers exported by ships.js.

import { el } from './dom.js';
import { S } from './store.js';
import { api } from './api.js';
import { renderFollowedMap } from './maps.js';
import { t } from './i18n.js';
import {
  flagSeenButtonsHtml,
  bindFlagSeenButtons,
  bindShipRows,
  filterShips,
  sortShips,
  updateFilterCount,
  exportShipsCsv,
} from './ships.js';
import {
  escHtml,
  formatTime,
  shipTypeBadge,
  directionBadge,
  riskBadge,
} from './helpers.js';

let follActiveData = [];
let follActiveSort = { col: null, dir: 'asc' };
let follPastData = [];
let follPastSort = { col: null, dir: 'asc' };

function staleMonthsLabel() {
  const months = Math.round(S.followStaleHours / 24 / 30);
  return `Nessun segnale AIS ricevuto. La nave viene cercata in tutto il mondo per un massimo di ${months} mesi. Se riprende a trasmettere riceverai una notifica.`;
}

// Reload both lists (and their counts) after any follow toggle, so a ship that
// just moved between "seguite" and "seguite in passato" lands in the right list.
function reloadFollowed() {
  loadFollowedActive();
  loadFollowedPast();
}

export async function loadFollowedActive() {
  try {
    const data = await api('/api/ships/followed/active');
    const ships = data.ships || [];
    if (el.follActiveCount) el.follActiveCount.textContent = ships.length;
    renderFollowedActiveTable(ships);
  } catch {
    /* ignore */
  }
}

export async function loadFollowedPast() {
  try {
    const data = await api('/api/ships/followed/past');
    const ships = data.ships || [];
    if (el.follPastCount) el.follPastCount.textContent = ships.length;
    renderFollowedPastTable(ships);
  } catch {
    /* ignore */
  }
}

function renderFollowedActiveTable(ships) {
  follActiveData = ships;
  const filtered = filterShips(ships, S.followedFilter, { inPort: true });
  renderFollowedMap(filtered);
  updateFilterCount('foll-active-filter-count', filtered.length, ships.length);
  const sorted = sortShips(filtered, follActiveSort.col, follActiveSort.dir);
  if (!sorted.length) {
    el.follActiveBody.innerHTML =
      `<tr><td colspan="9" class="empty">${ships.length ? t('filter.noMatch') : t('empty.followActive')}</td></tr>`;
    applyFollActiveSortHeader();
    return;
  }
  el.follActiveBody.innerHTML = sorted
    .map(
      (s) => `
    <tr class="ship-row ${s.is_military ? 'military-row' : s.risk?.band === 'high' ? 'risk-row' : ''} ${s.flagged ? 'flagged-row' : ''} ${s.seen ? 'seen-row' : ''} ${s.search_mode ? 'follow-searching-row' : ''}" data-mmsi="${s.mmsi}">
      <td class="col-flags">${flagSeenButtonsHtml(s)}</td>
      <td>${s.search_mode ? '🔍' : formatTime(s.last_seen_at)}</td>
      <td class="ship-name">${escHtml(s.ship_name) || '—'}${s.in_port ? ` <span class="port-badge">${t('port.badge')}</span>` : ''}${s.search_mode ? ` <span class="follow-search-badge" data-tip="${staleMonthsLabel()}">🔍 in ricerca</span>` : ''}${s.sf_last_at ? `<div class="ship-name-sub"><span class="follow-search-badge follow-sf-badge" data-tip="${t('follow.sfSeenTip')}">📍 ${t('follow.sfSeen', { time: formatTime(s.sf_last_at) })}</span></div>` : ''}${s.mst_last_at ? `<div class="ship-name-sub"><span class="follow-search-badge follow-sf-badge" data-tip="${t('follow.mstSeenTip')}">📍 ${t('follow.mstSeen', { time: formatTime(s.mst_last_at) })}</span></div>` : ''}</td>
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
  bindShipRows(el.follActiveBody, 'followed', sorted);
  bindFlagSeenButtons(el.follActiveBody, reloadFollowed);
  applyFollActiveSortHeader();
}

function renderFollowedPastTable(ships) {
  follPastData = ships;
  const filtered = filterShips(ships, S.followedPastFilter);
  updateFilterCount('foll-past-filter-count', filtered.length, ships.length);
  const sorted = sortShips(filtered, follPastSort.col, follPastSort.dir);
  if (!sorted.length) {
    el.follPastBody.innerHTML =
      `<tr><td colspan="6" class="empty">${ships.length ? t('filter.noMatch') : t('empty.followPast')}</td></tr>`;
    applyFollPastSortHeader();
    return;
  }
  el.follPastBody.innerHTML = sorted
    .map(
      (s) => `
    <tr class="ship-row ${s.is_military ? 'military-row' : s.risk?.band === 'high' ? 'risk-row' : ''} ${s.flagged ? 'flagged-row' : ''} ${s.seen ? 'seen-row' : ''}" data-mmsi="${s.mmsi}">
      <td class="col-flags">${flagSeenButtonsHtml(s)}</td>
      <td class="ship-name">${escHtml(s.ship_name) || '—'}</td>
      <td class="mono">${s.mmsi}</td>
      <td>${formatTime(s.last_seen_at)}</td>
      <td>${s.last_sog != null ? s.last_sog.toFixed(1) + ' kn' : '—'}</td>
      <td class="col-risk">${riskBadge(s.risk)}</td>
    </tr>
  `
    )
    .join('');
  bindShipRows(el.follPastBody, 'followed', sorted);
  bindFlagSeenButtons(el.follPastBody, reloadFollowed);
  applyFollPastSortHeader();
}

function applyFollActiveSortHeader() {
  const thead = el.follActiveBody?.closest('table')?.tHead;
  if (!thead) return;
  for (const th of thead.querySelectorAll('th[data-col]')) {
    th.classList.toggle('sort-asc', th.dataset.col === follActiveSort.col && follActiveSort.dir === 'asc');
    th.classList.toggle('sort-desc', th.dataset.col === follActiveSort.col && follActiveSort.dir === 'desc');
  }
}

function applyFollPastSortHeader() {
  const thead = el.follPastBody?.closest('table')?.tHead;
  if (!thead) return;
  for (const th of thead.querySelectorAll('th[data-col]')) {
    th.classList.toggle('sort-asc', th.dataset.col === follPastSort.col && follPastSort.dir === 'asc');
    th.classList.toggle('sort-desc', th.dataset.col === follPastSort.col && follPastSort.dir === 'desc');
  }
}

// Switch between the "seguite" and "seguite in passato" sub-tabs.
export function switchFollowedSubview(sub) {
  S.followedSubview = sub;
  el.tabFollActive.classList.toggle('tab-active', sub === 'active');
  el.tabFollPast.classList.toggle('tab-active', sub === 'past');
  el.follActiveView.classList.toggle('hidden', sub !== 'active');
  el.follPastView.classList.toggle('hidden', sub !== 'past');
  if (sub === 'active') {
    // Re-render so the Leaflet map (hidden until now) sizes itself correctly.
    renderFollowedActiveTable(follActiveData);
  }
}

// Entry point called when the section is opened (see views.js).
export function loadFollowed() {
  reloadFollowed();
  switchFollowedSubview(S.followedSubview || 'active');
}

// ── Wiring (run once at module load) ──────────────────────────────────────────
if (el.tabFollActive) el.tabFollActive.addEventListener('click', () => switchFollowedSubview('active'));
if (el.tabFollPast) el.tabFollPast.addEventListener('click', () => switchFollowedSubview('past'));

// Sort headers.
{
  const aThead = el.follActiveBody?.closest('table')?.tHead;
  if (aThead) {
    for (const th of aThead.querySelectorAll('th[data-col]')) {
      th.addEventListener('click', () => {
        if (follActiveSort.col === th.dataset.col) {
          follActiveSort.dir = follActiveSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          follActiveSort.col = th.dataset.col;
          follActiveSort.dir = 'asc';
        }
        renderFollowedActiveTable(follActiveData);
      });
    }
  }
  const pThead = el.follPastBody?.closest('table')?.tHead;
  if (pThead) {
    for (const th of pThead.querySelectorAll('th[data-col]')) {
      th.addEventListener('click', () => {
        if (follPastSort.col === th.dataset.col) {
          follPastSort.dir = follPastSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          follPastSort.col = th.dataset.col;
          follPastSort.dir = 'asc';
        }
        renderFollowedPastTable(follPastData);
      });
    }
  }
}

// Filter / export toolbars.
{
  const a = {
    search: document.getElementById('foll-active-search'),
    band: document.getElementById('foll-active-band'),
    inport: document.getElementById('foll-active-inport'),
    flagged: document.getElementById('foll-active-flagged'),
    exp: document.getElementById('foll-active-export'),
  };
  if (a.search) a.search.addEventListener('input', () => { S.followedFilter.q = a.search.value; renderFollowedActiveTable(follActiveData); });
  if (a.band) a.band.addEventListener('change', () => { S.followedFilter.band = a.band.value; renderFollowedActiveTable(follActiveData); });
  if (a.inport) a.inport.addEventListener('change', () => { S.followedFilter.inPort = a.inport.checked; renderFollowedActiveTable(follActiveData); });
  if (a.flagged) a.flagged.addEventListener('change', () => { S.followedFilter.flagged = a.flagged.checked; renderFollowedActiveTable(follActiveData); });
  if (a.exp) a.exp.addEventListener('click', () => {
    const sorted = sortShips(filterShips(follActiveData, S.followedFilter, { inPort: true }), follActiveSort.col, follActiveSort.dir);
    exportShipsCsv(sorted, 'navi-seguite');
  });

  const p = {
    search: document.getElementById('foll-past-search'),
    band: document.getElementById('foll-past-band'),
    flagged: document.getElementById('foll-past-flagged'),
    exp: document.getElementById('foll-past-export'),
  };
  if (p.search) p.search.addEventListener('input', () => { S.followedPastFilter.q = p.search.value; renderFollowedPastTable(follPastData); });
  if (p.band) p.band.addEventListener('change', () => { S.followedPastFilter.band = p.band.value; renderFollowedPastTable(follPastData); });
  if (p.flagged) p.flagged.addEventListener('change', () => { S.followedPastFilter.flagged = p.flagged.checked; renderFollowedPastTable(follPastData); });
  if (p.exp) p.exp.addEventListener('click', () => {
    const sorted = sortShips(filterShips(follPastData, S.followedPastFilter), follPastSort.col, follPastSort.dir);
    exportShipsCsv(sorted, 'navi-seguite-passate');
  });
}
