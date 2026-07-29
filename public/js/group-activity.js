// "Attività di gruppo": own-group roster + a human-readable feed of the
// group_activity_log audit trail (mirror actions from services/group-sync.js).
// Two tabs: group info (name + members) and the paginated action log.

import { el } from './dom.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { escHtml, formatTime } from './helpers.js';
import { displayName } from './group.js';

const PAGE_SIZE = 50;

let loading = false;
let membersById = new Map();
let loadedRows = []; // every row fetched so far, across "Carica altro" pages
let query = '';

function shipLabel(detail, targetId) {
  if (detail?.shipName) return t('groupActivity.shipNamed', { name: escHtml(detail.shipName) });
  return t('groupActivity.shipFallback', { mmsi: detail?.mmsi ?? targetId ?? '?' });
}

// Renders the changed-settings list of a 'settings_change' row as a
// human-readable, comma-joined fragment (e.g. "notifica rientro nave: attivata").
function settingsDetails(detail) {
  const values = detail?.values || {};
  const parts = [];
  for (const [key, value] of Object.entries(values)) {
    if (key === 'defaultArea') {
      parts.push(t('groupActivity.setting.defaultArea', { area: escHtml(detail.areaName || value) }));
      continue;
    }
    const label = t(`groupActivity.setting.${key}`);
    parts.push(typeof value === 'boolean' ? `${label}: ${value ? t('groupActivity.on') : t('groupActivity.off')}` : label);
  }
  return parts.join(', ');
}

// The "Azione" sentence for one mirrored member action — shared by the log
// table below (buildActionText(row)) AND the "group activity" notifications
// overlay (public/js/group-notif-format.js), which has the same 13 actions but
// a different row shape (notification columns instead of a group_activity_log
// row), hence the explicit params instead of reading a `row` object directly.
export function actionText(action, detail, targetId, actorId, membersById) {
  const d = detail || {};
  switch (action) {
    case 'area_add':
    case 'area_remove':
      return t(`groupActivity.msg.${action}`, { area: escHtml(d.areaName || d.areaKey || targetId) });
    case 'follow_on':
    case 'follow_off':
    case 'flag_on':
    case 'flag_off':
    case 'mute_on':
    case 'mute_off':
    case 'seen_on':
    case 'seen_off':
    case 'charge_on':
      return t(`groupActivity.msg.${action}`, { ship: shipLabel(d, targetId) });
    case 'charge_assign':
      return t('groupActivity.msg.charge_assign', { ship: shipLabel(d, targetId), target: escHtml(displayName(membersById.get(d.targetUserId))) });
    case 'charge_off':
      return d.targetUserId === actorId
        ? t('groupActivity.msg.charge_off_self', { ship: shipLabel(d, targetId) })
        : t('groupActivity.msg.charge_off_other', { ship: shipLabel(d, targetId), target: escHtml(displayName(membersById.get(d.targetUserId))) });
    case 'settings_change':
      return t('groupActivity.msg.settings_change', { details: settingsDetails(d) });
    default:
      return escHtml(action);
  }
}

// The "Azione" cell text — no user name in it (that's its own column).
function buildActionText(row) {
  return actionText(row.action, row.detail, row.target_id, row.user_id, membersById);
}

function renderInfo(data) {
  if (!data.group) {
    el.gaGroupName.textContent = '';
    el.gaGroupDesc.textContent = '';
    el.gaMembersTitle.textContent = '';
    el.gaMembersList.innerHTML = '';
    return;
  }
  el.gaGroupName.textContent = data.group.name;
  el.gaGroupDesc.textContent = data.group.description || '';
  el.gaMembersTitle.textContent = t('groupActivity.members', { n: data.members.length });
  el.gaMembersList.innerHTML = data.members
    .map((m) => {
      const you = m.id === data.youId ? `<span class="ga-you">(${t('groupActivity.you')})</span>` : '';
      return `<li>${escHtml(displayName(m))}${you}</li>`;
    })
    .join('');
}

// Whether `row` matches the current search query — checked against the
// user's display name, the raw fields (ship/area name, mmsi, the changed
// settings) AND the actual rendered "Azione" sentence (tags stripped), so a
// search for a word that only appears in the translated verb (e.g. IT
// "segnalato", EN "flagged") matches too, in whichever language is active.
function matchesQuery(row) {
  if (!query) return true;
  const d = row.detail || {};
  const hay = [
    displayName(membersById.get(row.user_id)),
    d.shipName,
    d.areaName,
    d.mmsi,
    row.target_id,
    displayName(membersById.get(d.targetUserId)),
    ...(d.values ? Object.keys(d.values) : []),
    buildActionText(row).replace(/<[^>]*>/g, ''),
  ]
    .map((v) => (v == null ? '' : String(v).toLowerCase()))
    .join(' ');
  return hay.includes(query);
}

function renderFilteredLog() {
  if (!loadedRows.length) {
    el.gaLogBody.innerHTML = `<tr><td colspan="3" class="empty">${t('groupActivity.empty')}</td></tr>`;
    return;
  }
  const filtered = loadedRows.filter(matchesQuery);
  if (!filtered.length) {
    el.gaLogBody.innerHTML = `<tr><td colspan="3" class="empty">${t('groupActivity.noMatch')}</td></tr>`;
    return;
  }
  el.gaLogBody.innerHTML = filtered
    .map((row) => `
      <tr class="ga-log-row">
        <td class="ga-log-time">${formatTime(row.created_at)}</td>
        <td>${escHtml(displayName(membersById.get(row.user_id)))}</td>
        <td class="ga-log-action">${buildActionText(row)}</td>
      </tr>`)
    .join('');
}

async function loadLogPage() {
  if (loading) return;
  loading = true;
  try {
    const data = await api(`/api/group/activity?limit=${PAGE_SIZE}&offset=${loadedRows.length}`);
    loadedRows = loadedRows.concat(data.rows);
    renderFilteredLog();
    el.btnGaLoadMore.classList.toggle('hidden', !data.hasMore);
  } catch (e) {
    el.gaLogBody.innerHTML = `<tr><td colspan="3" class="empty">${t('groupActivity.loadFail')}${escHtml(e.message)}</td></tr>`;
  } finally {
    loading = false;
  }
}

function switchTab(tab) {
  el.gaTabInfo.classList.toggle('tab-active', tab === 'info');
  el.gaTabLog.classList.toggle('tab-active', tab === 'log');
  el.gaInfoView.classList.toggle('hidden', tab !== 'info');
  el.gaLogView.classList.toggle('hidden', tab !== 'log');
}

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;
  el.gaTabInfo.addEventListener('click', () => switchTab('info'));
  el.gaTabLog.addEventListener('click', () => switchTab('log'));
  el.btnGaLoadMore.addEventListener('click', () => loadLogPage());
  el.gaLogSearch.addEventListener('input', () => {
    query = el.gaLogSearch.value.trim().toLowerCase();
    renderFilteredLog();
  });
}

export async function enterGroupActivityView() {
  wireOnce();
  switchTab('info');
  loadedRows = [];
  query = '';
  el.gaLogSearch.value = '';
  el.btnGaLoadMore.classList.add('hidden');
  try {
    const data = await api('/api/group');
    membersById = new Map((data.members || []).map((m) => [m.id, m]));
    renderInfo(data);
  } catch {
    /* ignore — info tab just stays empty */
  }
  loadLogPage();
}
