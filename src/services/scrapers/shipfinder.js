'use strict';

// Scrape a ShipFinder ship-detail page. Unlike VesselFinder/MarineTraffic (whose
// free pages carry no coordinates), ShipFinder server-renders the vessel's last
// known position (lat/lon/sog/cog/status) directly in the HTML — that position is
// the unique value here, used to re-locate followed ships our AIS stream has lost.
// The page is plain HTTPS (no Cloudflare TLS fingerprinting), so fetchHttp works;
// the static fields (flag/type/dimensions) mostly duplicate VF/MT and ride along
// as a cheap fallback.
//
// The detail page keys ship attributes by `<label id="ais-<field>">value</label>`
// (the position block, voyage, dimensions). The flag is an <img> whose filename is
// the ISO country code. Port-call / event / similar-ship blocks load later over
// XHR and are intentionally ignored.

const { fetchHttp, stripHtml } = require('./http');
const { parseDdm } = require('../../lib/coords');

const SF_URL = (mmsi) => `https://www.shipfinder.com/ship/detail/mmsi/${encodeURIComponent(mmsi)}`;

// Text content of <label id="ais-<id>">value</label>.
function labelVal(html, id) {
  const m = html.match(new RegExp(`id="ais-${id}"[^>]*>([^<]*)`, 'i'));
  return m ? stripHtml(m[1]) : '';
}

// First number in a string ("6.0 kn" -> 6.0, "165.4 °" -> 165.4). null if none.
function firstNum(s) {
  const m = String(s || '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// ShipFinder timestamps are UTC ("2026-06-29 23:37:24"). Convert to ISO; null if
// unparseable (we then fall back to "now" at insert time).
function parseSfTime(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Fetch and parse a ShipFinder detail page for `mmsi`. Returns
 * `{ static: {label: value, ...}, position: {...}|null }`. Throws on a missing
 * page / captcha challenge (no usable data) so the caller can negative-cache it.
 */
async function crawlShipfinder(mmsi) {
  const html = await fetchHttp(SF_URL(mmsi));

  const name = labelVal(html, 'name');
  const callsign = labelVal(html, 'callsign');
  const imo = labelVal(html, 'imo');
  const type = labelVal(html, 'shipType');
  const status = labelVal(html, 'shipStatus');
  const length = labelVal(html, '_length');
  const width = labelVal(html, '_width');
  const draught = labelVal(html, '_draught');
  const dest = labelVal(html, 'dest');
  const eta = labelVal(html, '_eta');
  const sog = labelVal(html, '_sog');
  const cog = labelVal(html, 'course_f');
  const heading = labelVal(html, 'heading_f');
  const latRaw = labelVal(html, '_lat');
  const lonRaw = labelVal(html, '_lon');
  const lastTime = labelVal(html, 'lastTime');
  const flagM = html.match(/flags\/([A-Za-z]{2,3})\.png/i);
  const flag = flagM ? flagM[1].toUpperCase() : '';

  const lat = parseDdm(latRaw);
  const lon = parseDdm(lonRaw);

  // Empty page / captcha challenge: neither identity nor a position came through.
  if (!name && lat == null) throw new Error('ShipFinder: nessun dato (captcha o nave sconosciuta)');

  // Flat label/value map for the detail panel (same shape as VF/MT). Drops
  // empty / "-" / "Unknown" placeholders the page uses for missing fields.
  const staticData = {};
  const put = (k, v) => {
    const s = (v || '').trim();
    if (s && s !== '-' && s.toLowerCase() !== 'unknown') staticData[k] = s;
  };
  put('Nome', name);
  put('IMO', imo);
  put('MMSI', String(mmsi));
  put('Call Sign', callsign);
  put('Bandiera', flag);
  put('Tipo', type);
  put('Lunghezza', length);
  put('Larghezza', width);
  put('Pescaggio', draught);
  put('Stato', status);
  put('Destinazione', dest);
  put('ETA', eta);

  const position = lat != null && lon != null
    ? {
        lat,
        lon,
        sog: firstNum(sog),
        cog: firstNum(cog),
        heading: firstNum(heading),
        status: (status || '').trim() || null,
        dest: (dest || '').trim() || null,
        name: (name || '').trim() || null,
        reportedAt: parseSfTime(lastTime),
      }
    : null;

  return { static: staticData, position };
}

module.exports = { crawlShipfinder };
