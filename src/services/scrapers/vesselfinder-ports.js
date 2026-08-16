'use strict';

// Search VesselFinder's ports index for a port by name, as a second,
// independent corroborating source for port-discovery's cascade (Task 5 of
// the port-discovery plan) — Task 7 calls this per LOCODE/WPI candidate name
// and cross-references the returned coordinates against the candidate's own.
//
// VERIFICATION (spike, 2026-08-17): fetched https://www.vesselfinder.com/ports
// for real. It is a BROWSE INDEX (like MyShipTracking's ports page was), not a
// search endpoint: `?name=`/`?q=`/`?search=` all returned byte-identical
// output to the unfiltered page (same 39865-byte length, same first page of
// rows) — confirmed these params are silently ignored, not a guess.
//
// The listing rows themselves carry no coordinates — only name, country and
// a link to a detail page (`<a href="/ports/{PID}">`, e.g.
// `<div class="row-title">Livorno</div>`, `PID="ITLIV001"`). Coordinates only
// appear on that detail page, inlined as `var port={lat:43.54..., lon:10.28...};`.
//
// The site's own free-text search widget (a "type search" box, placeholder
// "Search ports by name or LOCODE") is entirely client-side: it downloads a
// private binary blob once (`/api/pro/ports/v4a/bin`, a custom packed
// LOCODE+name+country format) and filters it in JS. Replicating that would
// mean reverse-engineering an undocumented binary wire format from the site's
// JS bundle — out of scope per this task's boundary (no browser automation,
// no JS-bundle reverse engineering).
//
// Instead: the /ports listing is confirmed paginated (20 rows/page, "page N /
// TOTAL" in a `<span>`) and GLOBALLY SORTED ALPHABETICALLY BY NAME across all
// countries (verified: page 2 starts "Abu Qir"/ends "Afjord"; page 150 starts
// "Maassluis"; page 301 — the last — starts "Zumaya"). That sort order is
// itself enough for a binary search over page numbers to locate the page
// bracketing a target name in ~log2(301) ≈ 9 plain HTTP GETs — verified live:
// "Livorno" -> page 144 (8 steps) -> PID ITLIV001 -> lat 43.548828, lon
// 10.280542; "Genova" -> page 83 (9 steps) -> ITGOA001 -> 44.371593, 8.844298;
// "Napoli" -> page 173 (6 steps) -> ITNAP001 -> 40.828001, 14.274073. All
// three match the real-world locations. A name with no match (tested:
// "Nonexistentportxyz") converges to a bracketing page with zero matching
// rows and returns [] — no exception, no infinite loop (binary search halves
// the [low, high] range every iteration regardless of outcome).

const { fetchHttp, stripHtml } = require('./http');

const VF_PORTS_LIST_URL = (page) =>
  `https://www.vesselfinder.com/ports${page > 1 ? `?page=${page}` : ''}`;
const VF_PORT_DETAIL_URL = (pid) => `https://www.vesselfinder.com/ports/${encodeURIComponent(pid)}`;

const TOTAL_PAGES_RE = /<span>\s*page\s+\d+\s*\/\s*(\d+)\s*<\/span>/i;
const ROW_RE =
  /href="\/ports\/([A-Z0-9]+)">\s*<div class="row-title">([^<]*)<\/div>\s*<div class="row-country">([^<]*)<\/div>/g;
const PORT_COORDS_RE =
  /var\s+port\s*=\s*\{\s*lat\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*lon\s*:\s*(-?\d+(?:\.\d+)?)\s*\}/;

// Hard cap on binary-search iterations. Mathematically the [low, high] range
// halves every loop (so ~9 iterations covers today's 301 pages, ~20 would
// cover over a million), but this guards against an unforeseen response
// shape ever stalling the range instead of shrinking it.
const MAX_SEARCH_STEPS = 30;

/** Parse one /ports listing page: total page count (from the "page N / TOTAL"
 *  marker, present on every page) and its rows (pid, name, country). */
function parseListPage(html) {
  const totalM = html.match(TOTAL_PAGES_RE);
  const total = totalM ? Number(totalM[1]) : null;
  const rows = [];
  ROW_RE.lastIndex = 0;
  let m;
  while ((m = ROW_RE.exec(html)) !== null) {
    rows.push({ pid: m[1], name: stripHtml(m[2]), country: stripHtml(m[3]) });
  }
  return { rows, total };
}

async function fetchListPage(page) {
  const html = await fetchHttp(VF_PORTS_LIST_URL(page));
  return parseListPage(html);
}

/** Binary-search the alphabetically-sorted paginated index for the page whose
 *  row range brackets `target` (already lowercased). Returns that page's
 *  `{rows, total}`, or null if the index has no bracketing page for it
 *  (e.g. an empty/degenerate index). */
async function findBracketingPage(target) {
  const first = await fetchListPage(1);
  const total = first.total || 1;
  const cache = new Map([[1, first]]);
  let low = 1;
  let high = total;
  let steps = 0;
  while (low <= high && steps < MAX_SEARCH_STEPS) {
    steps += 1;
    const mid = Math.floor((low + high) / 2);
    let page = cache.get(mid);
    if (!page) {
      page = await fetchListPage(mid);
      cache.set(mid, page);
    }
    if (!page.rows.length) {
      high = mid - 1;
      continue;
    }
    const lo = page.rows[0].name.toLowerCase();
    const hi = page.rows[page.rows.length - 1].name.toLowerCase();
    if (target < lo) high = mid - 1;
    else if (target > hi) low = mid + 1;
    else return page;
  }
  return null;
}

/**
 * Search VesselFinder's ports index for `name`. Returns `{name, lat, lon}[]`
 * (empty if no match), throws on network/parse failure (negative-cached by
 * the caller like every other scraper here — Task 7 wraps each call in its
 * own try/catch so one candidate's failure doesn't block the rest).
 */
async function searchVesselFinderPorts(name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return [];

  const page = await findBracketingPage(target);
  if (!page) return [];

  const candidates = page.rows.filter((r) => {
    const n = r.name.toLowerCase();
    return n === target || n.includes(target);
  });
  if (!candidates.length) return [];

  const out = [];
  for (const cand of candidates) {
    const html = await fetchHttp(VF_PORT_DETAIL_URL(cand.pid));
    const m = html.match(PORT_COORDS_RE);
    if (!m) continue;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    out.push({ name: cand.name, lat, lon });
  }
  return out;
}

module.exports = { searchVesselFinderPorts };
