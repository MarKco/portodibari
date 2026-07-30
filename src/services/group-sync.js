'use strict';

// ── Group sync ───────────────────────────────────────────────────────────────
//
// Users bound into a `groups` row SHARE five per-user resource sets — monitoring
// areas, followed ships, flagged ships, muted ships, seen ships — and a subset
// of personal settings. Sharing is WRITE-THROUGH: the per-user tables stay the source of
// truth (so the notification / geographic-visibility layer is untouched), and
// every mutation a member makes is mirrored onto its co-members.
//
//   • On JOIN/CREATE the resource sets are UNION'd across all members and the
//     union is written back to each (additive — nothing is removed).
//   • On an ongoing edit BOTH add and remove propagate, so members stay identical.
//   • On LEAVE the member simply stops syncing; it keeps whatever it accumulated.
//
// Settings: only the SHARED_SETTING_KEYS below are mirrored. The Telegram
// connection (telegramEnabled / telegramChatId / telegramLinkCode) and the UI
// language stay strictly personal. Admin-managed GLOBAL settings (enrichment
// sources, risk/cargo weights, sanctions/PSC/GFW) are out of scope entirely —
// they are already shared across every user.

const db = require('../db');
const userPrefs = require('./user-prefs');
const { BBOX_PRESETS } = require('../config');

// Personal-preference keys that propagate within a group. Everything not listed
// here (telegramEnabled, telegramChatId, telegramLinkCode, lang) stays personal.
const SHARED_SETTING_KEYS = new Set([
  'notificationsEnabled', 'notifyRevisit', 'notifyAreaChange', 'notifyHighRisk',
  'notifyBerthNew', 'notifyBerthChar', 'notifyProximity',
  'notifyShipTypesHidden', 'notifyIncludeSeen',
  'telegramNotifyHighRisk', 'telegramNotifyRevisit', 'telegramNotifyAreaChange',
  'telegramNotifyBerthNew', 'telegramNotifyBerthChar', 'telegramNotifyProximity',
  'telegramNotifyOutage', 'telegramNotifyAreaMonitor', 'telegramSendMap',
  'notifyGroupArea', 'notifyGroupFollow', 'notifyGroupFlag', 'notifyGroupMute',
  'notifyGroupSeen', 'notifyGroupCharge',
  'telegramNotifyGroupArea', 'telegramNotifyGroupFollow', 'telegramNotifyGroupFlag',
  'telegramNotifyGroupMute', 'telegramNotifyGroupSeen', 'telegramNotifyGroupCharge',
  'webhookNotifyGroupArea', 'webhookNotifyGroupFollow', 'webhookNotifyGroupFlag',
  'webhookNotifyGroupMute', 'webhookNotifyGroupSeen', 'webhookNotifyGroupCharge',
  'showOpenSeaMap', 'showOpenSeaMapMarkers', 'openSeaMapHidden',
  'showFollowedShipNames', 'showFollowedTrails', 'showActiveShipNames', 'showActiveTrails',
  'hideHeatmapSingletons',
  'defaultArea',
]);

// Action → the in-app pref key that gates its "group activity" notification
// (see notifyGroupActivity below). Telegram/webhook gating live in their own
// modules (telegram.js PREF_KEY / webhooks.js GROUP_PREF_KEY), keyed by the
// full 'group_<action>' type instead — this map only covers the in-app surface.
const IN_APP_PREF_BY_ACTION = {
  area_add: 'notifyGroupArea', area_remove: 'notifyGroupArea', area_edit: 'notifyGroupArea',
  follow_on: 'notifyGroupFollow', follow_off: 'notifyGroupFollow',
  flag_on: 'notifyGroupFlag', flag_off: 'notifyGroupFlag',
  mute_on: 'notifyGroupMute', mute_off: 'notifyGroupMute',
  seen_on: 'notifyGroupSeen', seen_off: 'notifyGroupSeen',
  charge_on: 'notifyGroupCharge', charge_off: 'notifyGroupCharge', charge_assign: 'notifyGroupCharge',
};

// The co-members of `actorId` (the group, minus the actor). Empty if the user is
// in no group — which makes every sync* call below a no-op for solo users.
function coMembers(actorId) {
  const gid = db.getUserGroupId(actorId);
  if (!gid) return [];
  return db.getGroupMembers(gid).filter((id) => id !== actorId);
}

// Audit trail (group_activity_log, see db.js): one row per actor action that
// gets mirrored, so co-members can see who did what. No-op for solo users
// (mirrors `coMembers` above, but must stand on its own since `applyUnion`
// callers don't go through it — see the admin lifecycle section).
function logActivity(actorId, action, targetType, targetId, detail) {
  const gid = db.getUserGroupId(actorId);
  if (!gid) return;
  db.logGroupActivity({ groupId: gid, userId: actorId, action, targetType, targetId, detail });
}

function shipLabel(mmsi) {
  const ship = db.getShip(mmsi);
  return { mmsi, shipName: ship?.ship_name || null };
}

function areaLabel(areaKey) {
  return { areaKey, areaName: BBOX_PRESETS[areaKey]?.name || areaKey };
}

function displayName(u) {
  if (!u) return '?';
  return u.first_name ? `${u.first_name} ${u.last_name || ''}`.trim() : (u.username || u.email);
}

// Fan out a "group activity" notification for a mirrored (or charge) member
// action to co-members: in-app (gated by IN_APP_PREF_BY_ACTION), Telegram and
// webhook (each gated by their own per-category toggle inside telegram.js /
// webhooks.js, keyed by the full 'group_<action>' type). No-op for solo users.
// `evp` carries whatever ship/area/target fields the action needs — same shape
// db.addNotification expects (mmsi/ship_name, area, target_user_id).
// `recipients` overrides the default co-member fan-out. Used by area edits,
// which must also reach the owners of that area OUTSIDE the actor's group: the
// area catalog is global, so a moved bbox changes what those users collect too.
function notifyGroupActivity(actorId, action, evp, recipients = null) {
  const members = recipients || coMembers(actorId);
  if (!members.length) return;
  const telegram = require('./telegram'); // lazy: avoids a load-time cycle
  const webhooks = require('./webhooks');
  const type = `group_${action}`;
  const inAppKey = IN_APP_PREF_BY_ACTION[action];
  const actorName = displayName(db.getUserById(actorId));
  for (const uid of members) {
    const p = userPrefs.get(uid);
    if (p.notificationsEnabled && p[inAppKey]) {
      db.addNotification({ user_id: uid, type, actor_id: actorId, ...evp });
    }
    const tp = { ...evp, actorName };
    telegram.notifyGroupActivity(uid, type, tp);
    webhooks.dispatch(uid, type, tp);
  }
}

// ── Ongoing edit propagation (actor already wrote its own row) ────────────────

function syncAreaAdd(actorId, areaKey) {
  for (const uid of coMembers(actorId)) db.addUserArea(uid, areaKey);
  logActivity(actorId, 'area_add', 'area', areaKey, areaLabel(areaKey));
  notifyGroupActivity(actorId, 'area_add', { area: areaKey });
}

function syncAreaRemove(actorId, areaKey) {
  const detail = areaLabel(areaKey); // resolve the name before the catalog entry can be purged
  for (const uid of coMembers(actorId)) db.removeUserArea(uid, areaKey);
  logActivity(actorId, 'area_remove', 'area', areaKey, detail);
  notifyGroupActivity(actorId, 'area_remove', { area: areaKey });
}

// An area edit changes a GLOBAL catalog entry: nothing to mirror (membership is
// unchanged), but everyone else monitoring that area — co-members and unrelated
// users alike — gets told, since their own data collection just moved.
function notifyAreaEdit(actorId, areaKey) {
  const others = db.getAreaOwners(areaKey).filter((id) => id !== actorId);
  logActivity(actorId, 'area_edit', 'area', areaKey, areaLabel(areaKey));
  notifyGroupActivity(actorId, 'area_edit', { area: areaKey }, others);
}

function syncFollow(actorId, mmsi, on) {
  // The shared follow stream subscribes by DISTINCT mmsi across all users, so
  // mirroring the follow onto co-members doesn't change the bbox set — no extra
  // ship-follow.refresh() needed beyond the one applyFollow already fired.
  for (const uid of coMembers(actorId)) db.setUserFollow(uid, mmsi, !!on);
  const action = on ? 'follow_on' : 'follow_off';
  logActivity(actorId, action, 'ship', mmsi, shipLabel(mmsi));
  notifyGroupActivity(actorId, action, { mmsi, ship_name: shipLabel(mmsi).shipName });
}

function syncFlag(actorId, mmsi, on) {
  for (const uid of coMembers(actorId)) db.setUserFlag(uid, mmsi, !!on);
  const action = on ? 'flag_on' : 'flag_off';
  logActivity(actorId, action, 'ship', mmsi, shipLabel(mmsi));
  notifyGroupActivity(actorId, action, { mmsi, ship_name: shipLabel(mmsi).shipName });
}

function syncMute(actorId, mmsi, on) {
  for (const uid of coMembers(actorId)) db.setUserMute(uid, mmsi, !!on);
  const action = on ? 'mute_on' : 'mute_off';
  logActivity(actorId, action, 'ship', mmsi, shipLabel(mmsi));
  notifyGroupActivity(actorId, action, { mmsi, ship_name: shipLabel(mmsi).shipName });
}

function syncSeen(actorId, mmsi, on) {
  for (const uid of coMembers(actorId)) db.setUserSeen(uid, mmsi, !!on);
  const action = on ? 'seen_on' : 'seen_off';
  logActivity(actorId, action, 'ship', mmsi, shipLabel(mmsi));
  notifyGroupActivity(actorId, action, { mmsi, ship_name: shipLabel(mmsi).shipName });
}

// "Taken in charge" is NOT mirrored like the sets above — each row belongs to
// whoever actually took (or was assigned) the ship, so several co-members can
// hold it on the same ship at once. Only the audit-log entry is written here;
// the actual user_ship_charges row is written by the caller (routes/ships.js),
// which also resolves/authorizes `targetUserId` against the group roster.
function chargeAction(targetUserId, actorId, on) {
  return !on ? 'charge_off' : (targetUserId === actorId ? 'charge_on' : 'charge_assign');
}

function logCharge(actorId, targetUserId, mmsi, on) {
  const action = chargeAction(targetUserId, actorId, on);
  logActivity(actorId, action, 'ship', mmsi, { ...shipLabel(mmsi), targetUserId });
  notifyGroupActivity(actorId, action, { mmsi, ship_name: shipLabel(mmsi).shipName, target_user_id: targetUserId });
}

/** Mirror a settings patch onto co-members — only the SHARED keys, by value.
 *  `patch` is the raw request patch; non-shared keys are silently ignored. */
function syncSettings(actorId, patch) {
  if (!patch || typeof patch !== 'object') return;
  const shared = {};
  for (const k of Object.keys(patch)) if (SHARED_SETTING_KEYS.has(k)) shared[k] = patch[k];
  if (!Object.keys(shared).length) return;
  for (const uid of coMembers(actorId)) userPrefs.set(uid, shared);
  const detail = { values: shared };
  if ('defaultArea' in shared) detail.areaName = BBOX_PRESETS[shared.defaultArea]?.name || shared.defaultArea;
  logActivity(actorId, 'settings_change', 'setting', null, detail);
}

// ── Union + baseline (used by the admin lifecycle below) ──────────────────────

// Compute the UNION of all five resource sets across `memberIds` and write it
// back to every member (additive). Returns whether any follow was touched.
function applyUnion(memberIds) {
  const areas = new Set(); const follows = new Set(); const flags = new Set(); const mutes = new Set(); const seens = new Set();
  for (const uid of memberIds) {
    for (const k of db.getUserAreaKeys(uid)) areas.add(k);
    for (const m of db.getUserFollowedMmsis(uid)) follows.add(m);
    for (const m of db.getUserFlaggedMmsis(uid)) flags.add(m);
    for (const m of db.getUserMutedMmsis(uid)) mutes.add(m);
    for (const m of db.getUserSeenMmsis(uid)) seens.add(m);
  }
  for (const uid of memberIds) {
    for (const k of areas) db.addUserArea(uid, k);
    for (const m of follows) db.setUserFollow(uid, m, true);
    for (const m of flags) db.setUserFlag(uid, m, true);
    for (const m of mutes) db.setUserMute(uid, m, true);
    for (const m of seens) db.setUserSeen(uid, m, true);
  }
  return follows.size > 0;
}

// Copy the SHARED settings of `fromUserId` onto each of `toUserIds` (overwrite).
function copySharedSettings(fromUserId, toUserIds) {
  const src = userPrefs.get(fromUserId);
  const shared = {};
  for (const k of SHARED_SETTING_KEYS) if (k in src) shared[k] = src[k];
  for (const uid of toUserIds) userPrefs.set(uid, shared);
}

function refreshFollowStream(touched) {
  if (!touched) return;
  try { require('./ship-follow').refresh(); } catch { /* stream not init yet */ }
}

// ── Admin lifecycle orchestration ─────────────────────────────────────────────

/** Create a group from `memberIds` (≥2). `baselineId` (one of the members)
 *  provides the initial shared settings. Returns the new group id. */
function formGroup({ name, description, memberIds, baselineId, createdBy }) {
  const ids = [...new Set(memberIds)];
  if (ids.length < 2) throw new Error('Un gruppo deve avere almeno 2 utenti');
  const baseline = ids.includes(baselineId) ? baselineId : ids[0];
  const gid = db.createGroup(name, description, createdBy);
  for (const uid of ids) db.setUserGroup(uid, gid);
  const touchedFollows = applyUnion(ids);
  copySharedSettings(baseline, ids.filter((id) => id !== baseline));
  refreshFollowStream(touchedFollows);
  return gid;
}

/** Add `userId` to an existing group: union the resources across everyone, then
 *  the new member adopts the group's current shared settings. */
function joinGroup(groupId, userId) {
  db.setUserGroup(userId, groupId);
  const members = db.getGroupMembers(groupId); // includes userId now
  const touchedFollows = applyUnion(members);
  const rep = members.find((id) => id !== userId);
  if (rep) copySharedSettings(rep, [userId]);
  refreshFollowStream(touchedFollows);
}

/** Detach `userId` from its group. Keeps all accumulated data; only stops sync. */
function leaveGroup(userId) {
  db.setUserGroup(userId, null);
}

/** Dissolve a whole group. Every member keeps its data; only the binding goes. */
function dissolveGroup(groupId) {
  db.deleteGroup(groupId);
}

module.exports = {
  SHARED_SETTING_KEYS,
  coMembers,
  notifyGroupActivity,
  syncAreaAdd,
  syncAreaRemove,
  notifyAreaEdit,
  syncFollow,
  syncFlag,
  syncMute,
  syncSeen,
  logCharge,
  syncSettings,
  formGroup,
  joinGroup,
  leaveGroup,
  dissolveGroup,
};
