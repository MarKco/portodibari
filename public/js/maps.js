import { S } from './store.js';
import { api } from './api.js';
import {
  haversineM,
  formatTime,
  directionBadge,
  shipTypeLabel,
  riskBadge,
  escHtml,
} from './helpers.js';
import { showView } from './views.js';
import { t } from './i18n.js';

const OSM_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// Bbox the active map was last framed to, so we re-fit only when the area
// changes — not on every poll, which would fight the user's pan/zoom.
let activeFitKey = null;

// ── Detail map (single ship track) ───────────────────────────────────────────
function initMap() {
  if (S.aisMap) return;
  S.aisMap = L.map('detail-map', { zoomControl: true }).setView([41.138, 16.843], 13);
  L.tileLayer(OSM_TILES, { attribution: OSM_ATTR, maxZoom: 19 }).addTo(S.aisMap);
  S.trackLayer = L.layerGroup().addTo(S.aisMap);
}

// Collapse consecutive stationary points (SOG≈0) that stay within the merge
// radius into a single "sosta" node — declutters anchor-swing / current drift.
function collapseTrack(pts) {
  const nodes = [];
  let cl = null;
  for (const p of pts) {
    const stopped = p.sog != null && p.sog < S.trackSogStop;
    if (
      cl &&
      cl.stopped &&
      stopped &&
      haversineM(cl.latitude, cl.longitude, p.latitude, p.longitude) < S.trackMergeRadiusM
    ) {
      cl.count++;
      cl.toTime = p.received_at;
      cl._latSum += p.latitude;
      cl._lonSum += p.longitude;
      cl.latitude = cl._latSum / cl.count;
      cl.longitude = cl._lonSum / cl.count;
      cl.sog = p.sog;
      cl.cog = p.cog;
    } else {
      if (cl) nodes.push(cl);
      cl = {
        latitude: p.latitude,
        longitude: p.longitude,
        received_at: p.received_at,
        fromTime: p.received_at,
        toTime: p.received_at,
        sog: p.sog,
        cog: p.cog,
        stopped,
        count: 1,
        _latSum: p.latitude,
        _lonSum: p.longitude,
      };
    }
  }
  if (cl) nodes.push(cl);
  return nodes;
}

export async function loadTrack(mmsi) {
  initMap();
  S.aisMap.invalidateSize();
  S.trackLayer.clearLayers();

  try {
    const data = await api(`/api/ships/${mmsi}/track`);
    const pts = data.points || [];
    if (!pts.length) return;

    const nodes = collapseTrack(pts);
    const latlngs = nodes.map((n) => [n.latitude, n.longitude]);
    L.polyline(latlngs, { color: '#3b82f6', weight: 2.5, opacity: 0.75 }).addTo(S.trackLayer);
    nodes.forEach((n, i) => {
      const isLast = i === nodes.length - 1;
      const isSosta = n.count > 1;
      L.circleMarker([n.latitude, n.longitude], {
        radius: isLast ? 9 : isSosta ? 7 : 5,
        color: isLast ? '#34d399' : isSosta ? '#38bdf8' : '#3b82f6',
        fillColor: isLast ? '#34d399' : isSosta ? '#0ea5e9' : '#1e40af',
        fillOpacity: 0.85,
        weight: isLast ? 2.5 : 1.5,
      })
        .bindPopup(
          `<b>${isLast ? t('map.lastPos') : isSosta ? t('map.stay') : formatTime(n.received_at)}</b><br>` +
            `${isLast ? formatTime(n.received_at) + '<br>' : ''}` +
            `${isSosta ? `${t('map.stays', { n: n.count, from: formatTime(n.fromTime), to: formatTime(n.toTime) })}<br>` : ''}` +
            `SOG: ${n.sog != null ? n.sog.toFixed(1) + ' kn' : '—'}&nbsp;&nbsp;` +
            `COG: ${n.cog != null && n.cog <= 360 ? n.cog.toFixed(0) + '°' : '—'}`
        )
        .addTo(S.trackLayer);
    });

    const bounds = L.latLngBounds(latlngs);
    if (bounds.isValid()) S.aisMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
  } catch {
    /* track unavailable */
  }
}

// ── Active-ships overview map ────────────────────────────────────────────────
export function initActiveMap() {
  if (S.activeMap) return;
  S.activeMap = L.map('active-map', { zoomControl: true }).setView([41.138, 16.843], 12);
  L.tileLayer(OSM_TILES, { attribution: OSM_ATTR, maxZoom: 19 }).addTo(S.activeMap);
  S.activeMarkersLayer = L.layerGroup().addTo(S.activeMap);
  if (S.currentBbox) {
    const [[swLat, swLon], [neLat, neLon]] = S.currentBbox;
    S.activeMap.fitBounds([[swLat, swLon], [neLat, neLon]], { padding: [40, 40] });
  }
}

// Exposed globally for the inline onclick in map popups.
window.openShipDetail = function (mmsi) {
  S.activeMap.closePopup();
  S.detailFrom = 'active';
  showView('detail', mmsi, S.activeShipsCache.get(mmsi) || null);
};

export function renderActiveMap(ships) {
  initActiveMap();
  S.activeMap.invalidateSize();
  S.activeMarkersLayer.clearLayers();
  S.activeShipsCache.clear();
  ships.forEach((s) => S.activeShipsCache.set(s.mmsi, s));

  const positioned = ships.filter((s) => s.last_latitude != null && s.last_longitude != null);
  if (!positioned.length) return;

  const latlngs = [];
  positioned.forEach((s) => {
    const ll = [s.last_latitude, s.last_longitude];
    latlngs.push(ll);
    // Marker colour: flagged ships → viola; otherwise the risk band
    // (verde ≤30 · giallo 31–70 · rosso 71–100).
    const RISK_STYLE = {
      high: { radius: 9, color: '#f87171', fillColor: '#dc2626', weight: 3 },
      med: { radius: 8, color: '#fbbf24', fillColor: '#d97706', weight: 2.5 },
      low: { radius: 7, color: '#34d399', fillColor: '#059669', weight: 2 },
    };
    const style = s.flagged
      ? { radius: 10, color: '#a78bfa', fillColor: '#7c3aed', weight: 3 }
      : RISK_STYLE[s.risk?.band] || RISK_STYLE.low;
    L.circleMarker(ll, { ...style, fillOpacity: 0.9 })
      .bindPopup(
        `<b style="font-size:1rem">${escHtml(s.ship_name || t('map.unknown'))}</b><br>` +
          `<span style="color:#9ca3af;font-size:0.8rem">MMSI: ${s.mmsi}</span><br><br>` +
          `🚢 ${shipTypeLabel(s.ship_type)}<br>` +
          `${t('map.risk')} ${riskBadge(s.risk)}<br>` +
          `📍 ${s.destination ? escHtml(s.destination) : '—'}<br>` +
          `⚡ SOG: ${s.last_sog != null ? s.last_sog.toFixed(1) + ' kn' : '—'}` +
          `${s.last_cog != null && s.last_cog <= 360 ? `&nbsp;&nbsp;COG: ${s.last_cog.toFixed(0)}°` : ''}<br>` +
          `${directionBadge(s.direction)}${s.in_port ? ` ${t('port.badge')}` : ''}<br>` +
          `🕐 ${formatTime(s.last_seen_at)}<br>` +
          `<div style="margin-top:8px;display:flex;gap:6px">` +
          `<button onclick="openShipDetail(${s.mmsi})" style="padding:4px 12px;cursor:pointer;border:1px solid #3b82f6;background:#1e40af;color:#fff;border-radius:4px;font-size:0.8rem;flex:1">${t('map.detail')}</button>` +
          `<a href="https://www.vesselfinder.com/vessels/details/${s.mmsi}" target="_blank" rel="noopener" style="padding:4px 10px;cursor:pointer;border:1px solid #374151;background:#1e2330;color:#9ca3af;border-radius:4px;font-size:0.8rem;text-decoration:none;display:flex;align-items:center" title="VesselFinder">⧉</a>` +
          `</div>`
      )
      .addTo(S.activeMarkersLayer);
  });

  // Frame the selected area's bounding box, not the ships, so the view stays
  // anchored to the chosen area even if a few (possibly mis-tagged) ships sit
  // outside it. Re-fit only when the area changed, to avoid snapping back on
  // every poll. Fall back to ship bounds only when no area box is known.
  if (S.currentBbox) {
    const key = JSON.stringify(S.currentBbox);
    if (key !== activeFitKey) {
      S.activeMap.fitBounds(S.currentBbox, { padding: [40, 40] });
      activeFitKey = key;
    }
  } else {
    const bounds = L.latLngBounds(latlngs);
    if (bounds.isValid()) S.activeMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }
}
