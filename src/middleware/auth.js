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
 * True when the request comes directly from the loopback interface. Reads the
 * raw socket address only — X-Forwarded-For is deliberately NOT trusted, so a
 * spoofed header can't masquerade as local and the password-less bypass can
 * never be reached through a reverse proxy (where the socket is the proxy, not
 * the client). Behind a proxy you must set AUTH_PASSWORD.
 */
function isLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * HTTP Basic Auth gate. Protects everything mounted after it (static files,
 * API, SSE) using credentials from local.properties / env (AUTH_USER,
 * AUTH_PASSWORD).
 *
 * When AUTH_PASSWORD is empty, auth is bypassed ONLY for loopback requests —
 * preserving the zero-config local-dev experience while refusing any remote
 * client (which would otherwise gain full, unauthenticated control, including
 * destructive endpoints). Remote access therefore requires a password.
 *
 * NOTE: Basic auth does not encrypt credentials (base64 ≈ cleartext on every
 * request). Put TLS in front (or use an SSH tunnel) when exposing publicly.
 */
module.exports = function basicAuth(req, res, next) {
  const { AUTH_USER, AUTH_PASSWORD } = config;
  if (!AUTH_PASSWORD) {
    if (isLoopback(req)) return next(); // zero-config local dev
    // No password configured but the request is remote: refuse rather than
    // exposing everything unauthenticated.
    res.set('WWW-Authenticate', 'Basic realm="Tracker Porti", charset="UTF-8"');
    return res
      .status(401)
      .send('Accesso remoto non consentito senza autenticazione: imposta AUTH_PASSWORD in local.properties');
  }

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
