// AIS service-outage banner.
//
// The server (services/ais-uptime.js) sets `outage` on the /api/stream/status
// payload that updateStatus() polls. We show a slim, dismissible banner only
// when an outage is asserted AND the user is on a monitoring page — never on
// Settings/Aree. Dismissal is keyed to the outage's `since` timestamp, so a new
// distinct outage re-shows the banner even after the user closed a previous one.

import { el } from './dom.js';
import { S } from './store.js';
import { t } from './i18n.js';
import { formatTime } from './helpers.js';

const MONITORING_VIEWS = new Set(['active', 'past', 'traffico', 'followed', 'detail']);
let dismissedSince = null;

/** Store the latest outage verdict from the server and refresh the banner. */
export function setOutage(outage) {
  S.outage = outage || null;
  applyOutageBanner();
}

/** Show/hide the banner from the current outage state + active view. */
export function applyOutageBanner() {
  const banner = el.outageBanner;
  if (!banner) return;
  const o = S.outage;
  const show =
    !!o && o.serviceDown && MONITORING_VIEWS.has(S.view) && dismissedSince !== o.since;
  if (!show) {
    banner.classList.add('hidden');
    return;
  }
  const when = o.checkedAt ? formatTime(o.checkedAt) : '—';
  el.outageBannerText.textContent = t('outage.banner', { state: o.monitorState || '—', time: when });
  banner.classList.remove('hidden');
}

/** Wire the dismiss button. Call once at startup. */
export function initOutageBanner() {
  if (el.outageBannerClose) {
    el.outageBannerClose.addEventListener('click', () => {
      dismissedSince = S.outage ? S.outage.since : null;
      applyOutageBanner();
    });
  }
}
