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

// "Modalità fallback" (see services/fallback-mode.js): status + per-source
// circuit breaker state, real recent scrape volume (last 48h, sf+mst combined,
// hour buckets), and a comparison of the two scope options' request/hour
// estimate — so an admin can see the risk jump before switching, not just a
// bare toggle. Bars reuse the same CSS classes as the traffic stats charts
// (traffico.js) — no chart library, consistent with the rest of the app.
function fallbackModeBlock(fb, est) {
  if (!fb) return '';
  const statusVal = fb.active
    ? `<span class="health-err">${t('health.fallbackActive')}</span>`
    : `<span class="health-ok">${t('health.fallbackInactive')}</span>`;
  const rows = [`<div class="health-item"><label>${t('health.fallbackStatus')}</label><span>${statusVal}</span></div>`];
  if (fb.active && fb.since) {
    rows.push(`<div class="health-item"><label>${t('health.fallbackSince')}</label><span>${formatTime(fb.since)}</span></div>`);
  }
  rows.push(
    `<div class="health-item"><label>${t('health.fallbackScope')}</label><span>${
      fb.scope === 'areas' ? t('health.fallbackModeFull') : t('health.fallbackModeFollow')
    }</span></div>`
  );
  for (const src of ['sf', 'mst']) {
    const c = fb.circuits?.[src];
    const label = src === 'sf' ? 'ShipFinder' : 'MyShipTracking';
    const val = c?.open
      ? `<span class="health-err">${t('health.circuitOpen', { until: formatTime(c.until) })}</span>`
      : `<span class="health-ok">${t('health.circuitClosed')}</span>`;
    rows.push(`<div class="health-item"><label>${label}</label><span>${val}</span></div>`);
  }

  const byHour = new Map();
  for (const row of est?.recentHistory || []) {
    if (row.source !== 'sf' && row.source !== 'mst') continue;
    byHour.set(row.hour, (byHour.get(row.hour) || 0) + row.total);
  }
  const hours = [...byHour.keys()].sort();
  const maxHour = Math.max(1, ...hours.map((h) => byHour.get(h)));
  const historyChart = hours.length
    ? `<div class="hourly-bars">${hours
        .map(
          (h) => `
      <div class="hour-bar-wrap" title="${escHtml(h)}: ${byHour.get(h)}">
        <div class="hour-bar" style="height:${Math.max(2, Math.round((byHour.get(h) / maxHour) * 100))}%"></div>
      </div>`
        )
        .join('')}</div>`
    : `<p class="health-muted">${t('health.fallbackNoHistory')}</p>`;

  const maxEst = Math.max(1, est?.followOnly?.requestsPerHour || 0, est?.full?.requestsPerHour || 0);
  const estRow = (labelKey, e) => `
    <div class="type-bar-row">
      <div class="type-bar-label">${t(labelKey)}</div>
      <div class="type-bar-track"><div class="type-bar-fill" style="width:${Math.round(((e?.requestsPerHour || 0) / maxEst) * 100)}%"></div></div>
      <div class="type-bar-count" style="width:auto;min-width:36px">${e?.requestsPerHour || 0}/h</div>
    </div>`;

  return `
    <div class="health-section">
      <h4 class="health-subtitle">${t('health.fallbackTitle')}</h4>
      <p class="health-section-desc">${t('health.fallbackDesc')}</p>
      <div class="health-grid">${rows.join('')}</div>
      <h4 class="health-subtitle">${t('health.fallbackHistoryTitle')}</h4>
      ${historyChart}
      <h4 class="health-subtitle">${t('health.fallbackEstimateTitle')}</h4>
      ${estRow('health.fallbackModeFollow', est?.followOnly)}
      ${estRow('health.fallbackModeFull', est?.full)}
      <p class="health-note">${t('health.fallbackBudgetNote', { n: est?.budgetPerHour || 0 })}</p>
      <div class="fallback-scope-actions">
        <button id="btn-fallback-scope-follow" class="btn btn-sm ${fb.scope !== 'areas' ? 'btn-primary' : 'btn-secondary'}">${t('health.fallbackModeFollow')}</button>
        <button id="btn-fallback-scope-areas" class="btn btn-sm ${fb.scope === 'areas' ? 'btn-primary' : 'btn-secondary'}">${t('health.fallbackModeFull')}</button>
      </div>
    </div>`;
}

async function setFallbackScope(areas) {
  try {
    await api('/api/settings/fallback-scope', 'POST', { areas });
    fetchHealth();
  } catch { /* best-effort; next poll reflects real state either way */ }
}

// Delegated once on the static container — fetchHealth() rebuilds its innerHTML
// on every poll, so per-render listeners would leak/duplicate.
el.healthBody?.addEventListener('click', (e) => {
  if (e.target.id === 'btn-fallback-scope-follow') setFallbackScope(false);
  else if (e.target.id === 'btn-fallback-scope-areas') setFallbackScope(true);
});

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
      ${fallbackModeBlock(h.fallbackMode, h.fallbackEstimate)}
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
