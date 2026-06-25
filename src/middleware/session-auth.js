'use strict';

// Session-based auth middleware. Replaces the old HTTP Basic gate.
//
//  - parseCookies / attachUser run on every request: resolve the signed session
//    cookie → session row → user, and expose req.user (the EFFECTIVE user),
//    req.realUser (the session owner), req.session and req.isImpersonating.
//  - requireAuth / requireAdmin guard individual routers.
//  - gate() is the global enforcement: anything not explicitly public needs an
//    active session. The public auth pages/endpoints are mounted BEFORE gate(),
//    so the gate itself only has to allow-or-block.

const db = require('../db');
const auth = require('../services/auth');
const { SESSION_COOKIE, COOKIE_SECURE, SESSION_TTL_DAYS } = require('../config');

const TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

// How stale a session's last_seen_at must be before we rewrite it. Throttles the
// per-request UPDATE (every request would otherwise write on each poll) while
// keeping the admin "online" indicator fresh enough.
const TOUCH_THROTTLE_MS = 60 * 1000;

/** Parse a Cookie header into a plain object. */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Serialize + send the signed session cookie on the response. */
function setSessionCookie(res, sessionId) {
  const signed = auth.signCookie(sessionId, db.getSessionSecret());
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(signed)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

/** Clear the session cookie. */
function clearSessionCookie(res) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (COOKIE_SECURE) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

/**
 * Resolve the current session from the signed cookie and attach the user to the
 * request. Never blocks — just populates req.* (or leaves them null). Honors a
 * read-only impersonation set on the session: req.user becomes the impersonated
 * user while req.realUser stays the admin.
 */
function attachUser(req, res, next) {
  req.user = null;
  req.realUser = null;
  req.session = null;
  req.isImpersonating = false;

  const cookies = parseCookies(req.headers.cookie);
  const signed = cookies[SESSION_COOKIE];
  if (!signed) return next();

  const sessionId = auth.unsignCookie(signed, db.getSessionSecret());
  if (!sessionId) return next();

  const session = db.getSession(sessionId);
  if (!session) return next();

  const owner = db.getUserById(session.user_id);
  if (!owner || owner.status !== 'active') {
    // Owner gone/disabled → kill the session.
    db.deleteSession(sessionId);
    return next();
  }

  req.session = session;
  req.realUser = owner;
  req.user = owner;

  // Mark the session as seen now (throttled) so the admin online indicator works.
  const now = Date.now();
  if (!session.last_seen_at || now - Date.parse(session.last_seen_at) >= TOUCH_THROTTLE_MS) {
    db.touchSession(sessionId, new Date(now).toISOString());
  }

  // Read-only impersonation: an admin viewing another user's world.
  if (session.impersonating_user_id && owner.role === 'admin') {
    const target = db.getUserById(session.impersonating_user_id);
    if (target) {
      req.user = target;
      req.isImpersonating = true;
    }
  }
  next();
}

/** 401/redirect unless an effective user is present. */
function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith('/api') || req.xhr || (req.headers.accept || '').includes('application/json')) {
    return res.status(401).json({ error: 'Autenticazione richiesta' });
  }
  return res.redirect('/login');
}

/** 403 unless the SESSION OWNER is an admin (impersonation doesn't grant admin). */
function requireAdmin(req, res, next) {
  if (req.realUser && req.realUser.role === 'admin') return next();
  return res.status(403).json({ error: 'Permesso negato: richiede amministratore' });
}

/**
 * Enforce read-only impersonation: while an admin impersonates a user, only safe
 * methods pass. The admin surface (/api/admin/*, incl. stop-impersonation) and
 * the auth surface stay reachable so the admin can always exit. Mounted globally
 * on /api.
 */
function blockImpersonationWrites(req, res, next) {
  if (!req.isImpersonating) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const url = req.originalUrl || '';
  if (url.startsWith('/api/admin') || url.startsWith('/api/auth')) return next();
  return res.status(403).json({ error: 'Impersonificazione in sola lettura: azione non consentita' });
}

/** Global gate: everything reaching here (i.e. not a public auth route) needs an
 *  active session. */
function gate(req, res, next) {
  return requireAuth(req, res, next);
}

module.exports = {
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
  requireAdmin,
  blockImpersonationWrites,
  gate,
  TTL_MS,
};
