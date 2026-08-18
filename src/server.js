'use strict';

// Detect a missing database file BEFORE anything requires ./db (requiring it —
// directly or via ./app → routes — creates an empty ais_data.db). This is the
// signal that a deploy wiped the DB, used below to auto-restore the latest
// backup. Must stay the very first statements in this file.
const fs = require('fs');
const path = require('path');
// The DB now lives under data/db/ (older versions kept it at the project root, and
// db.js relocates a legacy file there on load). Treat EITHER location as "existed"
// so an in-place upgrade isn't mistaken for a wiped deploy.
const NEW_DB_PATH = path.join(__dirname, '..', 'data', 'db', 'ais_data.db');
const OLD_DB_PATH = path.join(__dirname, '..', 'ais_data.db');
const dbFileExisted = fs.existsSync(NEW_DB_PATH) || fs.existsSync(OLD_DB_PATH);

const createApp = require('./app');
const db = require('./db');
const heatmapDb = require('./heatmap-db');
const heatmapStream = require('./services/heatmap-stream');
const stream = require('./services/ais-stream');
const aisUptime = require('./services/ais-uptime');
const fallbackMode = require('./services/fallback-mode');
const shipFollow = require('./services/ship-follow');
const telegram = require('./services/telegram');
const sanctions = require('./services/sanctions');
const psc = require('./services/psc');
const berths = require('./services/berths');
const proximity = require('./services/proximity');
const portDiscovery = require('./services/port-discovery');
const appLog = require('./services/app-log');
const { startAutoBackup, restoreDbFromLatestBackup } = require('./routes/export');
const { PORT, API_KEY, API_KEY_SOURCE, state, areaForPoint, bboxSignature, BERTH, AUTO_RESTORE_ON_DEPLOY, HEATMAP,
  DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD, syncAreasWithDb } = require('./config');

// Honor the persisted on/off state for the operational log before anything logs.
appLog.setEnabled(state.appLogEnabled);

// Survive stray async failures. Node 22 terminates the process on an unhandled
// rejection, so a single failing scrape/telegram/webhook promise anywhere would
// take the whole tracker down. Log and keep running.
process.on('unhandledRejection', (reason) => {
  try { appLog.error('PROCESS', `Unhandled rejection: ${(reason && reason.stack) || reason}`); }
  catch { console.error('[PROCESS] Unhandled rejection:', reason); }
});
process.on('uncaughtException', (err) => {
  try { appLog.error('PROCESS', `Uncaught exception: ${(err && err.stack) || err}`); }
  catch { console.error('[PROCESS] Uncaught exception:', err); }
});

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
  state.boundingBox
    ? `[AIS] Preset iniziale: ${state.bboxName} (${state.preset}) — [${state.boundingBox[0][0]}] → [${state.boundingBox[0][1]}]`
    : '[AIS] Nessuna area configurata al primo avvio'
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
  // Refuse to run rather than ever create the built-in admin with an empty/weak
  // password: seedDefaultAdmin() above silently no-ops when DEFAULT_ADMIN_PASSWORD
  // is unset, so a deploy that forgot to configure ADMIN_PASSWORD would otherwise
  // boot with NO admin account at all — worse, before this check existed, a
  // hardcoded fallback password shipped in the committed source filled that gap.
  // A restore that brought back a valid admin (or any pre-existing admin under a
  // different username) always satisfies hasAnyAdmin() and skips this.
  if (!admin && !DEFAULT_ADMIN_PASSWORD && !db.hasAnyAdmin()) {
    appLog.error('AUTH', 'ADMIN_PASSWORD non configurata in local.properties: nessun amministratore esiste e non ne verrà creato uno con password debole/vuota. Imposta ADMIN_PASSWORD e riavvia.');
    console.error('[AUTH] ADMIN_PASSWORD non configurata: avvio interrotto per sicurezza.');
    process.exit(1);
  }
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
  // then keep checking every minute. Wrapped in try/catch like every other
  // interval so a transient SQLite error can't abort the boot sequence (nor, now,
  // crash the process).
  const runDepartures = () => {
    try { db.checkAndLogDepartures(); }
    catch (e) { appLog.error('DB', `checkAndLogDepartures fallito: ${e.message}`); }
  };
  runDepartures();
  setInterval(runDepartures, 60 * 1000);

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

  // Orphan cleanup: deleting an area removes its rows, but a ship that drifted
  // between areas can leave rows keyed by its mmsi behind (and the scrape cache
  // is untagged). pruneOrphans is a cheap idempotent sweep — run once at startup
  // (catches leftovers from older versions) and then daily.
  const sweepOrphans = () => {
    try {
      const c = db.pruneOrphans();
      if (c.total) appLog.info('DB', appLog.t('db.orphans_pruned', { total: c.total }), c);
    } catch (e) {
      appLog.error('DB', appLog.t('db.orphans_failed', { error: e.message }));
    }
  };
  setTimeout(sweepOrphans, 15 * 1000);
  setInterval(sweepOrphans, 24 * 60 * 60 * 1000);

  // One-time backfill for areas that predate the port-discovery feature: queued
  // one area at a time (not parallel) so a deploy with many existing areas
  // doesn't burst external requests (GFW/VesselFinder) all at once.
  async function backfillAreaPorts() {
    const keys = db.getActiveAreaKeys();
    for (const key of keys) {
      if (db.countAreaPorts(key) > 0) continue;
      try {
        await portDiscovery.discoverPortsForArea(key);
        await portDiscovery.resolveMstPidForConfirmedPorts(key);
        appLog.info('AREE', `Scoperta porti (backfill) completata per ${key}`);
      } catch (e) {
        appLog.warn('AREE', `Scoperta porti (backfill) fallita per ${key}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 30 * 1000)); // spacing between areas
    }
  }
  setTimeout(() => backfillAreaPorts().catch(() => {}), 60 * 1000); // give boot (streams, DB) time to settle first

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

  // Ship-to-ship proximity (rendezvous) scan: periodic per-area sweep that flags
  // slow, offshore vessel pairs lingering close together (transshipment signature).
  proximity.init();

  // Resume exactly the monitorings that were active before this restart (and only
  // those). The active set is persisted per-area and rides in backups, so this
  // also covers the deploy auto-restore done above. First boot ever falls back to
  // the preset area inside resumeActiveStreams().
  const resumed = stream.resumeActiveStreams({ defaultArea: state.preset });
  appLog.info('AIS', appLog.t('ais.streams_resumed', { count: resumed.length }), { count: resumed.length, aree: resumed });
  // Follow stream: connects on its own only when there are ships to follow.
  shipFollow.init();

  // Coverage heatmap: migrate any legacy cells out of the main DB into the
  // separate heatmap DB, then resume background collection if it was left on
  // (admin-controlled, persisted). A safety sweep stops the firehose if NO user
  // has been active in the last 10 minutes — never let it run with nobody around.
  heatmapDb.migrateFromMainIfNeeded();
  heatmapStream.resumeIfDesired();
  const HEATMAP_IDLE_MS = 10 * 60 * 1000;
  setInterval(() => {
    try { heatmapStream.autoStopIfNoUsers(HEATMAP_IDLE_MS); } catch { /* best-effort */ }
  }, HEATMAP_IDLE_MS);
  // Daily noise sweep: at the fine grid, single AIS pings spawn lone low-count
  // cells. Drop those not seen in PRUNE_AGE_DAYS so the DB stays bounded.
  const sweepHeatmap = () => {
    try {
      const cutoff = new Date(Date.now() - HEATMAP.PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const n = heatmapDb.pruneCells(HEATMAP.PRUNE_MIN_COUNT, cutoff);
      if (n) appLog.info('HEATMAP', `Potatura celle rumore: ${n} rimosse`);
    } catch (e) {
      appLog.error('HEATMAP', 'Potatura celle heatmap fallita', { error: e.message });
    }
  };
  setTimeout(sweepHeatmap, 60 * 1000);
  setInterval(sweepHeatmap, 24 * 60 * 60 * 1000);
  // Cross-checks the public AISStream uptime monitor when our streams go silent.
  aisUptime.init();
  // Fallback-mode scrape sweep: a no-op unless a prolonged outage has activated
  // fallback mode (see ais-uptime.js / services/fallback-mode.js). Own interval,
  // independent of the 60s outage check above.
  const FALLBACK_SWEEP_MS = 3 * 60 * 1000;
  setInterval(() => {
    fallbackMode.sweep().catch((e) => appLog.error('SCRAPE', 'Sweep fallback fallito', { error: e.message }));
  }, FALLBACK_SWEEP_MS);
  // Telegram bot: long-polls for /start link codes and sends per-user alerts.
  telegram.init();
  startAutoBackup();
});
