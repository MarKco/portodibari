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
  view: 'active', // 'active' | 'past' | 'detail' | 'traffico' | 'followed' | 'areas' | 'coverage' | 'settings'
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
  // Risk-signal weights (admin-editable, mirrors cargo weights)
  riskWeightKeys: null,
  riskWeights: null,
  defaultRiskWeights: null,
  riskPresets: null,
  riskWeightsPreset: null,
  currentPreset: '',

  // List filters (client-side, applied before sort/render). `showSeen` controls
  // whether ships marked as seen are listed; default off (they are hidden, with
  // flagged ships always kept visible). Persisted in localStorage — see below.
  activeFilter: { q: '', band: '', inPort: false, flagged: false, showSeen: false },
  pastFilter: { q: '', band: '', flagged: false, showSeen: false },
  followedFilter: { q: '', band: '', inPort: false, flagged: false },
  followedPastFilter: { q: '', band: '', flagged: false },
  followedSubview: 'active', // 'active' | 'past' within the Navi seguite section
  allStreamStatus: {},
  presets: {},

  // Maps
  aisMap: null,
  trackLayer: null,
  trackAnim: null, // active track-playback state (see maps.js)
  activeMap: null,
  activeMarkersLayer: null,
  activeShipsCache: new Map(),
  currentBbox: null, // [[swLat, swLon], [neLat, neLon]]
  showOpenSeaMap: false, // OpenSeaMap seamark *tile* raster on all maps; default off, synced from server settings
  showOpenSeaMapMarkers: true, // OpenSeaMap Overpass *vector* markers on the active map; default on, synced from server
  openSeaMapHidden: [], // OpenSeaMap marker category keys the user hid (default none = show all); synced from server
  seamarkBerthsLayer: null, // OpenSeaMap official berths/moorings overlay on the active map
  // Historical replay (time-scrubber on the active map). See replay.js.
  replay: null,
  replayMaxGapMin: 30, // hide a ship across fix gaps longer than this (synced from server)
  replayTailMin: 20,   // fading-trail length in minutes (synced from server)
  followedMap: null,
  followedMarkersLayer: null,
  followedShipsCache: new Map(),

  // Coverage heatmap map (mappa delle zone coperte) — see coverage.js
  coverageMap: null,
  coverageLayer: null,
  coverageRenderer: null,

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

// ── List-filter persistence ───────────────────────────────────────────────────
// The "navi presenti" / "navi passate" toolbar filters (search, band, in-port,
// flagged, show-seen) survive reloads via a single localStorage key. Saved as a
// whole object on every change; restored here at module load by merging onto the
// defaults so a future new field still gets its default when absent in storage.
const FILTERS_KEY = 'shipFilters';

export function saveShipFilters() {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ active: S.activeFilter, past: S.pastFilter }));
  } catch {
    /* storage unavailable / quota — non-fatal */
  }
}

try {
  const raw = localStorage.getItem(FILTERS_KEY);
  if (raw) {
    const saved = JSON.parse(raw);
    if (saved.active) Object.assign(S.activeFilter, saved.active);
    if (saved.past) Object.assign(S.pastFilter, saved.past);
  }
} catch {
  /* malformed JSON — ignore, keep defaults */
}
