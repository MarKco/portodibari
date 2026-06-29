'use strict';

// PER-KEY OPERATION TRACE — diagnostic for AISStream 429 "too many connections".
//
// AISStream limits concurrent connections PER ACCOUNT (not strictly per key). A
// 429 on a key you believe is dedicated means *something* is holding/opening a
// second slot on that account at the same moment: another of our three streams
// (per-area monitoring / ship-follow / heatmap), a second server instance, or a
// reconnect firing before the old socket was released.
//
// To make that visible, every operation that consumes a connection slot logs ONE
// line here, tagged KEY, carrying the masked key tail (last 4 chars — non-secret)
// + the stream label + the op. All three streams funnel through this one tag, so
// reading the KEY lines in order shows the interleaving: if two streams show
// WS_OPEN with the SAME tail seconds apart, that's the contention causing the 429.
//
// Ops: WS_OPEN (socket handshake started), OPEN_OK (handshake accepted),
// SUBSCRIBE (subscription sent), CLOSE (socket closed), ERROR (socket error),
// RECONNECT (next attempt scheduled).

const appLog = require('./app-log');
const { maskKey } = require('../config');

// Emit one trace line for a key-bearing operation. `key` is the raw API key (only
// its last 4 chars are ever logged). `stream` is a short label (e.g. 'area:livorno',
// 'follow', 'heatmap'). `op` is one of the ops above. `extra` is merged into the
// structured data for context (code, delaySec, error, …).
function traceKey(key, stream, op, extra) {
  const tail = maskKey(key); // …abcd — non-secret fingerprint, shared tail = shared key
  appLog.info('KEY', `${tail} | ${stream} | ${op}`, { key: tail, stream, op, ...(extra || {}) });
}

module.exports = { traceKey };
