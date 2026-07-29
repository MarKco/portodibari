// Shared, cached view of the current user's group roster — used by the ship
// "taken in charge" feature (charge tags/dropdown in ships.js) wherever it needs
// to know the group's members without re-fetching /api/group on every render.
// group-activity.js keeps its own fetch (it also needs name/description and
// reloads on every view-enter), this module is for read-mostly, cache-once use.

import { api } from './api.js';

let cache = null; // { inGroup, youId, members, membersById }
let pending = null;

function emptyState() {
  return { inGroup: false, youId: null, members: [], membersById: new Map() };
}

export function displayName(u) {
  if (!u) return '?';
  return u.first_name ? `${u.first_name} ${u.last_name || ''}`.trim() : (u.username || u.email);
}

/** Fetch (once) and cache the current user's group + roster. Safe to call
 *  repeatedly — subsequent calls return the cached value unless force=true. */
export async function loadGroupState(force = false) {
  if (cache && !force) return cache;
  if (pending) return pending;
  pending = (async () => {
    try {
      const data = await api('/api/group');
      const members = data.group ? (data.members || []) : [];
      cache = {
        inGroup: !!data.group,
        youId: data.youId ?? null,
        members,
        membersById: new Map(members.map((m) => [m.id, m])),
      };
    } catch {
      cache = emptyState();
    }
    pending = null;
    // Listeners (ships.js/followed.js) react to this to (re)populate the
    // charge-filter dropdowns and re-render lists/detail once the roster —
    // and member display names — are available.
    window.dispatchEvent(new CustomEvent('group-state-loaded', { detail: cache }));
    return cache;
  })();
  return pending;
}

/** Synchronous read of the last-loaded group state (empty until loadGroupState
 *  resolves at least once). */
export function getGroupState() {
  return cache || emptyState();
}
