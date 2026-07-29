'use strict';

// Public authentication surface: the login/register/reset pages and the
// /api/auth/* endpoints. Mounted BEFORE the global auth gate, so these are the
// only routes reachable without a session.

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const auth = require('../services/auth');
const appLog = require('../services/app-log');
const { setSessionCookie, clearSessionCookie } = require('../middleware/session-auth');
const { SESSION_TTL_DAYS, TESTER_MAX_AREAS, TESTER_MAX_AREA_KM2, TESTER_MAX_FOLLOWS } = require('../config');

const router = express.Router();
const VIEWS = path.join(__dirname, '..', 'views');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Throttle the public auth surface to blunt brute-force / credential-stuffing and
// automated sign-ups. Keyed by IP (built-in, IPv6-safe). Successful logins still
// count, but 10 attempts / 15 min per IP is far above any human and well below a
// guessing rig. Register/reset are rarer, so a wider window with the same ceiling.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppi tentativi di accesso. Riprova tra qualche minuto.' },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppe richieste. Riprova più tardi.' },
});

/** Shape a user row for the client (never includes hash/tokens). */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    first_name: u.first_name,
    last_name: u.last_name,
    role: u.role,
    status: u.status,
  };
}

// ── Public pages ──────────────────────────────────────────────────────────────
// Already-authenticated users are bounced to the app.
for (const page of ['login', 'register', 'reset']) {
  router.get(`/${page}`, (req, res) => {
    if (req.user && page !== 'reset') return res.redirect('/');
    res.sendFile(path.join(VIEWS, `${page}.html`));
  });
}

// ── API ─────────────────────────────────────────────────────────────────────

// Register. Always lands in 'pending' until an admin approves. Email-verify
// token is generated but unused until SMTP is configured.
router.post('/api/auth/register', registerLimiter, (req, res) => {
  const { email, username, first_name, last_name, password } = req.body || {};
  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: 'Email non valida' });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'La password deve avere almeno 8 caratteri' });
  }
  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'Nome e cognome obbligatori' });
  }
  const uname = username ? String(username).trim() : null;
  if (uname && !/^[A-Za-z0-9._-]{3,32}$/.test(uname)) {
    return res.status(400).json({ error: 'Username non valido (3-32 caratteri: lettere, numeri, . _ -)' });
  }
  try {
    const user = db.createUser({
      email: String(email).trim(),
      username: uname,
      firstName: String(first_name).trim(),
      lastName: String(last_name).trim(),
      password: String(password),
      role: 'user',
      status: 'pending',
    });
    appLog.info('AUTH', `Nuova registrazione in attesa di approvazione: ${user.email}`, { userId: user.id });
    res.json({ ok: true, status: 'pending' });
  } catch (e) {
    if (String(e.message).includes('UNIQUE') || String(e.message).includes('constraint')) {
      // Do NOT reveal that the email/username already exists (account
      // enumeration). Return the SAME generic pending response as a fresh
      // sign-up; the real owner's account is untouched. Logged for the admin.
      appLog.info('AUTH', `Registrazione ignorata: email o username già esistente (${String(email).trim()})`);
      return res.json({ ok: true, status: 'pending' });
    }
    res.status(500).json({ error: 'Registrazione non riuscita' });
  }
});

// Login by email OR username.
router.post('/api/auth/login', loginLimiter, (req, res) => {
  const { identifier, password } = req.body || {};
  const row = db.findUserByLogin(identifier);
  // Always run a verify (even on a missing user) to keep timing uniform.
  const ok = row
    ? auth.verifyPassword(String(password || ''), row.pw_hash, row.pw_salt)
    : auth.verifyPassword(String(password || ''), '00', '00');
  if (!row || !ok) {
    return res.status(401).json({ error: 'Credenziali non valide' });
  }
  if (row.status === 'pending') {
    return res.status(403).json({ error: 'Account in attesa di approvazione da un amministratore' });
  }
  if (row.status === 'disabled') {
    return res.status(403).json({ error: 'Account disabilitato. Contatta un amministratore.' });
  }
  const sessionId = db.createSession(row.id, {
    ttlMs: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  setSessionCookie(res, sessionId);
  appLog.info('AUTH', `Accesso: ${row.email}`, { userId: row.id });
  res.json({ ok: true, user: publicUser(db.getUserById(row.id)) });
});

// Logout — destroys the current session.
router.post('/api/auth/logout', (req, res) => {
  if (req.session) db.deleteSession(req.session.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Current user. Used by the SPA to bootstrap; 401 when not logged in.
router.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Non autenticato' });
  res.json({
    user: publicUser(req.user),
    isImpersonating: !!req.isImpersonating,
    realUser: req.isImpersonating ? publicUser(req.realUser) : null,
    isAdmin: !!(req.realUser && req.realUser.role === 'admin'),
    inGroup: req.user.group_id != null,
    testerLimits: req.user.role === 'tester'
      ? { maxAreas: TESTER_MAX_AREAS, maxAreaKm2: TESTER_MAX_AREA_KM2, maxFollows: TESTER_MAX_FOLLOWS }
      : null,
  });
});

// Forgot-password request. No email transport yet → no link is sent; we return a
// generic message regardless of whether the account exists (no enumeration).
// The real reset path today is admin-initiated (see admin router).
router.post('/api/auth/reset/request', loginLimiter, (req, res) => {
  const { identifier } = req.body || {};
  const row = db.findUserByLogin(identifier);
  if (row) appLog.info('AUTH', `Richiesta reset password: ${row.email}`, { userId: row.id });
  res.json({
    ok: true,
    message: 'Se l\'account esiste, contatta un amministratore per completare il reset (invio email non ancora configurato).',
  });
});

// Confirm a password reset via a one-time token (admin-issued link, or future
// email link). Invalidates the user's existing sessions.
router.post('/api/auth/reset/confirm', (req, res) => {
  const { token, password } = req.body || {};
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'La password deve avere almeno 8 caratteri' });
  }
  const user = db.findUserByResetToken(token);
  if (!user) return res.status(400).json({ error: 'Token non valido o scaduto' });
  db.setUserPassword(user.id, String(password));
  db.deleteUserSessions(user.id); // force re-login everywhere
  appLog.info('AUTH', `Password reimpostata: ${user.email}`, { userId: user.id });
  res.json({ ok: true });
});

// Email verification (inert until SMTP exists, but functional if a token is set).
router.get('/api/auth/verify', (req, res) => {
  const user = db.verifyEmailToken(req.query.token);
  if (!user) return res.status(400).json({ error: 'Token di verifica non valido' });
  res.json({ ok: true });
});

module.exports = router;
