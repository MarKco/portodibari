'use strict';

// Reconnect backoff shared by the per-area AIS streams (ais-stream.js) and the
// ship-follow stream (ship-follow.js). Both used to reconnect on a fixed 5s timer,
// which turns a refused handshake (HTTP 429 — AISstream's per-key connection limit)
// into an endless 5s hammer loop that never recovers. This computes an exponential
// backoff with jitter, with a longer floor while the last failure was a 429.

const { RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS, RECONNECT_429_DELAY_MS } = require('../config');

// True when a WebSocket error message indicates an HTTP 429 handshake rejection.
function is429(message) {
  return /\b429\b/.test(String(message || ''));
}

// Classify a WS error / AISstream error message as a key over-use problem (the
// per-key connection/rate limit being hit), returning an Italian reason for the
// log, or null if the error is something else. Covers both the 429 handshake
// rejection and the JSON error messages AISstream sends when a key is over its
// connection allowance. Callers use a non-null result to flag the longer backoff.
function keyAbuseReason(message) {
  const m = String(message || '');
  if (/\b429\b/.test(m)) return 'sovra-uso chiave: troppe connessioni/richieste sulla stessa chiave (429)';
  if (/too many|rate.?limit|connection limit|max(?:imum)?\b.*\bconnection|quota|exceeded/i.test(m)) {
    return 'sovra-uso chiave: limite connessioni/quota della chiave superato';
  }
  return null;
}

// Next reconnect delay in ms. `failCount` is the number of consecutive failed
// connection attempts (0 on the first retry after a healthy connection). `was429`
// raises the floor so we back right off a rate/connection limit instead of poking
// it every few seconds. ±20% jitter avoids a thundering herd across streams.
function backoffDelay(failCount, was429) {
  let d = Math.min(RECONNECT_DELAY_MS * 2 ** failCount, RECONNECT_MAX_DELAY_MS);
  if (was429) d = Math.max(d, RECONNECT_429_DELAY_MS);
  d = Math.min(d, RECONNECT_MAX_DELAY_MS);
  const jitter = d * 0.2 * (Math.random() * 2 - 1);
  return Math.max(RECONNECT_DELAY_MS, Math.round(d + jitter));
}

module.exports = { is429, keyAbuseReason, backoffDelay };
