'use strict';

// Detect a missing database file BEFORE anything requires ./db (requiring it —
// directly or via ./app → routes — creates an empty ais_data.db). This is the
// signal that a deploy wiped the DB, used below to auto-restore the latest
// backup. Must stay the very first statements in this file.
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, '..', 'ais_data.db');
const dbFileExisted = fs.existsSync(DB_PATH);

const createApp = require('./app');
const db = require('./db');
const stream = require('./services/ais-stream');
const sanctions = require('./services/sanctions');
const psc = require('./services/psc');
const berths = require('./services/berths');
const appLog = require('./services/app-log');
const { startAutoBackup, restoreDbFromLatestBackup } = require('./routes/export');
const { PORT, API_KEY, API_KEY_SOURCE, state, areaForPoint, bboxSignature, BERTH, AUTO_RESTORE_ON_DEPLOY } = require('./config');

// Honor the persisted on/off state for the operational log before anything logs.
appLog.setEnabled(state.appLogEnabled);

const app = createApp();

console.log(
  `[AIS] Preset iniziale: ${state.bboxName} (${state.preset}) — [${state.boundingBox[0][0]}] → [${state.boundingBox[0][1]}]`
);

app.listen(PORT, () => {
  console.log(`Tracking porti running at http://localhost:${PORT}`);
  appLog.info('SERVER', `Server avviato su http://localhost:${PORT}`, { preset: state.preset, area: state.bboxName });
  const keyHint = `${API_KEY.slice(0, 4)}...${API_KEY.slice(-4)} (len:${API_KEY.length})`;
  db.insertLog({
    method: 'SYS',
    path: '/startup',
    status: 200,
    duration_ms: 0,
    response_body: `Porta ${PORT} | API key da: ${API_KEY_SOURCE} | key: ${keyHint}`,
  });

  // Auto-restore after a deploy: the .db file was absent at startup (just
  // re-created empty), so pull the most recent auto-backup back in. Runs before
  // the area reconcile below so the restored rows get re-tagged. Skipped when
  // the file already existed (an empty DB from "Clear data" is left untouched).
  if (!dbFileExisted && AUTO_RESTORE_ON_DEPLOY) {
    try {
      const r = restoreDbFromLatestBackup();
      if (r) {
        const total = Object.values(r.counts || {}).reduce((a, b) => a + b, 0);
        appLog.info('RESTORE', `DB assente dopo il deploy → ripristinato l'ultimo backup ${r.filename}`, { righe: total });
      } else {
        appLog.info('RESTORE', 'DB assente e nessun backup disponibile: avvio con database vuoto');
      }
    } catch (e) {
      appLog.error('RESTORE', `Auto-ripristino fallito, avvio con DB vuoto: ${e.message}`);
    }
  }

  // Tag legacy rows (area='') by coordinates. Cheap after the first run (no rows
  // left with area=''), so it always runs.
  db.tagLegacyArea(state.preset, areaForPoint);

  // Reconcile mis-tagged rows by coordinates only when the area definitions have
  // changed since last time (it scans every row, so skip the full O(rows) sweep
  // when nothing moved). The signature is persisted in `meta`; a restore of an
  // older backup lacks it → sweep runs once, then the signature is stored.
  const sig = bboxSignature();
  if (db.getMeta('areas_sig') !== sig) {
    const moved = db.reconcileAreasByCoords(areaForPoint);
    if (moved) appLog.info('AIS', `Aree riconciliate per coordinate: ${moved} righe corrette`);
    db.setMeta('areas_sig', sig);
  }

  // Catch departures that crossed the 60-min threshold while the server was down,
  // then keep checking every minute.
  db.checkAndLogDepartures();
  setInterval(db.checkAndLogDepartures, 60 * 1000);

  // Sanctions screening: load any cached OFAC list from disk (offline-safe). If
  // enabled but no cache yet, download once in the background, then refresh daily.
  if (state.importSanctions) {
    sanctions
      .loadFromDisk()
      .then((n) => {
        if (!n) return sanctions.refresh();
      })
      .catch((e) => console.error(`[SANCTIONS] Startup refresh failed: ${e.message}`));
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
      appLog.info('BERTHS', 'Backfill iniziale banchine completato');
    } catch (e) {
      appLog.error('BERTHS', `Backfill banchine fallito: ${e.message}`);
    }
  }, 0);
  setInterval(() => {
    try {
      berths.recomputeAll();
    } catch (e) {
      console.error(`[BERTHS] Ricalcolo periodico fallito: ${e.message}`);
    }
  }, BERTH.RECOMPUTE_MIN * 60 * 1000);

  // Fast incremental recompute of only the areas that just saw new arrivals.
  berths.startDirtyFlush();

  stream.startStream(state.preset);
  startAutoBackup();
});
