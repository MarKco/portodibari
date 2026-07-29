'use strict';

// Self-service view of the CURRENT USER's own group: membership + the
// group_activity_log audit trail (services/group-sync.js). Read-only —
// membership/roster changes stay admin-only (see routes/admin.js).

const express = require('express');
const db = require('../db');
const { clampLimit, clampOffset } = require('../lib/params');

const router = express.Router();

function memberInfo(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, username: u.username, first_name: u.first_name, last_name: u.last_name };
}

// The group the current user belongs to, with its roster. `group: null` when
// the user isn't in one (frontend hides the whole section in that case).
router.get('/group', (req, res) => {
  const gid = db.getUserGroupId(req.user.id);
  if (!gid) return res.json({ group: null });
  const g = db.getGroup(gid);
  if (!g) return res.json({ group: null });
  const members = db.getGroupMembers(gid).map((uid) => memberInfo(db.getUserById(uid))).filter(Boolean);
  res.json({ group: { id: g.id, name: g.name, description: g.description || null }, members, youId: req.user.id });
});

// Paginated activity feed for the current user's group, newest first.
router.get('/group/activity', (req, res) => {
  const gid = db.getUserGroupId(req.user.id);
  if (!gid) return res.json({ rows: [], hasMore: false });
  const limit = clampLimit(req.query.limit, 50);
  const offset = clampOffset(req.query.offset);
  const rows = db.getGroupActivityLog(gid, limit + 1, offset);
  const hasMore = rows.length > limit;
  res.json({ rows: rows.slice(0, limit), hasMore });
});

module.exports = router;
