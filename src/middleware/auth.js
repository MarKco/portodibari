'use strict';

const crypto = require('crypto');
const config = require('../config');

/**
 * Constant-time string comparison: avoids leaking the password length/content
 * through response-timing differences. `timingSafeEqual` requires equal-length
 * buffers, so the length check short-circuits (already non-secret information).
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * HTTP Basic Auth gate. Protects everything mounted after it (static files,
 * API, SSE) using credentials from local.properties / env (AUTH_USER,
 * AUTH_PASSWORD). When AUTH_PASSWORD is empty, auth is disabled — preserving
 * the zero-config local-dev experience.
 *
 * NOTE: Basic auth does not encrypt credentials (base64 ≈ cleartext on every
 * request). Put TLS in front (or use an SSH tunnel) when exposing publicly.
 */
module.exports = function basicAuth(req, res, next) {
  const { AUTH_USER, AUTH_PASSWORD } = config;
  if (!AUTH_PASSWORD) return next(); // auth disabled when no password set

  const hdr = req.headers.authorization || '';
  const [scheme, encoded] = hdr.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = sep === -1 ? decoded : decoded.slice(0, sep);
    const pass = sep === -1 ? '' : decoded.slice(sep + 1);
    // Evaluate both comparisons regardless of the first result (no early exit)
    // so a wrong username and a wrong password take the same time.
    const okUser = safeEqual(user, AUTH_USER);
    const okPass = safeEqual(pass, AUTH_PASSWORD);
    if (okUser && okPass) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Tracker Porti", charset="UTF-8"');
  return res.status(401).send('Autenticazione richiesta');
};
