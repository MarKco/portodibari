'use strict';

const db = require('../db');
const { state, SOG_FERMA, STILL_RADIUS_M } = require('../config');

/** Great-circle distance in metres between two lat/lon points. */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// In-port = moored/anchored (AIS nav status 1/5) or effectively stationary.
// Hysteresis: a ship swinging at anchor / drifting on current can momentarily
// report SOG > threshold, which would otherwise flip it out of "in port". So we
// also treat it as in-port when its recent positions stay clustered within
// STILL_RADIUS_M (only small current/anchoring movements). These keep a wider
// retention window (see db ACTIVE_PREDICATE).
function isInPort(ship) {
  const ns = ship.last_navigational_status;
  if (ns === '1' || ns === '5') return true;
  const recent = db.getRecentPositions(ship.mmsi, 30);
  if (recent.length >= 3) {
    const cLat = recent.reduce((s, p) => s + p.lat, 0) / recent.length;
    const cLon = recent.reduce((s, p) => s + p.lon, 0) / recent.length;
    const maxD = Math.max(...recent.map((p) => haversineM(cLat, cLon, p.lat, p.lon)));
    if (maxD < STILL_RADIUS_M) return true;
  }
  return ship.last_sog != null && ship.last_sog < SOG_FERMA;
}

/** Classify movement relative to the active bounding-box centre. */
function computeDirection(ship) {
  const ns = ship.last_navigational_status;
  if (ns === '1' || ns === '5') return 'ferma'; // at anchor / moored
  if (ship.last_sog == null || ship.last_sog < SOG_FERMA) return 'ferma';
  const cog = ship.last_cog;
  if (cog == null || cog > 360) return null; // COG not available
  if (ship.last_latitude == null || ship.last_longitude == null) return null;
  const dLon = ((state.centerLon - ship.last_longitude) * Math.PI) / 180;
  const lat1r = (ship.last_latitude * Math.PI) / 180;
  const lat2r = (state.centerLat * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2r);
  const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLon);
  const bearingToCenter = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const diff = Math.abs((((cog - bearingToCenter) + 540) % 360) - 180);
  return diff < 90 ? 'entrata' : 'uscita';
}

module.exports = { haversineM, isInPort, computeDirection };
