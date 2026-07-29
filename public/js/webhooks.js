import { api } from './api.js';
import { t } from './i18n.js';
import { escHtml } from './helpers.js';
import { showAlert } from './toast.js';
import { S } from './store.js';

// ── Outbound webhooks settings (per-user) ────────────────────────────────────
// Manage the user's webhook list: add (URL + format + event subscription +
// optional HMAC secret), toggle enabled, send a test event, delete. Mirrors the
// per-user Telegram settings. Backend: /api/webhooks (see src/routes/webhooks.js).

let EVENTS = [];
const $ = (id) => document.getElementById(id);

function eventLabel(e) {
  const k = 'webhook.event.' + e;
  const tr = t(k);
  return tr && tr !== k ? tr : e;
}

function renderEventChecks(selected) {
  const box = $('webhook-events');
  if (!box) return;
  box.innerHTML = EVENTS.map(
    (e) => `<label class="webhook-ev"><input type="checkbox" value="${e}" ${selected == null || selected.includes(e) ? 'checked' : ''}> ${escHtml(eventLabel(e))}</label>`
  ).join('');
}

function renderList(hooks) {
  // Drives the "webhook" sub-toggle visibility for group-activity notification
  // categories in Settings → Notifiche (main.js applyGroupNotifState) — that
  // toggle only makes sense once the user has ≥1 webhook to include it in.
  S.webhookCount = hooks.length;
  window.dispatchEvent(new CustomEvent('webhooks-loaded'));
  const box = $('webhooks-list');
  if (!box) return;
  if (!hooks.length) {
    box.innerHTML = `<div class="webhook-empty">${escHtml(t('settings.webhooks.none'))}</div>`;
    return;
  }
  box.innerHTML = hooks
    .map(
      (w) => `
      <div class="webhook-item" data-id="${escHtml(w.id)}">
        <div class="webhook-item-main">
          <span class="webhook-fmt">${escHtml(w.format)}</span>
          <span class="webhook-url-txt">${escHtml(w.url)}</span>
          ${w.hasSecret ? '<span class="webhook-badge" title="HMAC">🔐</span>' : ''}
        </div>
        <div class="webhook-item-meta">${escHtml(w.events.map(eventLabel).join(', ')) || '—'}</div>
        <div class="webhook-item-actions">
          <label class="webhook-enabled"><input type="checkbox" class="wh-enabled" ${w.enabled ? 'checked' : ''}> ${escHtml(t('settings.webhooks.enabled'))}</label>
          <button type="button" class="btn btn-sm wh-test">${escHtml(t('settings.webhooks.test'))}</button>
          <button type="button" class="btn btn-sm wh-del">${escHtml(t('settings.webhooks.delete'))}</button>
        </div>
      </div>`
    )
    .join('');
  box.querySelectorAll('.webhook-item').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('.wh-enabled').addEventListener('change', async (e) => {
      try { await api('/api/webhooks/' + encodeURIComponent(id), 'PATCH', { enabled: e.target.checked }); } catch { e.target.checked = !e.target.checked; }
    });
    row.querySelector('.wh-test').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true;
      try {
        const r = await api('/api/webhooks/' + encodeURIComponent(id) + '/test', 'POST', {});
        showAlert(t(r.ok ? 'settings.webhooks.testOk' : 'settings.webhooks.testFail'));
      } catch {
        showAlert(t('settings.webhooks.testFail'));
      } finally {
        btn.disabled = false;
      }
    });
    row.querySelector('.wh-del').addEventListener('click', async () => {
      if (!confirm(t('settings.webhooks.delConfirm'))) return;
      try {
        const r = await api('/api/webhooks/' + encodeURIComponent(id), 'DELETE');
        renderList(r.webhooks || []);
      } catch { /* ignore */ }
    });
  });
}

export async function loadWebhooks() {
  try {
    const r = await api('/api/webhooks');
    EVENTS = r.events || [];
    renderEventChecks(null);
    renderList(r.webhooks || []);
  } catch { /* ignore */ }
}

export function initWebhooks() {
  const addBtn = $('webhook-add');
  if (!addBtn) return;
  addBtn.addEventListener('click', async () => {
    const url = $('webhook-url').value.trim();
    const status = $('webhook-status');
    if (!url) { if (status) status.textContent = t('settings.webhooks.needUrl'); return; }
    const format = $('webhook-format').value;
    const secret = $('webhook-secret').value.trim();
    const events = [...$('webhook-events').querySelectorAll('input:checked')].map((c) => c.value);
    try {
      const r = await api('/api/webhooks', 'POST', { url, format, events, secret, enabled: true });
      $('webhook-url').value = '';
      $('webhook-secret').value = '';
      renderList(r.webhooks || []);
      if (status) status.textContent = t('settings.webhooks.added');
    } catch (e) {
      if (status) status.textContent = e.message || t('settings.webhooks.error');
    }
  });
  loadWebhooks();
}
