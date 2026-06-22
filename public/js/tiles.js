// Shared map tile layers. Every map gets the OSM base layer plus — when the
// OpenSeaMap setting is on — the OpenSeaMap "seamark" overlay: a transparent
// layer of nautical marks (buoys, lights, fairways, traffic separation,
// anchorages). No API key is required; the tiles are free (CC-BY-SA) and the
// attribution rides along with the layer.
import { S } from './store.js';

export const OSM_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const SEAMARK_TILES = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png';
const SEAMARK_ATTR = '© <a href="https://www.openseamap.org">OpenSeaMap</a>';

// map -> seamark tileLayer, so applyOpenSeaMap() can add/remove the overlay on
// every map live when the settings toggle flips, without recreating the maps.
const seamarkLayers = new Map();

// Add the OSM base layer to `map`, plus the OpenSeaMap seamark overlay (shown
// only when S.showOpenSeaMap is on). The seamark layer is registered for later
// toggling. Call this in every map's init in place of the bare L.tileLayer.
export function addBaseLayers(map, maxZoom = 19) {
  L.tileLayer(OSM_TILES, { attribution: OSM_ATTR, maxZoom }).addTo(map);
  const sea = L.tileLayer(SEAMARK_TILES, { attribution: SEAMARK_ATTR, maxZoom: 18, opacity: 0.9 });
  seamarkLayers.set(map, sea);
  if (S.showOpenSeaMap) sea.addTo(map);
  return sea;
}

// Sync the seamark overlay on every registered map to S.showOpenSeaMap. Called
// after settings load and whenever the settings toggle changes.
export function applyOpenSeaMap() {
  for (const [map, sea] of seamarkLayers) {
    if (S.showOpenSeaMap) {
      if (!map.hasLayer(sea)) sea.addTo(map);
    } else if (map.hasLayer(sea)) {
      map.removeLayer(sea);
    }
  }
}
