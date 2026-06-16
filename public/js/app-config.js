// Parameters tab: edit app.config.properties from the UI. The form is built
// from the file itself (groups = sections, descriptions = the file's comments),
// served by GET /api/app-config. Saving writes the file; values are read only at
// startup, so the UI makes clear a server restart is required.
import { el } from './dom.js';
import { api } from './api.js';
import { escHtml } from './helpers.js';
import { showAlert } from './toast.js';
import { t } from './i18n.js';

function fieldRow(f) {
  const name = f.description ? escHtml(f.description) : escHtml(f.key);
  const keyTag = `<code class="param-key">${escHtml(f.key)}</code>`;
  const desc = f.description ? keyTag : '';
  let control;
  if (f.type === 'bool') {
    const checked = f.value === 'true' ? ' checked' : '';
    control = `<label class="toggle"><input type="checkbox" class="param-input" data-type="bool" data-key="${escHtml(f.key)}" data-orig="${f.value}"${checked}><span class="toggle-slider"></span></label>`;
  } else {
    const unit = f.unit ? `<span class="param-unit">${escHtml(f.unit)}</span>` : '';
    control = `<input type="number" step="any" class="param-input" data-type="number" data-key="${escHtml(f.key)}" data-orig="${escHtml(f.value)}" value="${escHtml(f.value)}">${unit}`;
  }
  return `<div class="setting-row param-row">
    <div class="setting-info">
      <div class="setting-name">${name}</div>
      <div class="setting-desc">${desc}</div>
    </div>
    <div class="param-control">${control}</div>
  </div>`;
}

function render(groups) {
  el.paramsBody.innerHTML = groups
    .map(
      (g) =>
        `<h3 class="settings-group-title">${escHtml(g.title || '—')}</h3>` +
        g.fields.map(fieldRow).join('')
    )
    .join('');
  updateDirtyState();
}

function inputValue(input) {
  return input.dataset.type === 'bool' ? (input.checked ? 'true' : 'false') : input.value.trim();
}

function isDirty(input) {
  const orig = input.dataset.orig;
  if (input.dataset.type === 'bool') return inputValue(input) !== orig;
  const v = input.value.trim();
  if (v === '') return true; // empty = invalid/changed
  return Number(v) !== Number(orig);
}

function updateDirtyState() {
  const inputs = el.paramsBody.querySelectorAll('.param-input');
  let n = 0;
  inputs.forEach((i) => {
    const dirty = isDirty(i);
    i.closest('.param-row').classList.toggle('param-dirty', dirty);
    if (dirty) n++;
  });
  if (el.paramsDirty) el.paramsDirty.textContent = n ? t('params.dirtyCount', { n }) : '';
  if (el.btnParamsSave) el.btnParamsSave.disabled = n === 0;
}

export async function loadAppConfig() {
  if (!el.paramsBody) return;
  el.paramsBody.innerHTML = `<p class="param-loading">${escHtml(t('params.loading'))}</p>`;
  try {
    const r = await api('/api/app-config');
    render(r.groups || []);
  } catch (e) {
    el.paramsBody.innerHTML = `<p class="param-loading">${escHtml(t('params.loadFail') + (e.message || e))}</p>`;
  }
}

async function save() {
  const inputs = el.paramsBody.querySelectorAll('.param-input');
  const values = {};
  for (const i of inputs) {
    if (!isDirty(i)) continue;
    if (i.dataset.type === 'number' && i.value.trim() === '') {
      showAlert(t('params.saveFail'), t('params.emptyField', { key: i.dataset.key }));
      return;
    }
    values[i.dataset.key] = i.dataset.type === 'bool' ? i.checked : i.value.trim();
  }
  if (!Object.keys(values).length) return;

  el.btnParamsSave.disabled = true;
  try {
    const r = await api('/api/app-config', 'POST', { values });
    const n = (r.changed || []).length;
    showAlert(t('params.saved', { n }), t('params.savedBody'));
    await loadAppConfig(); // refresh originals from the persisted file
  } catch (e) {
    showAlert(t('params.saveFail'), escHtml(e.message || String(e)));
    el.btnParamsSave.disabled = false;
  }
}

export function initAppConfig() {
  if (el.paramsBody) {
    el.paramsBody.addEventListener('input', (e) => {
      if (e.target.classList.contains('param-input')) updateDirtyState();
    });
    el.paramsBody.addEventListener('change', (e) => {
      if (e.target.classList.contains('param-input')) updateDirtyState();
    });
  }
  if (el.btnParamsSave) el.btnParamsSave.addEventListener('click', save);
}
