'use strict';

const createApp = require('./app');
const db = require('./db');
const stream = require('./services/ais-stream');
const sanctions = require('./services/sanctions');
const psc = require('./services/psc');
const berths = require('./services/berths');
const { startAutoBackup } = require('./routes/export');
const { PORT, API_KEY, API_KEY_SOURCE, state, BBOX_PRESETS, areaForPoint, BERTH } = require('./config');

const app = createApp();

console.log(
  `[AIS] Preset iniziale: ${state.bboxName} (${state.preset}) — [${state.boundingBox[0][0]}] → [${state.boundingBox[0][1]}]`
);

app.listen(PORT, () => {
  console.log(`Tracking porti running at http://localhost:${PORT}`);
  const keyHint = `${API_KEY.slice(0, 4)}...${API_KEY.slice(-4)} (len:${API_KEY.length})`;
  db.insertLog({
    method: 'SYS',
    path: '/startup',
    status: 200,
    duration_ms: 0,
    response_body: `Porta ${PORT} | API key da: ${API_KEY_SOURCE} | key: ${keyHint}`,
  });

  // Tag legacy rows (area='') by coordinates, then repair any rows a previous
  // blind migration mis-assigned (e.g. Taranto ships stamped as the startup area).
  db.tagLegacyArea(state.preset, areaForPoint);
  const moved = db.reconcileAreasByCoords(areaForPoint);
  if (moved) console.log(`[AIS] Aree riconciliate per coordinate: ${moved} righe corrette`);

  // Catch departures that crossed the 60-min threshold while the server was down,
  // then keep checking every minute.
  db.checkAndLogDepartures();
  setInterval(db.checkAndLogDepartures, 60 * 1000);

  // Sanctions screening: load any cached OFAC list from disk (offline-safe). If
  // enabled but no cache yet, download once in the background, then refresh daily.
  if (state.importSanctions) {
    if (!sanctions.loadFromDisk()) {
      sanctions.refresh().catch((e) => console.error(`[SANCTIONS] Startup refresh failed: ${e.message}`));
    }
    setInterval(() => {
      sanctions.refresh().catch((e) => console.error(`[SANCTIONS] Daily refresh failed: ${e.message}`));
    }, 24 * 60 * 60 * 1000);
  }

  // Port State Control screening: load bundled flag lists + cached banned list
  // from disk (offline-safe). If the banned list isn't cached yet, download it
  // once in the background, then refresh daily.
  if (state.importPsc) {
    psc.loadFromDisk();
    if (!psc.bannedLoaded()) {
      psc.refresh().catch((e) => console.error(`[PSC] Startup refresh failed: ${e.message}`));
    }
    setInterval(() => {
      psc.refresh().catch((e) => console.error(`[PSC] Daily refresh failed: ${e.message}`));
    }, 24 * 60 * 60 * 1000);
  }

  // Berths: backfill mooring clusters from existing history once at startup
  // (idempotent — manual edits survive), then recompute periodically as new
  // arrivals accumulate. Runs detached so it never blocks the listen callback.
  setTimeout(() => {
    try {
      berths.recomputeAll();
      console.log('[BERTHS] Backfill iniziale completato');
    } catch (e) {
      console.error(`[BERTHS] Backfill fallito: ${e.message}`);
    }
  }, 0);
  setInterval(() => {
    try {
      berths.recomputeAll();
    } catch (e) {
      console.error(`[BERTHS] Ricalcolo periodico fallito: ${e.message}`);
    }
  }, BERTH.RECOMPUTE_MIN * 60 * 1000);

  stream.startStream(state.preset);
  startAutoBackup();
});
