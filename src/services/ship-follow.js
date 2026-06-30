'use strict';

// Dedicated AISstream connection that "follows" individual ships across the open
// sea. Unlike the per-area streams (see ais-stream.js), this keeps a single
// connection whose subscription is a set of small bounding boxes — one per
// followed ship, centred on its last known position — plus a FiltersShipMMSI
// allow-list so we only receive those vessels. As ships move, the boxes are
// rebuilt and re-sent every FOLLOW_REFRESH_MS.
//
// When a followed ship goes silent past FOLLOW_FRESH_MS (a coverage gap), its
// tight box — pinned to an old position — likely no longer covers it. So stale
// follows fall back to the worldwide box (WORLD_BOX): the server-side MMSI
// filter keeps that cheap, and it re-acquires the ship wherever it next
// transmits, re-centring the tight box on the fresh fix. A ship silent for
// FOLLOW_STALE_HOURS is finally auto-unfollowed and drops to "passate" history.

const WebSocket = require('ws');

const db = require('../db');
const { invalidateRiskCache } = require('./risk-score');
const appLog = require('./app-log');
const telegram = require('./telegram');
const { broadcastLog } = require('../realtime');
const { crawlShipfinder } = require('./scrapers/shipfinder');
const { crawlMyshiptracking } = require('./scrapers/myshiptracking');
const { keyAbuseReason, backoffDelay, closeSocket } = require('./ais-backoff');
const { traceKey } = require('./key-trace');
const {
  FOLLOW_API_KEY,
  FOLLOW_API_KEY_SOURCE,
  maskKey,
  AIS_URL,
  MSG_TYPES,
  MAX_BODY,
  FOLLOW_BOX_HALF_DEG,
  FOLLOW_REFRESH_MS,
  FOLLOW_STALE_HOURS,
  FOLLOW_FRESH_MS,
  SEARCH_LOOKUP_TIMEOUT_MS,
  SF_REACQUIRE_THROTTLE_MS,
  SF_REACQUIRE_MAX_PER_SWEEP,
  SCRAPE_NEG_CACHE_DAYS,
  state,
  areaForPoint,
} = require('../config');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Non-secret key fingerprint for logs. FOLLOW_API_KEY_SOURCE='shared' means follow
// reuses API_KEY and competes with the area streams for the per-key slot (429 risk).
const KEY_TAG = `${maskKey(FOLLOW_API_KEY)} (${FOLLOW_API_KEY_SOURCE})`;

// Whole-globe bounding box. Used for "search lookups" (see addLookup): a ship the
// user searched for whose position we don't know yet. AISstream applies
// FiltersShipMMSI server-side, so a worldwide box filtered to a single MMSI costs
// only that vessel's frames — it lets us recover the live position of any
// transmitting ship anywhere, without knowing where it is first.
const WORLD_BOX = [[-90, -180], [90, 180]];

// Transient position lookups keyed by MMSI → Set of onFix callbacks. Unlike a
// real follow (persisted in user_follows), a lookup lives only as long as a
// search session is open: it injects the MMSI into the subscription with a
// worldwide box, fires its callbacks on the first position fix, and is removed
// when the search is cancelled / times out (see routes/ships.js search/recover).
const lookups = new Map();

// Background position re-acquisitions, keyed by MMSI. Triggered when a ship is
// (re)followed without a recent live fix (e.g. re-followed from "passate"): the
// follow is set optimistically, then we run a worldwide lookup for it. On the
// first fix the re-acquire succeeds silently; if none arrives within
// SEARCH_LOOKUP_TIMEOUT_MS the follow is reverted (back to "passate") and the
// user is notified. Value: { users:Set<userId>, name, cb, timer }.
const reacquires = new Map();

// ShipFinder fallback re-acquisition. When a followed ship is stale (no AIS for
// FOLLOW_FRESH_MS), the worldwide AIS box is the primary recovery net — but a ship
// that has gone fully dark to our stream won't reappear there. ShipFinder often
// still serves a relayed last-known position for it, so the refresh sweep scrapes
// stale follows as a fallback and stores the fix (tagged source='sf', shown as a
// distinct marker — it never enters the AIS track/risk/freshness). `lastSfScrape`
// throttles per MMSI; `sfSweeping` prevents overlapping sweeps.
const lastSfScrape = new Map(); // mmsi -> epoch ms of last scrape attempt
let sfSweeping = false;

// MyShipTracking re-acquire sweep — an independent second backup alongside
// ShipFinder, same mechanics (own throttle map + sweep guard, reuses the shared
// SF_REACQUIRE_* timing). When both are enabled a stale follow is scraped from
// both sources; whichever returns a fix gives a last-known marker.
const lastMstScrape = new Map();
let mstSweeping = false;

const s = {
  wsClient: null,
  active: false, // we want a connection (there are ships to follow)
  reconnectTimer: null,
  heartbeatTimer: null,
  refreshTimer: null,
  totalReceived: 0,
  rawFramesReceived: 0,
  connectedAt: null,
  reconnectCount: 0,
  isFirstConnect: true,
  sessionMessages: 0,
  connFailCount: 0, // consecutive failed connection attempts (drives backoff)
  was429: false, // last failure was an HTTP 429 handshake rejection
  abuseReason: null, // human reason when the failure is a key over-use problem
  followedCount: 0,
  staleCount: 0, // followed ships currently re-acquired via the worldwide box
  lastAisError: null,
  lastAisErrorAt: null,
};

// A followed ship is "stale" once we haven't heard it for FOLLOW_FRESH_MS: its
// tight box is centred on a now-old position and probably no longer covers it.
function isStaleFollow(sh, now) {
  return !sh.last_seen_at || now - new Date(sh.last_seen_at).getTime() > FOLLOW_FRESH_MS;
}

// One bounding box per *fresh* followed ship, FOLLOW_BOX_HALF_DEG either side of
// its last position, plus a single worldwide box that re-acquires stale follows
// (and transient search lookups) wherever they next transmit. The FiltersShipMMSI
// allow-list keeps the worldwide box cheap — only followed/looked-up vessels.
// Returns null when there is nothing to follow (AISstream rejects an empty
// BoundingBoxes — so we disconnect instead of subscribing).
function buildSubscription() {
  const ships = db.getAllFollowedPositions();
  s.followedCount = ships.length;
  const h = FOLLOW_BOX_HALF_DEG;
  const now = Date.now();
  // Tight box only for fresh ships; stale ones rely on the worldwide box below.
  const boxes = ships
    .filter((sh) => !isStaleFollow(sh, now))
    .map((sh) => [
      [clamp(sh.lat - h, -90, 90), clamp(sh.lon - h, -180, 180)],
      [clamp(sh.lat + h, -90, 90), clamp(sh.lon + h, -180, 180)],
    ]);
  const mmsis = new Set(ships.map((sh) => String(sh.mmsi)));
  s.staleCount = ships.reduce((n, sh) => n + (isStaleFollow(sh, now) ? 1 : 0), 0);
  // One shared worldwide box catches stale follows + pending search lookups
  // anywhere; the server-side MMSI filter keeps the traffic to just those vessels.
  if (lookups.size || s.staleCount) {
    boxes.push(WORLD_BOX);
    for (const m of lookups.keys()) mmsis.add(String(m));
  }
  if (!boxes.length) return null; // nothing to follow and nothing to look up
  return {
    APIKey: FOLLOW_API_KEY,
    BoundingBoxes: boxes,
    FilterMessageTypes: MSG_TYPES,
    FiltersShipMMSI: [...mmsis],
  };
}

// Send (or re-send) the current subscription on the open socket. If there is
// nothing left to follow, tear the connection down instead.
function sendSubscription() {
  if (!s.wsClient || s.wsClient.readyState !== WebSocket.OPEN) return;
  const sub = buildSubscription();
  if (!sub) {
    stop();
    return;
  }
  s.wsClient.send(JSON.stringify(sub));
  traceKey(FOLLOW_API_KEY, 'follow', 'SUBSCRIBE', { navi: sub.FiltersShipMMSI.length });
  const masked = JSON.stringify(sub).replace(FOLLOW_API_KEY, '***masked***');
  broadcastLog(
    db.insertLog({
      method: 'AIS',
      path: '/ais/follow/subscribe',
      status: 200,
      duration_ms: 0,
      response_body: `[follow] Sottoscrizione ${sub.FiltersShipMMSI.length} navi seguite${s.staleCount ? `, ${s.staleCount} in ri-acquisizione worldwide` : ''} | ${masked}`,
    })
  );
}

function connect() {
  if (s.wsClient) return;
  s.active = true;
  traceKey(FOLLOW_API_KEY, 'follow', 'WS_OPEN', { riconnessione: s.reconnectCount });
  s.wsClient = new WebSocket(AIS_URL);

  s.wsClient.on('open', () => {
    traceKey(FOLLOW_API_KEY, 'follow', 'OPEN_OK');
    console.log('[AIS:follow] Stream connesso');
    appLog.info('AIS', appLog.t('ais.stream_connected'), { area: 'follow', riconnessione: s.reconnectCount });
    s.rawFramesReceived = 0;
    s.sessionMessages = 0;
    s.connectedAt = Date.now();
    s.connFailCount = 0; // healthy connection: reset the backoff ramp
    s.was429 = false;
    s.abuseReason = null;
    if (s.isFirstConnect) s.isFirstConnect = false;
    else s.reconnectCount++;

    sendSubscription();

    s.heartbeatTimer = setInterval(() => {
      const upSec = Math.round((Date.now() - s.connectedAt) / 1000);
      broadcastLog(
        db.insertLog({
          method: 'AIS',
          path: '/ais/follow/heartbeat',
          status: s.rawFramesReceived > 0 ? 200 : 204,
          duration_ms: 0,
          response_body: `[follow] Connesso da ${upSec}s | frame WS: ${s.rawFramesReceived} | navi seguite: ${s.followedCount}${s.staleCount ? ` (${s.staleCount} in ri-acquisizione worldwide)` : ''}`,
        })
      );
    }, 60000);
  });

  s.wsClient.on('message', (data) => {
    s.rawFramesReceived++;
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.error) {
        console.error('[AIS:follow] Error:', parsed.error);
        const apiAbuse = keyAbuseReason(parsed.error);
        if (apiAbuse) { s.was429 = true; s.abuseReason = apiAbuse; }
        traceKey(FOLLOW_API_KEY, 'follow', 'API_ERROR', { error: String(parsed.error), ...(apiAbuse ? { problema: apiAbuse } : {}) });
        appLog.error('AIS', appLog.t('ais.api_error'), { area: 'follow', error: String(parsed.error), key: KEY_TAG, ...(apiAbuse ? { problema: apiAbuse } : {}) });
        s.lastAisError = String(parsed.error);
        s.lastAisErrorAt = new Date().toISOString();
        broadcastLog(
          db.insertLog({ method: 'AIS', path: '/ais/follow/api-error', status: 401, duration_ms: 0, response_body: String(parsed.error) })
        );
        return;
      }
      if (!parsed.MessageType) return;

      const t0 = Date.now();
      const lat = parsed.MetaData?.latitude ?? null;
      const lon = parsed.MetaData?.longitude ?? null;
      const area = lat != null && lon != null ? areaForPoint(lat, lon) || '' : '';
      // Check before insert: users with search_mode=1 for this MMSI (follow_searching was sent).
      // If position arrives, we'll fire follow_found for them.
      const rawMmsi = parsed.MetaData?.MMSI ? Number(parsed.MetaData.MMSI) : null;
      const searchFollowers = rawMmsi && lat != null && lon != null ? db.getSearchModeFollowersOf(rawMmsi) : [];
      const mmsi = db.insertFollowPosition(parsed, area);
      // A search lookup is waiting for this MMSI's first position: hand the fix
      // to its callbacks (the SSE search/recover handler streams it to the UI).
      if (mmsi && lat != null && lon != null && lookups.has(mmsi)) {
        const fix = {
          mmsi,
          lat,
          lon,
          name: (parsed.MetaData?.ShipName || '').trim() || null,
          sog: parsed.Message?.[parsed.MessageType]?.Sog ?? null,
          cog: parsed.Message?.[parsed.MessageType]?.Cog ?? null,
          time: parsed.MetaData?.time_utc || null,
        };
        for (const cb of lookups.get(mmsi)) {
          try { cb(fix); } catch { /* a dead SSE client must not break the stream */ }
        }
      }
      // Ship was in search_mode: position arrived → notify follow_found, reset mode.
      if (mmsi && searchFollowers.length) {
        const shipName = (parsed.MetaData?.ShipName || '').trim() || `MMSI ${mmsi}`;
        appLog.info('AIS', `Nave ritrovata in ricerca: ${shipName}`, { area: 'follow', mmsi });
        for (const userId of searchFollowers) {
          db.setFollowSearchMode(userId, mmsi, 0);
          db.addNotification({ user_id: userId, type: 'follow_found', mmsi, ship_name: shipName });
          try { telegram.notifyShipEvent(userId, 'follow_found', { name: shipName }); } catch { /* best-effort */ }
        }
      }
      if (mmsi) {
        invalidateRiskCache(mmsi);
        s.totalReceived++;
        s.sessionMessages++;
        broadcastLog(
          db.insertLog({
            method: 'DB',
            path: `/ais/follow/${parsed.MessageType}`,
            status: 200,
            duration_ms: Date.now() - t0,
            request_body: JSON.stringify(parsed).slice(0, MAX_BODY),
            response_body: null,
          })
        );
      }
    } catch (e) {
      console.error('[AIS:follow] Parse error:', e.message);
      appLog.error('AIS', appLog.t('ais.parse_error'), { area: 'follow', error: e.message });
      broadcastLog(
        db.insertLog({ method: 'AIS', path: '/ais/follow/parse-error', status: 500, duration_ms: 0, response_body: e.message })
      );
    }
  });

  s.wsClient.on('close', (code) => {
    traceKey(FOLLOW_API_KEY, 'follow', `CLOSE(${code})`, s.abuseReason ? { problema: s.abuseReason } : undefined);
    console.log(`[AIS:follow] Connessione chiusa (${code})`);
    clearInterval(s.heartbeatTimer);
    s.heartbeatTimer = null;
    const upSec = s.connectedAt ? Math.round((Date.now() - s.connectedAt) / 1000) : 0;
    const delayMs = s.active ? backoffDelay(s.connFailCount, s.was429) : 0;
    const delaySec = Math.round(delayMs / 1000);
    broadcastLog(
      db.insertLog({
        method: 'AIS',
        path: '/ais/follow/disconnect',
        status: code || 0,
        duration_ms: 0,
        response_body: `[follow] Connessione chiusa (code ${code}) dopo ${upSec}s | key: ${KEY_TAG}${s.active ? ` — riconnessione in ${delaySec}s${s.abuseReason ? ` — ${s.abuseReason}` : ''}` : ''}`,
      })
    );
    s.wsClient = null;
    if (s.active) {
      s.connFailCount++;
      appLog.warn('AIS', appLog.t('ais.conn_closed_reconnect', { code, delaySec }), { area: 'follow', upSec, delaySec, key: KEY_TAG, ...(s.abuseReason ? { problema: s.abuseReason } : {}) });
      traceKey(FOLLOW_API_KEY, 'follow', 'RECONNECT', { delaySec });
      s.reconnectTimer = setTimeout(() => { s.reconnectTimer = null; connect(); }, delayMs);
    } else {
      appLog.info('AIS', appLog.t('ais.conn_closed', { code }), { area: 'follow', upSec, key: KEY_TAG });
    }
  });

  s.wsClient.on('error', (err) => {
    const abuse = keyAbuseReason(err.message);
    if (abuse) { s.was429 = true; s.abuseReason = abuse; } // raise the reconnect floor (see close handler)
    traceKey(FOLLOW_API_KEY, 'follow', 'ERROR', { error: err.message, ...(abuse ? { problema: abuse } : {}) });
    console.error('[AIS:follow] WS error:', err.message);
    appLog.error('AIS', appLog.t('ais.ws_error'), { area: 'follow', error: err.message, key: KEY_TAG, ...(abuse ? { problema: abuse } : {}) });
    broadcastLog(
      db.insertLog({ method: 'AIS', path: '/ais/follow/ws-error', status: 500, duration_ms: 0, response_body: err.message })
    );
    s.wsClient?.terminate();
    s.wsClient = null;
  });
}

// Tear down the connection and stop reconnecting (used when nothing is followed).
function stop() {
  s.active = false;
  clearTimeout(s.reconnectTimer);
  clearInterval(s.heartbeatTimer);
  s.reconnectTimer = null;
  s.heartbeatTimer = null;
  if (s.wsClient) {
    traceKey(FOLLOW_API_KEY, 'follow', 'CLOSE_GRACEFUL');
    closeSocket(s.wsClient); // close frame → free the per-account slot promptly
    s.wsClient = null;
  }
}

// Periodic + on-demand reconciliation: auto-stop stale follows, then connect /
// resubscribe / disconnect to match the current followed set. Called by the
// refresh timer and immediately whenever a ship is followed/unfollowed.
function refresh() {
  const stale = db.autoStopStaleFollowsAll(FOLLOW_STALE_HOURS);
  if (stale.length) {
    const uniqueNames = [...new Set(stale.map((x) => x.ship_name || String(x.mmsi)))];
    appLog.info('AIS', `Follow auto-stop dopo ${FOLLOW_STALE_HOURS}h di silenzio: ${uniqueNames.join(', ')}`, { area: 'follow', navi: uniqueNames.length });
    for (const { user_id, mmsi, ship_name } of stale) {
      db.addNotification({ user_id, type: 'follow_lost', mmsi, ship_name });
      try { telegram.notifyShipEvent(user_id, 'follow_lost', { name: ship_name || `MMSI ${mmsi}` }); } catch { /* best-effort */ }
    }
  }

  const positions = db.getAllFollowedPositions();
  s.followedCount = positions.length;

  // Fallback: scrape ShipFinder for stale follows AIS can't see (fire-and-forget,
  // throttled/capped inside). Uses getAllFollowedShips so it also covers follows
  // that NEVER got an AIS fix (e.g. added by search) — ShipFinder can locate them
  // by MMSI. The worldwide AIS box recovery continues in parallel regardless.
  if (state.importSfData || state.importMstData) {
    const now = Date.now();
    const stale = db.getAllFollowedShips().filter((sh) => isStaleFollow(sh, now));
    if (stale.length && state.importSfData) reacquireStaleViaShipfinder(stale).catch((e) => console.error(`[SF:reacquire] ${e.message}`));
    if (stale.length && state.importMstData) reacquireStaleViaMst(stale).catch((e) => console.error(`[MST:reacquire] ${e.message}`));
  }

  if (!positions.length && !lookups.size) {
    if (s.wsClient || s.active) stop();
    return;
  }
  if (!s.wsClient && !s.reconnectTimer) {
    connect();
  } else {
    sendSubscription();
  }
}

// Scrape ShipFinder for stale followed ships and store any position found, so a
// follow that has gone dark to our AIS stream still gets a last-known fix on the
// map. Throttled per MMSI (SF_REACQUIRE_THROTTLE_MS), capped per sweep, staggered,
// and negative-cached on miss — keeps request volume low / captcha-safe. The AIS
// worldwide box keeps hunting in parallel; a real AIS fix always supersedes this.
async function reacquireStaleViaShipfinder(staleShips) {
  if (sfSweeping || !state.importSfData || !staleShips.length) return;
  sfSweeping = true;
  try {
    const now = Date.now();
    const due = staleShips
      .filter((sh) => now - (lastSfScrape.get(sh.mmsi) || 0) >= state.sfScrapeIntervalMs)
      .filter((sh) => !db.hasRecentScrapeFailure(sh.mmsi, 'sf', SCRAPE_NEG_CACHE_DAYS))
      .slice(0, SF_REACQUIRE_MAX_PER_SWEEP);
    for (const sh of due) {
      lastSfScrape.set(sh.mmsi, Date.now());
      try {
        const { static: staticData, position } = await crawlShipfinder(sh.mmsi);
        db.recordScrape('sf', true);
        if (staticData && Object.keys(staticData).length) db.setScrapedData(sh.mmsi, 'sf', staticData);
        if (position) {
          const stored = db.insertScrapedPosition(sh.mmsi, { ...position, name: position.name || sh.ship_name });
          db.clearScrapeFailure(sh.mmsi, 'sf');
          if (stored) {
            invalidateRiskCache(sh.mmsi);
            appLog.info('SCRAPE', `Posizione ShipFinder per nave seguita persa: ${sh.ship_name || sh.mmsi}`, { mmsi: sh.mmsi });
          }
        } else {
          db.setScrapeFailure(sh.mmsi, 'sf', 'ShipFinder: nessuna posizione');
        }
      } catch (e) {
        db.setScrapeFailure(sh.mmsi, 'sf', e.message);
        db.recordScrape('sf', false);
      }
      await new Promise((r) => setTimeout(r, 2000)); // stagger requests
    }
  } finally {
    sfSweeping = false;
  }
}

// MyShipTracking counterpart of reacquireStaleViaShipfinder — identical mechanics
// (throttle / cap / stagger / negative-cache), a second independent source so a
// stale follow still gets a last-known fix if ShipFinder misses it.
async function reacquireStaleViaMst(staleShips) {
  if (mstSweeping || !state.importMstData || !staleShips.length) return;
  mstSweeping = true;
  try {
    const now = Date.now();
    const due = staleShips
      .filter((sh) => now - (lastMstScrape.get(sh.mmsi) || 0) >= state.mstScrapeIntervalMs)
      .filter((sh) => !db.hasRecentScrapeFailure(sh.mmsi, 'mst', SCRAPE_NEG_CACHE_DAYS))
      .slice(0, SF_REACQUIRE_MAX_PER_SWEEP);
    for (const sh of due) {
      lastMstScrape.set(sh.mmsi, Date.now());
      try {
        const { static: staticData, position } = await crawlMyshiptracking(sh.mmsi);
        db.recordScrape('mst', true);
        if (staticData && Object.keys(staticData).length) db.setScrapedData(sh.mmsi, 'mst', staticData);
        if (position) {
          const stored = db.insertScrapedPosition(sh.mmsi, { ...position, name: position.name || sh.ship_name }, 'mst');
          db.clearScrapeFailure(sh.mmsi, 'mst');
          if (stored) {
            invalidateRiskCache(sh.mmsi);
            appLog.info('SCRAPE', `Posizione MyShipTracking per nave seguita persa: ${sh.ship_name || sh.mmsi}`, { mmsi: sh.mmsi });
          }
        } else {
          db.setScrapeFailure(sh.mmsi, 'mst', 'MyShipTracking: nessuna posizione');
        }
      } catch (e) {
        db.setScrapeFailure(sh.mmsi, 'mst', e.message);
        db.recordScrape('mst', false);
      }
      await new Promise((r) => setTimeout(r, 2000)); // stagger requests
    }
  } finally {
    mstSweeping = false;
  }
}

// Start the background refresh loop. Safe to call once at boot.
function init() {
  if (s.refreshTimer) return;
  s.refreshTimer = setInterval(refresh, FOLLOW_REFRESH_MS);
  refresh();
}

// Register a transient position lookup for `mmsi`. `onFix(fix)` is invoked on the
// first (and every subsequent) position frame for that ship until removeLookup is
// called. Multiple concurrent searches for the same MMSI share one subscription.
// Returns the callback so the caller can pass it back to removeLookup.
function addLookup(mmsi, onFix) {
  mmsi = Number(mmsi);
  let set = lookups.get(mmsi);
  if (!set) {
    set = new Set();
    lookups.set(mmsi, set);
  }
  set.add(onFix);
  // (Re)connect or resubscribe so the worldwide box + MMSI take effect now.
  if (!s.wsClient && !s.reconnectTimer) connect();
  else sendSubscription();
  return onFix;
}

// Drop a lookup callback. When the last callback for an MMSI is gone the worldwide
// box is rebuilt without it; if nothing is followed or looked up the connection
// is torn down. Idempotent.
function removeLookup(mmsi, onFix) {
  mmsi = Number(mmsi);
  const set = lookups.get(mmsi);
  if (!set) return;
  set.delete(onFix);
  if (!set.size) lookups.delete(mmsi);
  refresh();
}

// Begin a background re-acquisition for a just-(re)followed ship. Idempotent per
// MMSI: concurrent followers share one worldwide lookup + one timer.
function startReacquire(userId, mmsi, name) {
  mmsi = Number(mmsi);
  const existing = reacquires.get(mmsi);
  if (existing) { existing.users.add(userId); return; }
  const r = { users: new Set([userId]), name: name || null, cb: null, timer: null };
  reacquires.set(mmsi, r);
  r.cb = addLookup(mmsi, () => finishReacquire(mmsi, true));
  r.timer = setTimeout(() => finishReacquire(mmsi, false), SEARCH_LOOKUP_TIMEOUT_MS);
  appLog.info('AIS', `Ri-acquisizione posizione avviata per ${name || mmsi}`, { area: 'follow', mmsi });
}

// Resolve a re-acquisition. `found=true` (a fix arrived) just tears the lookup
// down and rebuilds the tight box around the fresh position. `found=false` (the
// timer fired) keeps the follow active but marks search_mode=1 so the worldwide
// box keeps hunting for the ship; the user is notified it's "in ricerca".
function finishReacquire(mmsi, found) {
  mmsi = Number(mmsi);
  const r = reacquires.get(mmsi);
  if (!r) return; // already resolved (first fix wins / cancelled)
  reacquires.delete(mmsi);
  clearTimeout(r.timer);
  if (r.cb) removeLookup(mmsi, r.cb);
  if (found) {
    appLog.info('AIS', `Ri-acquisizione riuscita per ${r.name || mmsi}`, { area: 'follow', mmsi });
    refresh();
    return;
  }
  appLog.warn('AIS', `Ri-acquisizione fallita per ${r.name || mmsi}: nessun segnale entro il timeout — rimane in ricerca`, { area: 'follow', mmsi });
  for (const userId of r.users) {
    if (!db.getUserFollowedMmsis(userId).has(mmsi)) continue; // user unfollowed meanwhile
    db.setFollowSearchMode(userId, mmsi, 1);
    db.addNotification({ user_id: userId, type: 'follow_searching', mmsi, ship_name: r.name });
    try { telegram.notifyShipEvent(userId, 'follow_searching', { name: r.name || `MMSI ${mmsi}` }); } catch { /* best-effort */ }
  }
  refresh();
}

// Cancel a pending re-acquisition for one user (e.g. they unfollowed before it
// resolved). Drops the shared lookup/timer when the last follower leaves.
function cancelReacquire(userId, mmsi) {
  mmsi = Number(mmsi);
  const r = reacquires.get(mmsi);
  if (!r) return;
  r.users.delete(userId);
  if (!r.users.size) {
    clearTimeout(r.timer);
    if (r.cb) removeLookup(mmsi, r.cb);
    reacquires.delete(mmsi);
  }
}

// Apply a follow/unfollow for a user: persist it, then reconcile the live stream.
// Following a ship whose last position is stale (typically a re-follow from
// "passate") can't rely on the tight follow box — the ship has likely left it —
// so we kick off a background worldwide re-acquisition; if it finds nothing
// within the timeout the follow is reverted and the user notified. Shared by the
// HTTP route and the Telegram inline button. Returns { reacquiring }.
function applyFollow(userId, mmsi, followed) {
  mmsi = Number(mmsi);
  db.setUserFollow(userId, mmsi, !!followed);
  let reacquiring = false;
  if (followed) {
    let ship = db.getShip(mmsi);
    if (!ship) {
      // Never seen via AIS — followed from a ShipFinder/MyShipTracking scrape fix.
      // Materialize a stub master row (epoch last_seen = "never had AIS") so it
      // lists and the worldwide box hunts it; mark search_mode=1 so the UI shows
      // "in ricerca" at once. A real AIS frame later upgrades last_seen and clears
      // search_mode (see the insert path's follow_found handling).
      db.ensureShipStub(mmsi, db.getScrapedShipName(mmsi));
      db.setFollowSearchMode(userId, mmsi, 1);
      ship = db.getShip(mmsi);
    }
    const fresh = ship && ship.last_latitude != null && ship.last_longitude != null && ship.last_seen_at
      && Date.now() - new Date(ship.last_seen_at).getTime() < FOLLOW_FRESH_MS;
    if (!fresh) {
      startReacquire(userId, mmsi, ship ? ship.ship_name : null);
      reacquiring = true;
    }
  } else {
    cancelReacquire(userId, mmsi);
  }
  refresh();
  return { reacquiring };
}

function getStatus() {
  return { active: s.active, connected: !!s.wsClient, followedCount: s.followedCount, staleCount: s.staleCount, lookupCount: lookups.size, reacquireCount: reacquires.size, totalReceived: s.totalReceived };
}

function getHealth() {
  const uptimeSec = s.connectedAt ? Math.round((Date.now() - s.connectedAt) / 1000) : 0;
  const msgPerMin = uptimeSec > 0 ? Math.round((s.sessionMessages / uptimeSec) * 60) : null;
  return {
    area: 'follow',
    connected: !!s.wsClient,
    keyTag: KEY_TAG,
    // 'shared' means follow reuses API_KEY and competes with the area streams for
    // the per-key connection slot (the 429 risk); a distinct key removes it.
    keySource: FOLLOW_API_KEY_SOURCE,
    connectedAt: s.connectedAt ? new Date(s.connectedAt).toISOString() : null,
    uptimeSec,
    followedCount: s.followedCount,
    staleCount: s.staleCount,
    sessionFrames: s.rawFramesReceived,
    sessionMessages: s.sessionMessages,
    msgPerMin,
    reconnectCount: s.reconnectCount,
    lastAisError: s.lastAisError,
    lastAisErrorAt: s.lastAisErrorAt,
  };
}

module.exports = { init, refresh, stop, addLookup, removeLookup, startReacquire, cancelReacquire, applyFollow, getStatus, getHealth };
