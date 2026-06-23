'use strict';

// AIS service outage detection.
//
// We always know whether *our* WebSocket to aisstream.io is connected (see
// services/ais-stream.js), but a connected-yet-silent stream is ambiguous: it
// could mean the global AIS service is down, or simply that the monitored area
// is quiet right now. To disambiguate, when our active streams have received no
// ship message for `AIS_OUTAGE_SILENCE_MIN` minutes we consult the public
// AISStream uptime monitor (github.com/buttermilkgreen/AISStream-Uptime, hosted
// at AIS_UPTIME_URL) — an independent service that keeps its own connection to
// stream.aisstream.io and classifies it as Up / Silent Failure / Auth Error /
// Down. Only when WE are silent AND the monitor reports a non-Up state do we
// declare an outage, which the UI surfaces as a non-blocking banner.
//
// The monitor is probed only while we're silent (never during normal traffic),
// and at most once per MIN_PROBE_GAP_MS, so this adds negligible outbound load.

const appLog = require('./app-log');
const stream = require('./ais-stream');
const { AIS_OUTAGE_CHECK, AIS_OUTAGE_SILENCE_MIN, AIS_UPTIME_URL } = require('../config');

const CHECK_INTERVAL_MS = 60 * 1000; // how often we re-evaluate local silence
const PROBE_TIMEOUT_MS = 8000; // give up on the monitor after this
const MIN_PROBE_GAP_MS = 60 * 1000; // don't hammer the public monitor

// Current outage verdict, served to the frontend via GET /api/stream/status.
//   serviceDown  — true only when local silence AND monitor reports non-Up
//   monitorState — the monitor's last reported state ('Down' | 'Up' | …)
//   checkedAt    — ISO time of our last evaluation
//   since        — ISO time serviceDown first became true (null when up)
//   silentMin    — our local silence in whole minutes
let outage = { serviceDown: false, monitorState: null, checkedAt: null, since: null, silentMin: 0 };
let lastProbeAt = 0;
let lastProbeResult = null; // { state, lastChecked } from the most recent probe
let timer = null;

/** Query the public uptime monitor's status endpoint. Throws on failure. */
async function probe() {
  const url = `${AIS_UPTIME_URL}/api/v1/status?simple=true`;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { state: data.state || null, lastChecked: data.lastChecked || null };
  } finally {
    clearTimeout(to);
  }
}

async function evaluate() {
  const info = stream.getSilenceInfo();
  const nowIso = new Date().toISOString();

  // No active stream, or the pipe is healthy → clear any standing outage.
  if (!info.active || info.silentMs < AIS_OUTAGE_SILENCE_MIN * 60 * 1000) {
    if (outage.serviceDown) appLog.info('AIS', appLog.t('ais.outage_cleared'));
    outage = { serviceDown: false, monitorState: null, checkedAt: nowIso, since: null, silentMin: 0 };
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

  const monitorState = lastProbeResult ? lastProbeResult.state : null;
  const down = monitorState !== null && monitorState !== 'Up';

  if (down) {
    if (!outage.serviceDown) {
      appLog.warn('AIS', appLog.t('ais.outage_detected', { state: monitorState, min: silentMin }));
    }
    outage = {
      serviceDown: true,
      monitorState,
      checkedAt: nowIso,
      since: outage.serviceDown ? outage.since : nowIso,
      silentMin,
    };
  } else {
    if (outage.serviceDown) appLog.info('AIS', appLog.t('ais.outage_cleared'));
    outage = { serviceDown: false, monitorState, checkedAt: nowIso, since: null, silentMin };
  }
}

/** Current outage verdict (cheap; served on every status poll). */
function getOutage() {
  return outage;
}

/** Start the periodic silence/uptime evaluation. No-op when disabled. */
function init() {
  if (!AIS_OUTAGE_CHECK || timer) return;
  timer = setInterval(() => evaluate().catch(() => {}), CHECK_INTERVAL_MS);
}

module.exports = { init, getOutage };
