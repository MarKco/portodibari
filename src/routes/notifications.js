'use strict';

const express = require('express');
const db = require('../db');
const appLog = require('../services/app-log');

const router = express.Router();

// Two independent feeds share this table: personal (ship/berth alerts) and
// "group activity" (mirrored member actions, see group-sync.js notifyGroupActivity)
// — separate sidebar buttons/overlays/badges, so every route is scoped by
// ?kind=personal|group (default personal, for older/plain clients).
const isGroup = (req) => req.query.kind === 'group';

// Full feed (last 100) plus the current unread count for that feed's badge.
router.get('/notifications', (req, res) => {
  const uid = req.user.id;
  const group = isGroup(req);
  res.json({
    notifications: db.getNotifications(uid, undefined, group),
    unread: db.getUnreadNotificationCount(uid, group),
  });
});

router.post('/notifications/:id/read', (req, res) => {
  const uid = req.user.id;
  db.markNotificationRead(Number(req.params.id), uid);
  res.json({ ok: true, unread: db.getUnreadNotificationCount(uid, isGroup(req)) });
});

router.delete('/notifications/:id', (req, res) => {
  const uid = req.user.id;
  db.deleteNotification(Number(req.params.id), uid);
  appLog.info('NOTIF', appLog.t('notif.deleted'), { id: Number(req.params.id) });
  res.json({ ok: true, unread: db.getUnreadNotificationCount(uid, isGroup(req)) });
});

// Delete the whole feed at once (the frontend applies the same undo window as a
// single delete before calling this).
router.delete('/notifications', (req, res) => {
  db.deleteAllNotifications(req.user.id, isGroup(req));
  appLog.info('NOTIF', appLog.t('notif.all_deleted'));
  res.json({ ok: true, unread: 0 });
});

router.post('/notifications/read-all', (req, res) => {
  db.markAllNotificationsRead(req.user.id, isGroup(req));
  res.json({ ok: true, unread: 0 });
});

module.exports = router;
