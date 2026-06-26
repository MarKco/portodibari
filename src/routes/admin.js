'use strict';

// Admin surface (all routes require the SESSION OWNER to be an admin, so an
// impersonating admin still qualifies via req.realUser). Serves the admin page
// and the user-management API.

const express = require('express');
const path = require('path');
const db = require('../db');
const appLog = require('../services/app-log');
const groupSync = require('../services/group-sync');
const { requireAdmin } = require('../middleware/session-auth');

const router = express.Router();
const VIEWS = path.join(__dirname, '..', 'views');

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, username: u.username,
    first_name: u.first_name, last_name: u.last_name,
    role: u.role, status: u.status, created_at: u.created_at,
    approved_at: u.approved_at, group_id: u.group_id != null ? u.group_id : null,
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

// A user is "online" if one of their sessions made a request within this window.
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

router.get('/api/admin/users', (req, res) => {
  const cutoff = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
  const online = new Set(db.getOnlineUserIds(cutoff));
  const users = db.listUsers().map((u) => ({
    ...publicUser(u),
    areas: db.getUserAreaKeys(u.id).length,
    online: online.has(u.id),
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

router.post('/api/admin/users/:id/approve-as-tester', (req, res) => {
  const id = Number(req.params.id);
  const u = db.getUserById(id);
  if (!u) return res.status(404).json({ error: 'Utente sconosciuto' });
  if (u.status !== 'pending') return res.status(400).json({ error: 'Utente non in attesa di approvazione' });
  db.approveTester(id, req.realUser.id);
  appLog.info('AUTH', `Registrazione approvata come tester: ${u.email}`, { userId: id, by: req.realUser.id });
  res.json({ ok: true, user: publicUser(db.getUserById(id)) });
});

router.post('/api/admin/users/:id/role', (req, res) => {
  const id = Number(req.params.id);
  const reqRole = req.body?.role;
  const role = ['admin', 'user', 'tester'].includes(reqRole) ? reqRole : 'user';
  const u = db.getUserById(id);
  if (!u) return res.status(404).json({ error: 'Utente sconosciuto' });
  // Tester role only assignable to active pending-approved users — not re-assignable after removal.
  if (role === 'tester') return res.status(400).json({ error: 'Usa "approva come tester" per assegnare il ruolo tester' });
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
  const groupId = u.group_id;
  db.deleteUser(id);
  // A group must keep ≥2 members. Deleting a user is an explicit destructive
  // action (unlike a plain disassociation, which is blocked at <2), so if the
  // deletion drops the group to a single member we auto-dissolve it: the lone
  // survivor keeps all its accumulated data, only the binding goes.
  if (groupId && db.groupMemberCount(groupId) < 2) db.deleteGroup(groupId);
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

// ── User groups ───────────────────────────────────────────────────────────────
// A group binds ≥2 users who SHARE (union) their areas/follows/flags/mutes and a
// subset of personal settings (see services/group-sync.js). All admin-only.

function groupWithMembers(g) {
  return {
    id: g.id, name: g.name, description: g.description || null,
    created_at: g.created_at, member_count: g.member_count,
    members: db.getGroupMembers(g.id).map((uid) => publicUser(db.getUserById(uid))).filter(Boolean),
  };
}

router.get('/api/admin/groups', (req, res) => {
  res.json({ groups: db.getGroups().map(groupWithMembers) });
});

router.post('/api/admin/groups', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const description = req.body?.description != null ? String(req.body.description).trim() : null;
  const memberIds = Array.isArray(req.body?.memberIds) ? [...new Set(req.body.memberIds.map(Number))] : [];
  const baselineId = Number(req.body?.baselineId);
  if (!name) return res.status(400).json({ error: 'Nome gruppo obbligatorio' });
  if (memberIds.length < 2) return res.status(400).json({ error: 'Un gruppo deve avere almeno 2 utenti' });
  for (const uid of memberIds) {
    const u = db.getUserById(uid);
    if (!u) return res.status(404).json({ error: `Utente ${uid} sconosciuto` });
    if (u.group_id != null) return res.status(400).json({ error: `${u.email} è già in un gruppo` });
  }
  if (!memberIds.includes(baselineId)) return res.status(400).json({ error: 'L\'utente modello deve essere tra i membri' });
  const gid = groupSync.formGroup({ name, description, memberIds, baselineId, createdBy: req.realUser.id });
  appLog.info('GROUPS', `Gruppo creato: ${name}`, { groupId: gid, members: memberIds.length, by: req.realUser.id });
  res.json({ ok: true, group: groupWithMembers({ ...db.getGroup(gid), member_count: memberIds.length }) });
});

router.patch('/api/admin/groups/:id', (req, res) => {
  const id = Number(req.params.id);
  const g = db.getGroup(id);
  if (!g) return res.status(404).json({ error: 'Gruppo sconosciuto' });
  const name = req.body?.name != null ? String(req.body.name).trim() : undefined;
  if (name !== undefined && !name) return res.status(400).json({ error: 'Nome gruppo obbligatorio' });
  db.updateGroup(id, { name, description: req.body?.description });
  res.json({ ok: true, group: groupWithMembers({ ...db.getGroup(id), member_count: db.groupMemberCount(id) }) });
});

router.post('/api/admin/groups/:id/members', (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.body?.userId);
  const g = db.getGroup(id);
  if (!g) return res.status(404).json({ error: 'Gruppo sconosciuto' });
  const u = db.getUserById(userId);
  if (!u) return res.status(404).json({ error: 'Utente sconosciuto' });
  if (u.group_id != null) return res.status(400).json({ error: `${u.email} è già in un gruppo` });
  groupSync.joinGroup(id, userId);
  appLog.info('GROUPS', `Utente aggiunto al gruppo ${g.name}: ${u.email}`, { groupId: id, userId, by: req.realUser.id });
  res.json({ ok: true, group: groupWithMembers({ ...db.getGroup(id), member_count: db.groupMemberCount(id) }) });
});

router.delete('/api/admin/groups/:id/members/:userId', (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.params.userId);
  const g = db.getGroup(id);
  if (!g) return res.status(404).json({ error: 'Gruppo sconosciuto' });
  if (db.getUserGroupId(userId) !== id) return res.status(404).json({ error: 'Utente non nel gruppo' });
  // A group must keep ≥2 members: a removal that would leave 1 is blocked — the
  // admin must dissolve the whole group instead.
  if (db.groupMemberCount(id) <= 2) {
    return res.status(400).json({ error: 'Un gruppo deve avere almeno 2 utenti: sciogli il gruppo invece di rimuovere un membro' });
  }
  groupSync.leaveGroup(userId);
  appLog.info('GROUPS', `Utente rimosso dal gruppo ${g.name}`, { groupId: id, userId, by: req.realUser.id });
  res.json({ ok: true, group: groupWithMembers({ ...db.getGroup(id), member_count: db.groupMemberCount(id) }) });
});

router.delete('/api/admin/groups/:id', (req, res) => {
  const id = Number(req.params.id);
  const g = db.getGroup(id);
  if (!g) return res.status(404).json({ error: 'Gruppo sconosciuto' });
  groupSync.dissolveGroup(id);
  appLog.warn('GROUPS', `Gruppo sciolto: ${g.name}`, { groupId: id, by: req.realUser.id });
  res.json({ ok: true });
});

module.exports = router;
