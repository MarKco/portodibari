'use strict';

const express = require('express');
const db = require('../db');
const appLog = require('../services/app-log');

const router = express.Router();

// Full feed (last 100) plus the current unread count for the sidebar badge.
router.get('/notifications', (req, res) => {
  res.json({
    notifications: db.getNotifications(),
    unread: db.getUnreadNotificationCount(),
  });
});

router.post('/notifications/:id/read', (req, res) => {
  db.markNotificationRead(Number(req.params.id));
  res.json({ ok: true, unread: db.getUnreadNotificationCount() });
});

router.delete('/notifications/:id', (req, res) => {
  db.deleteNotification(Number(req.params.id));
  appLog.info('NOTIF', appLog.t('notif.deleted'), { id: Number(req.params.id) });
  res.json({ ok: true, unread: db.getUnreadNotificationCount() });
});

// Delete the whole feed at once (the frontend applies the same undo window as a
// single delete before calling this).
router.delete('/notifications', (req, res) => {
  db.deleteAllNotifications();
  appLog.info('NOTIF', appLog.t('notif.all_deleted'));
  res.json({ ok: true, unread: 0 });
});

router.post('/notifications/read-all', (req, res) => {
  db.markAllNotificationsRead();
  res.json({ ok: true, unread: 0 });
});

module.exports = router;
