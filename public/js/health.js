import { el } from './dom.js';
import { S } from './store.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { fmtUptime, formatTime, escHtml } from './helpers.js';

let healthTimer = null;

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
      <p class="health-note">${t('health.note')}</p>
    `;
  } catch {
    el.healthBody.innerHTML =
      `<p class="health-err" style="padding:1rem">${t('error.diagnostics')}</p>`;
  }
}

function openHealthPanel() {
  el.healthOverlay.classList.remove('hidden');
  fetchHealth();
  healthTimer = setInterval(fetchHealth, 5000);
}

function closeHealthPanel() {
  el.healthOverlay.classList.add('hidden');
  clearInterval(healthTimer);
  healthTimer = null;
}

export function initHealthPanel() {
  el.btnHealth.addEventListener('click', openHealthPanel);
  el.healthClose.addEventListener('click', closeHealthPanel);
  el.healthOverlay.addEventListener('click', (e) => {
    if (e.target === el.healthOverlay) closeHealthPanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHealthPanel();
  });
}
