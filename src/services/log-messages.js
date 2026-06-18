'use strict';

// Server-side i18n for the operational log.
//
// Every log message is referenced by a stable id and rendered here in the
// current UI language (state.uiLang, mirrored from the browser). The frontend
// log viewer just displays the rendered `msg`, so nothing has to be translated
// client-side. Each entry is a { it, en } pair; values may be plain strings or
// functions of a params object. render() falls back to Italian, then the id.

const { state } = require('../config');

// Convenience for on/off style messages so call sites pass a single boolean.
const onOff = (it, en) => ({
  it: (p) => (p.on ? it[0] : it[1]),
  en: (p) => (p.on ? en[0] : en[1]),
});

const MESSAGES = {
  // ── Server / restore / maintenance ──
  'server.started': { it: (p) => `Server avviato su ${p.url}`, en: (p) => `Server started at ${p.url}` },
  'restore.deploy_restored': {
    it: (p) => `DB assente dopo il deploy → ripristinato l'ultimo backup ${p.filename}`,
    en: (p) => `Database missing after deploy → restored latest backup ${p.filename}`,
  },
  'restore.deploy_empty': {
    it: 'DB assente e nessun backup disponibile: avvio con database vuoto',
    en: 'Database missing and no backup available: starting with an empty database',
  },
  'restore.deploy_failed': {
    it: (p) => `Auto-ripristino fallito, avvio con DB vuoto: ${p.error}`,
    en: (p) => `Auto-restore failed, starting with empty database: ${p.error}`,
  },
  'restore.db_from_upload': { it: 'Database ripristinato da file caricato', en: 'Database restored from uploaded file' },
  'restore.db_failed': { it: (p) => `Ripristino database fallito: ${p.error}`, en: (p) => `Database restore failed: ${p.error}` },
  'db.maint_initial_done': { it: 'Compattazione iniziale del database completata', en: 'Initial database compaction completed' },
  'db.maint_initial_failed': { it: (p) => `Compattazione iniziale fallita: ${p.error}`, en: (p) => `Initial compaction failed: ${p.error}` },
  'db.maint_periodic_failed': { it: (p) => `Compattazione periodica fallita: ${p.error}`, en: (p) => `Periodic compaction failed: ${p.error}` },

  // ── AIS stream ──
  'ais.areas_reconciled': {
    it: (p) => `Aree riconciliate per coordinate: ${p.count} righe corrette`,
    en: (p) => `Areas reconciled by coordinates: ${p.count} rows fixed`,
  },
  'ais.stream_start_manual': { it: 'Avvio stream richiesto manualmente', en: 'Stream start requested manually' },
  'ais.stream_stop_manual': { it: 'Arresto stream richiesto manualmente', en: 'Stream stop requested manually' },
  'ais.stream_connected': { it: 'Stream connesso', en: 'Stream connected' },
  'ais.api_error': { it: 'Errore API AISStream', en: 'AISStream API error' },
  'ais.parse_error': { it: 'Errore di parsing messaggio', en: 'Message parse error' },
  'ais.conn_closed_reconnect': {
    it: (p) => `Connessione chiusa (code ${p.code}) — riconnessione in 5s`,
    en: (p) => `Connection closed (code ${p.code}) — reconnecting in 5s`,
  },
  'ais.conn_closed': { it: (p) => `Connessione chiusa (code ${p.code})`, en: (p) => `Connection closed (code ${p.code})` },
  'ais.ws_error': { it: 'Errore WebSocket', en: 'WebSocket error' },
  'ais.stream_stopped': { it: 'Stream fermato', en: 'Stream stopped' },

  // ── Sanctions ──
  'sanctions.loaded_disk': { it: 'Liste sanzioni caricate da disco', en: 'Sanctions lists loaded from disk' },
  'sanctions.initial_failed': { it: (p) => `Aggiornamento iniziale fallito: ${p.error}`, en: (p) => `Initial update failed: ${p.error}` },
  'sanctions.daily_started': { it: 'Aggiornamento giornaliero liste sanzioni avviato', en: 'Daily sanctions lists update started' },
  'sanctions.daily_failed': { it: (p) => `Aggiornamento giornaliero fallito: ${p.error}`, en: (p) => `Daily update failed: ${p.error}` },
  'sanctions.manual_started': { it: 'Aggiornamento manuale liste sanzioni avviato', en: 'Manual sanctions lists update started' },
  'sanctions.list_updated': { it: (p) => `Lista ${p.list} aggiornata`, en: (p) => `${p.list} list updated` },
  'sanctions.list_failed': { it: (p) => `Aggiornamento lista ${p.list} fallito: ${p.error}`, en: (p) => `${p.list} list update failed: ${p.error}` },

  // ── Port State Control ──
  'psc.initial_failed': { it: (p) => `Aggiornamento iniziale fallito: ${p.error}`, en: (p) => `Initial update failed: ${p.error}` },
  'psc.daily_started': { it: 'Aggiornamento giornaliero liste PSC avviato', en: 'Daily PSC lists update started' },
  'psc.daily_failed': { it: (p) => `Aggiornamento giornaliero fallito: ${p.error}`, en: (p) => `Daily update failed: ${p.error}` },
  'psc.manual_started': { it: 'Aggiornamento manuale liste PSC avviato', en: 'Manual PSC lists update started' },
  'psc.banned_updated': { it: 'Lista navi bandite aggiornata', en: 'Banned ships list updated' },
  'psc.banned_failed': { it: (p) => `Aggiornamento lista navi bandite fallito: ${p.error}`, en: (p) => `Banned ships list update failed: ${p.error}` },

  // ── Berths ──
  'berths.backfill_done': { it: 'Backfill iniziale banchine completato', en: 'Initial berth backfill completed' },
  'berths.backfill_failed': { it: (p) => `Backfill banchine fallito: ${p.error}`, en: (p) => `Berth backfill failed: ${p.error}` },
  'berths.recompute_periodic_failed': { it: (p) => `Ricalcolo periodico fallito: ${p.error}`, en: (p) => `Periodic recompute failed: ${p.error}` },
  'berths.recompute_failed': { it: (p) => `Ricalcolo fallito per ${p.area}: ${p.error}`, en: (p) => `Recompute failed for ${p.area}: ${p.error}` },
  'berths.recompute_incremental': {
    it: 'Ricalcolo incrementale banchine per arrivi/partenze',
    en: 'Incremental berth recompute for arrivals/departures',
  },
  'berths.recompute_incremental_failed': {
    it: (p) => `Ricalcolo incrementale fallito per ${p.area}: ${p.error}`,
    en: (p) => `Incremental recompute failed for ${p.area}: ${p.error}`,
  },
  'berths.recompute_manual': { it: 'Ricalcolo banchine richiesto manualmente', en: 'Berth recompute requested manually' },
  'berths.recompute_manual_all': {
    it: 'Ricalcolo banchine richiesto manualmente (tutte le aree)',
    en: 'Berth recompute requested manually (all areas)',
  },
  'berths.created': {
    it: (p) => `Banchina creata manualmente${p.name ? `: ${p.name}` : ''}`,
    en: (p) => `Berth created manually${p.name ? `: ${p.name}` : ''}`,
  },
  'berths.modified': {
    it: (p) => `Banchina modificata${p.name ? `: ${p.name}` : ''}`,
    en: (p) => `Berth modified${p.name ? `: ${p.name}` : ''}`,
  },
  'berths.merged': { it: (p) => `${p.count} banchine unite in una`, en: (p) => `${p.count} berths merged into one` },
  'berths.deleted': {
    it: (p) => `Banchina eliminata${p.name ? `: ${p.name}` : ''}`,
    en: (p) => `Berth deleted${p.name ? `: ${p.name}` : ''}`,
  },

  // ── Port events ──
  'port.arrivals': { it: (p) => `${p.count} arrivi: ${p.list}`, en: (p) => `${p.count} arrivals: ${p.list}` },
  'port.departures': { it: (p) => `${p.count} partenze: ${p.list}`, en: (p) => `${p.count} departures: ${p.list}` },
  'port.high_risk': { it: (p) => `Nave ad alto rischio in arrivo: ${p.name}`, en: (p) => `High-risk vessel arriving: ${p.name}` },
  'port.area_change': { it: (p) => `Nave spostata tra aree: ${p.name}`, en: (p) => `Vessel moved between areas: ${p.name}` },

  // ── Areas ──
  'areas.imported': { it: 'Aree importate', en: 'Areas imported' },
  'areas.autostart_failed': {
    it: (p) => `Avvio automatico stream fallito per ${p.key}: ${p.error}`,
    en: (p) => `Automatic stream start failed for ${p.key}: ${p.error}`,
  },
  'areas.added': { it: (p) => `Area aggiunta: ${p.name}`, en: (p) => `Area added: ${p.name}` },
  'areas.deleted': {
    it: (p) => `Area eliminata con tutto lo storico: ${p.name}`,
    en: (p) => `Area deleted with all its history: ${p.name}`,
  },

  // ── Backup / bundle ──
  'backup.auto_initial': { it: 'Auto-backup iniziale creato', en: 'Initial auto-backup created' },
  'backup.auto_initial_failed': { it: (p) => `Auto-backup iniziale fallito: ${p.error}`, en: (p) => `Initial auto-backup failed: ${p.error}` },
  'backup.auto_created': { it: 'Auto-backup creato', en: 'Auto-backup created' },
  'backup.auto_failed': { it: (p) => `Auto-backup fallito: ${p.error}`, en: (p) => `Auto-backup failed: ${p.error}` },
  'backup.manual_saved': { it: 'Backup manuale salvato', en: 'Manual backup saved' },
  'bundle.imported': {
    it: 'Backup completo importato (DB + aree + impostazioni)',
    en: 'Full backup imported (DB + areas + settings)',
  },
  'bundle.import_failed': { it: (p) => `Importazione backup completo fallita: ${p.error}`, en: (p) => `Full backup import failed: ${p.error}` },

  // ── App config ──
  'config.param_changed': {
    it: (p) => `Parametro ${p.key} = ${p.value} (era ${p.old})`,
    en: (p) => `Parameter ${p.key} = ${p.value} (was ${p.old})`,
  },
  'config.restart_required': {
    it: (p) => `${p.count} parametri modificati — riavvio richiesto`,
    en: (p) => `${p.count} parameters changed — restart required`,
  },

  // ── Ship manual changes ──
  'ship.flag': onOff(['Nave segnalata manualmente', 'Nave desegnalata manualmente'], ['Ship flagged manually', 'Ship unflagged manually']),
  'ship.military': onOff(['Nave marcata come militare', 'Nave marcata come non militare'], ['Ship marked as military', 'Ship marked as non-military']),
  'ship.seen': onOff(['Nave marcata come vista', 'Nave marcata come non vista'], ['Ship marked as seen', 'Ship marked as not seen']),
  'ship.notif_muted': onOff(['Notifiche nave silenziate', 'Notifiche nave riattivate'], ['Ship notifications muted', 'Ship notifications unmuted']),
  'ship.notes': onOff(['Note nave aggiornate', 'Note nave cancellate'], ['Ship notes updated', 'Ship notes cleared']),

  // ── Scraping (VF / MT / Equasis / backfill) ──
  'scrape.requested': { it: (p) => `${p.source} richiesto per ${p.name}`, en: (p) => `${p.source} requested for ${p.name}` },
  'scrape.ok': { it: (p) => `${p.source} ok per ${p.name}`, en: (p) => `${p.source} ok for ${p.name}` },
  'scrape.failed': { it: (p) => `${p.source} fallito per ${p.name}: ${p.error}`, en: (p) => `${p.source} failed for ${p.name}: ${p.error}` },
  'scrape.backfill_started': { it: (p) => `Backfill ${p.source} avviato`, en: (p) => `${p.source} backfill started` },
  'gfw.not_found': {
    it: (p) => `Nave non presente in Global Fishing Watch: ${p.name}`,
    en: (p) => `Vessel not found in Global Fishing Watch: ${p.name}`,
  },

  // ── Settings toggles ──
  'settings.notifications': onOff(['Notifiche attivate', 'Notifiche disattivate'], ['Notifications enabled', 'Notifications disabled']),
  'settings.import_vf': onOff(['Import VesselFinder attivato', 'Import VesselFinder disattivato'], ['VesselFinder import enabled', 'VesselFinder import disabled']),
  'settings.import_mt': onOff(['Import MarineTraffic attivato', 'Import MarineTraffic disattivato'], ['MarineTraffic import enabled', 'MarineTraffic import disabled']),
  'settings.import_sanctions': onOff(['Screening sanzioni attivato', 'Screening sanzioni disattivato'], ['Sanctions screening enabled', 'Sanctions screening disabled']),
  'settings.import_psc': onOff(['Screening Port State Control attivato', 'Screening Port State Control disattivato'], ['Port State Control screening enabled', 'Port State Control screening disabled']),
  'settings.import_gfw': onOff(['Import Global Fishing Watch attivato', 'Import Global Fishing Watch disattivato'], ['Global Fishing Watch import enabled', 'Global Fishing Watch import disabled']),
  'settings.exclude_tankers': onOff(['Esclusione tanker dal punteggio attivata', 'Esclusione tanker dal punteggio disattivata'], ['Tankers excluded from score enabled', 'Tankers excluded from score disabled']),
  'settings.cargo_weights': { it: () => 'Pesi rischio per tipo di carico aggiornati', en: () => 'Per-cargo-type risk weights updated' },
  'settings.view_changed': { it: (p) => `Vista cambiata a: ${p.name}`, en: (p) => `View changed to: ${p.name}` },

  // ── Data / notifications / log ──
  'data.area_cleared': { it: "Dati cancellati per l'area", en: 'Data cleared for the area' },
  'notif.deleted': { it: 'Notifica eliminata', en: 'Notification deleted' },
  'notif.all_deleted': { it: 'Tutte le notifiche eliminate', en: 'All notifications deleted' },
  'log.cleared': { it: 'Log applicazione cancellato', en: 'Application log cleared' },
  'log.toggled': onOff(['Logging applicazione attivato', 'Logging applicazione disattivato'], ['Application logging enabled', 'Application logging disabled']),
};

/** Render message `id` in the current UI language. Unknown id → the id itself. */
function render(id, params = {}) {
  const m = MESSAGES[id];
  if (!m) return id;
  const lang = state.uiLang === 'en' ? 'en' : 'it';
  const v = m[lang] !== undefined ? m[lang] : m.it;
  return typeof v === 'function' ? v(params) : v;
}

module.exports = { render };
