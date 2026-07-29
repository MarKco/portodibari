'use strict';

// Per-user personal preferences, layered over db.user_settings (key/value rows).
// These are the settings the spec made per-user: notification toggles, the
// OpenSeaMap map-display options, the UI language and the default area. Global
// settings (enrichment sources, risk weights, sanctions/PSC/GFW, API keys) stay
// admin-managed in config/state — they are NOT here.

const db = require('../db');

// key → default value. Booleans default ON except the OpenSeaMap tile raster.
const DEFAULTS = {
  notificationsEnabled: true,
  notifyRevisit: true,
  notifyAreaChange: true,
  notifyHighRisk: true,
  notifyBerthNew: true,
  notifyBerthChar: true,
  notifyProximity: true,
  // Ship-category filter for the four per-ship notification types above
  // (high_risk/revisit/area_change/proximity). Holds the EXCLUDED category keys
  // (see services/notify-categories.js) — empty = every category notifies.
  notifyShipTypesHidden: [],
  // Off → suppress those same four notification types for ships the user has
  // marked "seen" (per-user, see user_seen table / db.isUserSeen).
  notifyIncludeSeen: true,
  // Telegram bot notifications. INDEPENDENT of the in-app toggles above: a user
  // can receive a category on Telegram while it's off in the sidebar, and vice
  // versa. telegramEnabled is the per-user master switch; it stays OFF until the
  // user links a chat (the chat id + one-time link code live as raw
  // user_settings rows — telegramChatId / telegramLinkCode — not here, so they
  // never leak through the generic settings surface).
  telegramEnabled: false,
  telegramNotifyHighRisk: true,
  telegramNotifyRevisit: true,
  telegramNotifyAreaChange: true,
  telegramNotifyBerthNew: true,
  telegramNotifyBerthChar: true,
  telegramNotifyProximity: true,
  telegramNotifyOutage: true,
  telegramNotifyAreaMonitor: true,
  // Attach a static map image + a native location pin to Telegram notifications
  // that carry coordinates (berth + ship events). Off → those go as text only.
  telegramSendMap: true,
  // "Attività del gruppo": notify me when a co-member does X (area add/remove,
  // follow, flag, mute, seen, ship charge). In-app master per category, plus an
  // independent Telegram sub-toggle (same telegramEnabled/link gate as the other
  // telegramNotify* keys) and an independent webhook sub-toggle (gates dispatch
  // in services/webhooks.js — see GROUP_PREF_KEY there). All default ON; only
  // relevant while the user belongs to a group (see routes/group.js).
  notifyGroupArea: true,
  notifyGroupFollow: true,
  notifyGroupFlag: true,
  notifyGroupMute: true,
  notifyGroupSeen: true,
  notifyGroupCharge: true,
  telegramNotifyGroupArea: true,
  telegramNotifyGroupFollow: true,
  telegramNotifyGroupFlag: true,
  telegramNotifyGroupMute: true,
  telegramNotifyGroupSeen: true,
  telegramNotifyGroupCharge: true,
  webhookNotifyGroupArea: true,
  webhookNotifyGroupFollow: true,
  webhookNotifyGroupFlag: true,
  webhookNotifyGroupMute: true,
  webhookNotifyGroupSeen: true,
  webhookNotifyGroupCharge: true,
  showOpenSeaMap: false,
  showOpenSeaMapMarkers: true,
  openSeaMapHidden: ['light', 'beacon', 'pilot'],
  // "Navi seguite" map overlay toggles: ship name label next to each marker, and
  // its small recent-trail breadcrumb.
  showFollowedShipNames: true,
  showFollowedTrails: true,
  // Area map overlay toggles: name label (see showFollowedShipNames) + trail,
  // opt-in and off by default since an area can hold many more ships than a
  // hand-picked followed list.
  showActiveShipNames: true,
  showActiveTrails: false,
  // Coverage heatmap: hide single-message cells (isolated noise — e.g. satellite
  // position fallback artifacts far from any real traffic). On by default.
  hideHeatmapSingletons: true,
  lang: 'it',
  defaultArea: null,
};

const BOOL_KEYS = new Set([
  'notificationsEnabled', 'notifyRevisit', 'notifyAreaChange', 'notifyHighRisk',
  'notifyBerthNew', 'notifyBerthChar', 'notifyProximity', 'notifyIncludeSeen',
  'showOpenSeaMap', 'showOpenSeaMapMarkers',
  'showFollowedShipNames', 'showFollowedTrails', 'showActiveShipNames', 'showActiveTrails',
  'hideHeatmapSingletons',
  'telegramEnabled', 'telegramNotifyHighRisk', 'telegramNotifyRevisit',
  'telegramNotifyAreaChange', 'telegramNotifyBerthNew', 'telegramNotifyBerthChar',
  'telegramNotifyProximity', 'telegramNotifyOutage', 'telegramNotifyAreaMonitor', 'telegramSendMap',
  'notifyGroupArea', 'notifyGroupFollow', 'notifyGroupFlag', 'notifyGroupMute',
  'notifyGroupSeen', 'notifyGroupCharge',
  'telegramNotifyGroupArea', 'telegramNotifyGroupFollow', 'telegramNotifyGroupFlag',
  'telegramNotifyGroupMute', 'telegramNotifyGroupSeen', 'telegramNotifyGroupCharge',
  'webhookNotifyGroupArea', 'webhookNotifyGroupFollow', 'webhookNotifyGroupFlag',
  'webhookNotifyGroupMute', 'webhookNotifyGroupSeen', 'webhookNotifyGroupCharge',
]);

// String-array keys, JSON-encoded in user_settings (a list of category keys).
const ARRAY_KEYS = new Set(['openSeaMapHidden', 'notifyShipTypesHidden']);

/** Typed, defaulted view of a user's personal preferences. */
function get(userId) {
  const raw = db.getUserSettings(userId);
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in raw) || raw[key] == null) continue;
    const v = raw[key];
    if (BOOL_KEYS.has(key)) out[key] = v === '1' || v === 'true';
    else if (ARRAY_KEYS.has(key)) {
      try { const a = JSON.parse(v); if (Array.isArray(a)) out[key] = a.filter((x) => typeof x === 'string'); } catch { /* keep default */ }
    } else out[key] = v;
  }
  return out;
}

/** Apply a partial patch of personal settings; ignores unknown keys. Returns the
 *  resulting typed view. */
function set(userId, patch) {
  if (patch && typeof patch === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (!(key in patch)) continue;
      const v = patch[key];
      if (BOOL_KEYS.has(key)) db.setUserSetting(userId, key, v ? '1' : '0');
      else if (ARRAY_KEYS.has(key)) {
        const arr = Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string'))] : [];
        db.setUserSetting(userId, key, JSON.stringify(arr));
      } else if (key === 'lang') db.setUserSetting(userId, key, v === 'en' ? 'en' : 'it');
      else db.setUserSetting(userId, key, v == null ? null : String(v));
    }
  }
  return get(userId);
}

module.exports = { get, set, DEFAULTS, BOOL_KEYS };
