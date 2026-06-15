'use strict';

const express = require('express');
const {
  state, setPreset, setImportVf, setImportMt, setImportSanctions, setImportPsc, setImportEquasis, setNotificationsEnabled, setNotifyRevisit,
  setNotifyAreaChange, setNotifyHighRisk, BBOX_PRESETS, currentKeyword,
  POLL_INTERVAL_MS, TRACK_MERGE_RADIUS_M, SOG_FERMA, NOTIF_DELETE_UNDO_SECONDS,
  EQUASIS_USER, EQUASIS_PASSWORD,
} = require('../config');

// Whether Equasis credentials are present (the lookup is unusable without them).
const equasisConfigured = !!(EQUASIS_USER && EQUASIS_PASSWORD);
const { enrichAllExisting } = require('../services/enrichment');
const sanctions = require('../services/sanctions');
const psc = require('../services/psc');
const equasisLog = require('../services/equasis-log');

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
    sanctions: sanctions.getStatus(),
    importPsc: state.importPsc,
    psc: psc.getStatus(),
    importEquasis: state.importEquasis,
    equasisConfigured,
    notificationsEnabled: state.notificationsEnabled,
    notifyRevisit: state.notifyRevisit,
    notifyAreaChange: state.notifyAreaChange,
    notifyHighRisk: state.notifyHighRisk,
  });
});

// Manually re-download the sanctions list (OFAC SDN). Fire-and-forget refresh;
// returns the dataset status so the UI can reflect "refreshing in progress".
router.post('/sanctions/refresh', (req, res) => {
  sanctions.refresh().catch((e) => console.error(`[SANCTIONS] Manual refresh failed: ${e.message}`));
  res.json({ ok: true, sanctions: sanctions.getStatus() });
});

// Manually re-download the PSC banned list + reload bundled flag lists.
router.post('/psc/refresh', (req, res) => {
  psc.refresh().catch((e) => console.error(`[PSC] Manual refresh failed: ${e.message}`));
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
    importPsc: state.importPsc,
    importEquasis: state.importEquasis,
    notificationsEnabled: state.notificationsEnabled,
    notifyRevisit: state.notifyRevisit,
    notifyAreaChange: state.notifyAreaChange,
    notifyHighRisk: state.notifyHighRisk,
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

  if (s.importVfData !== undefined) {
    const wasDisabled = !state.importVfData;
    setImportVf(s.importVfData);
    if (state.importVfData && wasDisabled) enrichAllExisting('vf');
  }
  if (s.importMtData !== undefined) {
    const wasDisabled = !state.importMtData;
    setImportMt(s.importMtData);
    if (state.importMtData && wasDisabled) enrichAllExisting('mt');
  }
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

  if (s.preset && BBOX_PRESETS[s.preset]) setPreset(s.preset);

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
    importPsc: newPsc, importEquasis: newEquasis,
    notificationsEnabled: newNotif, notifyRevisit: newRevisit, notifyAreaChange: newAreaChange,
    notifyHighRisk: newHighRisk,
  } = req.body;

  if (newNotif !== undefined) {
    setNotificationsEnabled(newNotif);
    console.log(`[NOTIF] Notifications enabled: ${state.notificationsEnabled}`);
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

  if (newImportVf !== undefined) {
    const wasDisabled = !state.importVfData;
    setImportVf(newImportVf);
    console.log(`[VF] Import VF data: ${state.importVfData}`);
    if (state.importVfData && wasDisabled) enrichAllExisting('vf');
  }
  if (newImportMt !== undefined) {
    const wasDisabled = !state.importMtData;
    setImportMt(newImportMt);
    console.log(`[MT] Import MT data: ${state.importMtData}`);
    if (state.importMtData && wasDisabled) enrichAllExisting('mt');
  }
  if (newSanctions !== undefined) {
    const wasDisabled = !state.importSanctions;
    setImportSanctions(newSanctions);
    console.log(`[SANCTIONS] Import sanctions: ${state.importSanctions}`);
    // First enable (or no data yet) → download the list in the background.
    if (state.importSanctions && (wasDisabled || !sanctions.getStatus().loaded)) {
      sanctions.refresh().catch((e) => console.error(`[SANCTIONS] Refresh failed: ${e.message}`));
    }
  }
  if (newPsc !== undefined) {
    const wasDisabled = !state.importPsc;
    setImportPsc(newPsc);
    console.log(`[PSC] Import PSC data: ${state.importPsc}`);
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

  if (!preset) {
    return res.json({
      ok: true,
      importVfData: state.importVfData,
      importMtData: state.importMtData,
      importSanctions: state.importSanctions,
      sanctions: sanctions.getStatus(),
      importPsc: state.importPsc,
      psc: psc.getStatus(),
      importEquasis: state.importEquasis,
      equasisConfigured,
      notificationsEnabled: state.notificationsEnabled,
      notifyRevisit: state.notifyRevisit,
      notifyAreaChange: state.notifyAreaChange,
      notifyHighRisk: state.notifyHighRisk,
    });
  }

  if (!BBOX_PRESETS[preset]) {
    return res
      .status(400)
      .json({ error: `Preset sconosciuto. Validi: ${Object.keys(BBOX_PRESETS).join(', ')}` });
  }

  setPreset(preset);
  console.log(`[AIS] Vista cambiata a: ${state.bboxName}`);
  res.json({
    ok: true,
    preset,
    name: state.bboxName,
    bbox: state.boundingBox[0],
    restarted: false,
    importVfData: state.importVfData,
    importMtData: state.importMtData,
    importSanctions: state.importSanctions,
    importPsc: state.importPsc,
    importEquasis: state.importEquasis,
  });
});

module.exports = router;
module.exports.exportSettings = exportSettings;
module.exports.applyImportedSettings = applyImportedSettings;
