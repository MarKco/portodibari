import { el } from './dom.js';
import { S } from './store.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { escHtml, formatTime } from './helpers.js';
import { showView } from './views.js';
import { goToBerth } from './berths.js';
import { showUndoToast } from './toast.js';
import { actionText } from './group-activity.js';
import { getGroupState, loadGroupState, displayName } from './group.js';

// Two independent notification feeds — personal (ship/berth alerts) and "group
// activity" (mirrored member actions, see services/group-sync.js) — each with
// its own sidebar button/badge, sharing one overlay (#modal-overlay/#modal-body,
// the same dialog used for reading detail / berth rename / restore) instead of
// a permanently-visible sidebar panel, so neither eats sidebar space. Content
// loads fresh each time the overlay opens (no live refresh while open, same as
// the "Attività di gruppo" log view); badges keep polling in the background via
// pollNotificationBadges(), called from main.js's tick().

function areaName(key) {
  return S.presets[key]?.name || key || '—';
}

function personalNotifMessage(n) {
  if (n.type === 'revisit') {
    const ship = n.ship_name || `MMSI ${n.mmsi}`;
    return t('notif.revisit', { ship: escHtml(ship), area: escHtml(areaName(n.area)) });
  }
  if (n.type === 'area_change') {
    const ship = n.ship_name || `MMSI ${n.mmsi}`;
    return t('notif.areaChange', {
      ship: escHtml(ship),
      from: escHtml(areaName(n.from_area)),
      to: escHtml(areaName(n.area)),
    });
  }
  if (n.type === 'high_risk') {
    const ship = n.ship_name || `MMSI ${n.mmsi}`;
    return t('notif.highRisk', {
      ship: escHtml(ship),
      area: escHtml(areaName(n.area)),
      score: n.score != null ? n.score : '?',
    });
  }
  if (n.type === 'follow_searching') {
    const ship = n.ship_name || `MMSI ${n.mmsi}`;
    return t('notif.followSearching', { ship: escHtml(ship) });
  }
  if (n.type === 'follow_found') {
    const ship = n.ship_name || `MMSI ${n.mmsi}`;
    return t('notif.followFound', { ship: escHtml(ship) });
  }
  if (n.type === 'follow_lost') {
    const ship = n.ship_name || `MMSI ${n.mmsi}`;
    return t('notif.followLost', { ship: escHtml(ship) });
  }
  if (n.type === 'berth_new') {
    return t('notif.berthNew', { area: escHtml(areaName(n.area)) });
  }
  if (n.type === 'suspected_ban' || n.type === 'suspected_ban_cleared') {
    // `band` repurposed to carry the scrape source key ('sf'|'mst') for this
    // notification type — see services/fallback-mode.js onCircuitTransition.
    const source = n.band === 'mst' ? 'MyShipTracking' : n.band === 'sf' ? 'ShipFinder' : (n.band || '?');
    return t(n.type === 'suspected_ban' ? 'notif.suspectedBan' : 'notif.suspectedBanCleared', { source });
  }
  if (n.type === 'berth_characterized') {
    const name = n.ship_name || t('berth.unnamed');
    const cat = n.band ? t(`berthcat.${n.band}`) : '';
    return t('notif.berthChar', {
      berth: escHtml(name),
      cat: escHtml(cat),
      area: escHtml(areaName(n.area)),
    });
  }
  return escHtml(n.ship_name || '');
}

// "<actor> <azione>" — reuses the exact same i18n phrasing as the "Attività di
// gruppo" log view (group-activity.js's actionText), fed from this row's own
// columns (actor_id/target_user_id/mmsi/ship_name/area) instead of a
// group_activity_log row's `detail` JSON blob.
function groupNotifMessage(n) {
  const action = n.type.replace(/^group_/, '');
  const { membersById } = getGroupState();
  const detail = { areaName: areaName(n.area), areaKey: n.area, shipName: n.ship_name, mmsi: n.mmsi, targetUserId: n.target_user_id };
  const targetId = n.mmsi || n.area || null;
  // The actor isn't always a co-member: an area edit notifies every owner of
  // that area, group or not — hence the server-resolved `actor_name` fallback.
  const actor = membersById.has(n.actor_id) ? displayName(membersById.get(n.actor_id)) : (n.actor_name || '—');
  return `<strong>${escHtml(actor)}</strong> ${actionText(action, detail, targetId, n.actor_id, membersById)}`;
}

function updateBadge(badgeEl, unread) {
  if (!badgeEl) return;
  if (unread > 0) {
    badgeEl.textContent = unread > 99 ? '99+' : String(unread);
    badgeEl.classList.remove('hidden');
  } else {
    badgeEl.classList.add('hidden');
  }
}

/** One feed instance: wires its sidebar button to open the shared overlay, and
 *  exposes pollBadge() for the periodic background badge refresh. */
function createFeed({ kind, btn, badgeEl, titleKey, buildMessage, isGroup }) {
  async function pollBadge() {
    try {
      const data = await api(`/api/notifications?kind=${kind}`);
      updateBadge(badgeEl, data.unread || 0);
      // A solo user's first group notification (a shared area edited by an
      // outsider) has to reveal the entry that holds it, without a reload.
      if (isGroup && (data.notifications || []).length) {
        el.groupNotifControls?.style.setProperty('display', '');
      }
    } catch {
      /* ignore */
    }
  }

  function itemHtml(n) {
    const isBerth = n.type === 'berth_new' || n.type === 'berth_characterized';
    const dotClass = isGroup ? 'notif-dot-group' : (isBerth ? 'notif-dot-berth' : `risk-${n.band || 'low'}`);
    const clickable = n.mmsi || n.berth_id;
    return `
      <div class="notif-item ${n.read ? '' : 'unread'} ${clickable ? 'notif-item-clickable' : ''}" data-id="${n.id}" data-mmsi="${n.mmsi || ''}" data-berth="${n.berth_id || ''}" data-lat="${n.berth_lat ?? ''}" data-lon="${n.berth_lon ?? ''}" data-area="${escHtml(n.area || '')}">
        <span class="notif-dot ${dotClass}" title="${!isGroup && !isBerth && n.score != null ? `${n.score}/100` : ''}"></span>
        <div class="notif-text">
          <div class="notif-msg">${buildMessage(n)}</div>
          <div class="notif-meta">${formatTime(n.ts)}</div>
        </div>
        <button class="notif-check ${n.read ? 'done' : ''}" data-id="${n.id}"
                title="${t('notif.markRead')}" ${n.read ? 'disabled' : ''}>✓</button>
        <button class="notif-delete" data-id="${n.id}" title="${t('notif.delete')}">🗑</button>
      </div>`;
  }

  function render(notifications) {
    if (!notifications.length) {
      el.modalBody.innerHTML = `<div class="notif-empty">${t('notif.empty')}</div>`;
      return;
    }
    el.modalBody.innerHTML =
      `<div class="notif-overlay-toolbar">
        <button id="notif-ov-clear" class="btn btn-secondary btn-sm">🗑 ${escHtml(t('notif.clearAll'))}</button>
      </div>
      <div class="notif-list notif-list-overlay">${notifications.map(itemHtml).join('')}</div>`;
    wireList();
  }

  function wireList() {
    const list = el.modalBody.querySelector('.notif-list-overlay');
    const clearBtn = el.modalBody.querySelector('#notif-ov-clear');

    clearBtn?.addEventListener('click', () => {
      const items = list.querySelectorAll('.notif-item');
      if (!items.length) return;
      items.forEach((i) => i.classList.add('notif-deleting'));
      clearBtn.disabled = true;
      let cancelled = false;
      const secs = S.notifDeleteUndoSeconds;
      const { cancel } = showUndoToast({
        message: t('notif.clearAllUndo'),
        seconds: secs,
        onUndo: () => {
          cancelled = true;
          items.forEach((i) => i.classList.remove('notif-deleting'));
          clearBtn.disabled = false;
        },
      });
      setTimeout(async () => {
        if (cancelled) return;
        cancel();
        try {
          await api(`/api/notifications?kind=${kind}`, 'DELETE');
          el.modalBody.innerHTML = `<div class="notif-empty">${t('notif.empty')}</div>`;
          updateBadge(badgeEl, 0);
        } catch {
          items.forEach((i) => i.classList.remove('notif-deleting'));
          clearBtn.disabled = false;
        }
      }, secs * 1000);
    });

    list.addEventListener('click', async (e) => {
      const check = e.target.closest('.notif-check');
      if (check) {
        if (check.disabled) return;
        const id = Number(check.dataset.id);
        try {
          const res = await api(`/api/notifications/${id}/read?kind=${kind}`, 'POST');
          const item = check.closest('.notif-item');
          item?.classList.remove('unread');
          check.classList.add('done');
          check.disabled = true;
          updateBadge(badgeEl, res.unread || 0);
        } catch {
          /* ignore */
        }
        return;
      }

      const delBtn = e.target.closest('.notif-delete');
      if (delBtn) {
        const id = Number(delBtn.dataset.id);
        const item = delBtn.closest('.notif-item');
        item?.classList.add('notif-deleting');
        let cancelled = false;
        const secs = S.notifDeleteUndoSeconds;
        const { cancel } = showUndoToast({
          message: t('notif.deleteUndo'),
          seconds: secs,
          onUndo: () => {
            cancelled = true;
            item?.classList.remove('notif-deleting');
          },
        });
        setTimeout(async () => {
          if (cancelled) return;
          cancel();
          try {
            const res = await api(`/api/notifications/${id}?kind=${kind}`, 'DELETE');
            item?.remove();
            updateBadge(badgeEl, res.unread || 0);
            if (!list.querySelector('.notif-item')) {
              el.modalBody.innerHTML = `<div class="notif-empty">${t('notif.empty')}</div>`;
            }
          } catch {
            item?.classList.remove('notif-deleting');
          }
        }, secs * 1000);
        return;
      }

      const item = e.target.closest('.notif-item');
      if (!item) return;
      const berthId = Number(item.dataset.berth);
      const lat = parseFloat(item.dataset.lat);
      const lon = parseFloat(item.dataset.lon);
      if (berthId || Number.isFinite(lat)) {
        el.modalOverlay.classList.add('hidden');
        goToBerth(item.dataset.area, berthId || null, Number.isFinite(lat) ? lat : null, Number.isFinite(lon) ? lon : null);
        return;
      }
      const mmsi = Number(item.dataset.mmsi);
      if (!mmsi) return;
      el.modalOverlay.classList.add('hidden');
      showView('detail', mmsi, null);
    });
  }

  async function open() {
    el.modalTitle.textContent = t(titleKey);
    el.modalBody.innerHTML = `<div class="notif-empty">…</div>`;
    el.modalOverlay.classList.remove('hidden');
    try {
      const [data] = await Promise.all([api(`/api/notifications?kind=${kind}`), isGroup ? loadGroupState() : null]);
      render(data.notifications || []);
      updateBadge(badgeEl, data.unread || 0);
    } catch {
      el.modalBody.innerHTML = `<div class="notif-empty">${t('notif.loadFail')}</div>`;
    }
  }

  btn?.addEventListener('click', open);

  return { pollBadge };
}

let feeds = [];

/** Periodic background refresh of both feeds' unread badges — called from
 *  main.js's tick(). Does not touch the overlay content (loaded on open only). */
export function pollNotificationBadges() {
  feeds.forEach((f) => f.pollBadge());
}

export function initNotifications() {
  feeds = [
    createFeed({
      kind: 'personal',
      btn: el.btnNotifications,
      badgeEl: el.notifBadge,
      titleKey: 'notif.overlayTitle',
      buildMessage: personalNotifMessage,
      isGroup: false,
    }),
    createFeed({
      kind: 'group',
      btn: el.btnGroupNotifications,
      badgeEl: el.groupNotifBadge,
      titleKey: 'notif.groupOverlayTitle',
      buildMessage: groupNotifMessage,
      isGroup: true,
    }),
  ];
  pollNotificationBadges();
}
