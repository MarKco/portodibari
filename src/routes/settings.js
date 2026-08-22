'use strict';

const express = require('express');
const {
  state, setImportVf, setImportMt, setImportSf, setImportMst, setImportSanctions, setImportSanctionsExtra, setImportPsc, setImportEquasis, setImportGfw,
  setExcludeTankers, setCheckSpoofing, setCheckDarkActivity, setCargoWeights, setCargoWeightsPreset, DEFAULT_CARGO_WEIGHTS, BBOX_PRESETS, currentKeyword,
  setRiskWeights, setRiskWeightsPreset, DEFAULT_RISK_WEIGHTS, EDITABLE_RISK_WEIGHTS,
  setSfScrapeInterval, setMstScrapeInterval, setScrapeClusterRadius, setFallbackScopeAreas,
  POLL_INTERVAL_MS, TRACK_MERGE_RADIUS_M, SOG_FERMA, NOTIF_DELETE_UNDO_SECONDS,
  BACKUP_INTERVAL_MIN, REPLAY, FOLLOW_STALE_HOURS,
  EQUASIS_USER, EQUASIS_PASSWORD, GFW_TOKEN,
} = require('../config');
const db = require('../db');
const userPrefs = require('../services/user-prefs');
const groupSync = require('../services/group-sync');
const { requireAdmin } = require('../middleware/session-auth');
const { CARGO_CLASSES } = require('../services/cargo-type');
const { CATEGORIES: NOTIFY_CATEGORIES } = require('../services/notify-categories');
const cargoPresets = require('../services/cargo-presets');
const riskPresets = require('../services/risk-presets');

// True if the session owner is an admin (impersonation never grants admin).
function isAdminReq(req) {
  return !!(req.realUser && req.realUser.role === 'admin');
}

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
const fallbackMode = require('../services/fallback-mode');

const router = express.Router();

// Equasis lookup audit log — read the plain-text trail of past lookups (shown in
// the Settings modal) and clear it.
router.get('/equasis-log', requireAdmin, (req, res) => {
  res.json(equasisLog.read());
});

router.delete('/equasis-log', requireAdmin, (req, res) => {
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
    replayMaxGapMin: REPLAY.MAX_GAP_MIN,
    replayTailMin: REPLAY.TAIL_MIN,
    followStaleHours: FOLLOW_STALE_HOURS,
  });
});

router.get('/settings', (req, res) => {
  const prefs = userPrefs.get(req.user.id);
  // The user's view preset: their saved default area if still owned, else the
  // first area they monitor (only the user's own areas are offered).
  const myKeys = db.getUserAreaKeys(req.user.id);
  const preset = (prefs.defaultArea && myKeys.includes(prefs.defaultArea)) ? prefs.defaultArea : (myKeys[0] || null);
  res.json({
    isAdmin: isAdminReq(req),
    preset,
    keyword: currentKeyword(preset),
    presets: Object.fromEntries(
      myKeys
        .filter((k) => BBOX_PRESETS[k])
        .map((k) => [k, { name: BBOX_PRESETS[k].name, bbox: BBOX_PRESETS[k].box[0], keyword: BBOX_PRESETS[k].keyword }])
    ),
    // ── Personal (per-user) ──
    notificationsEnabled: prefs.notificationsEnabled,
    notifyRevisit: prefs.notifyRevisit,
    notifyAreaChange: prefs.notifyAreaChange,
    notifyHighRisk: prefs.notifyHighRisk,
    notifyBerthNew: prefs.notifyBerthNew,
    notifyBerthChar: prefs.notifyBerthChar,
    notifyProximity: prefs.notifyProximity,
    notifyShipTypesHidden: prefs.notifyShipTypesHidden,
    notifyIncludeSeen: prefs.notifyIncludeSeen,
    notifyShipCategories: NOTIFY_CATEGORIES,
    notifyGroupArea: prefs.notifyGroupArea,
    notifyGroupFollow: prefs.notifyGroupFollow,
    notifyGroupFlag: prefs.notifyGroupFlag,
    notifyGroupMute: prefs.notifyGroupMute,
    notifyGroupSeen: prefs.notifyGroupSeen,
    notifyGroupCharge: prefs.notifyGroupCharge,
    webhookNotifyGroupArea: prefs.webhookNotifyGroupArea,
    webhookNotifyGroupFollow: prefs.webhookNotifyGroupFollow,
    webhookNotifyGroupFlag: prefs.webhookNotifyGroupFlag,
    webhookNotifyGroupMute: prefs.webhookNotifyGroupMute,
    webhookNotifyGroupSeen: prefs.webhookNotifyGroupSeen,
    webhookNotifyGroupCharge: prefs.webhookNotifyGroupCharge,
    showOpenSeaMap: prefs.showOpenSeaMap,
    showOpenSeaMapMarkers: prefs.showOpenSeaMapMarkers,
    openSeaMapHidden: prefs.openSeaMapHidden,
    showFollowedShipNames: prefs.showFollowedShipNames,
    showFollowedTrails: prefs.showFollowedTrails,
    showActiveShipNames: prefs.showActiveShipNames,
    showActiveTrails: prefs.showActiveTrails,
    hideHeatmapSingletons: prefs.hideHeatmapSingletons,
    // ── Global (admin-managed; shown read-only to non-admins) ──
    importVfData: state.importVfData,
    importMtData: state.importMtData,
    importSfData: state.importSfData,
    importMstData: state.importMstData,
    sfScrapeIntervalMs: state.sfScrapeIntervalMs,
    mstScrapeIntervalMs: state.mstScrapeIntervalMs,
    scrapeClusterRadiusM: state.scrapeClusterRadiusM,
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
    excludeTankers: state.excludeTankers,
    checkSpoofing: state.checkSpoofing,
    checkDarkActivity: state.checkDarkActivity,
    cargoClasses: CARGO_CLASSES,
    cargoWeights: state.cargoWeights,
    defaultCargoWeights: DEFAULT_CARGO_WEIGHTS,
    cargoWeightsPreset: state.cargoWeightsPreset,
    cargoPresets: cargoPresets.listPresets(),
    // Live-editable risk-signal weights (admin-managed). riskWeightKeys gives the
    // editable subset in display order; riskWeights holds only those keys.
    riskWeightKeys: EDITABLE_RISK_WEIGHTS,
    riskWeights: Object.fromEntries(EDITABLE_RISK_WEIGHTS.map((k) => [k, state.riskWeights[k]])),
    defaultRiskWeights: DEFAULT_RISK_WEIGHTS,
    riskWeightsPreset: state.riskWeightsPreset,
    riskPresets: riskPresets.listPresets(),
  });
});

// Update the per-cargo-type risk weights and drop the memoised scores so the
// next read reflects the new weighting. Accepts a partial { class: weight } map.
router.post('/settings/cargo-weights', requireAdmin, (req, res) => {
  const map = req.body && req.body.cargoWeights ? req.body.cargoWeights : req.body;
  const weights = setCargoWeights(map);
  // A manual edit detaches the live weights from any named preset → "custom".
  const preset = setCargoWeightsPreset(null);
  clearRiskCache();
  appLog.info('SETTINGS', appLog.t('settings.cargo_weights'));
  res.json({ ok: true, cargoWeights: weights, cargoWeightsPreset: preset });
});

// ── Weight presets ("classi di pesi") ────────────────────────────────────────
// List built-in + user presets (the same payload GET /settings embeds, exposed
// standalone so the UI can refresh the list after a save/delete).
router.get('/settings/cargo-presets', (req, res) => {
  res.json({ presets: cargoPresets.listPresets(), active: state.cargoWeightsPreset });
});

// Apply a preset: copy its weights into the live set and remember the id.
router.post('/settings/cargo-presets/apply', requireAdmin, (req, res) => {
  const id = req.body && req.body.id;
  const preset = cargoPresets.getPreset(id);
  if (!preset) return res.status(404).json({ error: 'Preset sconosciuto' });
  const weights = setCargoWeights(preset.weights);
  const active = setCargoWeightsPreset(preset.id);
  clearRiskCache();
  appLog.info('SETTINGS', appLog.t('settings.cargo_preset_applied', { name: preset.name }));
  res.json({ ok: true, cargoWeights: weights, cargoWeightsPreset: active });
});

// Save the current live weights as a named user preset (stored in the DB, so it
// survives a backup/restore). Returns the refreshed preset list.
router.post('/settings/cargo-presets', requireAdmin, (req, res) => {
  try {
    const name = req.body && req.body.name;
    // Save whatever weights the caller passes, else the current live weights.
    const weights = req.body && req.body.weights ? req.body.weights : state.cargoWeights;
    const saved = cargoPresets.savePreset(name, weights);
    // Treat the just-saved set as the active preset (the live weights match it).
    setCargoWeights(saved.weights);
    const active = setCargoWeightsPreset(saved.id);
    clearRiskCache();
    appLog.info('SETTINGS', appLog.t('settings.cargo_preset_saved', { name: saved.name }));
    res.json({ ok: true, preset: saved, presets: cargoPresets.listPresets(), cargoWeights: state.cargoWeights, cargoWeightsPreset: active });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete a user preset. If it was the active one, the live weights are kept but
// detached (active → custom).
router.delete('/settings/cargo-presets/:id', requireAdmin, (req, res) => {
  try {
    const id = req.params.id;
    const removed = cargoPresets.deletePreset(id);
    if (!removed) return res.status(404).json({ error: 'Preset sconosciuto' });
    let active = state.cargoWeightsPreset;
    if (active === id) active = setCargoWeightsPreset(null);
    res.json({ ok: true, presets: cargoPresets.listPresets(), cargoWeightsPreset: active });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Risk-signal weights (live-editable, mirrors the cargo-weights endpoints) ──
// Update the point-contribution weights and drop memoised scores so the next
// read reflects the new weighting. Accepts a partial { KEY: weight } map.
router.post('/settings/risk-weights', requireAdmin, (req, res) => {
  const map = req.body && req.body.riskWeights ? req.body.riskWeights : req.body;
  const weights = setRiskWeights(map);
  const preset = setRiskWeightsPreset(null); // a manual edit → "custom"
  clearRiskCache();
  appLog.info('SETTINGS', appLog.t('settings.risk_weights'));
  res.json({ ok: true, riskWeights: weights, riskWeightsPreset: preset });
});

router.get('/settings/risk-presets', (req, res) => {
  res.json({ presets: riskPresets.listPresets(), active: state.riskWeightsPreset });
});

router.post('/settings/risk-presets/apply', requireAdmin, (req, res) => {
  const id = req.body && req.body.id;
  const preset = riskPresets.getPreset(id);
  if (!preset) return res.status(404).json({ error: 'Preset sconosciuto' });
  const weights = setRiskWeights(preset.weights);
  const active = setRiskWeightsPreset(preset.id);
  clearRiskCache();
  appLog.info('SETTINGS', appLog.t('settings.risk_preset_applied', { name: preset.name }));
  res.json({ ok: true, riskWeights: weights, riskWeightsPreset: active });
});

router.post('/settings/risk-presets', requireAdmin, (req, res) => {
  try {
    const name = req.body && req.body.name;
    const weights = req.body && req.body.weights ? req.body.weights : state.riskWeights;
    const saved = riskPresets.savePreset(name, weights);
    setRiskWeights(saved.weights);
    const active = setRiskWeightsPreset(saved.id);
    clearRiskCache();
    appLog.info('SETTINGS', appLog.t('settings.risk_preset_saved', { name: saved.name }));
    res.json({ ok: true, preset: saved, presets: riskPresets.listPresets(), riskWeights: state.riskWeights, riskWeightsPreset: active });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/settings/risk-presets/:id', requireAdmin, (req, res) => {
  try {
    const id = req.params.id;
    const removed = riskPresets.deletePreset(id);
    if (!removed) return res.status(404).json({ error: 'Preset sconosciuto' });
    let active = state.riskWeightsPreset;
    if (active === id) active = setRiskWeightsPreset(null);
    res.json({ ok: true, presets: riskPresets.listPresets(), riskWeightsPreset: active });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Manually re-download the sanctions list (OFAC SDN). Fire-and-forget refresh;
// returns the dataset status so the UI can reflect "refreshing in progress".
router.post('/sanctions/refresh', requireAdmin, (req, res) => {
  appLog.info('SANCTIONS', appLog.t('sanctions.manual_started'));
  sanctions
    .refresh()
    .then(() => clearRiskCache()) // new list contents can change matches
    .catch((e) => console.error(`[SANCTIONS] Manual refresh failed: ${e.message}`));
  res.json({ ok: true, sanctions: sanctions.getStatus() });
});

// Manually re-download the PSC banned list + reload bundled flag lists.
router.post('/psc/refresh', requireAdmin, (req, res) => {
  appLog.info('PSC', appLog.t('psc.manual_started'));
  psc
    .refresh()
    .then(() => clearRiskCache()) // new flag/banned data can change matches
    .catch((e) => console.error(`[PSC] Manual refresh failed: ${e.message}`));
  res.json({ ok: true, psc: psc.getStatus() });
});

// The persisted, portable subset of settings (all the on/off toggles + the
// active view preset). Shared by the export route and the full-bundle export.
// GLOBAL (admin-managed) settings only. Per-user prefs (notifications, map
// display, default area) live in the user_settings table and ride along with the
// database backup, so they are NOT part of this portable settings blob.
function exportSettings() {
  return {
    importVfData: state.importVfData,
    importMtData: state.importMtData,
    importSfData: state.importSfData,
    importMstData: state.importMstData,
    sfScrapeIntervalMs: state.sfScrapeIntervalMs,
    mstScrapeIntervalMs: state.mstScrapeIntervalMs,
    scrapeClusterRadiusM: state.scrapeClusterRadiusM,
    importSanctions: state.importSanctions,
    importSanctionsExtra: state.importSanctionsExtra,
    importPsc: state.importPsc,
    importEquasis: state.importEquasis,
    importGfw: state.importGfw,
    excludeTankers: state.excludeTankers,
    checkSpoofing: state.checkSpoofing,
    checkDarkActivity: state.checkDarkActivity,
    cargoWeights: state.cargoWeights,
    cargoWeightsPreset: state.cargoWeightsPreset,
    riskWeights: Object.fromEntries(EDITABLE_RISK_WEIGHTS.map((k) => [k, state.riskWeights[k]])),
    riskWeightsPreset: state.riskWeightsPreset,
    // NOT re-applied by fallbackMode.enter() itself — that always resets scope
    // to "follow only" on a fresh inactive→active transition, by design (an
    // admin's earlier "monitoraggio completo" choice must never silently carry
    // over into a NEW outage they haven't looked at yet). This only matters
    // when a restore's `meta.fallback_mode_active` is already '1' (read live
    // by fallbackMode.isActive() on every sweep, not cached) — enter() is never
    // called in that case, so without this the restored scope choice would be
    // silently lost even though fallback mode itself is already running.
    fallbackScopeAreas: state.fallbackScopeAreas,
  };
}

// Apply an imported settings object, firing the same "freshly enabled" side
// effects as the interactive POST /settings handler (enrichment backfill,
// list downloads). Unknown/absent fields are left untouched. The preset is only
// switched when it names an existing area. Shared by /settings/import and the
// full-bundle import. Returns the resulting exportSettings() snapshot.
function applyImportedSettings(s) {
  if (!s || typeof s !== 'object') throw new Error('File impostazioni non valido');

  if (s.excludeTankers !== undefined) setExcludeTankers(s.excludeTankers);
  if (s.checkSpoofing !== undefined) setCheckSpoofing(s.checkSpoofing);
  if (s.checkDarkActivity !== undefined) setCheckDarkActivity(s.checkDarkActivity);
  // Per-cargo-type risk weights. Null-safe: an older bundle (pre-feature) omits
  // this key, so the local defaults are kept; setCargoWeights drops unknown
  // classes and clamps values, so a malformed/partial map can't corrupt state.
  if (s.cargoWeights !== undefined) setCargoWeights(s.cargoWeights);
  // Active-preset id (UI hint). User presets themselves live in the DB `meta`
  // table and ride along with the database restore, so nothing to apply here
  // beyond remembering which one was selected.
  if (s.cargoWeightsPreset !== undefined) setCargoWeightsPreset(s.cargoWeightsPreset);

  // VF/MT toggles: persist only — do NOT backfill. The scraped data lives in
  // ship_scrape_cache, which is part of the DB backup and is restored alongside
  // the ships. Re-scraping every loaded vessel on restore would hammer
  // VesselFinder/MarineTraffic for no gain (the data is already in the DB).
  // The interactive POST /settings handler still backfills on a live toggle.
  if (s.importVfData !== undefined) setImportVf(s.importVfData);
  if (s.importMtData !== undefined) setImportMt(s.importMtData);
  if (s.importSfData !== undefined) setImportSf(s.importSfData);
  if (s.importMstData !== undefined) setImportMst(s.importMstData);
  if (s.sfScrapeIntervalMs != null) setSfScrapeInterval(+s.sfScrapeIntervalMs);
  if (s.mstScrapeIntervalMs != null) setMstScrapeInterval(+s.mstScrapeIntervalMs);
  if (s.scrapeClusterRadiusM != null) setScrapeClusterRadius(+s.scrapeClusterRadiusM);
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

  // Fallback-mode scope: persist only. Does NOT itself activate/deactivate
  // fallback mode (that's meta.fallback_mode_active, restored with the DB) —
  // this only decides which scope fallback mode uses IF/when it's active, and
  // never overrides enter()'s own "reset to follow-only" on a genuinely fresh
  // outage (see the comment on exportSettings above).
  if (s.fallbackScopeAreas !== undefined) setFallbackScopeAreas(s.fallbackScopeAreas);

  clearRiskCache(); // import may have flipped sources that feed the score
  return exportSettings();
}

// Download the portable settings subset as a JSON file (re-importable).
router.get('/settings/export', requireAdmin, (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="tracker-porti-impostazioni-${ts}.json"`);
  res.send(JSON.stringify(exportSettings(), null, 2) + '\n');
});

// Apply settings from an uploaded JSON file.
router.post('/settings/import', requireAdmin, (req, res) => {
  try {
    const applied = applyImportedSettings(req.body);
    res.json({ ok: true, settings: applied });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/settings', (req, res) => {
  const b = req.body || {};
  const uid = req.user.id;

  // ── Personal settings (any user) ──
  const personalKeys = [
    'notificationsEnabled', 'notifyRevisit', 'notifyAreaChange', 'notifyHighRisk',
    'notifyBerthNew', 'notifyBerthChar', 'notifyProximity', 'notifyShipTypesHidden', 'notifyIncludeSeen',
    'notifyGroupArea', 'notifyGroupFollow', 'notifyGroupFlag', 'notifyGroupMute', 'notifyGroupSeen', 'notifyGroupCharge',
    'webhookNotifyGroupArea', 'webhookNotifyGroupFollow', 'webhookNotifyGroupFlag',
    'webhookNotifyGroupMute', 'webhookNotifyGroupSeen', 'webhookNotifyGroupCharge',
    'showOpenSeaMap', 'showOpenSeaMapMarkers', 'openSeaMapHidden',
    'showFollowedShipNames', 'showFollowedTrails', 'showActiveShipNames', 'showActiveTrails',
    'hideHeatmapSingletons',
  ];
  const personalPatch = {};
  for (const k of personalKeys) if (b[k] !== undefined) personalPatch[k] = b[k];
  if (Object.keys(personalPatch).length) userPrefs.set(uid, personalPatch);

  // Default view area (per-user). Must be one of the user's own areas.
  if (b.preset !== undefined && b.preset !== null && b.preset !== '') {
    if (!db.getUserAreaKeys(uid).includes(b.preset)) {
      return res.status(400).json({ error: 'Area non assegnata' });
    }
    userPrefs.set(uid, { defaultArea: b.preset });
  }

  // Mirror the shared personal prefs (notif/map toggles + default area) onto the
  // user's group co-members, so the whole group stays in sync.
  const sharedPatch = { ...personalPatch };
  if (b.preset !== undefined && b.preset !== null && b.preset !== '') sharedPatch.defaultArea = b.preset;
  groupSync.syncSettings(uid, sharedPatch);

  // ── Global settings (admin only) ──
  const {
    importVfData: newImportVf, importMtData: newImportMt, importSfData: newImportSf, importMstData: newImportMst, importSanctions: newSanctions,
    importSanctionsExtra: newSanctionsExtra, importPsc: newPsc, importEquasis: newEquasis, importGfw: newGfw,
    excludeTankers: newExcludeTankers, checkSpoofing: newCheckSpoofing, checkDarkActivity: newCheckDarkActivity,
  } = b;
  const globalTouched = [newImportVf, newImportMt, newImportSf, newImportMst, newSanctions, newSanctionsExtra, newPsc, newEquasis, newGfw, newExcludeTankers, newCheckSpoofing, newCheckDarkActivity].some((v) => v !== undefined);
  if (globalTouched && !isAdminReq(req)) {
    return res.status(403).json({ error: 'Solo un amministratore può modificare le impostazioni globali (sorgenti dati, rischio).' });
  }

  if (newExcludeTankers !== undefined) {
    setExcludeTankers(newExcludeTankers);
    console.log(`[RISK] Exclude tankers from type score: ${state.excludeTankers}`);
    appLog.info('SETTINGS', appLog.t('settings.exclude_tankers', { on: state.excludeTankers }));
  }
  if (newCheckSpoofing !== undefined) {
    setCheckSpoofing(newCheckSpoofing);
    console.log(`[RISK] Check position spoofing: ${state.checkSpoofing}`);
    appLog.info('SETTINGS', appLog.t('settings.check_spoofing', { on: state.checkSpoofing }));
  }
  if (newCheckDarkActivity !== undefined) {
    setCheckDarkActivity(newCheckDarkActivity);
    console.log(`[RISK] Check AIS blackout: ${state.checkDarkActivity}`);
    appLog.info('SETTINGS', appLog.t('settings.check_dark', { on: state.checkDarkActivity }));
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
  if (newImportSf !== undefined) {
    const wasDisabled = !state.importSfData;
    setImportSf(newImportSf);
    console.log(`[SF] Import SF data: ${state.importSfData}`);
    appLog.info('SETTINGS', appLog.t('settings.import_sf', { on: state.importSfData }));
    if (state.importSfData && wasDisabled) enrichAllExisting('sf');
  }
  if (newImportMst !== undefined) {
    const wasDisabled = !state.importMstData;
    setImportMst(newImportMst);
    console.log(`[MST] Import MST data: ${state.importMstData}`);
    appLog.info('SETTINGS', appLog.t('settings.import_mst', { on: state.importMstData }));
    if (state.importMstData && wasDisabled) enrichAllExisting('mst');
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

  // Any global toggle above (VF/MT/sanctions/PSC/Equasis/GFW) can change which
  // signals feed the risk score, so drop the memoised scores.
  if (globalTouched) clearRiskCache();

  // Echo back the resulting state (personal prefs + global flags).
  const prefs = userPrefs.get(uid);
  const myKeys = db.getUserAreaKeys(uid);
  const effPreset = (prefs.defaultArea && myKeys.includes(prefs.defaultArea)) ? prefs.defaultArea : (myKeys[0] || null);
  const effArea = effPreset && BBOX_PRESETS[effPreset] ? BBOX_PRESETS[effPreset] : null;
  res.json({
    ok: true,
    isAdmin: isAdminReq(req),
    preset: effPreset,
    // name + bbox of the (possibly newly-selected) view area, so the client can
    // recenter the map after an area change.
    name: effArea ? effArea.name : null,
    bbox: effArea ? effArea.box[0] : null,
    notificationsEnabled: prefs.notificationsEnabled,
    notifyRevisit: prefs.notifyRevisit,
    notifyAreaChange: prefs.notifyAreaChange,
    notifyHighRisk: prefs.notifyHighRisk,
    notifyBerthNew: prefs.notifyBerthNew,
    notifyBerthChar: prefs.notifyBerthChar,
    notifyProximity: prefs.notifyProximity,
    notifyShipTypesHidden: prefs.notifyShipTypesHidden,
    notifyIncludeSeen: prefs.notifyIncludeSeen,
    notifyGroupArea: prefs.notifyGroupArea,
    notifyGroupFollow: prefs.notifyGroupFollow,
    notifyGroupFlag: prefs.notifyGroupFlag,
    notifyGroupMute: prefs.notifyGroupMute,
    notifyGroupSeen: prefs.notifyGroupSeen,
    notifyGroupCharge: prefs.notifyGroupCharge,
    webhookNotifyGroupArea: prefs.webhookNotifyGroupArea,
    webhookNotifyGroupFollow: prefs.webhookNotifyGroupFollow,
    webhookNotifyGroupFlag: prefs.webhookNotifyGroupFlag,
    webhookNotifyGroupMute: prefs.webhookNotifyGroupMute,
    webhookNotifyGroupSeen: prefs.webhookNotifyGroupSeen,
    webhookNotifyGroupCharge: prefs.webhookNotifyGroupCharge,
    showOpenSeaMap: prefs.showOpenSeaMap,
    showOpenSeaMapMarkers: prefs.showOpenSeaMapMarkers,
    openSeaMapHidden: prefs.openSeaMapHidden,
    showFollowedShipNames: prefs.showFollowedShipNames,
    showFollowedTrails: prefs.showFollowedTrails,
    showActiveShipNames: prefs.showActiveShipNames,
    showActiveTrails: prefs.showActiveTrails,
    hideHeatmapSingletons: prefs.hideHeatmapSingletons,
    importVfData: state.importVfData,
    importMtData: state.importMtData,
    importSfData: state.importSfData,
    importMstData: state.importMstData,
    sfScrapeIntervalMs: state.sfScrapeIntervalMs,
    mstScrapeIntervalMs: state.mstScrapeIntervalMs,
    scrapeClusterRadiusM: state.scrapeClusterRadiusM,
    importSanctions: state.importSanctions,
    importSanctionsExtra: state.importSanctionsExtra,
    sanctions: sanctions.getStatus(),
    importPsc: state.importPsc,
    psc: psc.getStatus(),
    importEquasis: state.importEquasis,
    equasisConfigured,
    importGfw: state.importGfw,
    gfwConfigured,
    excludeTankers: state.excludeTankers,
    checkSpoofing: state.checkSpoofing,
    checkDarkActivity: state.checkDarkActivity,
  });
});

// Update the per-source scrape intervals and spatial clustering radius.
router.post('/settings/scrape-params', requireAdmin, (req, res) => {
  const { sfScrapeIntervalMs, mstScrapeIntervalMs, scrapeClusterRadiusM } = req.body || {};
  if (sfScrapeIntervalMs != null) setSfScrapeInterval(+sfScrapeIntervalMs);
  if (mstScrapeIntervalMs != null) setMstScrapeInterval(+mstScrapeIntervalMs);
  if (scrapeClusterRadiusM != null) setScrapeClusterRadius(+scrapeClusterRadiusM);
  appLog.info('SETTINGS', `Scraping params: SF ${Math.round(state.sfScrapeIntervalMs / 60000)}min, MST ${Math.round(state.mstScrapeIntervalMs / 60000)}min, cluster ${state.scrapeClusterRadiusM}m`);
  res.json({ ok: true, sfScrapeIntervalMs: state.sfScrapeIntervalMs, mstScrapeIntervalMs: state.mstScrapeIntervalMs, scrapeClusterRadiusM: state.scrapeClusterRadiusM });
});

// "Modalità fallback" admin panel: scope switch (always readable/settable, not
// only while fallback is active — an admin can explore/test it any time) +
// history/estimate for the comparison chart. See services/fallback-mode.js.
router.post('/settings/fallback-scope', requireAdmin, (req, res) => {
  const { areas } = req.body || {};
  setFallbackScopeAreas(!!areas);
  appLog.info('SETTINGS', `Modalità fallback: scope impostato su "${state.fallbackScopeAreas ? 'monitoraggio completo' : 'solo navi seguite'}"`);
  res.json({ ok: true, scope: state.fallbackScopeAreas ? 'areas' : 'follow' });
});

router.get('/settings/fallback-mode/estimate', requireAdmin, (req, res) => {
  res.json(fallbackMode.getEstimate());
});

module.exports = router;
module.exports.exportSettings = exportSettings;
module.exports.applyImportedSettings = applyImportedSettings;
