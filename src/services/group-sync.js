'use strict';

// ── Group sync ───────────────────────────────────────────────────────────────
//
// Users bound into a `groups` row SHARE four per-user resource sets — monitoring
// areas, followed ships, flagged ships, muted ships — and a subset of personal
// settings. Sharing is WRITE-THROUGH: the per-user tables stay the source of
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

// Personal-preference keys that propagate within a group. Everything not listed
// here (telegramEnabled, telegramChatId, telegramLinkCode, lang) stays personal.
const SHARED_SETTING_KEYS = new Set([
  'notificationsEnabled', 'notifyRevisit', 'notifyAreaChange', 'notifyHighRisk',
  'notifyBerthNew', 'notifyBerthChar', 'notifyProximity',
  'telegramNotifyHighRisk', 'telegramNotifyRevisit', 'telegramNotifyAreaChange',
  'telegramNotifyBerthNew', 'telegramNotifyBerthChar', 'telegramNotifyProximity',
  'telegramNotifyOutage', 'telegramNotifyAreaMonitor', 'telegramSendMap',
  'showOpenSeaMap', 'showOpenSeaMapMarkers', 'openSeaMapHidden',
  'showFollowedShipNames', 'showFollowedTrails', 'showActiveShipNames', 'showActiveTrails',
  'hideHeatmapSingletons',
  'defaultArea',
]);

// The co-members of `actorId` (the group, minus the actor). Empty if the user is
// in no group — which makes every sync* call below a no-op for solo users.
function coMembers(actorId) {
  const gid = db.getUserGroupId(actorId);
  if (!gid) return [];
  return db.getGroupMembers(gid).filter((id) => id !== actorId);
}

// ── Ongoing edit propagation (actor already wrote its own row) ────────────────

function syncAreaAdd(actorId, areaKey) {
  for (const uid of coMembers(actorId)) db.addUserArea(uid, areaKey);
}

function syncAreaRemove(actorId, areaKey) {
  for (const uid of coMembers(actorId)) db.removeUserArea(uid, areaKey);
}

function syncFollow(actorId, mmsi, on) {
  // The shared follow stream subscribes by DISTINCT mmsi across all users, so
  // mirroring the follow onto co-members doesn't change the bbox set — no extra
  // ship-follow.refresh() needed beyond the one applyFollow already fired.
  for (const uid of coMembers(actorId)) db.setUserFollow(uid, mmsi, !!on);
}

function syncFlag(actorId, mmsi, on) {
  for (const uid of coMembers(actorId)) db.setUserFlag(uid, mmsi, !!on);
}

function syncMute(actorId, mmsi, on) {
  for (const uid of coMembers(actorId)) db.setUserMute(uid, mmsi, !!on);
}

/** Mirror a settings patch onto co-members — only the SHARED keys, by value.
 *  `patch` is the raw request patch; non-shared keys are silently ignored. */
function syncSettings(actorId, patch) {
  if (!patch || typeof patch !== 'object') return;
  const shared = {};
  for (const k of Object.keys(patch)) if (SHARED_SETTING_KEYS.has(k)) shared[k] = patch[k];
  if (!Object.keys(shared).length) return;
  for (const uid of coMembers(actorId)) userPrefs.set(uid, shared);
}

// ── Union + baseline (used by the admin lifecycle below) ──────────────────────

// Compute the UNION of all four resource sets across `memberIds` and write it
// back to every member (additive). Returns whether any follow was touched.
function applyUnion(memberIds) {
  const areas = new Set(); const follows = new Set(); const flags = new Set(); const mutes = new Set();
  for (const uid of memberIds) {
    for (const k of db.getUserAreaKeys(uid)) areas.add(k);
    for (const m of db.getUserFollowedMmsis(uid)) follows.add(m);
    for (const m of db.getUserFlaggedMmsis(uid)) flags.add(m);
    for (const m of db.getUserMutedMmsis(uid)) mutes.add(m);
  }
  for (const uid of memberIds) {
    for (const k of areas) db.addUserArea(uid, k);
    for (const m of follows) db.setUserFollow(uid, m, true);
    for (const m of flags) db.setUserFlag(uid, m, true);
    for (const m of mutes) db.setUserMute(uid, m, true);
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
  syncAreaAdd,
  syncAreaRemove,
  syncFollow,
  syncFlag,
  syncMute,
  syncSettings,
  formGroup,
  joinGroup,
  leaveGroup,
  dissolveGroup,
};
