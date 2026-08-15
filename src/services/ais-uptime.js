'use strict';

// AIS service outage detection.
//
// We always know whether *our* WebSocket to aisstream.io is connected (see
// services/ais-stream.js), but a connected-yet-silent stream is ambiguous: it
// could mean the global AIS service is down, or simply that the monitored area
// is quiet right now. To disambiguate, when our active streams have received no
// ship message for `AIS_OUTAGE_SILENCE_MIN` minutes we consult an AISStream
// uptime monitor (github.com/buttermilkgreen/AISStream-Uptime, MIT) — an
// independent service that keeps its own connection to stream.aisstream.io and
// classifies it as Up / Silent Failure / Auth Error / Down. Only when WE are
// silent AND the monitor reports a non-Up state do we declare an outage, which
// the UI surfaces as a non-blocking banner.
//
// Hybrid lookup: we try the monitors returned by `monitors()` in priority order
// and the first one that answers decides the verdict. A self-hosted instance
// (AIS_UPTIME_SELFHOST_URL) comes first, so a healthy private deployment never
// touches the public service; the public monitor (AIS_UPTIME_URL) is the
// fallback and also reflects whether the outage is community-wide.
//
// The monitors are probed only while we're silent (never during normal
// traffic), and at most once per MIN_PROBE_GAP_MS, so this adds negligible load.

const db = require('../db');
const appLog = require('./app-log');
const stream = require('./ais-stream');
const shipFollow = require('./ship-follow');
const heatmapStream = require('./heatmap-stream');
const fallbackMode = require('./fallback-mode');
const {
  AIS_OUTAGE_CHECK,
  AIS_OUTAGE_SILENCE_MIN,
  AIS_UPTIME_URL,
  AIS_UPTIME_SELFHOST_URL,
  AIS_FALLBACK_HOURS,
  AIS_FALLBACK_EXIT_GRACE_MIN,
} = require('../config');

const CHECK_INTERVAL_MS = 60 * 1000; // how often we re-evaluate local silence
const PROBE_TIMEOUT_MS = 8000; // give up on the monitor after this
const MIN_PROBE_GAP_MS = 60 * 1000; // don't hammer the public monitor

// Current outage verdict, served to the frontend via GET /api/stream/status.
//   serviceDown   — true only when local silence AND monitor reports non-Up
//   monitorState  — the monitor's last reported state ('Down' | 'Up' | …)
//   monitorSource — which monitor answered ('selfhost' | 'public' | null)
//   checkedAt     — ISO time of our last evaluation
//   since         — ISO time serviceDown first became true (null when up)
//   silentMin     — our local silence in whole minutes
//
// `since`/`monitorState`/`monitorSource` are mirrored to meta keys
// `ais_outage_since`, `ais_outage_monitor_state`, `ais_outage_monitor_source`
// (see applyDown/applyUp below) and re-hydrated here at module load —
// including `serviceDown` itself, derived from `since` — so a restart
// mid-outage shows the banner immediately instead of going blank until local
// silence rebuilds. `init()` below also fires one immediate reconfirmation
// probe when we boot already believing we're down, rather than waiting up to
// AIS_OUTAGE_SILENCE_MIN minutes for our own just-reconnected stream to go
// silent again before even checking — see reconfirmOnBoot(). Either the
// outage is still ongoing (probe confirms; no duplicate detection/notify since
// serviceDown was already true) or it resolved while we were restarting (probe
// clears it right away).
let outage = {
  serviceDown: false,
  monitorState: db.getMeta('ais_outage_monitor_state') || null,
  monitorSource: db.getMeta('ais_outage_monitor_source') || null,
  checkedAt: null,
  since: db.getMeta('ais_outage_since') || null,
  silentMin: 0,
};
outage.serviceDown = !!outage.since;
let lastProbeAt = 0;
let lastProbeResult = null; // { state, lastChecked, source } from the most recent successful probe
let timer = null;

// Fallback-mode hysteresis: once a clean verdict arrives while fallback mode is
// active, this marks when that grace period started. Only a *sustained* clean
// verdict (AIS_FALLBACK_EXIT_GRACE_MIN minutes straight) actually exits fallback
// mode — a brief reconnect-then-drop blip cancels the pending exit instead of
// flipping fallback mode off and back on. In-memory only: losing it on restart
// just restarts the grace window, never wrongly exits early.
let fallbackExitPendingSince = null;

function handleFallbackTransition(down) {
  if (down) {
    fallbackExitPendingSince = null;
    if (outage.since && Date.now() - new Date(outage.since).getTime() >= AIS_FALLBACK_HOURS * 3600 * 1000) {
      fallbackMode.enter();
    }
    return;
  }
  if (!fallbackMode.isActive()) {
    fallbackExitPendingSince = null;
    return;
  }
  if (fallbackExitPendingSince === null) {
    fallbackExitPendingSince = Date.now();
  } else if (Date.now() - fallbackExitPendingSince >= AIS_FALLBACK_EXIT_GRACE_MIN * 60 * 1000) {
    fallbackMode.exit();
    fallbackExitPendingSince = null;
  }
}

/** Monitors to consult, highest priority first. Self-hosted instance before the
 *  public service, so a healthy private deployment never calls the public one. */
function monitors() {
  const list = [];
  if (AIS_UPTIME_SELFHOST_URL) list.push({ base: AIS_UPTIME_SELFHOST_URL, source: 'selfhost' });
  if (AIS_UPTIME_URL) list.push({ base: AIS_UPTIME_URL, source: 'public' });
  return list;
}

/** Query one monitor's status endpoint. Throws on failure. */
async function probeOne(base) {
  const url = `${base}/api/v1/status?simple=true`;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // `lastMessageReceived` is the monitor's own last-message timestamp — the
    // authoritative "down since" for the whole aisstream.io service, independent
    // of when OUR instance booted or first noticed. Used (see evaluate()) to
    // seed AIS_FALLBACK_HOURS's countdown correctly even on a first-ever deploy
    // during an outage that's already been running for days.
    return { state: data.state || null, lastChecked: data.lastChecked || null, lastMessageReceived: data.lastMessageReceived || null };
  } finally {
    clearTimeout(to);
  }
}

/** Probe monitors in priority order; the first that answers wins. Returns
 *  { state, lastChecked, lastMessageReceived, source }. Throws only when every
 *  monitor is unreachable (its message lists each failure), so a single failed
 *  probe is never an outage. */
async function probe() {
  const list = monitors();
  if (!list.length) throw new Error('no uptime monitor configured');
  const errors = [];
  for (const m of list) {
    try {
      const r = await probeOne(m.base);
      return { ...r, source: m.source };
    } catch (e) {
      errors.push(`${m.source}: ${e.message}`);
    }
  }
  throw new Error(errors.join('; '));
}

/** Transition (or reconfirm) the outage verdict to "down". Shared by evaluate()
 *  and reconfirmOnBoot() so the subtle since-fallback chain and notify-once
 *  behavior can't drift between the two call sites. */
function applyDown(result, nowIso, silentMin) {
  const monitorState = result.state;
  const monitorSource = result.source;
  if (!outage.serviceDown) {
    appLog.warn('AIS', appLog.t('ais.outage_detected', { state: monitorState, min: silentMin, source: monitorSource }));
    require('./telegram').broadcastOutage('start', { min: silentMin });
    require('./webhooks').broadcast('outage', { phase: 'start', min: silentMin });
  }
  // Prefer the monitor's own `lastMessageReceived` — the authoritative,
  // community-wide "down since" — over anything local: it's correct even on
  // a first-ever deploy made days into an outage, when our own detection
  // would otherwise start counting from nowIso. Falls back to `outage.since`
  // (re-hydrated from meta at module load, or set on a prior tick), and
  // finally to nowIso if neither is available. Persisted every tick while
  // down (cheap single UPSERT); the value itself is stable while down.
  const monitorSince =
    result?.lastMessageReceived && !Number.isNaN(Date.parse(result.lastMessageReceived)) ? result.lastMessageReceived : null;
  const since = monitorSince || outage.since || nowIso;
  db.setMeta('ais_outage_since', since);
  db.setMeta('ais_outage_monitor_state', monitorState);
  db.setMeta('ais_outage_monitor_source', monitorSource);
  outage = { serviceDown: true, monitorState, monitorSource, checkedAt: nowIso, since, silentMin };
  handleFallbackTransition(true);
}

/** Transition (or reconfirm) the outage verdict to "up". Shared by evaluate()
 *  and reconfirmOnBoot(). */
function applyUp(monitorState, monitorSource, nowIso, silentMin) {
  if (outage.serviceDown) {
    appLog.info('AIS', appLog.t('ais.outage_cleared'));
    require('./telegram').broadcastOutage('end');
    require('./webhooks').broadcast('outage', { phase: 'end' });
  }
  outage = { serviceDown: false, monitorState, monitorSource, checkedAt: nowIso, since: null, silentMin };
  db.setMeta('ais_outage_since', null);
  db.setMeta('ais_outage_monitor_state', null);
  db.setMeta('ais_outage_monitor_source', null);
  handleFallbackTransition(false);
}

async function evaluate() {
  const info = stream.getSilenceInfo();
  const nowIso = new Date().toISOString();

  // No active stream, or the pipe is healthy → clear any standing outage.
  if (!info.active || info.silentMs < AIS_OUTAGE_SILENCE_MIN * 60 * 1000) {
    applyUp(null, null, nowIso, 0);
    return;
  }

  // We've been silent long enough: cross-check the independent monitor.
  const silentMin = Math.round(info.silentMs / 60000);
  const now = Date.now();
  if (!lastProbeResult || now - lastProbeAt >= MIN_PROBE_GAP_MS) {
    lastProbeAt = now;
    try {
      lastProbeResult = await probe();
    } catch (e) {
      // Can't reach the monitor — a failed probe alone isn't proof of an outage,
      // so leave the current verdict untouched (just refresh the timestamp).
      appLog.warn('AIS', appLog.t('ais.outage_check_failed', { error: e.message }));
      outage = { ...outage, checkedAt: nowIso, silentMin };
      return;
    }
  }

  const down = lastProbeResult && lastProbeResult.state !== null && lastProbeResult.state !== 'Up';
  if (down) applyDown(lastProbeResult, nowIso, silentMin);
  else applyUp(lastProbeResult ? lastProbeResult.state : null, lastProbeResult ? lastProbeResult.source : null, nowIso, silentMin);
}

// Fires once at boot when we already believe (from persisted meta) that the
// service was down when we last shut down. Bypasses evaluate()'s local-silence
// gate — which would otherwise force waiting AIS_OUTAGE_SILENCE_MIN minutes for
// our just-reconnected stream to go quiet again before even checking — and
// reconfirms against the monitor immediately instead. One extra probe call,
// made only in this restart-mid-outage case, still respects MIN_PROBE_GAP_MS
// pacing for every check after it. If both monitors are unreachable, the
// rehydrated verdict is left as-is and the next scheduled evaluate() tick
// retries normally.
async function reconfirmOnBoot() {
  const nowIso = new Date().toISOString();
  lastProbeAt = Date.now();
  try {
    lastProbeResult = await probe();
  } catch (e) {
    appLog.warn('AIS', appLog.t('ais.outage_check_failed', { error: e.message }));
    return;
  }
  const down = lastProbeResult.state !== null && lastProbeResult.state !== 'Up';
  if (down) applyDown(lastProbeResult, nowIso, outage.silentMin);
  else applyUp(lastProbeResult.state, lastProbeResult.source, nowIso, 0);
}

// Follow/heatmap message silence is normal (a followed ship or a quiet grid cell
// can go silent for a long time without anything being wrong), so they can't use
// evaluate()'s frame-silence + external cross-check above. But there's a SEPARATE
// failure mode that affects all three streams equally, monitoring included: never
// managing to hold a connection long enough to even become silent (or silent-and-
// data-flowing) in the first place — it keeps closing (503 / socket hang up / 1006)
// within seconds of connecting, over and over. evaluate()'s silentMs is computed
// from connectedAt when no frame has ever arrived, and connectedAt resets on every
// single reconnect — so pure flapping NEVER accumulates enough silence to even
// reach the external-monitor cross-check. That's unambiguous on its own (repeatedly
// failing to hold OUR OWN socket open has nothing to do with area traffic being
// quiet), so it doesn't need the cross-check either. Two signals, either flags
// trouble:
//   - sustained: failed to hold ANY healthy connection for AIS_OUTAGE_SILENCE_MIN
//     minutes straight (disconnectedSince keeps growing).
//   - flapping: keeps reconnecting every minute or so — each attempt briefly
//     clears disconnectedSince (it gets past the healthy mark) so it never
//     accumulates, but the connection is clearly not stable. Caught by counting
//     reconnects within the same window instead of their continuous duration.
const FLAP_RECONNECTS = 3; // reconnects within the window = flapping, not a one-off blip
function stuckStreams() {
  const stuck = [];
  const windowMs = AIS_OUTAGE_SILENCE_MIN * 60 * 1000;
  const now = Date.now();
  for (const [name, mod] of [['monitoring', stream], ['follow', shipFollow], ['heatmap', heatmapStream]]) {
    const c = mod.getConnTrouble();
    if (!c.active) continue;
    const sustained = c.disconnectedSince && now - c.disconnectedSince >= windowMs;
    const recentReconnects = (c.reconnectLog || []).filter((t) => now - t <= windowMs).length;
    if (sustained || recentReconnects >= FLAP_RECONNECTS) stuck.push(name);
  }
  return stuck;
}

/** Current outage verdict (cheap; served on every status poll). Recomputes the
 *  follow/heatmap connectivity signal fresh on every call (no interval needed —
 *  it's a plain state read, not a network probe). */
function getOutage() {
  return { ...outage, streamIssues: stuckStreams(), fallbackMode: fallbackMode.getStatus() };
}

/** Start the periodic silence/uptime evaluation. No-op when disabled. */
function init() {
  if (!AIS_OUTAGE_CHECK || timer) return;
  if (outage.serviceDown) reconfirmOnBoot().catch(() => {});
  timer = setInterval(() => evaluate().catch(() => {}), CHECK_INTERVAL_MS);
}

module.exports = { init, getOutage };
