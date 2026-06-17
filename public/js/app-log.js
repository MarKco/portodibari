// Operational application-log viewer: a shared live feed rendered into two
// independent surfaces — the floating overlay window (toggled from the sidebar)
// and the dedicated panel in Settings → Log. Both tail the feed by default but
// stop auto-scrolling the moment the user scrolls up, so entries can be read,
// selected and copied without new lines yanking the viewport.

import { el } from './dom.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { formatTime, escHtml } from './helpers.js';

const MAX_ENTRIES = 2000; // cap kept in memory / rendered per surface
const STICK_THRESHOLD = 32; // px from bottom still considered "pinned"

// ── Shared live core ──────────────────────────────────────────────────────────
const buffer = []; // recent entries, oldest → newest
const listeners = new Set(); // (entry) => void, one per open surface
let es = null;
let refCount = 0;
let loaded = false;
const statusFns = new Set(); // (state) => void  state: 'live'|'offline'|'error'

function setStatus(state) {
  for (const fn of statusFns) fn(state);
}

async function ensureLoaded() {
  if (loaded) return;
  try {
    const data = await api('/api/app-log?limit=1000');
    buffer.push(...(data.entries || []));
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  } catch {
    /* ignore — surfaces just start empty */
  }
  loaded = true;
}

function connect() {
  if (es) return;
  es = new EventSource('/api/app-log/stream');
  es.onopen = () => setStatus('live');
  es.onmessage = (e) => {
    let entry;
    try {
      entry = JSON.parse(e.data);
    } catch {
      return;
    }
    buffer.push(entry);
    if (buffer.length > MAX_ENTRIES) buffer.shift();
    for (const fn of listeners) fn(entry);
  };
  es.onerror = () => setStatus('error');
}

function disconnect() {
  if (es) {
    es.close();
    es = null;
  }
  setStatus('offline');
}

function acquire(onEntry) {
  listeners.add(onEntry);
  refCount++;
  connect();
}

function release(onEntry) {
  listeners.delete(onEntry);
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) disconnect();
}

// ── Rendering ───────────────────────────────────────────────────────────────
function lineHtml(e) {
  const lvl = e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info';
  const data = e.data ? ` <span class="ll-data">${escHtml(e.data)}</span>` : '';
  return `<div class="log-line ll-${lvl}">` +
    `<span class="ll-time">${escHtml(formatTime(e.ts))}</span>` +
    `<span class="ll-tag">${escHtml(e.tag || '')}</span>` +
    `<span class="ll-msg">${escHtml(e.msg || '')}${data}</span>` +
    `</div>`;
}

const EMPTY = () => `<div class="log-empty">${escHtml(t('appLog.empty'))}</div>`;

// A surface binds the shared feed to one scroll container. It keeps its own
// pinned-to-bottom flag so scrolling one surface doesn't affect the other.
function makeSurface(body) {
  let pinned = true;
  let open = false;

  function atBottom() {
    return body.scrollHeight - body.scrollTop - body.clientHeight <= STICK_THRESHOLD;
  }
  function scrollToBottom() {
    body.scrollTop = body.scrollHeight;
  }
  body.addEventListener('scroll', () => {
    if (open) pinned = atBottom();
  });

  function renderAll() {
    body.innerHTML = buffer.length ? buffer.map(lineHtml).join('') : EMPTY();
    pinned = true;
    scrollToBottom();
  }
  function onEntry(entry) {
    const empty = body.querySelector('.log-empty');
    if (empty) body.innerHTML = '';
    body.insertAdjacentHTML('beforeend', lineHtml(entry));
    while (body.children.length > MAX_ENTRIES) body.removeChild(body.firstChild);
    if (pinned) scrollToBottom();
  }

  return {
    async open() {
      if (open) return;
      open = true;
      await ensureLoaded();
      renderAll();
      acquire(onEntry);
    },
    close() {
      if (!open) return;
      open = false;
      release(onEntry);
    },
    clear() {
      body.innerHTML = EMPTY();
    },
    isOpen() {
      return open;
    },
  };
}

function badgeUpdater(badge) {
  return (state) => {
    if (!badge) return;
    if (state === 'live') {
      badge.textContent = t('log.live');
      badge.className = 'badge active';
    } else if (state === 'error') {
      badge.textContent = t('log.disconnected');
      badge.className = 'badge error';
    } else {
      badge.textContent = t('log.offline');
      badge.className = 'badge inactive';
    }
  };
}

async function clearLog() {
  if (!confirm(t('appLog.confirmClear'))) return;
  try {
    await api('/api/app-log', 'DELETE');
    buffer.length = 0;
  } catch {
    /* ignore */
  }
}

// ── Floating overlay window ───────────────────────────────────────────────────
function initOverlay() {
  const win = el.logOvWindow;
  const body = el.logOvBody;
  if (!win || !body) return;
  const surface = makeSurface(body);
  statusFns.add(badgeUpdater(el.logOvLive));

  function positionNearButton() {
    // Only set an initial position the first time; afterwards respect drag/resize.
    if (win.dataset.placed) return;
    const btn = el.btnLogOverlay;
    const w = win.offsetWidth || 440;
    const h = win.offsetHeight || 360;
    let left = 232; // just outside the 220px sidebar
    let top = window.innerHeight - h - 48;
    if (btn) {
      const r = btn.getBoundingClientRect();
      left = r.right + 8;
      top = r.bottom - h; // rise above the button
    }
    left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
    top = Math.min(Math.max(8, top), window.innerHeight - h - 8);
    win.style.left = left + 'px';
    win.style.top = top + 'px';
    win.dataset.placed = '1';
  }

  function openWin() {
    win.classList.remove('hidden');
    positionNearButton();
    el.btnLogOverlay?.classList.add('active');
    surface.open();
  }
  function closeWin() {
    win.classList.add('hidden');
    el.btnLogOverlay?.classList.remove('active');
    surface.close();
  }
  function toggleWin() {
    if (win.classList.contains('hidden')) openWin();
    else closeWin();
  }

  el.btnLogOverlay?.addEventListener('click', toggleWin);
  el.logOvClose?.addEventListener('click', closeWin);
  el.logOvClear?.addEventListener('click', () => surface && clearLog().then(() => surface.clear()));

  // Drag by the header (ignore clicks on the action buttons).
  const header = el.logOvHeader;
  if (header) {
    let dragging = false;
    let offX = 0;
    let offY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.log-ov-btn')) return;
      dragging = true;
      const r = win.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      win.dataset.placed = '1';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = win.offsetWidth;
      const h = win.offsetHeight;
      const left = Math.min(Math.max(0, e.clientX - offX), window.innerWidth - w);
      const top = Math.min(Math.max(0, e.clientY - offY), window.innerHeight - h);
      win.style.left = left + 'px';
      win.style.top = top + 'px';
    });
    document.addEventListener('mouseup', () => {
      dragging = false;
      document.body.style.userSelect = '';
    });
  }
}

// ── Settings panel surface ────────────────────────────────────────────────────
let settingsSurface = null;

function initSettingsPanel() {
  const body = el.appLogBody;
  if (!body) return;
  settingsSurface = makeSurface(body);
  statusFns.add(badgeUpdater(el.appLogLive));
  el.appLogClear?.addEventListener('click', () => clearLog().then(() => settingsSurface.clear()));
}

// Called by main.js when the Settings → Log tab is shown / hidden.
export function openSettingsLog() {
  settingsSurface?.open();
}
export function closeSettingsLog() {
  settingsSurface?.close();
}

// Reflect the enabled/disabled state coming from /api/settings.
export function setAppLogToggle(enabled) {
  if (el.toggleAppLog) el.toggleAppLog.checked = !!enabled;
}

export function initAppLog() {
  initOverlay();
  initSettingsPanel();

  if (el.toggleAppLog) {
    el.toggleAppLog.addEventListener('change', async () => {
      const enabled = el.toggleAppLog.checked;
      try {
        await api('/api/app-log/enabled', 'POST', { enabled });
      } catch {
        el.toggleAppLog.checked = !enabled;
      }
    });
  }
}
