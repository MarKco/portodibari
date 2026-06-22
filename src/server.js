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
const shipFollow = require('./services/ship-follow');
const sanctions = require('./services/sanctions');
const psc = require('./services/psc');
const berths = require('./services/berths');
const appLog = require('./services/app-log');
const { startAutoBackup, restoreDbFromLatestBackup } = require('./routes/export');
const { PORT, API_KEY, API_KEY_SOURCE, state, areaForPoint, bboxSignature, BERTH, AUTO_RESTORE_ON_DEPLOY,
  DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD, syncAreasWithDb } = require('./config');

// Honor the persisted on/off state for the operational log before anything logs.
appLog.setEnabled(state.appLogEnabled);

// Always ensure the built-in administrator exists (idempotent), and clear out
// any expired sessions left behind. Runs before listen so the very first request
// can already authenticate.
db.seedDefaultAdmin({ username: DEFAULT_ADMIN_USERNAME, email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD });
db.pruneExpiredSessions();
setInterval(() => {
  try { db.pruneExpiredSessions(); } catch { /* best-effort */ }
}, 6 * 60 * 60 * 1000);

const app = createApp();

console.log(
  `[AIS] Preset iniziale: ${state.bboxName} (${state.preset}) — [${state.boundingBox[0][0]}] → [${state.boundingBox[0][1]}]`
);

app.listen(PORT, () => {
  console.log(`Tracking porti running at http://localhost:${PORT}`);
  appLog.info('SERVER', appLog.t('server.started', { url: `http://localhost:${PORT}` }), { preset: state.preset, area: state.bboxName });
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
        appLog.info('RESTORE', appLog.t('restore.deploy_restored', { filename: r.filename }), { righe: total });
      } else {
        appLog.info('RESTORE', appLog.t('restore.deploy_empty'));
      }
    } catch (e) {
      appLog.error('RESTORE', appLog.t('restore.deploy_failed', { error: e.message }));
    }
    // A restore replaces the users table with the backup's. Re-seed so the
    // built-in admin is guaranteed present even after restoring an older backup
    // that predates the users schema (where the copy is skipped entirely).
    db.seedDefaultAdmin({ username: DEFAULT_ADMIN_USERNAME, email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD });
  }

  // Areas are now DB-backed: seed the catalog from the bootstrap JSON on first
  // run, then load it back so the DB is authoritative (BBOX_PRESETS is rebuilt
  // in place). Then re-home any legacy GLOBAL state (flagged/followed/muted
  // ships, owner-less notifications, memberless areas) to the admin. This is the
  // deploy path: an OLD pre-multi-user backup is restored into this version and
  // its global data must land on the admin account. migrateMultiUser is
  // idempotent + self-retiring, so it is safe to run on every boot.
  const admin = db.findUserByLogin(DEFAULT_ADMIN_USERNAME);
  syncAreasWithDb(admin ? admin.id : null);
  if (admin) {
    const m = db.migrateMultiUser(admin.id);
    if (m && m.orphanAreas) appLog.info('AUTH', `Migrazione multi-utente: ${m.orphanAreas} aree assegnate all'amministratore`);
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
    if (moved) appLog.info('AIS', appLog.t('ais.areas_reconciled', { count: moved }));
    db.setMeta('areas_sig', sig);
  }

  // Catch departures that crossed the 60-min threshold while the server was down,
  // then keep checking every minute.
  db.checkAndLogDepartures();
  setInterval(db.checkAndLogDepartures, 60 * 1000);

  // DB compaction: fold the WAL back into the main file (the passive
  // autocheckpoint can't, while the stream/SSE readers hold a read lock) and
  // return pruned pages to the OS. The first run also converts the file to
  // incremental auto_vacuum via a one-time VACUUM, so it's deferred (and
  // detached) to keep startup snappy, then repeats every 5 minutes.
  setTimeout(() => {
    try {
      db.runMaintenance();
      appLog.info('DB', appLog.t('db.maint_initial_done'));
    } catch (e) {
      appLog.error('DB', appLog.t('db.maint_initial_failed', { error: e.message }));
    }
  }, 10 * 1000);
  setInterval(() => {
    try {
      db.runMaintenance();
    } catch (e) {
      appLog.error('DB', appLog.t('db.maint_periodic_failed', { error: e.message }));
    }
  }, 5 * 60 * 1000);

  // Sanctions screening: load any cached OFAC list from disk (offline-safe). If
  // enabled but no cache yet, download once in the background, then refresh daily.
  if (state.importSanctions) {
    sanctions
      .loadFromDisk()
      .then((n) => {
        if (n) appLog.info('SANCTIONS', appLog.t('sanctions.loaded_disk'), { navi: n });
        else return sanctions.refresh();
      })
      .catch((e) => appLog.error('SANCTIONS', appLog.t('sanctions.initial_failed', { error: e.message })));
    setInterval(() => {
      appLog.info('SANCTIONS', appLog.t('sanctions.daily_started'));
      sanctions.refresh().catch((e) => appLog.error('SANCTIONS', appLog.t('sanctions.daily_failed', { error: e.message })));
    }, 24 * 60 * 60 * 1000);
  }

  // Port State Control screening: load bundled flag lists + cached banned list
  // from disk (offline-safe). If the banned list isn't cached yet, download it
  // once in the background, then refresh daily.
  if (state.importPsc) {
    psc.loadFromDisk();
    if (!psc.bannedLoaded()) {
      psc.refresh().catch((e) => appLog.error('PSC', appLog.t('psc.initial_failed', { error: e.message })));
    }
    setInterval(() => {
      appLog.info('PSC', appLog.t('psc.daily_started'));
      psc.refresh().catch((e) => appLog.error('PSC', appLog.t('psc.daily_failed', { error: e.message })));
    }, 24 * 60 * 60 * 1000);
  }

  // Berths: backfill mooring clusters from existing history once at startup
  // (idempotent — manual edits survive), then recompute periodically as new
  // arrivals accumulate. Runs detached so it never blocks the listen callback.
  setTimeout(() => {
    try {
      berths.recomputeAll();
      appLog.info('BERTHS', appLog.t('berths.backfill_done'));
    } catch (e) {
      appLog.error('BERTHS', appLog.t('berths.backfill_failed', { error: e.message }));
    }
  }, 0);
  setInterval(() => {
    try {
      berths.recomputeAll();
    } catch (e) {
      appLog.error('BERTHS', appLog.t('berths.recompute_periodic_failed', { error: e.message }));
    }
  }, BERTH.RECOMPUTE_MIN * 60 * 1000);

  // Fast incremental recompute of only the areas that just saw new arrivals.
  berths.startDirtyFlush();

  stream.startStream(state.preset);
  // Follow stream: connects on its own only when there are ships to follow.
  shipFollow.init();
  startAutoBackup();
});
