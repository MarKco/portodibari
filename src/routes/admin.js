'use strict';

// Admin surface (all routes require the SESSION OWNER to be an admin, so an
// impersonating admin still qualifies via req.realUser). Serves the admin page
// and the user-management API.

const express = require('express');
const path = require('path');
const db = require('../db');
const appLog = require('../services/app-log');
const { requireAdmin } = require('../middleware/session-auth');

const router = express.Router();
const VIEWS = path.join(__dirname, '..', 'views');

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, username: u.username,
    first_name: u.first_name, last_name: u.last_name,
    role: u.role, status: u.status, created_at: u.created_at,
    approved_at: u.approved_at,
  };
}

// Admin page (gated). Served before the API routes below.
router.get('/admin', requireAdminPage, (req, res) => {
  res.sendFile(path.join(VIEWS, 'admin.html'));
});

// HTML variant of the admin guard: redirect non-admins to the app instead of
// returning JSON.
function requireAdminPage(req, res, next) {
  if (req.realUser && req.realUser.role === 'admin') return next();
  return res.redirect('/');
}

// Everything under /api/admin requires admin.
router.use('/api/admin', requireAdmin);

router.get('/api/admin/users', (req, res) => {
  const users = db.listUsers().map((u) => ({
    ...publicUser(u),
    areas: db.getUserAreaKeys(u.id).length,
  }));
  res.json({ users, me: req.realUser.id, impersonating: req.isImpersonating ? req.user.id : null });
});

router.post('/api/admin/users/:id/approve', (req, res) => {
  const id = Number(req.params.id);
  const u = db.getUserById(id);
  if (!u) return res.status(404).json({ error: 'Utente sconosciuto' });
  db.approveUser(id, req.realUser.id);
  appLog.info('AUTH', `Registrazione approvata: ${u.email}`, { userId: id, by: req.realUser.id });
  res.json({ ok: true, user: publicUser(db.getUserById(id)) });
});

router.post('/api/admin/users/:id/role', (req, res) => {
  const id = Number(req.params.id);
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  const u = db.getUserById(id);
  if (!u) return res.status(404).json({ error: 'Utente sconosciuto' });
  // Never demote the last remaining active admin.
  if (role === 'user' && u.role === 'admin' && db.countAdmins() <= 1) {
    return res.status(400).json({ error: 'Deve restare almeno un amministratore' });
  }
  db.setUserRole(id, role);
  appLog.info('AUTH', `Ruolo utente cambiato in ${role}: ${u.email}`, { userId: id, by: req.realUser.id });
  res.json({ ok: true, user: publicUser(db.getUserById(id)) });
});

router.post('/api/admin/users/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const status = req.body?.status;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Stato non valido' });
  const u = db.getUserById(id);
  if (!u) return res.status(404).json({ error: 'Utente sconosciuto' });
  if (status === 'disabled' && u.role === 'admin' && db.countAdmins() <= 1) {
    return res.status(400).json({ error: 'Non puoi disabilitare l\'ultimo amministratore' });
  }
  db.setUserStatus(id, status);
  if (status === 'disabled') db.deleteUserSessions(id); // kick active sessions
  appLog.warn('AUTH', `Utente ${status === 'disabled' ? 'disabilitato' : 'riabilitato'}: ${u.email}`, { userId: id, by: req.realUser.id });
  res.json({ ok: true, user: publicUser(db.getUserById(id)) });
});

// Admin-initiated password reset: issue a one-time token and return the link for
// the admin to deliver (no email transport yet).
router.post('/api/admin/users/:id/reset', (req, res) => {
  const id = Number(req.params.id);
  const u = db.getUserById(id);
  if (!u) return res.status(404).json({ error: 'Utente sconosciuto' });
  const token = db.issueResetToken(id, 24 * 60 * 60 * 1000); // 24h
  appLog.info('AUTH', `Reset password generato (admin): ${u.email}`, { userId: id, by: req.realUser.id });
  res.json({ ok: true, resetUrl: `/reset?token=${token}` });
});

router.delete('/api/admin/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const u = db.getUserById(id);
  if (!u) return res.status(404).json({ error: 'Utente sconosciuto' });
  if (id === req.realUser.id) return res.status(400).json({ error: 'Non puoi eliminare te stesso' });
  if (u.role === 'admin' && db.countAdmins() <= 1) {
    return res.status(400).json({ error: 'Deve restare almeno un amministratore' });
  }
  db.deleteUser(id);
  appLog.warn('AUTH', `Utente eliminato: ${u.email}`, { userId: id, by: req.realUser.id });
  res.json({ ok: true });
});

// Read-only impersonation: view another user's world. The session still belongs
// to the admin (req.realUser); the effective user becomes the target.
// NOTE: the literal /stop route must precede the /:id parameter route.
router.post('/api/admin/impersonate/stop', (req, res) => {
  db.setSessionImpersonation(req.session.id, null);
  res.json({ ok: true });
});

router.post('/api/admin/impersonate/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID non valido' });
  const u = db.getUserById(id);
  if (!u) return res.status(404).json({ error: 'Utente sconosciuto' });
  db.setSessionImpersonation(req.session.id, id);
  appLog.info('AUTH', `Impersonificazione avviata: ${u.email}`, { target: id, by: req.realUser.id });
  res.json({ ok: true, impersonating: publicUser(u) });
});

module.exports = router;
