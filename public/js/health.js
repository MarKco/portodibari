import { el } from './dom.js';
import { S } from './store.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { fmtUptime, formatTime, escHtml } from './helpers.js';

let healthTimer = null;

// Human label for an API-key source tag (env / local.properties / shared / null).
function keySourceLabel(src) {
  if (src === 'shared') return t('health.keyShared');
  if (src === 'local.properties') return 'local.properties';
  if (src === 'env') return 'env';
  return t('health.keyNone');
}

// One connection block (header + key fingerprint + alerts + status grid) for a
// single AISStream key/account. `h` is the per-stream health object; `extra` is an
// array of {label, value} rows appended to the grid (e.g. followed-ship counts).
function streamBlock(title, h, extra = []) {
  if (!h) return '';

  // Heatmap with no key configured: nothing to monitor, say so and stop.
  if (h.enabled === false) {
    return `
      <div class="health-section">
        <h4 class="health-subtitle">${title}</h4>
        <p class="health-section-desc health-muted">${t('health.notConfigured')}</p>
      </div>`;
  }

  const connectedSince = h.connectedAt
    ? new Date(h.connectedAt).toLocaleTimeString() + ' ' + new Date(h.connectedAt).toLocaleDateString()
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

  const keyTag = h.keyTag || `(${keySourceLabel(h.keySource)})`;
  const keyLine = `${escHtml(keyTag)} — ${keySourceLabel(h.keySource)}`;

  const extraCells = extra
    .map((e) => `<div class="health-item"><label>${e.label}</label><span>${e.value}</span></div>`)
    .join('');

  return `
    <div class="health-section">
      <h4 class="health-subtitle">${title}</h4>
      <p class="health-section-desc">${t('health.key')}: <code>${keyLine}</code></p>
      ${noDataWarning}
      ${errorBlock}
      <div class="health-grid">
        <div class="health-item"><label>${t('health.connection')}</label><span>${connStatus}</span></div>
        <div class="health-item"><label>${t('health.uptime')}</label><span>${fmtUptime(h.uptimeSec)}</span></div>
        <div class="health-item"><label>${t('health.frames')}</label><span>${(h.sessionFrames || 0).toLocaleString()}</span></div>
        <div class="health-item"><label>${t('health.messages')}</label><span>${(h.sessionMessages || 0).toLocaleString()}</span></div>
        <div class="health-item"><label>${t('health.msgRate')}</label><span>${h.msgPerMin != null ? t('health.msgPerMin', { n: h.msgPerMin }) : '—'}</span></div>
        <div class="health-item"><label>${t('health.reconnects')}</label><span class="${reconnectColor}">${h.reconnectCount || 0}</span></div>
        ${extraCells}
        <div class="health-item"><label>${t('health.lastError')}</label><span>${h.lastAisError ? `<span class="health-err">${escHtml(h.lastAisError).slice(0, 80)}</span>` : `<span class="health-muted">${t('health.noError')}</span>`}</span></div>
      </div>
    </div>`;
}

// Scraping counters over the last 24h, per external vendor. Shows total fetches
// with the failed count when any failed.
function scrapeCountsBlock(counts) {
  counts = counts || {};
  const vendors = [
    { key: 'vf', label: 'VesselFinder' },
    { key: 'mt', label: 'MarineTraffic' },
    { key: 'sf', label: 'ShipFinder' },
    { key: 'mst', label: 'MyShipTracking' },
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
    const mon = h.monitoring || h; // monitoring also lives at top level (back-compat)

    const monBlock = streamBlock(
      `${t('health.streamMonitoring')}${mon.area ? ` (${escHtml(mon.area)})` : ''}`,
      mon,
      [{ label: t('health.dbCount'), value: (mon.totalDbCount || 0).toLocaleString() }]
    );

    const followBlock = streamBlock(t('health.streamFollow'), h.follow, [
      { label: t('health.followed'), value: (h.follow?.followedCount || 0).toLocaleString() },
      { label: t('health.followStale'), value: (h.follow?.staleCount || 0).toLocaleString() },
    ]);

    const heatBlock = streamBlock(t('health.streamHeatmap'), h.heatmap);

    el.healthBody.innerHTML = `
      ${monBlock}
      ${followBlock}
      ${heatBlock}
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
  clearInterval(healthTimer); // guard against a leaked timer if re-opened without close
  fetchHealth();
  healthTimer = setInterval(fetchHealth, 5000);
}

// Called when leaving that tab (or Settings entirely): stop polling.
export function closeHealth() {
  clearInterval(healthTimer);
  healthTimer = null;
}
