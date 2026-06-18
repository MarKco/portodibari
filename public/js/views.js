import { el } from './dom.js';
import { S } from './store.js';
import {
  loadActive,
  loadPast,
  loadDetail,
  loadVfData,
  loadMtData,
  loadEquasisData,
  loadGfwData,
  renderDetailInfoBar,
  renderSanctionsSection,
  updateDetailFlagBtn,
  updateDetailSeenBtn,
  updateDetailNotifMuteBtn,
} from './ships.js';
import { loadTrack, stopTrackAnim } from './maps.js';
import { loadTraffco } from './traffico.js';
import { enterAreasView, commitPendingDelete } from './areas.js';
import { closeSettingsLog } from './app-log.js';
import { closeLogs } from './logs.js';
import { closeHealth } from './health.js';

export function showView(v, mmsi, shipData) {
  // Leaving the Areas screen counts as "navigating away": commit any pending
  // (undo-window) area deletion before the screen disappears.
  if (S.view === 'areas' && v !== 'areas') commitPendingDelete();
  // Leaving the ship detail: stop any running track playback (rAF loop).
  if (S.view === 'detail' && v !== 'detail') stopTrackAnim();
  // Leaving Settings: stop every live feed bound to a settings tab
  // (app-log tail, API-log stream, AIS health polling).
  if (S.view === 'settings' && v !== 'settings') {
    closeSettingsLog();
    closeLogs();
    closeHealth();
  }

  S.view = v;
  el.viewActive.classList.toggle('hidden', v !== 'active');
  el.viewPast.classList.toggle('hidden', v !== 'past');
  el.viewDetail.classList.toggle('hidden', v !== 'detail');
  el.viewTraffco.classList.toggle('hidden', v !== 'traffico');
  el.viewAreas.classList.toggle('hidden', v !== 'areas');
  el.viewSettings.classList.toggle('hidden', v !== 'settings');
  el.mainTabs.classList.toggle('hidden', v === 'detail' || v === 'areas' || v === 'settings');

  el.tabActive.classList.toggle('tab-active', v === 'active');
  el.tabPast.classList.toggle('tab-active', v === 'past');
  el.tabTraffco.classList.toggle('tab-active', v === 'traffico');

  if (v === 'detail' && mmsi != null) {
    S.detailMmsi = mmsi;
    S.detailShipData = shipData || null;
    S.detailPage = 0;
    el.detailName.textContent = shipData?.ship_name || '';
    el.detailMmsiEl.textContent = `MMSI: ${mmsi}`;
    updateDetailFlagBtn(shipData?.flagged);
    updateDetailSeenBtn(shipData?.seen);
    updateDetailNotifMuteBtn(shipData?.notif_muted);
    el.btnVfDetail.href = `https://www.vesselfinder.com/vessels/details/${mmsi}`;
    el.btnMtDetail.href = shipData?.mt_ship_id
      ? `https://www.marinetraffic.com/it/ais/details/ships/shipid:${shipData.mt_ship_id}`
      : `https://www.marinetraffic.com/it/ais/details/ships/mmsi:${mmsi}`;
    renderDetailInfoBar(shipData, null);
    renderSanctionsSection(shipData?.risk);
    loadDetail();
    loadTrack(mmsi);
    // VF/MT/GFW are proactive enrichment and can shift the risk score, so
    // refresh the detail (score + factors) once they resolve.
    Promise.all([loadVfData(mmsi), loadMtData(mmsi), loadGfwData(mmsi)]).then(() => loadDetail());
    // Equasis is manual: only show cached data here, never auto-fetch.
    loadEquasisData(mmsi, false);
  } else if (v === 'active') {
    loadActive();
  } else if (v === 'past') {
    loadPast();
  } else if (v === 'traffico') {
    loadTraffco();
  } else if (v === 'areas') {
    enterAreasView();
  }
}
