import { el } from './dom.js';
import { S } from './store.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { escHtml, formatTime } from './helpers.js';
import { showView } from './views.js';
import { goToBerth } from './berths.js';
import { showUndoToast } from './toast.js';

// Sidebar notifications feed. The list is shown by default; the bell button
// toggles its visibility (persisted in localStorage). The red badge counts
// unread notifications; unread rows render bold until acknowledged.

const VISIBLE_KEY = 'notifVisible';

function isVisible() {
  return localStorage.getItem(VISIBLE_KEY) !== 'hidden';
}

function applyVisibility() {
  const show = isVisible();
  el.notifList.classList.toggle('hidden', !show);
  el.btnNotifications.classList.toggle('active', show);
}

function areaName(key) {
  return S.presets[key]?.name || key || '—';
}

function notifMessage(n) {
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
  if (n.type === 'follow_lost') {
    const ship = n.ship_name || `MMSI ${n.mmsi}`;
    return t('notif.followLost', { ship: escHtml(ship) });
  }
  if (n.type === 'berth_new') {
    return t('notif.berthNew', { area: escHtml(areaName(n.area)) });
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

function renderNotifications(notifications) {
  if (el.btnNotifClear) el.btnNotifClear.classList.toggle('hidden', !notifications.length);
  if (!notifications.length) {
    el.notifList.innerHTML = `<div class="notif-empty">${t('notif.empty')}</div>`;
    return;
  }
  el.notifList.innerHTML = notifications
    .map((n) => {
      const isBerth = n.type === 'berth_new' || n.type === 'berth_characterized';
      const dotClass = isBerth ? 'notif-dot-berth' : `risk-${n.band || 'low'}`;
      const clickable = n.mmsi || n.berth_id;
      return `
      <div class="notif-item ${n.read ? '' : 'unread'} ${clickable ? 'notif-item-clickable' : ''}" data-id="${n.id}" data-mmsi="${n.mmsi || ''}" data-berth="${n.berth_id || ''}" data-lat="${n.berth_lat ?? ''}" data-lon="${n.berth_lon ?? ''}" data-area="${escHtml(n.area || '')}">
        <span class="notif-dot ${dotClass}" title="${!isBerth && n.score != null ? `${n.score}/100` : ''}"></span>
        <div class="notif-text">
          <div class="notif-msg">${notifMessage(n)}</div>
          <div class="notif-meta">${formatTime(n.ts)}</div>
        </div>
        <button class="notif-check ${n.read ? 'done' : ''}" data-id="${n.id}"
                title="${t('notif.markRead')}" ${n.read ? 'disabled' : ''}>✓</button>
        <button class="notif-delete" data-id="${n.id}" title="${t('notif.delete')}">🗑</button>
      </div>`;
    })
    .join('');
}

function updateBadge(unread) {
  if (unread > 0) {
    el.notifBadge.textContent = unread > 99 ? '99+' : String(unread);
    el.notifBadge.classList.remove('hidden');
  } else {
    el.notifBadge.classList.add('hidden');
  }
}

export async function loadNotifications() {
  try {
    const data = await api('/api/notifications');
    renderNotifications(data.notifications || []);
    updateBadge(data.unread || 0);
  } catch {
    /* ignore */
  }
}

export function initNotifications() {
  applyVisibility();

  el.btnNotifications.addEventListener('click', () => {
    localStorage.setItem(VISIBLE_KEY, isVisible() ? 'hidden' : 'visible');
    applyVisibility();
  });

  // Clear-all: delete the whole feed with the same undo window as a single
  // delete (duration configurable via NOTIF_DELETE_UNDO_SECONDS).
  el.btnNotifClear?.addEventListener('click', () => {
    const items = el.notifList.querySelectorAll('.notif-item');
    if (!items.length) return;
    items.forEach((i) => i.classList.add('notif-deleting'));
    let cancelled = false;
    const secs = S.notifDeleteUndoSeconds;
    const { cancel } = showUndoToast({
      message: t('notif.clearAllUndo'),
      seconds: secs,
      onUndo: () => {
        cancelled = true;
        items.forEach((i) => i.classList.remove('notif-deleting'));
      },
    });
    setTimeout(async () => {
      if (cancelled) return;
      cancel();
      try {
        await api('/api/notifications', 'DELETE');
        el.notifList.innerHTML = `<div class="notif-empty">${t('notif.empty')}</div>`;
        updateBadge(0);
        el.btnNotifClear.classList.add('hidden');
      } catch {
        items.forEach((i) => i.classList.remove('notif-deleting'));
      }
    }, secs * 1000);
  });

  el.notifList.addEventListener('click', async (e) => {
    // Mark-as-read: clicking the ✓ check button.
    const btn = e.target.closest('.notif-check');
    if (btn) {
      if (btn.disabled) return;
      const id = Number(btn.dataset.id);
      try {
        const res = await api(`/api/notifications/${id}/read`, 'POST');
        const item = btn.closest('.notif-item');
        item?.classList.remove('unread');
        btn.classList.add('done');
        btn.disabled = true;
        updateBadge(res.unread || 0);
      } catch {
        /* ignore */
      }
      return;
    }

    // Delete notification with 5-second undo window.
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
          const res = await api(`/api/notifications/${id}`, 'DELETE');
          item?.remove();
          updateBadge(res.unread || 0);
          if (!document.querySelector('.notif-item')) {
            el.notifList.innerHTML = `<div class="notif-empty">${t('notif.empty')}</div>`;
            el.btnNotifClear?.classList.add('hidden');
          }
        } catch {
          item?.classList.remove('notif-deleting');
        }
      }, secs * 1000);
      return;
    }

    // Navigate: clicking anywhere else on the row.
    const item = e.target.closest('.notif-item');
    if (!item) return;
    // Berth events → locate the berth on its area's map. The id may be stale
    // (berths are renumbered on every recompute), so pass the captured centroid
    // too — goToBerth falls back to it when the id no longer resolves.
    const berthId = Number(item.dataset.berth);
    const lat = parseFloat(item.dataset.lat);
    const lon = parseFloat(item.dataset.lon);
    if (berthId || Number.isFinite(lat)) {
      goToBerth(item.dataset.area, berthId || null, Number.isFinite(lat) ? lat : null, Number.isFinite(lon) ? lon : null);
      return;
    }
    // Ship events → open the ship detail view.
    const mmsi = Number(item.dataset.mmsi);
    if (!mmsi) return;
    showView('detail', mmsi, null);
  });

  loadNotifications();
}
