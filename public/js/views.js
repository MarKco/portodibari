import { el } from './dom.js';
import { S } from './store.js';
import {
  loadActive,
  loadPast,
  loadDetail,
  loadVfData,
  loadMtData,
  renderDetailInfoBar,
  updateDetailFlagBtn,
  updateDetailSeenBtn,
  updateDetailNotifMuteBtn,
} from './ships.js';
import { loadTrack } from './maps.js';
import { loadTraffco } from './traffico.js';
import { enterAreasView, commitPendingDelete } from './areas.js';

export function showView(v, mmsi, shipData) {
  // Leaving the Areas screen counts as "navigating away": commit any pending
  // (undo-window) area deletion before the screen disappears.
  if (S.view === 'areas' && v !== 'areas') commitPendingDelete();

  S.view = v;
  el.viewActive.classList.toggle('hidden', v !== 'active');
  el.viewPast.classList.toggle('hidden', v !== 'past');
  el.viewDetail.classList.toggle('hidden', v !== 'detail');
  el.viewTraffco.classList.toggle('hidden', v !== 'traffico');
  el.viewAreas.classList.toggle('hidden', v !== 'areas');
  el.mainTabs.classList.toggle('hidden', v === 'detail' || v === 'areas');

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
    loadDetail();
    loadTrack(mmsi);
    Promise.all([loadVfData(mmsi), loadMtData(mmsi)]).then(() => loadDetail());
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
