'use strict';

const express = require('express');
const {
  state, setPreset, setImportVf, setImportMt, setImportSanctions, setImportSanctionsExtra, setImportPsc, setImportEquasis, setImportGfw, setNotificationsEnabled, setNotifyRevisit,
  setNotifyAreaChange, setNotifyHighRisk, setNotifyBerthNew, setNotifyBerthChar, BBOX_PRESETS, currentKeyword,
  POLL_INTERVAL_MS, TRACK_MERGE_RADIUS_M, SOG_FERMA, NOTIF_DELETE_UNDO_SECONDS,
  BACKUP_INTERVAL_MIN,
  EQUASIS_USER, EQUASIS_PASSWORD, GFW_TOKEN,
} = require('../config');

// Whether Equasis credentials are present (the lookup is unusable without them).
const equasisConfigured = !!(EQUASIS_USER && EQUASIS_PASSWORD);
// Whether a GFW API token is present (enrichment no-ops without it).
const gfwConfigured = !!GFW_TOKEN;
const { enrichAllExisting, enrichActiveShips } = require('../services/enrichment');
const { clearRiskCache } = require('../services/risk-score');
const sanctions = require('../services/sanctions');
const psc = require('../services/psc');
const equasisLog = require('../services/equasis-log');
const appLog = require('../services/app-log');

const router = express.Router();

// Equasis lookup audit log — read the plain-text trail of past lookups (shown in
// the Settings modal) and clear it.
router.get('/equasis-log', (req, res) => {
  res.json(equasisLog.read());
});

router.delete('/equasis-log', (req, res) => {
  equasisLog.clear();
  res.json({ ok: true });
});

router.get('/config', (req, res) => {
  res.json({
    pollIntervalMs: POLL_INTERVAL_MS,
    trackMergeRadiusM: TRACK_MERGE_RADIUS_M,
    trackSogStop: SOG_FERMA,
    notifDeleteUndoSeconds: NOTIF_DELETE_UNDO_SECONDS,
    backupIntervalMin: BACKUP_INTERVAL_MIN,
  });
});

router.get('/settings', (req, res) => {
  res.json({
    preset: state.preset,
    keyword: currentKeyword(),
    presets: Object.fromEntries(
      Object.entries(BBOX_PRESETS).map(([k, v]) => [
        k,
        { name: v.name, bbox: v.box[0], keyword: v.keyword },
      ])
    ),
    importVfData: state.importVfData,
    importMtData: state.importMtData,
    importSanctions: state.importSanctions,
    importSanctionsExtra: state.importSanctionsExtra,
    sanctions: sanctions.getStatus(),
    importPsc: state.importPsc,
    psc: psc.getStatus(),
    importEquasis: state.importEquasis,
    equasisConfigured,
    importGfw: state.importGfw,
    gfwConfigured,
    appLogEnabled: state.appLogEnabled,
    notificationsEnabled: state.notificationsEnabled,
    notifyRevisit: state.notifyRevisit,
    notifyAreaChange: state.notifyAreaChange,
    notifyHighRisk: state.notifyHighRisk,
    notifyBerthNew: state.notifyBerthNew,
    notifyBerthChar: state.notifyBerthChar,
  });
});

// Manually re-download the sanctions list (OFAC SDN). Fire-and-forget refresh;
// returns the dataset status so the UI can reflect "refreshing in progress".
router.post('/sanctions/refresh', (req, res) => {
  appLog.info('SANCTIONS', appLog.t('sanctions.manual_started'));
  sanctions
    .refresh()
    .then(() => clearRiskCache()) // new list contents can change matches
    .catch((e) => console.error(`[SANCTIONS] Manual refresh failed: ${e.message}`));
  res.json({ ok: true, sanctions: sanctions.getStatus() });
});

// Manually re-download the PSC banned list + reload bundled flag lists.
router.post('/psc/refresh', (req, res) => {
  appLog.info('PSC', appLog.t('psc.manual_started'));
  psc
    .refresh()
    .then(() => clearRiskCache()) // new flag/banned data can change matches
    .catch((e) => console.error(`[PSC] Manual refresh failed: ${e.message}`));
  res.json({ ok: true, psc: psc.getStatus() });
});

// The persisted, portable subset of settings (all the on/off toggles + the
// active view preset). Shared by the export route and the full-bundle export.
function exportSettings() {
  return {
    preset: state.preset,
    importVfData: state.importVfData,
    importMtData: state.importMtData,
    importSanctions: state.importSanctions,
    importSanctionsExtra: state.importSanctionsExtra,
    importPsc: state.importPsc,
    importEquasis: state.importEquasis,
    importGfw: state.importGfw,
    notificationsEnabled: state.notificationsEnabled,
    notifyRevisit: state.notifyRevisit,
    notifyAreaChange: state.notifyAreaChange,
    notifyHighRisk: state.notifyHighRisk,
    notifyBerthNew: state.notifyBerthNew,
    notifyBerthChar: state.notifyBerthChar,
  };
}

// Apply an imported settings object, firing the same "freshly enabled" side
// effects as the interactive POST /settings handler (enrichment backfill,
// list downloads). Unknown/absent fields are left untouched. The preset is only
// switched when it names an existing area. Shared by /settings/import and the
// full-bundle import. Returns the resulting exportSettings() snapshot.
function applyImportedSettings(s) {
  if (!s || typeof s !== 'object') throw new Error('File impostazioni non valido');

  if (s.notificationsEnabled !== undefined) setNotificationsEnabled(s.notificationsEnabled);
  if (s.notifyRevisit !== undefined) setNotifyRevisit(s.notifyRevisit);
  if (s.notifyAreaChange !== undefined) setNotifyAreaChange(s.notifyAreaChange);
  if (s.notifyHighRisk !== undefined) setNotifyHighRisk(s.notifyHighRisk);
  if (s.notifyBerthNew !== undefined) setNotifyBerthNew(s.notifyBerthNew);
  if (s.notifyBerthChar !== undefined) setNotifyBerthChar(s.notifyBerthChar);

  // VF/MT toggles: persist only — do NOT backfill. The scraped data lives in
  // ship_scrape_cache, which is part of the DB backup and is restored alongside
  // the ships. Re-scraping every loaded vessel on restore would hammer
  // VesselFinder/MarineTraffic for no gain (the data is already in the DB).
  // The interactive POST /settings handler still backfills on a live toggle.
  if (s.importVfData !== undefined) setImportVf(s.importVfData);
  if (s.importMtData !== undefined) setImportMt(s.importMtData);
  // Persist the extra-lists toggle before the master block so its refresh sees
  // the right active set.
  if (s.importSanctionsExtra !== undefined) setImportSanctionsExtra(s.importSanctionsExtra);
  if (s.importSanctions !== undefined) {
    const wasDisabled = !state.importSanctions;
    setImportSanctions(s.importSanctions);
    if (state.importSanctions && (wasDisabled || !sanctions.getStatus().loaded)) {
      sanctions.refresh().catch((e) => console.error(`[SANCTIONS] Refresh failed: ${e.message}`));
    }
  }
  if (s.importPsc !== undefined) {
    const wasDisabled = !state.importPsc;
    setImportPsc(s.importPsc);
    if (state.importPsc && (wasDisabled || !psc.bannedLoaded())) {
      psc.loadFromDisk();
      psc.refresh().catch((e) => console.error(`[PSC] Refresh failed: ${e.message}`));
    }
  }

  // Equasis is a manual, on-demand lookup: just persist the toggle, never backfill.
  if (s.importEquasis !== undefined) setImportEquasis(s.importEquasis);

  // GFW: persist only, no backfill on import (same reasoning as VF/MT — the
  // enrichment lives in ship_scrape_cache and is restored with the DB).
  if (s.importGfw !== undefined) setImportGfw(s.importGfw);

  if (s.preset && BBOX_PRESETS[s.preset]) setPreset(s.preset);

  clearRiskCache(); // import may have flipped sources that feed the score
  return exportSettings();
}

// Download the portable settings subset as a JSON file (re-importable).
router.get('/settings/export', (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="tracker-porti-impostazioni-${ts}.json"`);
  res.send(JSON.stringify(exportSettings(), null, 2) + '\n');
});

// Apply settings from an uploaded JSON file.
router.post('/settings/import', (req, res) => {
  try {
    const applied = applyImportedSettings(req.body);
    res.json({ ok: true, settings: applied });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/settings', (req, res) => {
  const {
    preset, importVfData: newImportVf, importMtData: newImportMt, importSanctions: newSanctions,
    importSanctionsExtra: newSanctionsExtra, importPsc: newPsc, importEquasis: newEquasis, importGfw: newGfw,
    notificationsEnabled: newNotif, notifyRevisit: newRevisit, notifyAreaChange: newAreaChange,
    notifyHighRisk: newHighRisk, notifyBerthNew: newBerthNew, notifyBerthChar: newBerthChar,
  } = req.body;

  if (newNotif !== undefined) {
    setNotificationsEnabled(newNotif);
    console.log(`[NOTIF] Notifications enabled: ${state.notificationsEnabled}`);
    appLog.info('SETTINGS', appLog.t('settings.notifications', { on: state.notificationsEnabled }));
  }
  if (newRevisit !== undefined) {
    setNotifyRevisit(newRevisit);
    console.log(`[NOTIF] Revisit notifications: ${state.notifyRevisit}`);
  }
  if (newAreaChange !== undefined) {
    setNotifyAreaChange(newAreaChange);
    console.log(`[NOTIF] Area change notifications: ${state.notifyAreaChange}`);
  }
  if (newHighRisk !== undefined) {
    setNotifyHighRisk(newHighRisk);
    console.log(`[NOTIF] High-risk notifications: ${state.notifyHighRisk}`);
  }
  if (newBerthNew !== undefined) {
    setNotifyBerthNew(newBerthNew);
    console.log(`[NOTIF] New-berth notifications: ${state.notifyBerthNew}`);
  }
  if (newBerthChar !== undefined) {
    setNotifyBerthChar(newBerthChar);
    console.log(`[NOTIF] Berth-characterised notifications: ${state.notifyBerthChar}`);
  }

  if (newImportVf !== undefined) {
    const wasDisabled = !state.importVfData;
    setImportVf(newImportVf);
    console.log(`[VF] Import VF data: ${state.importVfData}`);
    appLog.info('SETTINGS', appLog.t('settings.import_vf', { on: state.importVfData }));
    if (state.importVfData && wasDisabled) enrichAllExisting('vf');
  }
  if (newImportMt !== undefined) {
    const wasDisabled = !state.importMtData;
    setImportMt(newImportMt);
    console.log(`[MT] Import MT data: ${state.importMtData}`);
    appLog.info('SETTINGS', appLog.t('settings.import_mt', { on: state.importMtData }));
    if (state.importMtData && wasDisabled) enrichAllExisting('mt');
  }
  // Persist the extra-lists (EU/UK/UN) toggle before the master block so its
  // refresh below sees the correct active source set.
  let extraChanged = false;
  if (newSanctionsExtra !== undefined) {
    extraChanged = state.importSanctionsExtra !== !!newSanctionsExtra;
    setImportSanctionsExtra(newSanctionsExtra);
    console.log(`[SANCTIONS] Extra lists (EU/UK/UN): ${state.importSanctionsExtra}`);
  }
  if (newSanctions !== undefined) {
    const wasDisabled = !state.importSanctions;
    setImportSanctions(newSanctions);
    console.log(`[SANCTIONS] Import sanctions: ${state.importSanctions}`);
    appLog.info('SETTINGS', appLog.t('settings.import_sanctions', { on: state.importSanctions }));
    // First enable (or no data yet) → download the list in the background.
    if (state.importSanctions && (wasDisabled || !sanctions.getStatus().loaded)) {
      sanctions.refresh().catch((e) => console.error(`[SANCTIONS] Refresh failed: ${e.message}`));
    }
  }
  // Extra lists toggled while screening already on: drop them from the index now
  // (disable) or download them in the background (enable).
  if (extraChanged && newSanctions === undefined && state.importSanctions) {
    // Enable → download in the background (refresh rebuilds the index itself).
    // Disable → just reload from disk so the now-inactive lists drop out.
    const reindex = state.importSanctionsExtra ? sanctions.refresh() : sanctions.loadFromDisk();
    Promise.resolve(reindex).catch((e) => console.error(`[SANCTIONS] Refresh failed: ${e.message}`));
  }
  if (newPsc !== undefined) {
    const wasDisabled = !state.importPsc;
    setImportPsc(newPsc);
    console.log(`[PSC] Import PSC data: ${state.importPsc}`);
    appLog.info('SETTINGS', appLog.t('settings.import_psc', { on: state.importPsc }));
    // First enable (or banned list not cached yet) → load bundled flag lists
    // and download the banned list in the background.
    if (state.importPsc && (wasDisabled || !psc.bannedLoaded())) {
      psc.loadFromDisk();
      psc.refresh().catch((e) => console.error(`[PSC] Refresh failed: ${e.message}`));
    }
  }
  if (newEquasis !== undefined) {
    // Manual on-demand lookup: persist the toggle only, no backfill/auto-fetch.
    setImportEquasis(newEquasis);
    console.log(`[EQUASIS] Import Equasis: ${state.importEquasis}`);
  }
  if (newGfw !== undefined) {
    const wasDisabled = !state.importGfw;
    setImportGfw(newGfw);
    console.log(`[GFW] Import GFW data: ${state.importGfw}`);
    appLog.info('SETTINGS', appLog.t('settings.import_gfw', { on: state.importGfw }));
    // First enable → enrich only the ships *currently being monitored* (active
    // window), NOT the 7-day fleet. No token → no attempt (guarded downstream).
    if (state.importGfw && wasDisabled && GFW_TOKEN) enrichActiveShips('gfw');
  }

  // Any toggle above (VF/MT/sanctions/PSC/Equasis) can change which signals feed
  // the risk score, so drop the memoised scores.
  clearRiskCache();

  if (!preset) {
    return res.json({
      ok: true,
      importVfData: state.importVfData,
      importMtData: state.importMtData,
      importSanctions: state.importSanctions,
      importSanctionsExtra: state.importSanctionsExtra,
      sanctions: sanctions.getStatus(),
      importPsc: state.importPsc,
      psc: psc.getStatus(),
      importEquasis: state.importEquasis,
      equasisConfigured,
      importGfw: state.importGfw,
      gfwConfigured,
      notificationsEnabled: state.notificationsEnabled,
      notifyRevisit: state.notifyRevisit,
      notifyAreaChange: state.notifyAreaChange,
      notifyHighRisk: state.notifyHighRisk,
      notifyBerthNew: state.notifyBerthNew,
      notifyBerthChar: state.notifyBerthChar,
    });
  }

  if (!BBOX_PRESETS[preset]) {
    return res
      .status(400)
      .json({ error: `Preset sconosciuto. Validi: ${Object.keys(BBOX_PRESETS).join(', ')}` });
  }

  setPreset(preset);
  console.log(`[AIS] Vista cambiata a: ${state.bboxName}`);
  appLog.info('SETTINGS', appLog.t('settings.view_changed', { name: state.bboxName }), { preset });
  res.json({
    ok: true,
    preset,
    name: state.bboxName,
    bbox: state.boundingBox[0],
    restarted: false,
    importVfData: state.importVfData,
    importMtData: state.importMtData,
    importSanctions: state.importSanctions,
    importSanctionsExtra: state.importSanctionsExtra,
    importPsc: state.importPsc,
    importEquasis: state.importEquasis,
    importGfw: state.importGfw,
  });
});

module.exports = router;
module.exports.exportSettings = exportSettings;
module.exports.applyImportedSettings = applyImportedSettings;
