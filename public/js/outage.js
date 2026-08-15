// AIS service-outage banner.
//
// The server (services/ais-uptime.js) sets `outage` on the /api/stream/status
// payload that updateStatus() polls. We show a slim, dismissible banner only
// when an outage is asserted AND the user is on a monitoring page — never on
// Settings/Aree. Two independent triggers, either one shows the banner:
//   - `serviceDown` — the area/monitoring stream is silent AND an external
//     AISStream uptime monitor confirms a real outage.
//   - `streamIssues` — the follow and/or heatmap stream has been stuck failing
//     to reconnect for a while (see services/ais-uptime.js — message silence is
//     normal for those two, so they use a different, unambiguous signal).
// Dismissal is keyed to the current issue's identity (`since` for serviceDown,
// the sorted stream list for streamIssues), so a new/different issue re-shows
// the banner even after the user closed a previous one.

import { el } from './dom.js';
import { S } from './store.js';
import { t } from './i18n.js';
import { formatTime } from './helpers.js';

const MONITORING_VIEWS = new Set(['active', 'past', 'traffico', 'followed', 'detail']);
const STREAM_LABEL_KEY = { monitoring: 'health.streamMonitoring', follow: 'sidebar.followed', heatmap: 'settings.group.heatmap' };
let dismissedKey = null;

/** Store the latest outage verdict from the server and refresh the banner. */
export function setOutage(outage) {
  S.outage = outage || null;
  applyOutageBanner();
}

function currentKey(o) {
  const streamIssues = o?.streamIssues || [];
  if (o?.serviceDown) return o.since;
  if (o?.fallbackMode?.active) return `fallback:${o.fallbackMode.since}`;
  if (streamIssues.length) return `streams:${streamIssues.join(',')}`;
  return null;
}

/** Show/hide the banner from the current outage state + active view. Fallback
 *  mode (services/fallback-mode.js) can stay active a little after serviceDown
 *  clears (exit-grace hysteresis) — the banner keeps showing through that
 *  window instead of disappearing while scraping is still running. */
export function applyOutageBanner() {
  const banner = el.outageBanner;
  if (!banner) return;
  const o = S.outage;
  const streamIssues = o?.streamIssues || [];
  const fb = o?.fallbackMode;
  const active = !!o && (o.serviceDown || streamIssues.length > 0 || fb?.active);
  const key = currentKey(o);
  const show = active && MONITORING_VIEWS.has(S.view) && dismissedKey !== key;
  if (!show) {
    banner.classList.add('hidden');
    return;
  }
  let text;
  if (o.serviceDown) {
    const when = o.checkedAt ? formatTime(o.checkedAt) : '—';
    text = t('outage.banner', { state: o.monitorState || '—', time: when });
  } else if (fb?.active) {
    text = t('outage.fallbackStillActive');
  } else {
    const names = streamIssues.map((k) => t(STREAM_LABEL_KEY[k] || k)).join(', ');
    text = t('outage.streamBanner', { stream: names });
  }
  // Admin-only hint pointing at the "Modalità fallback" panel (Settings →
  // Diagnostica AIS) — not a link (the banner shows on monitoring pages, not
  // Settings), just enough to prompt an admin who logs in/reloads mid-outage
  // to go check scope/circuit-breaker state.
  if (fb?.active && S.isAdmin) {
    text += ' ' + t('outage.fallbackAdminCta');
  }
  el.outageBannerText.textContent = text;
  banner.classList.remove('hidden');
}

/** Wire the dismiss button. Call once at startup. */
export function initOutageBanner() {
  if (el.outageBannerClose) {
    el.outageBannerClose.addEventListener('click', () => {
      dismissedKey = currentKey(S.outage);
      applyOutageBanner();
    });
  }
}
