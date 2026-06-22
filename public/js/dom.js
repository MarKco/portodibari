// Centralised references to long-lived DOM elements, queried once at load.
const $ = (id) => document.getElementById(id);

export const el = {
  // Header / toolbar
  appTitle: $('app-title'),
  badge: $('status-badge'),
  btnStart: $('btn-start'),
  btnStop: $('btn-stop'),
  btnExport: $('btn-export'),
  btnClear: $('btn-clear'),
  counter: $('counter'),
  bboxSelect: $('bbox-select'),

  // Tabs / views
  tabActive: $('tab-active'),
  tabPast: $('tab-past'),
  tabTraffco: $('tab-traffico'),
  activeCount: $('active-count'),
  pastCount: $('past-count'),
  viewActive: $('view-active'),
  viewPast: $('view-past'),
  viewDetail: $('view-detail'),
  viewTraffco: $('view-traffico'),
  mainTabs: $('main-tabs'),
  activeBody: $('active-body'),
  pastBody: $('past-body'),

  // Navi seguite (followed ships) section
  btnFollowed: $('btn-followed'),
  viewFollowed: $('view-followed'),
  followedTabs: $('followed-tabs'),
  tabFollActive: $('tab-foll-active'),
  tabFollPast: $('tab-foll-past'),
  follActiveView: $('foll-active-view'),
  follPastView: $('foll-past-view'),
  follActiveCount: $('foll-active-count'),
  follPastCount: $('foll-past-count'),
  follActiveBody: $('foll-active-body'),
  follPastBody: $('foll-past-body'),

  // Berths overlay (overview map)
  berthsToggle: $('berths-toggle'),
  btnBerthsManage: $('btn-berths-manage'),

  // Auto-backup interval description (rendered dynamically from /api/config)
  autobackupDesc: $('autobackup-desc'),

  // Parameters tab (app.config.properties editor)
  paramsBody: $('params-body'),
  btnParamsSave: $('btn-params-save'),
  paramsDirty: $('params-dirty'),

  // Ship detail
  detailBody: $('detail-body'),
  btnBack: $('btn-back'),
  detailName: $('detail-ship-name'),
  detailMmsiEl: $('detail-ship-mmsi'),
  detailPrev: $('detail-prev'),
  detailNext: $('detail-next'),
  detailPageInfo: $('detail-page-info'),
  detailInfoBar: $('detail-info-bar'),
  btnFlagDetail: $('btn-flag-detail'),
  btnSeenDetail: $('btn-seen-detail'),
  btnFollowDetail: $('btn-follow-detail'),
  btnMilitaryDetail: $('btn-military-detail'),
  btnNotifMuteDetail: $('btn-notif-mute-detail'),
  btnVfDetail: $('btn-vf-detail'),
  btnMtDetail: $('btn-mt-detail'),
  btnEquasisFetch: $('btn-equasis-fetch'),
  btnReportDetail: $('btn-report-detail'),
  detailNotesEl: $('detail-notes'),
  btnSaveNotes: $('btn-save-notes'),

  // Generic modal
  modalOverlay: $('modal-overlay'),
  modalTitle: $('modal-title'),
  modalBody: $('modal-body'),
  modalClose: $('modal-close'),

  // Toast
  toastEl: $('toast'),
  toastTitle: $('toast-title'),
  toastBody: $('toast-body'),
  undoToast: $('undo-toast'),
  undoToastMsg: $('undo-toast-msg'),
  undoToastBtn: $('undo-toast-btn'),
  undoToastCount: $('undo-toast-count'),

  // Navigation
  btnHome: $('btn-home'),

  // Notifications
  btnNotifications: $('btn-notifications'),
  btnNotifClear: $('btn-notif-clear'),
  notifBadge: $('notif-badge'),
  notifList: $('notif-list'),

  // Areas view
  btnAreas: $('btn-areas'),
  viewAreas: $('view-areas'),
  areasBody: $('areas-body'),
  areaName: $('area-name'),
  areaKeyword: $('area-keyword'),
  areaSwLat: $('area-sw-lat'),
  areaSwLon: $('area-sw-lon'),
  areaNeLat: $('area-ne-lat'),
  areaNeLon: $('area-ne-lon'),
  btnAreaCapture: $('btn-area-capture'),
  btnAreaAdd: $('btn-area-add'),
  areaAddError: $('area-add-error'),

  // Settings view
  btnSettings: $('btn-settings'),
  viewSettings: $('view-settings'),
  btnSettingsBack: $('btn-settings-back'),
  toggleImportVf: $('toggle-import-vf'),
  toggleImportMt: $('toggle-import-mt'),
  toggleImportGfw: $('toggle-import-gfw'),
  gfwStatus: $('gfw-status'),
  toggleImportSanctions: $('toggle-import-sanctions'),
  toggleImportSanctionsExtra: $('toggle-import-sanctions-extra'),
  settingSanctionsExtra: $('toggle-import-sanctions-extra')
    ? $('toggle-import-sanctions-extra').closest('.setting-row')
    : null,
  sanctionsStatus: $('sanctions-status'),
  btnSanctionsRefresh: $('btn-sanctions-refresh'),
  toggleImportPsc: $('toggle-import-psc'),
  pscStatus: $('psc-status'),
  btnPscRefresh: $('btn-psc-refresh'),
  toggleNotifications: $('toggle-notifications'),
  toggleNotifyRevisit: $('toggle-notify-revisit'),
  settingNotifyRevisit: $('setting-notify-revisit'),
  toggleNotifyAreaChange: $('toggle-notify-area-change'),
  settingNotifyAreaChange: $('setting-notify-area-change'),
  toggleNotifyHighRisk: $('toggle-notify-high-risk'),
  settingNotifyHighRisk: $('setting-notify-high-risk'),
  toggleNotifyBerthNew: $('toggle-notify-berth-new'),
  settingNotifyBerthNew: $('setting-notify-berth-new'),
  toggleNotifyBerthChar: $('toggle-notify-berth-char'),
  settingNotifyBerthChar: $('setting-notify-berth-char'),
  toggleExcludeTankers: $('toggle-exclude-tankers'),
  toggleCheckSpoofing: $('toggle-check-spoofing'),
  toggleCheckDark: $('toggle-check-dark'),
  toggleOpenSeaMap: $('toggle-openseamap'),
  toggleOpenSeaMapMarkers: $('toggle-openseamap-markers'),
  openSeaMapTypes: $('openseamap-types'),
  cargoWeightsGrid: $('cargo-weights-grid'),
  btnCargoWeightsSave: $('btn-cargo-weights-save'),
  btnCargoWeightsReset: $('btn-cargo-weights-reset'),
  cargoWeightsStatus: $('cargo-weights-status'),
  cargoPresetSelect: $('cargo-preset-select'),
  btnCargoPresetApply: $('btn-cargo-preset-apply'),
  btnCargoPresetSave: $('btn-cargo-preset-save'),
  btnCargoPresetDelete: $('btn-cargo-preset-delete'),
  btnBackup: $('btn-backup'),
  btnRestore: $('btn-restore'),
  restoreFile: $('restore-file'),
  btnBundleExport: $('btn-bundle-export'),
  btnBundleImport: $('btn-bundle-import'),
  bundleFile: $('bundle-file'),
  btnAreasExport: $('btn-areas-export'),
  btnAreasImport: $('btn-areas-import'),
  areasFile: $('areas-file'),
  btnSettingsExport: $('btn-settings-export'),
  btnSettingsImport: $('btn-settings-import'),
  settingsFile: $('settings-file'),
  areaMonitors: $('area-monitors'),
  settingsTabs: $('settings-tabs'),
  settingsPanels: document.querySelectorAll('.settings-panel'),
  settingsPanelGeneral: $('settings-panel-general'),
  settingsPanelAreas: $('settings-panel-areas'),
  settingsPanelBackup: $('settings-panel-backup'),
  btnManualBackup: $('btn-manual-backup'),
  autoBackupList: $('auto-backup-list'),

  // Sanctions match section
  sanctionsDataSection: $('sanctions-data-section'),
  sanctionsDataBody: $('sanctions-data-body'),

  // Scraped data sections
  vfDataSection: $('vf-data-section'),
  vfDataBody: $('vf-data-body'),
  vfCacheBadge: $('vf-cache-badge'),
  mtDataSection: $('mt-data-section'),
  mtDataBody: $('mt-data-body'),
  mtCacheBadge: $('mt-cache-badge'),
  equasisDataSection: $('equasis-data-section'),
  equasisDataBody: $('equasis-data-body'),
  equasisCacheBadge: $('equasis-cache-badge'),
  toggleImportEquasis: $('toggle-import-equasis'),
  btnEquasisLog: $('btn-equasis-log'),
  gfwDataSection: $('gfw-data-section'),
  gfwDataBody: $('gfw-data-body'),
  gfwCacheBadge: $('gfw-cache-badge'),

  // API log panel (Settings → Log API tab)
  btnLogClear: $('btn-log-clear'),
  logLiveBadge: $('log-live-badge'),
  logBody: $('log-body'),
  logAutoScrollChk: $('log-autoscroll'),

  // Application log — sidebar toggle + floating overlay window
  btnLogOverlay: $('btn-log-overlay'),
  logOvWindow: $('log-overlay-window'),
  logOvHeader: $('log-ov-header'),
  logOvBody: $('log-ov-body'),
  logOvLive: $('log-ov-live'),
  logOvClear: $('log-ov-clear'),
  logOvClose: $('log-ov-close'),

  // Application log — Settings → Log tab
  toggleAppLog: $('toggle-app-log'),
  appLogBody: $('app-log-body'),
  appLogLive: $('app-log-live'),
  appLogClear: $('btn-app-log-clear'),

  // Health panel (Settings → Diagnostica AIS tab)
  healthBody: $('health-body'),
};
