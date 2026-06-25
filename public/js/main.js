import { el } from './dom.js';
import { S, PAGE_SIZE } from './store.js';
import { api } from './api.js';
import { showToast, showAlert } from './toast.js';
import { showView } from './views.js';
import { loadActive, loadPast, loadDetail, loadVfData, loadMtData, loadEquasisData, loadGfwData } from './ships.js';
import { loadTrack } from './maps.js';
import { loadTraffco } from './traffico.js';
import { initBerths, loadBerths } from './berths.js';
import { initReplay } from './replay.js';
import { initWebhooks } from './webhooks.js';
import { initAppConfig, loadAppConfig } from './app-config.js';
import { initLogPanel, openLogs, closeLogs } from './logs.js';
import { initAppLog, openSettingsLog, closeSettingsLog, setAppLogToggle } from './app-log.js';
import { openHealth, closeHealth } from './health.js';
import { initAreas } from './areas.js';
import { applyOpenSeaMap } from './tiles.js';
import { renderSeamarkBerths, SEAMARK_CATEGORIES } from './seamarks.js';
import { initNotifications, loadNotifications } from './notifications.js';
import { initOutageBanner, setOutage } from './outage.js';
import { initTheme } from './theme.js';
import { escHtml, cargoClassLabel } from './helpers.js';
import { t, getLang, setLang, LANG_NAMES, applyToDOM } from './i18n.js';
import './search.js'; // self-wiring: ship search ("Cerca e segui una nave")

// ── Stream status ────────────────────────────────────────────────────────────
async function updateStatus() {
  try {
    const s = await api('/api/stream/status');
    S.allStreamStatus = s.streams || {};
    const areaStatus = S.allStreamStatus[S.currentPreset] || { active: false };
    S.streamActive = areaStatus.active;
    el.badge.textContent = S.streamActive ? t('status.active') : t('status.inactive');
    el.badge.className = 'badge ' + (S.streamActive ? 'active' : 'inactive');
    el.btnStart.disabled = S.streamActive;
    el.btnStop.disabled = !S.streamActive;
    el.counter.textContent = t('sidebar.readings', { n: s.dbCount.toLocaleString() });
    updateAreaDropdownStatus(S.allStreamStatus);
    syncAreaMonitors();
    setOutage(s.outage);
  } catch {
    /* ignore */
  }
}

function updateAreaDropdownStatus(streamStatus) {
  for (const option of el.bboxSelect.options) {
    const active = streamStatus[option.value]?.active;
    const name = option.dataset.name || option.value;
    option.textContent = active ? `🟢 ${name} — ${t('area.active')}` : `⚪ ${name} — ${t('area.inactive')}`;
  }
}

// ── Per-area monitor toggles (Settings) ──────────────────────────────────────
// Build one toggle row per area; the checkbox starts/stops that area's stream.
function renderAreaMonitors() {
  if (!el.areaMonitors) return;
  el.areaMonitors.innerHTML = Object.entries(S.presets)
    .map(([key, v]) => {
      const active = S.allStreamStatus[key]?.active;
      const dot = active ? '🟢' : '⚪';
      return `<div class="area-monitor">
        <span class="area-monitor-name">${dot} ${v.name}</span>
        <label class="toggle">
          <input type="checkbox" data-area="${key}"${active ? ' checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>`;
    })
    .join('');
}

// Keep the rendered toggles in sync with live status without rebuilding (avoids
// clobbering a mid-click checkbox). Re-render only if the area set changed.
function syncAreaMonitors() {
  if (!el.areaMonitors) return;
  const rows = el.areaMonitors.querySelectorAll('.area-monitor input[data-area]');
  if (rows.length !== Object.keys(S.presets).length) return renderAreaMonitors();
  for (const input of rows) {
    const active = !!S.allStreamStatus[input.dataset.area]?.active;
    input.checked = active;
    const nameEl = input.closest('.area-monitor').querySelector('.area-monitor-name');
    const name = S.presets[input.dataset.area]?.name || input.dataset.area;
    nameEl.textContent = `${active ? '🟢' : '⚪'} ${name}`;
  }
}

// ── Title ──────────────────────────────────────────────────────────────────────
function setTitle(bboxName) {
  const title = bboxName ? `${t('app.title')} - ${bboxName}` : t('app.title');
  if (el.appTitle) el.appTitle.textContent = title;
  document.title = title;
}

// ── Settings ─────────────────────────────────────────────────────────────────
// Rebuild the OpenSeaMap category checkboxes from S.openSeaMapHidden. Each box
// toggles its category in the hidden set, redraws the markers immediately and
// persists the set (reverting on failure). Module-scoped so both loadSettings
// (initial render) and the change handlers can call it.
function renderSeamarkTypeToggles() {
  const box = el.openSeaMapTypes;
  if (!box) return;
  const hidden = new Set(S.openSeaMapHidden || []);
  box.innerHTML = SEAMARK_CATEGORIES.map(
    (c) =>
      `<label class="seamark-type-opt">` +
      `<input type="checkbox" data-cat="${c.key}"${hidden.has(c.key) ? '' : ' checked'}>` +
      `<span class="seamark-type-dot" style="background:${c.color}"></span>` +
      `<span>${escHtml(t('seamark.cat.' + c.key))}</span>` +
      `</label>`
  ).join('');
  box.querySelectorAll('input[data-cat]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const prev = S.openSeaMapHidden;
      const set = new Set(prev || []);
      if (cb.checked) set.delete(cb.dataset.cat);
      else set.add(cb.dataset.cat);
      const arr = [...set];
      S.openSeaMapHidden = arr;
      renderSeamarkBerths();
      try {
        await api('/api/settings', 'POST', { openSeaMapHidden: arr });
      } catch {
        S.openSeaMapHidden = prev;
        cb.checked = !cb.checked;
        renderSeamarkBerths();
      }
    });
  });
}

async function loadSettings() {
  try {
    const s = await api('/api/settings');
    S.presets = s.presets || {};
    el.bboxSelect.innerHTML = Object.entries(s.presets)
      .map(([k, v]) => `<option value="${k}" data-name="${v.name}"${k === s.preset ? ' selected' : ''}>${v.name}</option>`)
      .join('');
    renderAreaMonitors();
    S.currentPreset = s.preset;
    const active = s.presets[s.preset];
    if (active) {
      S.currentBbox = active.bbox;
      setTitle(active.name);
    }
    S.importVfData = !!s.importVfData;
    S.importMtData = !!s.importMtData;
    S.importSanctions = !!s.importSanctions;
    S.importSanctionsExtra = s.importSanctionsExtra !== false;
    if (el.toggleImportVf) el.toggleImportVf.checked = S.importVfData;
    if (el.toggleImportMt) el.toggleImportMt.checked = S.importMtData;
    if (el.toggleImportSanctions) el.toggleImportSanctions.checked = S.importSanctions;
    if (el.toggleImportSanctionsExtra) el.toggleImportSanctionsExtra.checked = S.importSanctionsExtra;
    applySanctionsSettingsState();
    renderSanctionsStatus(s.sanctions);
    S.importPsc = !!s.importPsc;
    if (el.toggleImportPsc) el.toggleImportPsc.checked = S.importPsc;
    renderPscStatus(s.psc);
    S.importEquasis = !!s.importEquasis;
    S.equasisConfigured = !!s.equasisConfigured;
    if (el.toggleImportEquasis) el.toggleImportEquasis.checked = S.importEquasis;
    S.importGfw = s.importGfw !== false;
    S.gfwConfigured = !!s.gfwConfigured;
    if (el.toggleImportGfw) el.toggleImportGfw.checked = S.importGfw;
    renderGfwStatus();
    S.appLogEnabled = s.appLogEnabled !== false;
    setAppLogToggle(S.appLogEnabled);
    S.notificationsEnabled = s.notificationsEnabled !== false;
    S.notifyRevisit = s.notifyRevisit !== false;
    S.notifyAreaChange = s.notifyAreaChange !== false;
    S.notifyHighRisk = s.notifyHighRisk !== false;
    S.notifyBerthNew = s.notifyBerthNew !== false;
    S.notifyBerthChar = s.notifyBerthChar !== false;
    S.notifyProximity = s.notifyProximity !== false;
    if (el.toggleNotifications) el.toggleNotifications.checked = S.notificationsEnabled;
    if (el.toggleNotifyRevisit) el.toggleNotifyRevisit.checked = S.notifyRevisit;
    if (el.toggleNotifyAreaChange) el.toggleNotifyAreaChange.checked = S.notifyAreaChange;
    if (el.toggleNotifyHighRisk) el.toggleNotifyHighRisk.checked = S.notifyHighRisk;
    if (el.toggleNotifyBerthNew) el.toggleNotifyBerthNew.checked = S.notifyBerthNew;
    if (el.toggleNotifyBerthChar) el.toggleNotifyBerthChar.checked = S.notifyBerthChar;
    if (el.toggleNotifyProximity) el.toggleNotifyProximity.checked = S.notifyProximity;
    S.excludeTankers = !!s.excludeTankers;
    if (el.toggleExcludeTankers) el.toggleExcludeTankers.checked = S.excludeTankers;
    S.checkSpoofing = s.checkSpoofing !== false;
    S.checkDarkActivity = s.checkDarkActivity !== false;
    if (el.toggleCheckSpoofing) el.toggleCheckSpoofing.checked = S.checkSpoofing;
    if (el.toggleCheckDark) el.toggleCheckDark.checked = S.checkDarkActivity;
    S.showOpenSeaMap = s.showOpenSeaMap !== false;
    if (el.toggleOpenSeaMap) el.toggleOpenSeaMap.checked = S.showOpenSeaMap;
    S.showOpenSeaMapMarkers = s.showOpenSeaMapMarkers !== false;
    if (el.toggleOpenSeaMapMarkers) el.toggleOpenSeaMapMarkers.checked = S.showOpenSeaMapMarkers;
    S.openSeaMapHidden = Array.isArray(s.openSeaMapHidden) ? s.openSeaMapHidden : [];
    renderSeamarkTypeToggles();
    applyOpenSeaMap(); // sync any maps already created before settings loaded
    if (s.cargoClasses) S.cargoClasses = s.cargoClasses;
    if (s.defaultCargoWeights) S.defaultCargoWeights = s.defaultCargoWeights;
    if (s.cargoWeights) S.cargoWeights = s.cargoWeights;
    if (s.cargoPresets) S.cargoPresets = s.cargoPresets;
    S.cargoWeightsPreset = s.cargoWeightsPreset || null;
    renderCargoWeights();
    renderCargoPresets();
    if (s.riskWeightKeys) S.riskWeightKeys = s.riskWeightKeys;
    if (s.defaultRiskWeights) S.defaultRiskWeights = s.defaultRiskWeights;
    if (s.riskWeights) S.riskWeights = s.riskWeights;
    if (s.riskPresets) S.riskPresets = s.riskPresets;
    S.riskWeightsPreset = s.riskWeightsPreset || null;
    renderRiskWeights();
    renderRiskPresets();
    applyNotifSettingsState();
  } catch {
    /* ignore */
  }
}

// ── Telegram bot settings ────────────────────────────────────────────────────
// Per-category toggle wiring: DOM element key → API field name.
const TELEGRAM_TOGGLES = [
  ['toggleTelegramHighRisk', 'telegramNotifyHighRisk'],
  ['toggleTelegramRevisit', 'telegramNotifyRevisit'],
  ['toggleTelegramAreaChange', 'telegramNotifyAreaChange'],
  ['toggleTelegramBerthNew', 'telegramNotifyBerthNew'],
  ['toggleTelegramBerthChar', 'telegramNotifyBerthChar'],
  ['toggleTelegramProximity', 'telegramNotifyProximity'],
  ['toggleTelegramOutage', 'telegramNotifyOutage'],
  ['toggleTelegramAreaMonitor', 'telegramNotifyAreaMonitor'],
  ['toggleTelegramSendMap', 'telegramSendMap'],
];
let telegramLinkPoll = null;

// Reflect S.telegram in the UI: configured/linked status, button visibility,
// and the enabled/disabled state of the per-category toggles (gated by master).
function applyTelegramState() {
  const tg = S.telegram || {};
  const configured = !!tg.configured;
  const linked = !!tg.linked;
  const master = !!tg.telegramEnabled;
  if (el.toggleTelegram) {
    el.toggleTelegram.checked = master;
    el.toggleTelegram.disabled = !configured;
  }
  // Show the link sub-row only when the bot is configured server-side.
  if (el.settingTelegramLink) el.settingTelegramLink.style.display = configured ? '' : 'none';
  // Status text.
  if (el.telegramStatus) {
    const key = !configured ? 'settings.telegram.status.notConfigured'
      : linked ? 'settings.telegram.status.linked'
        : 'settings.telegram.status.unlinked';
    el.telegramStatus.textContent = t(key);
  }
  if (el.btnTelegramLink) el.btnTelegramLink.hidden = !configured || linked;
  if (el.btnTelegramUnlink) el.btnTelegramUnlink.hidden = !configured || !linked;
  if (el.btnTelegramTest) el.btnTelegramTest.hidden = !configured || !linked;
  if (el.telegramCodeBox && (!configured || linked)) { el.telegramCodeBox.hidden = true; }
  // Per-category toggles: visible when configured, enabled only when master on.
  for (const [elKey, apiKey] of TELEGRAM_TOGGLES) {
    const input = el[elKey];
    const rowKey = 'setting' + elKey.slice('toggle'.length); // toggleTelegramX → settingTelegramX
    const row = el[rowKey];
    if (row) row.style.display = configured ? '' : 'none';
    if (input) {
      input.checked = tg[apiKey] !== false;
      input.disabled = !configured || !master;
    }
  }
}

async function loadTelegram() {
  if (!el.toggleTelegram) return;
  try {
    const s = await api('/api/telegram');
    S.telegram = s;
    applyTelegramState();
  } catch {
    /* ignore */
  }
}

// After the user generates a link code we don't get a push when they hit
// /start, so poll the link state a few times to flip the UI to "linked".
function startTelegramLinkPoll() {
  stopTelegramLinkPoll();
  let tries = 0;
  telegramLinkPoll = setInterval(async () => {
    tries++;
    try {
      const s = await api('/api/telegram');
      S.telegram = s;
      if (s.linked || tries > 40) { // ~2 min at 3s
        stopTelegramLinkPoll();
        applyTelegramState();
      }
    } catch { /* keep trying */ }
  }, 3000);
}
function stopTelegramLinkPoll() {
  if (telegramLinkPoll) { clearInterval(telegramLinkPoll); telegramLinkPoll = null; }
}

// Build the per-cargo-type weight editor: one number input per class, ordered
// as the server lists them. Non-cargo / unknown classes are shown too (weight
// usually 0) so the operator sees the full set. `values` overrides the stored
// weights (used by the reset button to preview defaults before saving).
function renderCargoWeights(values) {
  if (!el.cargoWeightsGrid || !S.cargoClasses) return;
  const w = values || S.cargoWeights || {};
  el.cargoWeightsGrid.innerHTML = S.cargoClasses
    .map(
      (cls) => `
      <label class="cargo-weight-item">
        <span class="cargo-weight-label">${escHtml(cargoClassLabel(cls))}</span>
        <input type="number" min="0" step="1" class="cargo-weight-input" data-class="${cls}" value="${w[cls] != null ? w[cls] : 0}">
      </label>`
    )
    .join('');
}

// Translated display name for a preset. Built-ins (id default/arms_transport)
// get a localized label; user presets keep their stored name.
function cargoPresetLabel(p) {
  if (p.builtin) {
    const key = 'settings.cargoPresets.builtin.' + p.id;
    const tr = t(key);
    if (tr && tr !== key) return tr;
  }
  return p.name;
}

// Build the preset dropdown: built-ins first, then user presets, plus a
// "(personalizzato)" entry shown only when the live weights match no preset.
function renderCargoPresets() {
  if (!el.cargoPresetSelect || !S.cargoPresets) return;
  const active = S.cargoWeightsPreset;
  const opts = S.cargoPresets
    .map((p) => `<option value="${escHtml(p.id)}"${p.id === active ? ' selected' : ''}>${escHtml(cargoPresetLabel(p))}${p.builtin ? '' : ' ★'}</option>`)
    .join('');
  const customSel = active ? '' : ' selected';
  el.cargoPresetSelect.innerHTML =
    `<option value=""${customSel}>${escHtml(t('settings.cargoPresets.custom'))}</option>` + opts;
  // Only user presets can be deleted.
  const sel = S.cargoPresets.find((p) => p.id === active);
  if (el.btnCargoPresetDelete) el.btnCargoPresetDelete.disabled = !sel || sel.builtin;
}

// Collect the grid into a { class: weight } map.
function collectCargoWeights() {
  const map = {};
  el.cargoWeightsGrid.querySelectorAll('.cargo-weight-input').forEach((inp) => {
    const v = Number(inp.value);
    if (Number.isFinite(v) && v >= 0) map[inp.dataset.class] = v;
  });
  return map;
}

// ── Risk-signal weights (mirrors the cargo-weights helpers) ──────────────────
const riskWeightLabel = (key) => {
  const k = 'risk.weight.' + key;
  const tr = t(k);
  return tr && tr !== k ? tr : key;
};

function renderRiskWeights(values) {
  if (!el.riskWeightsGrid || !S.riskWeightKeys) return;
  const w = values || S.riskWeights || {};
  el.riskWeightsGrid.innerHTML = S.riskWeightKeys
    .map(
      (key) => `
      <label class="cargo-weight-item">
        <span class="cargo-weight-label">${escHtml(riskWeightLabel(key))}</span>
        <input type="number" min="0" step="1" class="risk-weight-input" data-key="${key}" value="${w[key] != null ? w[key] : 0}">
      </label>`
    )
    .join('');
}

function riskPresetLabel(p) {
  if (p.builtin) {
    const key = 'settings.riskPresets.builtin.' + p.id;
    const tr = t(key);
    if (tr && tr !== key) return tr;
  }
  return p.name;
}

function renderRiskPresets() {
  if (!el.riskPresetSelect || !S.riskPresets) return;
  const active = S.riskWeightsPreset;
  const opts = S.riskPresets
    .map((p) => `<option value="${escHtml(p.id)}"${p.id === active ? ' selected' : ''}>${escHtml(riskPresetLabel(p))}${p.builtin ? '' : ' ★'}</option>`)
    .join('');
  const customSel = active ? '' : ' selected';
  el.riskPresetSelect.innerHTML =
    `<option value=""${customSel}>${escHtml(t('settings.cargoPresets.custom'))}</option>` + opts;
  const sel = S.riskPresets.find((p) => p.id === active);
  if (el.btnRiskPresetDelete) el.btnRiskPresetDelete.disabled = !sel || sel.builtin;
}

// Collect the grid into a { KEY: weight } map.
function collectRiskWeights() {
  const map = {};
  el.riskWeightsGrid.querySelectorAll('.risk-weight-input').forEach((inp) => {
    const v = Number(inp.value);
    if (Number.isFinite(v) && v >= 0) map[inp.dataset.key] = v;
  });
  return map;
}

// Dim/disable the notification sub-toggles when the master switch is off.
function applyNotifSettingsState() {
  if (el.toggleNotifyRevisit) el.toggleNotifyRevisit.disabled = !S.notificationsEnabled;
  if (el.settingNotifyRevisit) el.settingNotifyRevisit.classList.toggle('disabled', !S.notificationsEnabled);
  if (el.toggleNotifyAreaChange) el.toggleNotifyAreaChange.disabled = !S.notificationsEnabled;
  if (el.settingNotifyAreaChange) el.settingNotifyAreaChange.classList.toggle('disabled', !S.notificationsEnabled);
  if (el.toggleNotifyHighRisk) el.toggleNotifyHighRisk.disabled = !S.notificationsEnabled;
  if (el.settingNotifyHighRisk) el.settingNotifyHighRisk.classList.toggle('disabled', !S.notificationsEnabled);
  if (el.toggleNotifyBerthNew) el.toggleNotifyBerthNew.disabled = !S.notificationsEnabled;
  if (el.settingNotifyBerthNew) el.settingNotifyBerthNew.classList.toggle('disabled', !S.notificationsEnabled);
  if (el.toggleNotifyBerthChar) el.toggleNotifyBerthChar.disabled = !S.notificationsEnabled;
  if (el.settingNotifyBerthChar) el.settingNotifyBerthChar.classList.toggle('disabled', !S.notificationsEnabled);
  if (el.toggleNotifyProximity) el.toggleNotifyProximity.disabled = !S.notificationsEnabled;
  if (el.settingNotifyProximity) el.settingNotifyProximity.classList.toggle('disabled', !S.notificationsEnabled);
}

// Dim/disable the extra-lists sub-toggle when the master sanctions switch is off.
function applySanctionsSettingsState() {
  if (el.toggleImportSanctionsExtra) el.toggleImportSanctionsExtra.disabled = !S.importSanctions;
  if (el.settingSanctionsExtra) el.settingSanctionsExtra.classList.toggle('disabled', !S.importSanctions);
}

// Show the sanctions dataset status (loaded vessel count + last refresh). With
// the extra lists on, lists a per-source breakdown (OFAC / EU / UK / UN).
function renderSanctionsStatus(st) {
  if (!el.sanctionsStatus) return;
  if (!S.importSanctions) { el.sanctionsStatus.textContent = ''; return; }
  if (!st || !st.loaded) {
    el.sanctionsStatus.textContent = t('settings.sanctions.notLoaded');
    return;
  }
  const when = st.lastRefreshed ? new Date(st.lastRefreshed).toLocaleString() : '—';
  let text = t('settings.sanctions.loaded')
    .replace('{n}', st.vesselCount)
    .replace('{date}', when);
  if (Array.isArray(st.sources) && st.sources.length > 1) {
    text += ' · ' + st.sources.map((s) => `${s.label}: ${s.vesselCount}`).join(' · ');
  }
  el.sanctionsStatus.textContent = text;
}

// Show the PSC (Paris/Tokyo MoU) dataset status: flag-list counts + banned count.
function renderPscStatus(st) {
  if (!el.pscStatus) return;
  if (!S.importPsc) { el.pscStatus.textContent = ''; return; }
  if (!st || !st.loaded) {
    el.pscStatus.textContent = t('settings.psc.notLoaded');
    return;
  }
  const c = st.flagCounts || { black: 0, grey: 0, white: 0 };
  const when = st.bannedRefreshed ? new Date(st.bannedRefreshed).toLocaleString() : '—';
  el.pscStatus.textContent = t('settings.psc.loaded')
    .replace('{black}', c.black)
    .replace('{grey}', c.grey)
    .replace('{white}', c.white)
    .replace('{banned}', st.bannedCount || 0)
    .replace('{date}', when);
}

// GFW substatus: warn when the import is on but no API token is configured (the
// enrichment silently no-ops in that case).
function renderGfwStatus() {
  if (!el.gfwStatus) return;
  el.gfwStatus.textContent = S.importGfw && !S.gfwConfigured ? t('settings.gfw.noToken') : '';
}

// Upload a user-selected file to an import endpoint, showing a busy label on the
// triggering button. Runs onDone(responseData) on success.
async function runImport({ file, url, contentType, btn, busyLabel, onDone }) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    // Send raw bytes, never file.text(): decoding the bundle as UTF-8 corrupts
    // the binary v2 container (raw SQLite bytes >127 become U+FFFD), so the
    // restored DB is unreadable. arrayBuffer() preserves bytes for both the
    // binary bundle and the JSON area/settings imports.
    const body = await file.arrayBuffer();
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': contentType }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await onDone(data);
  } catch (e) {
    alert(t('toast.importFail') + (e.message || String(e)));
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// Show the Equasis lookup audit log in the generic modal, with a Clear button.
async function showEquasisLog() {
  try {
    const r = await api('/api/equasis-log');
    const body = (r && r.text && r.text.trim())
      ? `${r.truncated ? `<p class="vf-empty">${t('equasis.log.truncated')}</p>` : ''}<pre>${escHtml(r.text)}</pre>`
      : `<p class="vf-empty">${t('equasis.log.empty')}</p>`;
    el.modalTitle.textContent = t('equasis.log.title');
    el.modalBody.innerHTML = `
      <div style="text-align:right;margin-bottom:0.5rem">
        <button id="btn-equasis-log-clear" class="btn btn-clear">${escHtml(t('equasis.log.clear'))}</button>
      </div>
      ${body}`;
    const clearBtn = document.getElementById('btn-equasis-log-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        await api('/api/equasis-log', 'DELETE');
        showEquasisLog();
      });
    }
    el.modalOverlay.classList.remove('hidden');
  } catch {
    showToast(t('scrape.error'));
  }
}

// Show one settings panel and start/stop the live feeds tied to each tab.
// Only one feed runs at a time — the one whose tab is currently visible.
function activateSettingsPanel(panel) {
  const target = `settings-panel-${panel}`;
  el.settingsPanels.forEach((p) => p.classList.toggle('hidden', p.id !== target));
  if (panel === 'backup') loadAutoBackups();
  if (panel === 'params') loadAppConfig();
  if (panel === 'telegram') loadTelegram(); else stopTelegramLinkPoll();
  if (panel === 'log') openSettingsLog(); else closeSettingsLog();
  if (panel === 'logs') openLogs(); else closeLogs();
  if (panel === 'health') openHealth(); else closeHealth();
}

// Stop every live feed when leaving Settings.
function stopSettingsFeeds() {
  closeSettingsLog();
  closeLogs();
  closeHealth();
  stopTelegramLinkPoll();
}

function initSettingsModal() {
  el.btnSettings.addEventListener('click', () => {
    if (S.view !== 'settings') S.settingsFrom = S.view;
    showView('settings');
    // Resume the live feed of whichever tab the user had left active.
    const active = el.settingsTabs.querySelector('.tab.tab-active');
    if (active) activateSettingsPanel(active.dataset.panel);
  });
  el.btnSettingsBack.addEventListener('click', () => {
    stopSettingsFeeds();
    showView(S.settingsFrom || 'active');
  });

  // Settings tabs — switch between the panels
  // (general / areas / params / backup / log / logs / health).
  el.settingsTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    el.settingsTabs.querySelectorAll('.tab').forEach((b) => b.classList.remove('tab-active'));
    tab.classList.add('tab-active');
    activateSettingsPanel(tab.dataset.panel);
  });

  // Per-area monitor toggles — start/stop a stream without leaving Settings.
  el.areaMonitors.addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-area]');
    if (!input) return;
    const area = input.dataset.area;
    const turnOn = input.checked;
    input.disabled = true;
    try {
      await api(turnOn ? '/api/stream/start' : '/api/stream/stop', 'POST', { area });
      await updateStatus();
      // If we toggled the area currently in view, refresh its data immediately.
      if (area === S.currentPreset) tick();
    } catch (err) {
      input.checked = !turnOn; // revert on failure
      alert(t('error.changeArea') + (err.message || err));
    } finally {
      input.disabled = false;
    }
  });

  el.toggleImportVf.addEventListener('change', async () => {
    const enabled = el.toggleImportVf.checked;
    try {
      await api('/api/settings', 'POST', { importVfData: enabled });
      S.importVfData = enabled;
      if (S.view === 'detail' && S.detailMmsi != null) loadVfData(S.detailMmsi);
    } catch {
      el.toggleImportVf.checked = !enabled;
    }
  });

  el.toggleImportMt.addEventListener('change', async () => {
    const enabled = el.toggleImportMt.checked;
    try {
      await api('/api/settings', 'POST', { importMtData: enabled });
      S.importMtData = enabled;
      if (S.view === 'detail' && S.detailMmsi != null) loadMtData(S.detailMmsi);
    } catch {
      el.toggleImportMt.checked = !enabled;
    }
  });

  if (el.toggleImportEquasis) {
    el.toggleImportEquasis.addEventListener('change', async () => {
      const enabled = el.toggleImportEquasis.checked;
      try {
        await api('/api/settings', 'POST', { importEquasis: enabled });
        S.importEquasis = enabled;
        if (S.view === 'detail' && S.detailMmsi != null) loadEquasisData(S.detailMmsi, false);
      } catch {
        el.toggleImportEquasis.checked = !enabled;
      }
    });
  }

  if (el.toggleImportGfw) {
    el.toggleImportGfw.addEventListener('change', async () => {
      const enabled = el.toggleImportGfw.checked;
      try {
        await api('/api/settings', 'POST', { importGfw: enabled });
        S.importGfw = enabled;
        renderGfwStatus();
        if (S.view === 'detail' && S.detailMmsi != null) loadGfwData(S.detailMmsi);
      } catch {
        el.toggleImportGfw.checked = !enabled;
      }
    });
  }

  if (el.btnEquasisFetch) {
    el.btnEquasisFetch.addEventListener('click', () => {
      if (S.detailMmsi != null) loadEquasisData(S.detailMmsi, true);
    });
  }

  if (el.btnEquasisLog) {
    el.btnEquasisLog.addEventListener('click', showEquasisLog);
  }

  if (el.toggleImportSanctions) {
    el.toggleImportSanctions.addEventListener('change', async () => {
      const enabled = el.toggleImportSanctions.checked;
      try {
        const r = await api('/api/settings', 'POST', { importSanctions: enabled });
        S.importSanctions = enabled;
        applySanctionsSettingsState();
        renderSanctionsStatus(r && r.sanctions);
        if (enabled) showAlert(t('settings.sanctions.downloading'), '');
      } catch {
        el.toggleImportSanctions.checked = !enabled;
      }
    });
  }

  if (el.toggleImportSanctionsExtra) {
    el.toggleImportSanctionsExtra.addEventListener('change', async () => {
      const enabled = el.toggleImportSanctionsExtra.checked;
      try {
        const r = await api('/api/settings', 'POST', { importSanctionsExtra: enabled });
        S.importSanctionsExtra = enabled;
        renderSanctionsStatus(r && r.sanctions);
        if (enabled && S.importSanctions) showAlert(t('settings.sanctions.downloading'), '');
      } catch {
        el.toggleImportSanctionsExtra.checked = !enabled;
      }
    });
  }

  if (el.btnSanctionsRefresh) {
    el.btnSanctionsRefresh.addEventListener('click', async () => {
      el.btnSanctionsRefresh.disabled = true;
      try {
        const r = await api('/api/sanctions/refresh', 'POST');
        renderSanctionsStatus(r && r.sanctions);
        showAlert(t('settings.sanctions.downloading'), '');
      } catch (err) {
        showAlert(t('settings.sanctions.refreshFail'), escHtml(err.message || String(err)));
      } finally {
        el.btnSanctionsRefresh.disabled = false;
      }
    });
  }

  if (el.toggleImportPsc) {
    el.toggleImportPsc.addEventListener('change', async () => {
      const enabled = el.toggleImportPsc.checked;
      try {
        const r = await api('/api/settings', 'POST', { importPsc: enabled });
        S.importPsc = enabled;
        renderPscStatus(r && r.psc);
        if (enabled) showAlert(t('settings.psc.downloading'), '');
      } catch {
        el.toggleImportPsc.checked = !enabled;
      }
    });
  }

  if (el.btnPscRefresh) {
    el.btnPscRefresh.addEventListener('click', async () => {
      el.btnPscRefresh.disabled = true;
      try {
        const r = await api('/api/psc/refresh', 'POST');
        renderPscStatus(r && r.psc);
        showAlert(t('settings.psc.downloading'), '');
      } catch (err) {
        showAlert(t('settings.psc.refreshFail'), escHtml(err.message || String(err)));
      } finally {
        el.btnPscRefresh.disabled = false;
      }
    });
  }

  el.toggleNotifications.addEventListener('change', async () => {
    const enabled = el.toggleNotifications.checked;
    try {
      await api('/api/settings', 'POST', { notificationsEnabled: enabled });
      S.notificationsEnabled = enabled;
      applyNotifSettingsState();
    } catch {
      el.toggleNotifications.checked = !enabled;
    }
  });

  el.toggleNotifyRevisit.addEventListener('change', async () => {
    const enabled = el.toggleNotifyRevisit.checked;
    try {
      await api('/api/settings', 'POST', { notifyRevisit: enabled });
      S.notifyRevisit = enabled;
    } catch {
      el.toggleNotifyRevisit.checked = !enabled;
    }
  });

  el.toggleNotifyAreaChange.addEventListener('change', async () => {
    const enabled = el.toggleNotifyAreaChange.checked;
    try {
      await api('/api/settings', 'POST', { notifyAreaChange: enabled });
      S.notifyAreaChange = enabled;
    } catch {
      el.toggleNotifyAreaChange.checked = !enabled;
    }
  });

  el.toggleNotifyHighRisk.addEventListener('change', async () => {
    const enabled = el.toggleNotifyHighRisk.checked;
    try {
      await api('/api/settings', 'POST', { notifyHighRisk: enabled });
      S.notifyHighRisk = enabled;
    } catch {
      el.toggleNotifyHighRisk.checked = !enabled;
    }
  });

  el.toggleNotifyBerthNew.addEventListener('change', async () => {
    const enabled = el.toggleNotifyBerthNew.checked;
    try {
      await api('/api/settings', 'POST', { notifyBerthNew: enabled });
      S.notifyBerthNew = enabled;
    } catch {
      el.toggleNotifyBerthNew.checked = !enabled;
    }
  });

  el.toggleNotifyBerthChar.addEventListener('change', async () => {
    const enabled = el.toggleNotifyBerthChar.checked;
    try {
      await api('/api/settings', 'POST', { notifyBerthChar: enabled });
      S.notifyBerthChar = enabled;
    } catch {
      el.toggleNotifyBerthChar.checked = !enabled;
    }
  });

  if (el.toggleNotifyProximity) el.toggleNotifyProximity.addEventListener('change', async () => {
    const enabled = el.toggleNotifyProximity.checked;
    try {
      await api('/api/settings', 'POST', { notifyProximity: enabled });
      S.notifyProximity = enabled;
    } catch {
      el.toggleNotifyProximity.checked = !enabled;
    }
  });

  // ── Telegram bot ──
  if (el.toggleTelegram) {
    el.toggleTelegram.addEventListener('change', async () => {
      const enabled = el.toggleTelegram.checked;
      try {
        const s = await api('/api/telegram/settings', 'POST', { telegramEnabled: enabled });
        S.telegram = s;
        applyTelegramState();
      } catch {
        el.toggleTelegram.checked = !enabled;
      }
    });
  }
  for (const [elKey, apiKey] of TELEGRAM_TOGGLES) {
    const input = el[elKey];
    if (!input) continue;
    input.addEventListener('change', async () => {
      const enabled = input.checked;
      try {
        const s = await api('/api/telegram/settings', 'POST', { [apiKey]: enabled });
        S.telegram = s;
      } catch {
        input.checked = !enabled;
      }
    });
  }
  if (el.btnTelegramLink) {
    el.btnTelegramLink.addEventListener('click', async () => {
      el.btnTelegramLink.disabled = true;
      try {
        const r = await api('/api/telegram/link', 'POST');
        if (el.telegramCodeBox) {
          const link = r.deepLink
            ? `<a href="${r.deepLink}" target="_blank" rel="noopener">${r.deepLink}</a>`
            : `<code>/start ${r.code}</code>`;
          el.telegramCodeBox.innerHTML = `${t('settings.telegram.code.intro')}<br>${link}<br><span class="muted">${t('settings.telegram.code.hint')}</span>`;
          el.telegramCodeBox.hidden = false;
        }
        startTelegramLinkPoll();
      } catch (e) {
        alert((e && e.message) || 'Errore');
      } finally {
        el.btnTelegramLink.disabled = false;
      }
    });
  }
  if (el.btnTelegramUnlink) {
    el.btnTelegramUnlink.addEventListener('click', async () => {
      if (!confirm(t('settings.telegram.unlink.confirm'))) return;
      try {
        const s = await api('/api/telegram/unlink', 'POST');
        S.telegram = s;
        stopTelegramLinkPoll();
        if (el.telegramCodeBox) el.telegramCodeBox.hidden = true;
        applyTelegramState();
      } catch (e) {
        alert((e && e.message) || 'Errore');
      }
    });
  }
  if (el.btnTelegramTest) {
    el.btnTelegramTest.addEventListener('click', async () => {
      el.btnTelegramTest.disabled = true;
      try {
        await api('/api/telegram/test', 'POST');
        alert(t('settings.telegram.test.sent'));
      } catch (e) {
        alert((e && e.message) || 'Errore');
      } finally {
        el.btnTelegramTest.disabled = false;
      }
    });
  }

  if (el.toggleExcludeTankers) {
    el.toggleExcludeTankers.addEventListener('change', async () => {
      const enabled = el.toggleExcludeTankers.checked;
      try {
        await api('/api/settings', 'POST', { excludeTankers: enabled });
        S.excludeTankers = enabled;
      } catch {
        el.toggleExcludeTankers.checked = !enabled;
      }
    });
  }

  if (el.toggleCheckSpoofing) {
    el.toggleCheckSpoofing.addEventListener('change', async () => {
      const enabled = el.toggleCheckSpoofing.checked;
      try {
        await api('/api/settings', 'POST', { checkSpoofing: enabled });
        S.checkSpoofing = enabled;
      } catch {
        el.toggleCheckSpoofing.checked = !enabled;
      }
    });
  }

  if (el.toggleOpenSeaMap) {
    el.toggleOpenSeaMap.addEventListener('change', async () => {
      const enabled = el.toggleOpenSeaMap.checked;
      try {
        await api('/api/settings', 'POST', { showOpenSeaMap: enabled });
        S.showOpenSeaMap = enabled;
        applyOpenSeaMap(); // seamark tile raster on every map (add/remove live)
      } catch {
        el.toggleOpenSeaMap.checked = !enabled;
      }
    });
  }

  if (el.toggleOpenSeaMapMarkers) {
    el.toggleOpenSeaMapMarkers.addEventListener('change', async () => {
      const enabled = el.toggleOpenSeaMapMarkers.checked;
      try {
        await api('/api/settings', 'POST', { showOpenSeaMapMarkers: enabled });
        S.showOpenSeaMapMarkers = enabled;
        renderSeamarkBerths(); // Overpass vector markers on the active map (draws or clears)
      } catch {
        el.toggleOpenSeaMapMarkers.checked = !enabled;
      }
    });
  }

  if (el.toggleCheckDark) {
    el.toggleCheckDark.addEventListener('change', async () => {
      const enabled = el.toggleCheckDark.checked;
      try {
        await api('/api/settings', 'POST', { checkDarkActivity: enabled });
        S.checkDarkActivity = enabled;
      } catch {
        el.toggleCheckDark.checked = !enabled;
      }
    });
  }

  if (el.btnCargoWeightsSave) {
    el.btnCargoWeightsSave.addEventListener('click', async () => {
      const cargoWeights = collectCargoWeights();
      try {
        const r = await api('/api/settings/cargo-weights', 'POST', { cargoWeights });
        S.cargoWeights = r.cargoWeights || cargoWeights;
        // A manual save detaches from any named preset (server returns null).
        S.cargoWeightsPreset = r.cargoWeightsPreset || null;
        renderCargoWeights();
        renderCargoPresets();
        if (el.cargoWeightsStatus) el.cargoWeightsStatus.textContent = t('settings.cargoWeights.saved');
      } catch {
        if (el.cargoWeightsStatus) el.cargoWeightsStatus.textContent = t('settings.cargoWeights.error');
      }
    });
  }

  if (el.btnCargoWeightsReset) {
    el.btnCargoWeightsReset.addEventListener('click', () => {
      // Preview the defaults in the grid; not persisted until "Salva" is pressed.
      renderCargoWeights(S.defaultCargoWeights);
      if (el.cargoWeightsStatus) el.cargoWeightsStatus.textContent = t('settings.cargoWeights.resetHint');
    });
  }

  // Selecting a preset previews its weights in the grid right away (not yet
  // persisted — "Applica" saves them). The "(custom)" entry restores the
  // current live weights. Mirrors the reset button's preview behaviour.
  if (el.cargoPresetSelect) {
    el.cargoPresetSelect.addEventListener('change', () => {
      const id = el.cargoPresetSelect.value;
      const preset = id && S.cargoPresets && S.cargoPresets.find((p) => p.id === id);
      renderCargoWeights(preset ? preset.weights : S.cargoWeights);
      if (el.btnCargoPresetDelete) el.btnCargoPresetDelete.disabled = !preset || preset.builtin;
      if (el.cargoWeightsStatus) {
        el.cargoWeightsStatus.textContent = preset ? t('settings.cargoPresets.previewHint') : '';
      }
    });
  }

  // Apply the selected preset: server copies its weights into the live set.
  if (el.btnCargoPresetApply) {
    el.btnCargoPresetApply.addEventListener('click', async () => {
      const id = el.cargoPresetSelect && el.cargoPresetSelect.value;
      if (!id) return; // "(custom)" entry — nothing to apply
      try {
        const r = await api('/api/settings/cargo-presets/apply', 'POST', { id });
        S.cargoWeights = r.cargoWeights;
        S.cargoWeightsPreset = r.cargoWeightsPreset || null;
        renderCargoWeights();
        renderCargoPresets();
        if (el.cargoWeightsStatus) el.cargoWeightsStatus.textContent = t('settings.cargoPresets.applied');
      } catch {
        if (el.cargoWeightsStatus) el.cargoWeightsStatus.textContent = t('settings.cargoWeights.error');
      }
    });
  }

  // Save the weights currently shown in the grid as a named user preset.
  if (el.btnCargoPresetSave) {
    el.btnCargoPresetSave.addEventListener('click', async () => {
      const name = (window.prompt(t('settings.cargoPresets.namePrompt')) || '').trim();
      if (!name) return;
      const weights = collectCargoWeights();
      try {
        const r = await api('/api/settings/cargo-presets', 'POST', { name, weights });
        S.cargoPresets = r.presets;
        S.cargoWeights = r.cargoWeights || weights;
        S.cargoWeightsPreset = r.cargoWeightsPreset || null;
        renderCargoWeights();
        renderCargoPresets();
        if (el.cargoWeightsStatus) el.cargoWeightsStatus.textContent = t('settings.cargoPresets.saved');
      } catch {
        if (el.cargoWeightsStatus) el.cargoWeightsStatus.textContent = t('settings.cargoWeights.error');
      }
    });
  }

  // Delete the selected user preset (built-ins are guarded server- and UI-side).
  if (el.btnCargoPresetDelete) {
    el.btnCargoPresetDelete.addEventListener('click', async () => {
      const id = el.cargoPresetSelect && el.cargoPresetSelect.value;
      if (!id) return;
      if (!confirm(t('settings.cargoPresets.deleteConfirm'))) return;
      try {
        const r = await api('/api/settings/cargo-presets/' + encodeURIComponent(id), 'DELETE');
        S.cargoPresets = r.presets;
        S.cargoWeightsPreset = r.cargoWeightsPreset || null;
        renderCargoPresets();
        if (el.cargoWeightsStatus) el.cargoWeightsStatus.textContent = t('settings.cargoPresets.deleted');
      } catch {
        if (el.cargoWeightsStatus) el.cargoWeightsStatus.textContent = t('settings.cargoWeights.error');
      }
    });
  }

  // ── Risk-signal weights (mirrors the cargo-weights handlers) ──
  if (el.btnRiskWeightsSave) {
    el.btnRiskWeightsSave.addEventListener('click', async () => {
      const riskWeights = collectRiskWeights();
      try {
        const r = await api('/api/settings/risk-weights', 'POST', { riskWeights });
        S.riskWeights = r.riskWeights || riskWeights;
        S.riskWeightsPreset = r.riskWeightsPreset || null;
        renderRiskWeights();
        renderRiskPresets();
        if (el.riskWeightsStatus) el.riskWeightsStatus.textContent = t('settings.cargoWeights.saved');
      } catch {
        if (el.riskWeightsStatus) el.riskWeightsStatus.textContent = t('settings.cargoWeights.error');
      }
    });
  }

  if (el.btnRiskWeightsReset) {
    el.btnRiskWeightsReset.addEventListener('click', () => {
      renderRiskWeights(S.defaultRiskWeights);
      if (el.riskWeightsStatus) el.riskWeightsStatus.textContent = t('settings.cargoWeights.resetHint');
    });
  }

  if (el.riskPresetSelect) {
    el.riskPresetSelect.addEventListener('change', () => {
      const id = el.riskPresetSelect.value;
      const preset = id && S.riskPresets && S.riskPresets.find((p) => p.id === id);
      renderRiskWeights(preset ? preset.weights : S.riskWeights);
      if (el.btnRiskPresetDelete) el.btnRiskPresetDelete.disabled = !preset || preset.builtin;
      if (el.riskWeightsStatus) {
        el.riskWeightsStatus.textContent = preset ? t('settings.cargoPresets.previewHint') : '';
      }
    });
  }

  if (el.btnRiskPresetApply) {
    el.btnRiskPresetApply.addEventListener('click', async () => {
      const id = el.riskPresetSelect && el.riskPresetSelect.value;
      if (!id) return;
      try {
        const r = await api('/api/settings/risk-presets/apply', 'POST', { id });
        S.riskWeights = r.riskWeights;
        S.riskWeightsPreset = r.riskWeightsPreset || null;
        renderRiskWeights();
        renderRiskPresets();
        if (el.riskWeightsStatus) el.riskWeightsStatus.textContent = t('settings.cargoPresets.applied');
      } catch {
        if (el.riskWeightsStatus) el.riskWeightsStatus.textContent = t('settings.cargoWeights.error');
      }
    });
  }

  if (el.btnRiskPresetSave) {
    el.btnRiskPresetSave.addEventListener('click', async () => {
      const name = (window.prompt(t('settings.cargoPresets.namePrompt')) || '').trim();
      if (!name) return;
      const weights = collectRiskWeights();
      try {
        const r = await api('/api/settings/risk-presets', 'POST', { name, weights });
        S.riskPresets = r.presets;
        S.riskWeights = r.riskWeights || weights;
        S.riskWeightsPreset = r.riskWeightsPreset || null;
        renderRiskWeights();
        renderRiskPresets();
        if (el.riskWeightsStatus) el.riskWeightsStatus.textContent = t('settings.cargoPresets.saved');
      } catch {
        if (el.riskWeightsStatus) el.riskWeightsStatus.textContent = t('settings.cargoWeights.error');
      }
    });
  }

  if (el.btnRiskPresetDelete) {
    el.btnRiskPresetDelete.addEventListener('click', async () => {
      const id = el.riskPresetSelect && el.riskPresetSelect.value;
      if (!id) return;
      if (!confirm(t('settings.cargoPresets.deleteConfirm'))) return;
      try {
        const r = await api('/api/settings/risk-presets/' + encodeURIComponent(id), 'DELETE');
        S.riskPresets = r.presets;
        S.riskWeightsPreset = r.riskWeightsPreset || null;
        renderRiskPresets();
        if (el.riskWeightsStatus) el.riskWeightsStatus.textContent = t('settings.cargoPresets.deleted');
      } catch {
        if (el.riskWeightsStatus) el.riskWeightsStatus.textContent = t('settings.cargoWeights.error');
      }
    });
  }

  // Whole-database backup (download .db) and restore (upload .db).
  el.btnBackup.addEventListener('click', () => {
    window.location = '/api/backup';
  });

  el.btnRestore.addEventListener('click', () => el.restoreFile.click());

  el.restoreFile.addEventListener('change', async () => {
    const file = el.restoreFile.files[0];
    el.restoreFile.value = ''; // allow re-selecting the same file later
    if (!file) return;
    if (!confirm(t('confirm.restore', { file: file.name }))) return;

    el.btnRestore.disabled = true;
    const prevLabel = el.btnRestore.textContent;
    el.btnRestore.textContent = t('toast.restoring');
    try {
      const res = await fetch('/api/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const total = Object.values(data.counts || {}).reduce((a, b) => a + b, 0);
      showAlert(t('toast.restored'), `${total.toLocaleString()} righe importate`);
      showView(S.settingsFrom || 'active');
      await loadSettings();
      tick();
    } catch (e) {
      alert('Errore ripristino: ' + e.message);
    } finally {
      el.btnRestore.disabled = false;
      el.btnRestore.textContent = prevLabel;
    }
  });

  // ── Backup / restore tab — granular and full-bundle export/import ──────────
  el.btnBundleExport.addEventListener('click', () => { window.location = '/api/bundle'; });
  el.btnAreasExport.addEventListener('click', () => { window.location = '/api/areas/export'; });
  el.btnSettingsExport.addEventListener('click', () => { window.location = '/api/settings/export'; });

  el.btnAreasImport.addEventListener('click', () => el.areasFile.click());
  el.areasFile.addEventListener('change', async () => {
    const file = el.areasFile.files[0];
    el.areasFile.value = '';
    if (!file) return;
    await runImport({
      file, url: '/api/areas/import', contentType: 'application/json',
      btn: el.btnAreasImport, busyLabel: t('toast.importing'),
      onDone: async (d) => {
        const n = (d.added?.length || 0) + (d.updated?.length || 0);
        showAlert(t('toast.areasImported'), t('toast.areasImportedBody', { n }));
        window.dispatchEvent(new CustomEvent('areas-changed'));
      },
    });
  });

  el.btnSettingsImport.addEventListener('click', () => el.settingsFile.click());
  el.settingsFile.addEventListener('change', async () => {
    const file = el.settingsFile.files[0];
    el.settingsFile.value = '';
    if (!file) return;
    await runImport({
      file, url: '/api/settings/import', contentType: 'application/json',
      btn: el.btnSettingsImport, busyLabel: t('toast.importing'),
      onDone: async () => {
        showAlert(t('toast.settingsImported'), '');
        await loadSettings();
        updateStatus();
        tick();
      },
    });
  });

  el.btnBundleImport.addEventListener('click', () => el.bundleFile.click());
  el.bundleFile.addEventListener('change', async () => {
    const file = el.bundleFile.files[0];
    el.bundleFile.value = '';
    if (!file) return;
    if (!confirm(t('confirm.bundleImport', { file: file.name }))) return;
    await runImport({
      file, url: '/api/bundle/import', contentType: 'application/octet-stream',
      btn: el.btnBundleImport, busyLabel: t('toast.restoring'),
      onDone: async (d) => {
        const total = Object.values(d.counts || {}).reduce((a, b) => a + b, 0);
        showAlert(t('toast.bundleImported'), t('toast.bundleImportedBody', { n: total.toLocaleString() }));
        showView(S.settingsFrom || 'active');
        await loadSettings();
        window.dispatchEvent(new CustomEvent('areas-changed'));
        tick();
      },
    });
  });

  // ── Auto-backup: manual save ──────────────────────────────────────────────
  if (el.btnManualBackup) {
    el.btnManualBackup.addEventListener('click', async () => {
      const prev = el.btnManualBackup.textContent;
      el.btnManualBackup.disabled = true;
      el.btnManualBackup.textContent = '⏳ Salvataggio…';
      try {
        await api('/api/backups/save', 'POST');
        await loadAutoBackups();
        showAlert('Backup salvato', '');
      } catch (e) {
        alert('Errore salvataggio backup: ' + (e.message || String(e)));
      } finally {
        el.btnManualBackup.disabled = false;
        el.btnManualBackup.textContent = prev;
      }
    });
  }

  // ── Auto-backup: download / restore from list ─────────────────────────────
  if (el.autoBackupList) {
    el.autoBackupList.addEventListener('click', (e) => {
      const dlBtn = e.target.closest('[data-download]');
      const restoreBtn = e.target.closest('[data-restore]');
      if (dlBtn) window.location = `/api/backups/${encodeURIComponent(dlBtn.dataset.download)}/download`;
      if (restoreBtn) showBackupRestoreDialog(restoreBtn.dataset.restore);
    });
  }
}

// ── Auto-backup management ────────────────────────────────────────────────────

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderAutoBackupList(backups) {
  if (!el.autoBackupList) return;
  if (!backups || backups.length === 0) {
    el.autoBackupList.innerHTML = '<p class="auto-backup-empty">Nessun backup locale disponibile.</p>';
    return;
  }
  el.autoBackupList.innerHTML = backups.map((b) => {
    const date = new Date(b.mtime).toLocaleString();
    const size = formatFileSize(b.size);
    const isManual = b.filename.includes('-manualbackup-');
    const label = isManual ? '🖐 Manuale' : '⏱ Auto';
    return `<div class="auto-backup-item">
      <div class="auto-backup-info">
        <span class="auto-backup-label${isManual ? ' manual' : ''}">${label}</span>
        <span class="auto-backup-meta">${date} &middot; ${size}</span>
      </div>
      <div class="auto-backup-actions">
        <button class="btn-mini" data-download="${escHtml(b.filename)}" title="Scarica">⬇</button>
        <button class="btn-mini btn-mini-clear" data-restore="${escHtml(b.filename)}">↩ Ripristina</button>
      </div>
    </div>`;
  }).join('');
}

async function loadAutoBackups() {
  if (!el.autoBackupList) return;
  try {
    const r = await api('/api/backups');
    renderAutoBackupList(r.backups || []);
  } catch {
    /* ignore */
  }
}

function showBackupRestoreDialog(filename) {
  el.modalTitle.textContent = 'Ripristina backup';
  el.modalBody.innerHTML = `
    <p style="margin-bottom:1rem">Scegli cosa ripristinare da:<br><strong>${escHtml(filename)}</strong></p>
    <div class="restore-parts">
      <label class="restore-part-row"><input type="checkbox" id="rp-db" checked> <span>Database (letture AIS, navi, eventi porto)</span></label>
      <label class="restore-part-row"><input type="checkbox" id="rp-areas" checked> <span>Aree di monitoraggio</span></label>
      <label class="restore-part-row"><input type="checkbox" id="rp-settings" checked> <span>Impostazioni</span></label>
    </div>
    <div class="restore-dialog-actions">
      <button id="btn-cancel-restore" class="btn btn-secondary">Annulla</button>
      <button id="btn-confirm-restore" class="btn btn-clear">↩ Ripristina selezionati</button>
    </div>`;

  document.getElementById('btn-cancel-restore').addEventListener('click', () => {
    el.modalOverlay.classList.add('hidden');
  });

  document.getElementById('btn-confirm-restore').addEventListener('click', async () => {
    const parts = [];
    if (document.getElementById('rp-db')?.checked) parts.push('db');
    if (document.getElementById('rp-areas')?.checked) parts.push('areas');
    if (document.getElementById('rp-settings')?.checked) parts.push('settings');
    if (parts.length === 0) { alert('Seleziona almeno una parte da ripristinare.'); return; }

    const partsLabel = { db: 'database', areas: 'aree', settings: 'impostazioni' };
    const partsStr = parts.map((p) => partsLabel[p]).join(', ');
    if (!confirm(`Ripristinare ${partsStr} dal backup?\nL'operazione è irreversibile.`)) return;

    const btn = document.getElementById('btn-confirm-restore');
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Ripristino…';

    try {
      const r = await api(`/api/backups/${encodeURIComponent(filename)}/restore`, 'POST', { parts });
      el.modalOverlay.classList.add('hidden');
      showView(S.settingsFrom || 'active');
      let msg = '';
      if (r.counts) {
        const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
        msg += `${total.toLocaleString()} righe database importate. `;
      }
      if (r.areas) {
        const n = (r.areas.added?.length || 0) + (r.areas.updated?.length || 0);
        msg += `${n} aree ripristinate.`;
      }
      showAlert('Ripristino completato', msg.trim());
      await loadSettings();
      if (parts.includes('areas')) window.dispatchEvent(new CustomEvent('areas-changed'));
      tick();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = prev;
      alert('Errore ripristino: ' + (e.message || String(e)));
    }
  });

  el.modalOverlay.classList.remove('hidden');
}

function initBboxSelect() {
  el.bboxSelect.addEventListener('change', async () => {
    try {
      const preset = el.bboxSelect.value;
      const result = await api('/api/settings', 'POST', { preset });
      S.currentPreset = preset;
      showToast(result.name, result.bbox);
      setTitle(result.name);
      S.currentBbox = result.bbox;

      // Clear ship data — switching view area, not stream
      el.activeBody.innerHTML = `<tr><td colspan="8" class="empty">${t('toast.changing')}</td></tr>`;
      el.pastBody.innerHTML = `<tr><td colspan="7" class="empty">${t('empty.past')}</td></tr>`;
      el.activeCount.textContent = '0';
      el.pastCount.textContent = '0';
      S.activeShipsCache.clear();

      if (S.activeMap) {
        S.activeMarkersLayer.clearLayers();
        if (S.berthsLayer) S.berthsLayer.clearLayers();
        const [[swLat, swLon], [neLat, neLon]] = result.bbox;
        S.activeMap.fitBounds([[swLat, swLon], [neLat, neLon]], { padding: [40, 40] });
      }
      S.berthsList = [];

      await updateStatus();
      if (S.view === 'active') {
        loadActive();
        if (S.showBerths) loadBerths(S.currentPreset);
      }
    } catch (e) {
      alert(t('error.changeArea') + e.message);
    }
  });
}

// ── Collapsible detail sections ───────────────────────────────────────────────
function initCollapsibleSections() {
  document.querySelectorAll('#view-detail .detail-section').forEach(section => {
    const title = section.querySelector(':scope > h3.detail-section-title');
    if (!title) return;

    const chevron = document.createElement('span');
    chevron.className = 'detail-section-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '▼';
    title.appendChild(chevron);

    const body = document.createElement('div');
    body.className = 'detail-section-body';
    const toMove = [];
    let sibling = title.nextElementSibling;
    while (sibling) { toMove.push(sibling); sibling = sibling.nextElementSibling; }
    toMove.forEach(child => body.appendChild(child));
    section.appendChild(body);

    title.addEventListener('click', () => section.classList.toggle('collapsed'));
  });
}

// ── Polling ──────────────────────────────────────────────────────────────────
function tick() {
  updateStatus();
  loadNotifications();
  if (el.syncTime) {
    const now = new Date();
    el.syncTime.textContent = `↻ ${now.toLocaleTimeString('it-IT')}`;
  }
  if (S.view === 'active') {
    loadActive();
    if (S.showBerths) loadBerths(S.currentPreset);
  }
  else if (S.view === 'past') loadPast();
  else if (S.view === 'detail') {
    loadDetail();
    loadTrack(S.detailMmsi);
  } else if (S.view === 'traffico') loadTraffco();
}

function startPolling() {
  if (S.pollTimer) return;
  S.pollTimer = setInterval(tick, S.pollIntervalMs);
}

// ── Toolbar / navigation ─────────────────────────────────────────────────────
function initToolbar() {
  el.btnStart.addEventListener('click', async () => {
    el.btnStart.disabled = true;
    try {
      await api('/api/stream/start', 'POST', { area: S.currentPreset });
      await updateStatus();
      tick();
      startPolling();
    } catch (e) {
      alert(t('error.startStream') + e.message);
      el.btnStart.disabled = false;
    }
  });

  el.btnStop.addEventListener('click', async () => {
    await api('/api/stream/stop', 'POST', { area: S.currentPreset });
    await updateStatus();
  });

  el.btnExport.addEventListener('click', () => {
    window.location = '/api/export';
  });

  const onClearClick = async () => {
    const areaName = S.presets[S.currentPreset]?.name || S.currentPreset;
    if (!confirm(t('confirm.clear', { area: areaName }))) return;
    const area = encodeURIComponent(S.currentPreset || '');
    await api(`/api/readings?area=${area}`, 'DELETE');
    el.activeCount.textContent = '0';
    el.pastCount.textContent = '0';
    S.activeShipsCache.clear();
    tick();
  };
  el.btnClear.addEventListener('click', onClearClick);
  el.btnClearPast.addEventListener('click', onClearClick);

  el.tabActive.addEventListener('click', () => showView('active'));
  el.tabPast.addEventListener('click', () => showView('past'));
  el.tabTraffco.addEventListener('click', () => showView('traffico'));
  el.btnHome.addEventListener('click', () => showView('active'));
  if (el.btnFollowed) el.btnFollowed.addEventListener('click', () => showView('followed'));
  el.btnAreas.addEventListener('click', () => showView('areas'));

  el.btnBack.addEventListener('click', () => showView(S.detailFrom));

  el.detailPrev.addEventListener('click', () => {
    if (S.detailPage > 0) {
      S.detailPage--;
      loadDetail();
    }
  });
  el.detailNext.addEventListener('click', () => {
    if ((S.detailPage + 1) * PAGE_SIZE < S.detailTotal) {
      S.detailPage++;
      loadDetail();
    }
  });

  el.modalClose.addEventListener('click', () => el.modalOverlay.classList.add('hidden'));
  el.modalOverlay.addEventListener('click', (e) => {
    if (e.target === el.modalOverlay) el.modalOverlay.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') el.modalOverlay.classList.add('hidden');
  });
}

// ── Active-map vertical resize handle ────────────────────────────────────────
function initMapResizer() {
  const resizer = document.getElementById('active-map-resizer');
  const mapEl = document.getElementById('active-map');
  const MIN_H = 150;
  let dragging = false;
  let startY = 0;
  let startH = 0;

  function onStart(clientY) {
    dragging = true;
    startY = clientY;
    startH = mapEl.offsetHeight;
    resizer.classList.add('resizing');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }

  function onMove(clientY) {
    if (!dragging) return;
    const newH = Math.max(MIN_H, startH + (clientY - startY));
    mapEl.style.height = newH + 'px';
    S.activeMap?.invalidateSize();
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    onStart(e.clientY);
  });
  document.addEventListener('mousemove', (e) => onMove(e.clientY));
  document.addEventListener('mouseup', onEnd);

  resizer.addEventListener('touchstart', (e) => onStart(e.touches[0].clientY), { passive: true });
  document.addEventListener(
    'touchmove',
    (e) => {
      if (dragging) {
        e.preventDefault();
        onMove(e.touches[0].clientY);
      }
    },
    { passive: false }
  );
  document.addEventListener('touchend', onEnd);
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('btn-sidebar-toggle');
  if (!sidebar || !btn) return;

  // Restore persisted state before first paint.
  if (localStorage.getItem('sidebar') === 'collapsed') {
    sidebar.classList.add('collapsed');
  }

  btn.addEventListener('click', () => {
    const collapsed = sidebar.classList.toggle('collapsed');
    localStorage.setItem('sidebar', collapsed ? 'collapsed' : 'expanded');
    // Leaflet maps need to know the container resized.
    setTimeout(() => window.dispatchEvent(new Event('resize')), 220);
  });
}

// ── Risk tooltip ─────────────────────────────────────────────────────────────
function initRiskTooltip() {
  const tip = document.createElement('div');
  tip.id = 'risk-tooltip';
  tip.className = 'risk-tooltip hidden';
  document.body.appendChild(tip);

  const BAND_LABEL = { low: t('risk.lowLabel'), med: t('risk.medLabel'), high: t('risk.highLabel') };

  function show(badge) {
    let risk;
    try { risk = JSON.parse(badge.dataset.risk); } catch { return; }
    const bandLabel = BAND_LABEL[risk.band] || '—';
    const factors = risk.factors || [];
    const factorsHtml = factors.length
      ? `<ul class="rt-factors">${factors.map((f) => `<li><span class="rt-pts risk-${risk.band}">+${f.points}</span> ${escHtml(f.label)}</li>`).join('')}</ul>`
      : '<p class="rt-none">Nessuna anomalia rilevata</p>';
    const { vf, mt, gfw, sanctions, psc } = risk.sources || {};
    const vfUsed = vf === 'used', vfAvail = vf === 'available';
    const mtUsed = mt === 'used', mtAvail = mt === 'available';
    const gfwUsed = gfw === 'used', gfwAvail = gfw === 'available';
    const sancUsed = sanctions === 'used', sancAvail = sanctions === 'available';
    const pscUsed = psc === 'used', pscAvail = psc === 'available';
    const anyUsed = vfUsed || mtUsed || gfwUsed || sancUsed || pscUsed;
    const anyAvail = vfAvail || mtAvail || gfwAvail || sancAvail || pscAvail;
    let srcHtml;
    if (anyUsed || anyAvail) {
      const parts = [];
      if (sancUsed) parts.push('<span class="rt-src rt-src-sanction">Sanzioni ⚠</span>');
      else if (sancAvail) parts.push('<span class="rt-src rt-src-sanction rt-src-dim" title="Verificato in liste sanzioni (OFAC/UE/UK/ONU), nessun match">Sanzioni</span>');
      if (pscUsed) parts.push('<span class="rt-src rt-src-psc">Paris/Tokyo MoU ⚓</span>');
      else if (pscAvail) parts.push('<span class="rt-src rt-src-psc rt-src-dim" title="Verificato liste MoU (bandiera/banned), nessun segnale">Paris/Tokyo MoU</span>');
      if (vfUsed) parts.push('<span class="rt-src rt-src-vf">VesselFinder</span>');
      else if (vfAvail) parts.push('<span class="rt-src rt-src-vf rt-src-dim" title="Consultato, nessun dato rilevante per lo score">VesselFinder</span>');
      if (mtUsed) parts.push('<span class="rt-src rt-src-mt">MarineTraffic</span>');
      else if (mtAvail) parts.push('<span class="rt-src rt-src-mt rt-src-dim" title="Consultato, nessun dato rilevante per lo score">MarineTraffic</span>');
      if (gfwUsed) parts.push('<span class="rt-src rt-src-gfw">Global Fishing Watch</span>');
      else if (gfwAvail) parts.push('<span class="rt-src rt-src-gfw rt-src-dim" title="Consultato, nessun evento/dato rilevante per lo score">Global Fishing Watch</span>');
      srcHtml = parts.join(' <span class="rt-src-sep">+</span> ');
      if (!anyUsed) srcHtml += ' <span class="rt-src-note">(nessun dato rilevante per lo score)</span>';
    } else {
      srcHtml = '<span class="rt-src rt-src-ais">Solo AIS free</span>';
    }

    tip.innerHTML = `
      <div class="rt-header risk-${risk.band}">Score rischio: <strong>${risk.score}/100</strong> — <em>${bandLabel}</em></div>
      ${factorsHtml}
      <div class="rt-sources"><span class="rt-src-label">Fonti:</span> ${srcHtml}</div>
    `;
    tip.classList.remove('hidden');

    const rect = badge.getBoundingClientRect();
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    let top = rect.bottom + 6;
    let left = rect.left + rect.width / 2 - tipW / 2;
    if (top + tipH > window.innerHeight - 8) top = rect.top - tipH - 6;
    if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
    if (left < 8) left = 8;
    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
  }

  document.addEventListener('mouseover', (e) => {
    const badge = e.target.closest('.risk-badge[data-risk]');
    if (badge) show(badge);
  });
  document.addEventListener('mouseout', (e) => {
    const badge = e.target.closest('.risk-badge[data-risk]');
    if (badge && !badge.contains(e.relatedTarget)) tip.classList.add('hidden');
  });
}

// ── Glossary tooltip ─────────────────────────────────────────────────────────
// Generic hover explainer for the "ⓘ" icons in the Equasis tables. Each icon
// carries its term/definition inline via data-term / data-tip (built in
// ships.js: eqInfoIcon), so this handler stays content-agnostic.
function initGlossaryTooltip() {
  const tip = document.createElement('div');
  tip.id = 'gloss-tooltip';
  tip.className = 'gloss-tooltip hidden';
  document.body.appendChild(tip);

  function show(icon) {
    const term = icon.dataset.term || '';
    const def = icon.dataset.tip || '';
    if (!def) return;
    tip.innerHTML = `${term ? `<div class="gt-term">${escHtml(term)}</div>` : ''}<div class="gt-def">${escHtml(def)}</div>`;
    tip.classList.remove('hidden');

    const rect = icon.getBoundingClientRect();
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    let top = rect.bottom + 6;
    let left = rect.left + rect.width / 2 - tipW / 2;
    if (top + tipH > window.innerHeight - 8) top = rect.top - tipH - 6;
    if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
    if (left < 8) left = 8;
    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
  }

  document.addEventListener('mouseover', (e) => {
    const icon = e.target.closest('.eq-info[data-tip]');
    if (icon) show(icon);
  });
  document.addEventListener('mouseout', (e) => {
    const icon = e.target.closest('.eq-info[data-tip]');
    if (icon && !icon.contains(e.relatedTarget)) tip.classList.add('hidden');
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
// Apply translations to static HTML before anything renders.
applyToDOM();

initSidebar();
initTheme();
initToolbar();
initSettingsModal();
initBboxSelect();
initLogPanel();
initAppLog();
initAreas();
initNotifications();
initOutageBanner();
initMapResizer();
initRiskTooltip();
initGlossaryTooltip();
initBerths();
initReplay();
initWebhooks();
initAppConfig();
initCollapsibleSections();

// Areas added/removed at runtime → refresh the dropdown, monitor toggles and
// stream status everywhere.
window.addEventListener('areas-changed', () => {
  loadSettings().then(() => {
    updateStatus();
    if (S.view !== 'areas') tick();
  });
});

// ── Language selector ─────────────────────────────────────────────────────────
const langSelect = document.getElementById('lang-select');
if (langSelect) {
  langSelect.value = getLang();
  langSelect.addEventListener('change', () => setLang(langSelect.value));
}

// Fetch runtime config from server (reads app.config.properties), then start.
// On failure, S defaults (matching file defaults) are used.
// Human-friendly "every N hours/minutes" label for a minutes value.
function intervalLabel(min) {
  if (min % 60 === 0) {
    const h = min / 60;
    return h === 1 ? t('time.everyHour') : t('time.everyHours', { n: h });
  }
  return t('time.everyMinutes', { n: min });
}

api('/api/config').then((cfg) => {
  if (cfg.pollIntervalMs != null) S.pollIntervalMs = cfg.pollIntervalMs;
  if (cfg.trackMergeRadiusM != null) S.trackMergeRadiusM = cfg.trackMergeRadiusM;
  if (cfg.trackSogStop != null) S.trackSogStop = cfg.trackSogStop;
  if (cfg.notifDeleteUndoSeconds != null) S.notifDeleteUndoSeconds = cfg.notifDeleteUndoSeconds;
  if (cfg.replayMaxGapMin != null) S.replayMaxGapMin = cfg.replayMaxGapMin;
  if (cfg.replayTailMin != null) S.replayTailMin = cfg.replayTailMin;
  if (cfg.backupIntervalMin != null && el.autobackupDesc) {
    el.autobackupDesc.textContent = t('settings.autobackup.desc', { interval: intervalLabel(cfg.backupIntervalMin) });
  }
}).catch(() => {}).finally(async () => {
  await loadSettings();
  updateStatus();
  loadActive();
  startPolling();
});
