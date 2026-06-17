import { el } from './dom.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { formatTime, statusLabel, escHtml, formatJson, maskSecrets } from './helpers.js';

let logEs = null;

function logRowHtml(e) {
  const statusCls = e.status >= 500 ? 'status-err' : e.status >= 400 ? 'status-warn' : 'status-ok';
  const methodCls = e.method === 'DB' ? 'method-DB' : `method-${e.method}`;
  return `<tr class="log-row" data-id="${e.id}">
    <td class="mono" style="color:#4b5563">${e.id}</td>
    <td>${formatTime(e.ts)}</td>
    <td><span class="method-badge ${methodCls}">${escHtml(e.method)}</span></td>
    <td class="log-path">${escHtml(e.path)}</td>
    <td class="${statusCls} mono">${statusLabel(e.status)}</td>
    <td class="mono" style="color:#6b7280">${e.duration_ms}ms</td>
  </tr>`;
}

function scrollLogToBottom() {
  if (!el.logAutoScrollChk.checked) return;
  const wrap = document.getElementById('log-table-wrap');
  wrap.scrollTop = wrap.scrollHeight;
}

async function fetchLogs() {
  try {
    const data = await api('/api/logs?limit=200');
    const rows = (data.logs || []).reverse();
    if (!rows.length) {
      el.logBody.innerHTML = `<tr><td colspan="6" class="empty">${t('empty.logs')}</td></tr>`;
      return;
    }
    el.logBody.innerHTML = rows.map(logRowHtml).join('');
    scrollLogToBottom();
  } catch {
    /* ignore */
  }
}

function connectLogStream() {
  if (logEs) logEs.close();
  logEs = new EventSource('/api/logs/stream');
  logEs.onopen = () => {
    el.logLiveBadge.textContent = t('log.live');
    el.logLiveBadge.className = 'badge active';
  };
  logEs.onmessage = (e) => {
    const entry = JSON.parse(e.data);
    const empty = el.logBody.querySelector('.empty');
    if (empty) el.logBody.innerHTML = '';
    el.logBody.insertAdjacentHTML('beforeend', logRowHtml(entry));
    while (el.logBody.children.length > 500) el.logBody.removeChild(el.logBody.firstChild);
    scrollLogToBottom();
  };
  logEs.onerror = () => {
    el.logLiveBadge.textContent = t('log.disconnected');
    el.logLiveBadge.className = 'badge error';
  };
}

// Called when the Settings → "Log API" tab becomes active.
export function openLogs() {
  fetchLogs();
  connectLogStream();
}

// Called when leaving that tab (or Settings entirely): stop the live stream.
export function closeLogs() {
  if (logEs) {
    logEs.close();
    logEs = null;
  }
  el.logLiveBadge.textContent = t('log.offline');
  el.logLiveBadge.className = 'badge inactive';
}

async function openLogModal(id) {
  try {
    const e = await api(`/api/logs/${id}`);
    const isDb = e.method === 'DB';
    const statusCls = e.status >= 500 ? 'status-err' : e.status >= 400 ? 'status-warn' : 'status-ok';

    let curlSection = '';
    if (!isDb) {
      const origin = window.location.origin;
      let curl = `curl -X ${e.method} '${origin}${e.path}'`;
      if (e.request_body) {
        curl += ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${e.request_body.replace(/'/g, "\\'")}'`;
      }
      curlSection = `
        <div class="log-detail-section">
          <h3>cURL</h3>
          <pre>${escHtml(maskSecrets(curl))}</pre>
        </div>`;
    }

    const reqSection = e.request_body
      ? `
      <div class="log-detail-section">
        <h3>Request body</h3>
        <pre>${escHtml(maskSecrets(formatJson(e.request_body)))}</pre>
      </div>`
      : '';

    const resSection = e.response_body
      ? `
      <div class="log-detail-section">
        <h3>Response body</h3>
        <pre>${escHtml(maskSecrets(formatJson(e.response_body)))}</pre>
      </div>`
      : '';

    el.modalTitle.textContent = `${e.method} ${e.path}`;
    el.modalBody.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item"><label>${t('log.modal.method')}</label><span>${escHtml(e.method)}</span></div>
        <div class="detail-item"><label>${t('log.modal.status')}</label><span class="${statusCls}">${e.status ?? '—'}</span></div>
        <div class="detail-item"><label>${t('log.modal.duration')}</label><span>${e.duration_ms}ms</span></div>
        <div class="detail-item"><label>${t('log.modal.timestamp')}</label><span>${formatTime(e.ts)}</span></div>
      </div>
      ${curlSection}${reqSection}${resSection}
    `;
    el.modalOverlay.classList.remove('hidden');
  } catch {
    /* ignore */
  }
}

export function initLogPanel() {
  el.btnLogClear.addEventListener('click', async () => {
    if (!confirm(t('confirm.clearLog'))) return;
    await api('/api/logs', 'DELETE');
    el.logBody.innerHTML = `<tr><td colspan="6" class="empty">${t('empty.logs')}</td></tr>`;
  });
  el.logBody.addEventListener('click', (e) => {
    const tr = e.target.closest('.log-row');
    if (tr) openLogModal(Number(tr.dataset.id));
  });
}
