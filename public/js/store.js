// Constants and shared mutable UI state. State lives on a single object so that
// mutations from any module are visible everywhere (ES-module live bindings do
// not allow reassigning imported primitives).

export const PAGE_SIZE = 50;

export const S = {
  // Runtime config (fetched from /api/config at startup; defaults match app.config.properties)
  pollIntervalMs: 300000,
  trackMergeRadiusM: 100,
  trackSogStop: 0.5,
  notifDeleteUndoSeconds: 5,
  // View / detail
  view: 'active', // 'active' | 'past' | 'detail' | 'traffico' | 'areas' | 'settings'
  detailMmsi: null,
  detailFrom: 'active',
  settingsFrom: 'active',
  detailShipData: null,
  detailPage: 0,
  detailTotal: 0,

  // Stream / polling / settings
  streamActive: false,
  pollTimer: null,
  importVfData: false,
  importMtData: false,
  importSanctions: false,
  importSanctionsExtra: true,
  importPsc: false,
  importEquasis: false,
  equasisConfigured: false,
  importGfw: true,
  gfwConfigured: false,
  appLogEnabled: true,
  notificationsEnabled: true,
  notifyRevisit: true,
  notifyAreaChange: true,
  notifyHighRisk: true,
  notifyBerthNew: true,
  notifyBerthChar: true,
  excludeTankers: false,
  checkSpoofing: true,
  checkDarkActivity: true,
  cargoClasses: null,
  cargoWeights: null,
  defaultCargoWeights: null,
  cargoPresets: null,
  cargoWeightsPreset: null,
  currentPreset: '',

  // List filters (client-side, applied before sort/render)
  activeFilter: { q: '', band: '', inPort: false, flagged: false },
  pastFilter: { q: '', band: '', flagged: false },
  allStreamStatus: {},
  presets: {},

  // Maps
  aisMap: null,
  trackLayer: null,
  activeMap: null,
  activeMarkersLayer: null,
  activeShipsCache: new Map(),
  currentBbox: null, // [[swLat, swLon], [neLat, neLon]]

  // Berths (mooring characterization overlay on the overview map)
  berthsLayer: null,
  berthsList: [], // last-fetched berth descriptors for the current area
  showBerths: false, // overlay toggle (persisted in localStorage)
  berthsMinMoorings: 10,
  berthsDominantPct: 60,
  berthMergeSel: new Set(), // ids checked in the manager for merging

  // Areas screen
  areasMap: null,
  areasLayer: null, // existing-area rectangles
  areaCandidateLayer: null, // dashed preview rectangle for the area being added
  areasList: [], // last-fetched area descriptors
  pendingDelete: null, // { key, timer, toast } — deletion deferred during undo window
};
