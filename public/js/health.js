import { el } from './dom.js';
import { S } from './store.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { fmtUptime, formatTime, escHtml } from './helpers.js';

let healthTimer = null;

// Scraping counters over the last 24h, per external vendor. Shows total fetches
// with the failed count when any failed.
function scrapeCountsBlock(counts) {
  counts = counts || {};
  const vendors = [
    { key: 'vf', label: 'VesselFinder' },
    { key: 'mt', label: 'MarineTraffic' },
    { key: 'sf', label: 'ShipFinder' },
  ];
  const cells = vendors
    .map(({ key, label }) => {
      const c = counts[key] || { total: 0, failed: 0 };
      const failed = c.failed ? ` <span class="health-warn">(${t('health.scrapeFailed', { n: c.failed })})</span>` : '';
      return `<div class="health-item"><label>${label}</label><span>${c.total.toLocaleString()}${failed}</span></div>`;
    })
    .join('');
  return `
    <div class="health-section">
      <h4 class="health-subtitle">${t('health.scrape24h')}</h4>
      <p class="health-section-desc">${t('health.scrapeDesc')}</p>
      <div class="health-grid">${cells}</div>
    </div>`;
}

async function fetchHealth() {
  try {
    const area = encodeURIComponent(S.currentPreset || '');
    const h = await api(`/api/stream/health${area ? `?area=${area}` : ''}`);

    const connectedSince = h.connectedAt
      ? new Date(h.connectedAt).toLocaleTimeString() +
        ' ' +
        new Date(h.connectedAt).toLocaleDateString()
      : '—';

    const connStatus = h.connected
      ? `<span class="health-ok">${t('health.connected')}</span> ${connectedSince}`
      : `<span class="health-err">${t('health.disconnected')}</span>`;

    const noDataWarning =
      h.connected && h.uptimeSec > 120 && h.sessionFrames === 0
        ? `<div class="health-alert">${t('health.noData', { uptime: fmtUptime(h.uptimeSec) })}</div>`
        : '';

    const errorBlock = h.lastAisError
      ? `<div class="health-alert health-alert-err">
           <strong>${t('health.aisError')}</strong> (${h.lastAisErrorAt ? formatTime(h.lastAisErrorAt) : '—'})<br>
           <code>${escHtml(h.lastAisError)}</code>
         </div>`
      : '';

    const reconnectColor =
      h.reconnectCount > 5 ? 'health-warn' : h.reconnectCount > 0 ? 'health-muted' : 'health-ok';

    el.healthBody.innerHTML = `
      ${noDataWarning}
      ${errorBlock}
      <div class="health-grid">
        <div class="health-item"><label>${t('health.connection')}</label><span>${connStatus}</span></div>
        <div class="health-item"><label>${t('health.uptime')}</label><span>${fmtUptime(h.uptimeSec)}</span></div>
        <div class="health-item"><label>${t('health.frames')}</label><span>${h.sessionFrames.toLocaleString()}</span></div>
        <div class="health-item"><label>${t('health.messages')}</label><span>${h.sessionMessages.toLocaleString()}</span></div>
        <div class="health-item"><label>${t('health.msgRate')}</label><span>${h.msgPerMin !== null ? t('health.msgPerMin', { n: h.msgPerMin }) : '—'}</span></div>
        <div class="health-item"><label>${t('health.reconnects')}</label><span class="${reconnectColor}">${h.reconnectCount}</span></div>
        <div class="health-item"><label>${t('health.dbCount')}</label><span>${h.totalDbCount.toLocaleString()}</span></div>
        <div class="health-item"><label>${t('health.lastError')}</label><span>${h.lastAisError ? `<span class="health-err">${escHtml(h.lastAisError).slice(0, 80)}</span>` : `<span class="health-muted">${t('health.noError')}</span>`}</span></div>
      </div>
      ${scrapeCountsBlock(h.scrapeCounts24h)}
      <p class="health-note">${t('health.note')}</p>
    `;
  } catch {
    el.healthBody.innerHTML =
      `<p class="health-err" style="padding:1rem">${t('error.diagnostics')}</p>`;
  }
}

// Called when the Settings → "Diagnostica AIS" tab becomes active: poll health
// every 5s while visible.
export function openHealth() {
  fetchHealth();
  healthTimer = setInterval(fetchHealth, 5000);
}

// Called when leaving that tab (or Settings entirely): stop polling.
export function closeHealth() {
  clearInterval(healthTimer);
  healthTimer = null;
}
