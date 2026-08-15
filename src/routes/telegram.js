'use strict';

// Per-user Telegram bot settings: link/unlink the chat, read/update the
// notification toggles, send a test message. The actual sending + polling lives
// in services/telegram.js; the toggles are persisted as personal user prefs.

const express = require('express');
const telegram = require('../services/telegram');
const userPrefs = require('../services/user-prefs');
const groupSync = require('../services/group-sync');

const router = express.Router();

// The per-category Telegram toggles (master + 7 categories), echoed to the UI
// and accepted on update. Keys match the user-prefs DEFAULTS.
const TOGGLE_KEYS = [
  'telegramEnabled',
  'telegramNotifyHighRisk',
  'telegramNotifyRevisit',
  'telegramNotifyAreaChange',
  'telegramNotifyBerthNew',
  'telegramNotifyBerthChar',
  'telegramNotifyProximity',
  'telegramNotifyOutage',
  'telegramNotifyAreaMonitor',
  'telegramNotifySuspectedBan',
  'telegramSendMap',
  'telegramNotifyGroupArea',
  'telegramNotifyGroupFollow',
  'telegramNotifyGroupFlag',
  'telegramNotifyGroupMute',
  'telegramNotifyGroupSeen',
  'telegramNotifyGroupCharge',
];

function statePayload(userId) {
  const prefs = userPrefs.get(userId);
  const toggles = {};
  for (const k of TOGGLE_KEYS) toggles[k] = prefs[k];
  return { ...telegram.linkStatus(userId), ...toggles };
}

// Current Telegram state for this user (configured? linked? toggles).
router.get('/telegram', (req, res) => {
  res.json(statePayload(req.user.id));
});

// Generate a one-time link code + t.me deep link. The user sends "/start <code>"
// to the bot to bind their chat.
router.post('/telegram/link', (req, res) => {
  if (!telegram.isConfigured()) return res.status(503).json({ error: 'Bot Telegram non configurato' });
  const { code, deepLink, botUsername } = telegram.createLinkCode(req.user.id);
  res.json({ ok: true, code, deepLink, botUsername });
});

// Unbind this user's chat.
router.post('/telegram/unlink', (req, res) => {
  telegram.unlink(req.user.id);
  res.json({ ok: true, ...statePayload(req.user.id) });
});

// Update the per-category toggles. Body: any subset of TOGGLE_KEYS (booleans).
router.post('/telegram/settings', (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of TOGGLE_KEYS) if (b[k] !== undefined) patch[k] = !!b[k];
  if (Object.keys(patch).length) userPrefs.set(req.user.id, patch);
  // Mirror the shared toggles (telegramNotify* + telegramSendMap) to group
  // co-members. telegramEnabled stays personal (it's tied to each user's own
  // chat link), so syncSettings filters it out.
  groupSync.syncSettings(req.user.id, patch);
  res.json({ ok: true, ...statePayload(req.user.id) });
});

// Send a test message to the linked chat.
router.post('/telegram/test', async (req, res) => {
  try {
    const sent = await telegram.sendTest(req.user.id);
    if (!sent) return res.status(400).json({ error: 'Nessuna chat Telegram collegata' });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
