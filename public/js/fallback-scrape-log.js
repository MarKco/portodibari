// Live fallback-mode scrape-attempt feed — floating overlay window, sidebar
// toggle shown only while fallback mode is active AND the user is admin (same
// gate as the existing "🔀 Modalità fallback" nav button, see outage.js). One
// SSE connection (services/fallback-mode.js broadcasts via realtime.js, same
// pattern as the operational log in app-log.js) feeds a small rolling chart —
// stacked ok/failed bars per source, sliding 30s buckets over the last 10
// minutes — so an admin can see call volume and success rate at a glance
// without leaving whatever page they're on.

import { el } from './dom.js';
import { api } from './api.js';
import { t } from './i18n.js';

const SOURCE_LABEL = { sf: 'ShipFinder', mst: 'MyShipTracking' };
const BUCKET_MS = 30 * 1000;
const WINDOW_MIN = 10;
const BUCKET_COUNT = (WINDOW_MIN * 60 * 1000) / BUCKET_MS; // 20

let es = null;
let open = false;
const events = []; // {ts, source, mmsi, ok} — only kept back to WINDOW_MIN, see prune()
const totals = { sf: { ok: 0, failed: 0 }, mst: { ok: 0, failed: 0 } };

function prune() {
  const cutoff = Date.now() - WINDOW_MIN * 60 * 1000;
  while (events.length && new Date(events[0].ts).getTime() < cutoff) events.shift();
}

function addEvent(entry) {
  events.push(entry);
  const bucket = totals[entry.source];
  if (bucket) {
    if (entry.ok) bucket.ok++;
    else bucket.failed++;
  }
  prune();
  if (open) render();
}

function setStatus(state) {
  const badge = el.fallbackScrapeOvLive;
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
}

// One small stacked-bar chart for a single source, 30s buckets over the last
// 10 minutes — same visual language (stacked ok/failed bars) as the historical
// per-hour chart in Settings → Diagnostica AIS, just at live/fine granularity.
function sourceChart(source) {
  const now = Date.now();
  const buckets = new Array(BUCKET_COUNT).fill(null).map(() => ({ ok: 0, failed: 0 }));
  for (const e of events) {
    if (e.source !== source) continue;
    const age = now - new Date(e.ts).getTime();
    const idx = BUCKET_COUNT - 1 - Math.floor(age / BUCKET_MS);
    if (idx >= 0 && idx < BUCKET_COUNT) {
      if (e.ok) buckets[idx].ok++;
      else buckets[idx].failed++;
    }
  }
  const maxTotal = Math.max(1, ...buckets.map((b) => b.ok + b.failed));
  const bars = buckets
    .map((b) => {
      const total = b.ok + b.failed;
      const totalPct = total ? Math.max(4, Math.round((total / maxTotal) * 100)) : 0;
      const failPct = total ? Math.round(totalPct * (b.failed / total)) : 0;
      const okPct = totalPct - failPct;
      return `
      <div class="hour-bar-wrap" title="${b.ok} ${t('health.fallbackOkLabel')} · ${b.failed} ${t('health.fallbackFailedLabel')}">
        <div class="hour-bar-stack" style="height:${totalPct}%">
          ${failPct ? `<div class="hour-bar-fail" style="height:${failPct}%"></div>` : ''}
          ${okPct ? `<div class="hour-bar-ok" style="height:${okPct}%"></div>` : ''}
        </div>
      </div>`;
    })
    .join('');
  const t2 = totals[source];
  return `
    <p class="health-section-desc" style="margin:0.5rem 0 0.2rem"><strong>${SOURCE_LABEL[source]}</strong> — ${t2.ok + t2.failed} ${t('fallbackScrapeLog.calls')} (${t2.ok} ${t('health.fallbackOkLabel').toLowerCase()}, ${t2.failed} ${t('health.fallbackFailedLabel').toLowerCase()})</p>
    <div class="hourly-bars fallback-scrape-chart">${bars}</div>`;
}

function render() {
  const body = el.fallbackScrapeOvBody;
  if (!body) return;
  body.innerHTML = `
    <p class="health-note" style="margin:0 0 0.4rem">${t('fallbackScrapeLog.desc', { min: WINDOW_MIN })}</p>
    ${sourceChart('sf')}
    ${sourceChart('mst')}`;
}

async function connect() {
  if (es) return;
  try {
    const { entries } = await api('/api/fallback-scrape');
    for (const e of entries || []) addEvent(e);
  } catch { /* start empty */ }
  es = new EventSource('/api/fallback-scrape/stream');
  es.onopen = () => setStatus('live');
  es.onmessage = (ev) => {
    let entry;
    try {
      entry = JSON.parse(ev.data);
    } catch {
      return;
    }
    addEvent(entry);
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

function positionNearButton() {
  const win = el.fallbackScrapeOvWindow;
  if (!win || win.dataset.placed) return;
  const btn = el.btnFallbackScrapeOverlay;
  const w = win.offsetWidth || 440;
  const h = win.offsetHeight || 320;
  let left = 232;
  let top = window.innerHeight - h - 48;
  if (btn) {
    const r = btn.getBoundingClientRect();
    left = r.right + 8;
    top = r.bottom - h;
  }
  left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
  top = Math.min(Math.max(8, top), window.innerHeight - h - 8);
  win.style.left = left + 'px';
  win.style.top = top + 'px';
  win.dataset.placed = '1';
}

function openWin() {
  const win = el.fallbackScrapeOvWindow;
  if (!win) return;
  win.classList.remove('hidden');
  positionNearButton();
  el.btnFallbackScrapeOverlay?.classList.add('active');
  open = true;
  render();
  connect();
}

function closeWin() {
  const win = el.fallbackScrapeOvWindow;
  if (!win) return;
  win.classList.add('hidden');
  el.btnFallbackScrapeOverlay?.classList.remove('active');
  open = false;
  disconnect();
}

function toggleWin() {
  if (!el.fallbackScrapeOvWindow || el.fallbackScrapeOvWindow.classList.contains('hidden')) openWin();
  else closeWin();
}

// Called by outage.js when it hides the sidebar toggle (fallback mode ended,
// or the user stopped being admin) — no point polling a feed for a mode that's
// no longer active, so close the window if it happened to be open.
export function closeFallbackScrapeLogIfOpen() {
  if (open) closeWin();
}

export function initFallbackScrapeLog() {
  const win = el.fallbackScrapeOvWindow;
  if (!win) return;

  el.btnFallbackScrapeOverlay?.addEventListener('click', toggleWin);
  el.fallbackScrapeOvClose?.addEventListener('click', closeWin);

  // Drag by the header — identical pattern to the application-log overlay
  // window (app-log.js), duplicated rather than shared since each window
  // drags itself independently and the logic is a handful of lines.
  const header = el.fallbackScrapeOvHeader;
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
