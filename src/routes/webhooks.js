'use strict';

// Per-user outbound webhook management. Webhooks fire on the same events as the
// user's notifications but POST to an arbitrary URL (Slack/Discord/SIEM/custom).
// All routes are per-user (the global auth gate applies); writes are blocked
// during read-only impersonation by the upstream middleware.

const express = require('express');
const router = express.Router();
const webhooks = require('../services/webhooks');
const appLog = require('../services/app-log');

// List the user's webhooks (secrets masked) + the available event types/formats.
router.get('/webhooks', (req, res) => {
  res.json({ webhooks: webhooks.list(req.user.id), events: webhooks.EVENT_TYPES, formats: webhooks.FORMATS });
});

router.post('/webhooks', (req, res) => {
  try {
    const { url, format, events, secret, enabled } = req.body || {};
    const r = webhooks.add(req.user.id, { url, format, events, secret, enabled });
    appLog.info('WEBHOOK', appLog.t('webhook.added'), { userId: req.user.id });
    res.json({ ok: true, ...r, webhooks: webhooks.list(req.user.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/webhooks/:id', (req, res) => {
  try {
    const ok = webhooks.update(req.user.id, req.params.id, req.body || {});
    if (!ok) return res.status(404).json({ error: 'Webhook non trovato' });
    res.json({ ok: true, webhooks: webhooks.list(req.user.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/webhooks/:id', (req, res) => {
  const ok = webhooks.remove(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Webhook non trovato' });
  res.json({ ok: true, webhooks: webhooks.list(req.user.id) });
});

// Send a synthetic high-risk event to the webhook so the user can verify it.
router.post('/webhooks/:id/test', async (req, res) => {
  const ok = await webhooks.sendTest(req.user.id, req.params.id);
  res.json({ ok });
});

module.exports = router;
