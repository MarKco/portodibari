'use strict';

const { fetchViaCurl } = require('./http');

// Italian labels for the MarineTraffic vesselInfo fields we surface in the UI.
const MT_FIELD_LABELS = {
  name: 'Nome',
  imo: 'IMO',
  mmsi: 'MMSI',
  callsign: 'Nominativo',
  country: 'Bandiera',
  typeSpecific: 'Tipo',
  grossTonnage: 'Stazza lorda',
  deadweight: 'Portata lorda (DWT)',
  length: 'Lunghezza (m)',
  breadth: 'Larghezza (m)',
  yearBuilt: 'Anno costruzione',
  status: 'Stato',
  homePort: 'Porto di armamento',
};

// Resolve MarineTraffic internal shipid from MMSI/IMO/callsign.
// MT pages are a React SPA keyed by their own shipid; the public identifiers
// must be looked up via the global_search endpoint (requires JSON Accept).
// types: 1=Vessel, 3=IMO, 7=MMSI, 9=Callsign.
async function resolveMtShipId(ship) {
  const terms = [ship.mmsi, ship.imo_number, ship.call_sign].filter(Boolean);
  for (const term of terms) {
    const url = `https://www.marinetraffic.com/en/global_search/search?term=${encodeURIComponent(term)}&types=1,3,7,9`;
    let json;
    try {
      const body = await fetchViaCurl(url, {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      });
      json = JSON.parse(body);
    } catch {
      continue;
    }
    const id = json?.results?.[0]?.id;
    if (id) return id;
  }
  return null;
}

async function crawlMarineTraffic(ship) {
  const shipId = await resolveMtShipId(ship);
  if (!shipId) throw new Error('Nave non trovata su MarineTraffic');
  // The vesselInfo endpoint is an XHR API: without the XMLHttpRequest/JSON
  // headers Cloudflare serves a 403 challenge page instead of the JSON.
  const body = await fetchViaCurl(
    `https://www.marinetraffic.com/en/vesselDetails/vesselInfo/shipid:${encodeURIComponent(shipId)}`,
    { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
  );
  let info;
  try {
    info = JSON.parse(body);
  } catch {
    throw new Error('Risposta MarineTraffic non valida');
  }
  const data = {};
  for (const [key, label] of Object.entries(MT_FIELD_LABELS)) {
    const v = info[key];
    if (v != null && v !== '') data[label] = String(v);
  }
  return { data, shipId };
}

module.exports = { crawlMarineTraffic, MT_FIELD_LABELS };
