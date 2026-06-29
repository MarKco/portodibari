'use strict';

// Scrape a MyShipTracking ship-detail page. Like ShipFinder (and unlike
// VesselFinder/MarineTraffic, whose free pages carry no coordinates), MST
// server-renders the vessel's last-known position in the page — so it serves the
// same role: a free, plain-HTTPS source to re-locate followed ships our AIS stream
// has lost. It rides alongside ShipFinder as a second, independent position
// backup. MST's AIS is terrestrial (T-AIS): good coastal/port coverage, weak
// offshore — fine for our port-monitoring areas.
//
// Layout: the structured particulars and the live voyage block live in
// `<tr><th>label</th><td>value</td></tr>` tables — speed, course, AIS nav status,
// dimensions, call sign all come from there. The coordinates and the report
// timestamp, however, are only reliably present in the SEO prose sentence ("...with
// coordinates -10.90965° / 122.23539° as reported on 2026-06-16 20:32..."): the
// voyage table blanks Latitude/Longitude to "---" for stale vessels, while the prose
// always carries the last-known fix. So we read the fix (and flag/destination) from
// the prose and everything else from the tables. MST reports coordinates as signed
// decimal degrees (lat / lon order), not DDM.

const { fetchHttp, stripHtml } = require('./http');

const MST_URL = (mmsi) =>
  `https://www.myshiptracking.com/vessels/mmsi-${encodeURIComponent(mmsi)}`;

// All values of the rows `<th>label</th><td>value</td>` whose header cell is exactly
// `label` (e.g. "Status" appears in both the particulars and the voyage table).
// Returned in document order.
function rowVals(html, label) {
  const re = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(stripHtml(m[1]));
  return out;
}
const rowVal = (html, label) => rowVals(html, label)[0] || '';

// First number in a string ("14.2 Knots" -> 14.2, "208.3°" -> 208.3). null if none.
function firstNum(s) {
  const m = String(s || '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// MST prose timestamps are UTC with minute precision ("2026-06-16 20:32"; seconds
// optional). Convert to ISO; null if unparseable (caller falls back to "now").
function parseMstTime(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Fetch and parse a MyShipTracking detail page for `mmsi`. Returns
 * `{ static: {label: value, ...}, position: {...}|null }`. Throws on a missing /
 * unknown page (no usable data) so the caller can negative-cache it.
 */
async function crawlMyshiptracking(mmsi) {
  const html = await fetchHttp(MST_URL(mmsi));

  // Identity / type from <title> ("NAME - TYPE (IMO: ... , MMSI: ...) | ...").
  const titleM = html.match(/<title>\s*(.*?)\s+-\s+(.*?)\s+\(IMO:/i);
  const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const name = (h1M ? stripHtml(h1M[1]) : '') || (titleM ? stripHtml(titleM[1]) : '');
  const type = titleM ? stripHtml(titleM[2]) : '';

  // Particulars table.
  const imo = rowVal(html, 'IMO');
  const callsign = rowVal(html, 'Call Sign');
  const size = rowVal(html, 'Size'); // "299 x 50 m"
  const draught = rowVal(html, 'Draught'); // voyage table, "7.7 m"

  // Voyage / live block. "Status" occurs twice (particulars "Active" tracking flag,
  // then the AIS nav status) — the last is the nav status we want.
  const statuses = rowVals(html, 'Status');
  const navStatus = statuses[statuses.length - 1] || '';
  const speed = rowVal(html, 'Speed'); // "14.2 Knots"
  const course = rowVal(html, 'Course'); // "208.3°"

  // Position fix + report time + flag ISO + destination from the SEO prose, whose
  // values are wrapped in <strong>; strip the tags from the sentence first, then
  // match the plain text.
  const pIdx = html.search(/current position of/i);
  const prose = pIdx >= 0 ? stripHtml(html.slice(pIdx, pIdx + 1400)) : '';
  const coordsM = prose.match(/coordinates\s+(-?\d+(?:\.\d+)?)\s*°?\s*\/\s*(-?\d+(?:\.\d+)?)/i);
  const timeM = prose.match(/reported on\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/i);
  const flagM = prose.match(/flag of\s+\[([A-Za-z]{2,3})\]/i) ||
    html.match(/flags\d*\/(?:\d+\/)?([A-Za-z]{2,3})\.png/i);
  const destM = prose.match(/heading (?:to|at the port of)\s+(.+?)\s*\./i);
  const flag = flagM ? flagM[1].toUpperCase() : '';
  const dest = destM ? destM[1].trim() : '';

  let lat = null;
  let lon = null;
  if (coordsM) {
    const la = Number(coordsM[1]);
    const lo = Number(coordsM[2]);
    if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
      lat = Math.round(la * 1e6) / 1e6;
      lon = Math.round(lo * 1e6) / 1e6;
    }
  }

  // Empty page / unknown vessel: neither identity nor a position came through.
  if (!name && lat == null) throw new Error('MyShipTracking: nessun dato (nave sconosciuta)');

  // Flat label/value map for the detail panel (same shape as VF/MT/SF). Drops
  // empty / "-" / "---" / "Unknown" placeholders the page uses for missing fields.
  const staticData = {};
  const put = (k, v) => {
    const s = (v || '').trim();
    if (s && !/^-+$/.test(s) && s.toLowerCase() !== 'unknown') staticData[k] = s;
  };
  put('Nome', name);
  put('IMO', imo);
  put('MMSI', String(mmsi));
  put('Call Sign', callsign);
  put('Bandiera', flag);
  put('Tipo', type);
  put('Dimensioni', size);
  put('Pescaggio', draught);
  put('Stato', navStatus);
  put('Destinazione', dest);

  const position = lat != null && lon != null
    ? {
        lat,
        lon,
        sog: firstNum(speed),
        cog: firstNum(course),
        heading: null, // MST exposes course only, no separate heading
        status: navStatus.trim() || null,
        dest: dest.trim() || null,
        name: name.trim() || null,
        reportedAt: parseMstTime(timeM ? timeM[1] : ''),
      }
    : null;

  return { static: staticData, position };
}

module.exports = { crawlMyshiptracking };
