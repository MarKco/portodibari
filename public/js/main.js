import { el } from './dom.js';
import { S, PAGE_SIZE } from './store.js';
import { api } from './api.js';
import { showToast, showAlert } from './toast.js';
import { showView } from './views.js';
import { loadActive, loadPast, loadDetail, loadVfData, loadMtData, loadEquasisData } from './ships.js';
import { loadTrack } from './maps.js';
import { loadTraffco } from './traffico.js';
import { initBerths, loadBerths } from './berths.js';
import { initAppConfig, loadAppConfig } from './app-config.js';
import { initLogPanel } from './logs.js';
import { initHealthPanel } from './health.js';
import { initAreas } from './areas.js';
import { initNotifications, loadNotifications } from './notifications.js';
import { initTheme } from './theme.js';
import { escHtml } from './helpers.js';
import { t, getLang, setLang, LANG_NAMES, applyToDOM } from './i18n.js';

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
    S.notificationsEnabled = s.notificationsEnabled !== false;
    S.notifyRevisit = s.notifyRevisit !== false;
    S.notifyAreaChange = s.notifyAreaChange !== false;
    S.notifyHighRisk = s.notifyHighRisk !== false;
    S.notifyBerthNew = s.notifyBerthNew !== false;
    S.notifyBerthChar = s.notifyBerthChar !== false;
    if (el.toggleNotifications) el.toggleNotifications.checked = S.notificationsEnabled;
    if (el.toggleNotifyRevisit) el.toggleNotifyRevisit.checked = S.notifyRevisit;
    if (el.toggleNotifyAreaChange) el.toggleNotifyAreaChange.checked = S.notifyAreaChange;
    if (el.toggleNotifyHighRisk) el.toggleNotifyHighRisk.checked = S.notifyHighRisk;
    if (el.toggleNotifyBerthNew) el.toggleNotifyBerthNew.checked = S.notifyBerthNew;
    if (el.toggleNotifyBerthChar) el.toggleNotifyBerthChar.checked = S.notifyBerthChar;
    applyNotifSettingsState();
  } catch {
    /* ignore */
  }
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

// Upload a user-selected file to an import endpoint, showing a busy label on the
// triggering button. Runs onDone(responseData) on success.
async function runImport({ file, url, contentType, btn, busyLabel, onDone }) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    const body = await file.text();
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

function initSettingsModal() {
  el.btnSettings.addEventListener('click', () => {
    if (S.view !== 'settings') S.settingsFrom = S.view;
    showView('settings');
  });
  el.btnSettingsBack.addEventListener('click', () => showView(S.settingsFrom || 'active'));

  // Settings tabs — switch between the panels (general / areas / dev / backup).
  el.settingsTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    el.settingsTabs.querySelectorAll('.tab').forEach((b) => b.classList.remove('tab-active'));
    tab.classList.add('tab-active');
    const target = `settings-panel-${tab.dataset.panel}`;
    el.settingsPanels.forEach((p) => p.classList.toggle('hidden', p.id !== target));
    if (tab.dataset.panel === 'backup') loadAutoBackups();
    if (tab.dataset.panel === 'params') loadAppConfig();
  });

  // Developer option — inject a test notification and refresh the feed.
  el.btnTestNotification.addEventListener('click', async () => {
    el.btnTestNotification.disabled = true;
    try {
      await api('/api/notifications/test', 'POST');
      await loadNotifications();
      showAlert(t('settings.devNotifTest.done'), '');
    } catch (err) {
      showAlert(t('settings.devNotifTest.fail'), escHtml(err.message || String(err)));
    } finally {
      el.btnTestNotification.disabled = false;
    }
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

// ── Polling ──────────────────────────────────────────────────────────────────
function tick() {
  updateStatus();
  loadNotifications();
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

  el.btnClear.addEventListener('click', async () => {
    const areaName = S.presets[S.currentPreset]?.name || S.currentPreset;
    if (!confirm(t('confirm.clear', { area: areaName }))) return;
    const area = encodeURIComponent(S.currentPreset || '');
    await api(`/api/readings?area=${area}`, 'DELETE');
    el.activeCount.textContent = '0';
    el.pastCount.textContent = '0';
    S.activeShipsCache.clear();
    tick();
  });

  el.tabActive.addEventListener('click', () => showView('active'));
  el.tabPast.addEventListener('click', () => showView('past'));
  el.tabTraffco.addEventListener('click', () => showView('traffico'));
  el.btnHome.addEventListener('click', () => showView('active'));
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
    const { vf, mt, sanctions, psc } = risk.sources || {};
    const vfUsed = vf === 'used', vfAvail = vf === 'available';
    const mtUsed = mt === 'used', mtAvail = mt === 'available';
    const sancUsed = sanctions === 'used', sancAvail = sanctions === 'available';
    const pscUsed = psc === 'used', pscAvail = psc === 'available';
    const anyUsed = vfUsed || mtUsed || sancUsed || pscUsed;
    const anyAvail = vfAvail || mtAvail || sancAvail || pscAvail;
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

// ── Init ─────────────────────────────────────────────────────────────────────
// Apply translations to static HTML before anything renders.
applyToDOM();

initSidebar();
initTheme();
initToolbar();
initSettingsModal();
initBboxSelect();
initLogPanel();
initHealthPanel();
initAreas();
initNotifications();
initMapResizer();
initRiskTooltip();
initBerths();
initAppConfig();

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
  if (cfg.backupIntervalMin != null && el.autobackupDesc) {
    el.autobackupDesc.textContent = t('settings.autobackup.desc', { interval: intervalLabel(cfg.backupIntervalMin) });
  }
}).catch(() => {}).finally(async () => {
  await loadSettings();
  updateStatus();
  loadActive();
  startPolling();
});
