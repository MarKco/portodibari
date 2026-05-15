'use strict';

const express = require('express');
const {
  state, setPreset, setImportVf, setImportMt, setImportSanctions, setImportPsc, setNotificationsEnabled, setNotifyRevisit,
  setNotifyAreaChange, setNotifyHighRisk, BBOX_PRESETS, currentKeyword,
  POLL_INTERVAL_MS, TRACK_MERGE_RADIUS_M, SOG_FERMA, NOTIF_DELETE_UNDO_SECONDS,
} = require('../config');
const { enrichAllExisting } = require('../services/enrichment');
const sanctions = require('../services/sanctions');
const psc = require('../services/psc');

const router = express.Router();

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

router.post('/settings', (req, res) => {
  const {
    preset, importVfData: newImportVf, importMtData: newImportMt, importSanctions: newSanctions,
    importPsc: newPsc,
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

  if (!preset) {
    return res.json({
      ok: true,
      importVfData: state.importVfData,
      importMtData: state.importMtData,
      importSanctions: state.importSanctions,
      sanctions: sanctions.getStatus(),
      importPsc: state.importPsc,
      psc: psc.getStatus(),
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
  });
});

module.exports = router;
