# Port Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For any monitored area (bbox), automatically discover and let an admin confirm which real-world seaports fall inside it, persisted per-area, so later features (scrape-recovery new-arrival discovery, and future consumers) have a trustworthy `area_key → confirmed ports` catalog.

**Architecture:** A cascade of signals, cheapest/most-authoritative first: existing berth clusters (ground truth, if the area already has AIS history) → else Global Fishing Watch anchorages, World Port Index, UN/LOCODE (function-classified), VesselFinder ports — each returns candidate `{name, lat, lon}` points, clustered by geographic proximity across sources, confirmed automatically at ≥2 agreeing sources, otherwise left for admin review. New DB table `area_ports`. Triggered on area creation, via a spaced background backfill at boot for pre-existing areas, and via a manual admin button.

**Tech Stack:** Node.js (`node:sqlite` via existing `db.js`), existing `fetchHttp`/scraper conventions (`src/services/scrapers/http.js`), no new dependencies, no test framework in this repo (verification is via `node --check`, `npm run lint`, and small throwaway scripts run with `node`, per this project's actual conventions — no pytest-style unit tests are added).

**Spec:** `docs/superpowers/specs/2026-08-16-per-area-scrape-recovery-design.md` (sections 4 and, partially, 5 — new-ship discovery via MST arrivals pages is covered in the companion plan `docs/superpowers/plans/2026-08-16-per-area-scrape-recovery.md`, which depends on this plan's `area_ports`/`mst_pid` output).

## Global Constraints

- Every new persistent table goes in `BACKUP_TABLES` (`src/db.js`) and is added via `CREATE TABLE IF NOT EXISTS` (never a bare `CREATE TABLE`) so an old backup restores cleanly.
- New columns on existing tables go through the `try { db.exec('ALTER TABLE ... ADD COLUMN ...') } catch {}` idiom already used in `db.js` (e.g. `db.js:456-458`), never a schema change that fails on a column that already exists.
- No `fs.readFileSync` + full-array processing on anything that could be large (project-wide rule from sanctions.js's streaming design) — the new datasets here (WPI, LOCODE-derived) are small (a few thousand rows) and bundled as committed JSON, so this doesn't bite, but keep it in mind if a source ever grows.
- Scraper additions (VesselFinder ports, MST arrivals/search) must go through `fetchHttp` from `src/services/scrapers/http.js` (UA rotation, size cap, deadline) — never a bespoke `https.request`.
- Every new admin-only route uses `requireAdmin` (`src/middleware/session-auth.js`), matching the existing `/api/settings/fallback-scope` pattern (`src/routes/settings.js:619-624`).
- Every new UI string goes in **both** `public/locales/it.js` and `public/locales/en.js`, same key, same position.
- `public/sw.js`'s `CACHE` constant must be bumped once, in the last frontend-touching task, so the browser picks up all frontend changes from this plan in one go (not per-task — bumping it after every task would force stale intermediate states to redeploy needlessly during development, but MUST happen before this plan is considered done).
- Any code path that discovers a **new-to-us** ship is explicitly **out of scope for this plan** (that's the companion per-area-scrape-recovery plan) — this plan only ever produces/persists `area_ports` rows, never touches `ships`.

---

## File Structure

**New files:**
- `src/services/port-discovery.js` — orchestrator: berths-first check, cascade dispatch, proximity clustering, persistence.
- `src/services/scrapers/vesselfinder-ports.js` — VF ports-search scraper (sibling to existing `scrapers/vesselfinder.js`, kept separate since it's a different page/parser, not ship-detail).
- `scripts/build-wpi.js` — one-time generator for `data/wpi.json` (World Port Index bundle), modeled on `scripts/build-locode.js`.
- `data/wpi.json` — generated, committed (small, static).
- `data/locode-ports.json` — generated, committed (LOCODE codes classified as seaports).

**Modified files:**
- `src/db.js` — new `area_ports` table + index, `BACKUP_TABLES` entry, query functions.
- `src/services/gfw.js` — add an anchorages-lookup function.
- `src/services/scrapers/myshiptracking.js` — add `searchPort(name)` and `crawlPortArrivals(pid)`.
- `scripts/build-locode.js` — stop discarding `entry.Function`; also emit `data/locode-ports.json`.
- `src/routes/areas.js` — new routes (discover/list/confirm/reject), auto-trigger on area creation.
- `src/server.js` — spaced background backfill queue at boot.
- `public/js/areas.js` — render per-area ports list, confirm/reject buttons, "Cerca porti ora" button.
- `public/index.html` — markup for the ports list block inside each area row.
- `public/locales/it.js`, `public/locales/en.js` — new i18n keys.
- `public/css/style.css` — small styles for the ports list/badges.
- `public/sw.js` — `CACHE` bump (last task only).
- `docs/technical/README.it.md`, `docs/technical/README.en.md` — new "Scoperta porti" section.
- `docs/manuale_admin/manuale_admin.md`, `.en.md` (+ regenerated `.html`/`.pdf`) — admin-facing instructions.

---

### Task 1: `area_ports` table, indexes, and query functions

**Files:**
- Modify: `src/db.js`

**Interfaces:**
- Produces: `db.getAreaPorts(areaKey)`, `db.getConfirmedAreaPorts(areaKey)`, `db.upsertAreaPort({area_key, name, lat, lon, sources, status})`, `db.setAreaPortDecision(id, status)` (`status` is `'confirmed'|'rejected'`), `db.setAreaPortMstPid(id, pid)`, `db.countAreaPorts(areaKey)` (used by the boot backfill to decide "does this area already have ports discovered").

- [ ] **Step 1: Add the table + index**

Add a new `db.exec()` block right after the existing `areas`/`user_areas` block (near `db.js:352-371`):

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS area_ports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area_key TEXT NOT NULL,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    sources TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'review',
    admin_reviewed INTEGER NOT NULL DEFAULT 0,
    mst_pid TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(area_key, name)
  );
  CREATE INDEX IF NOT EXISTS idx_area_ports_area ON area_ports(area_key);
`);
```

`admin_reviewed` guards against a re-discovery run (manual refresh) silently overwriting an admin's explicit confirm/reject decision — see Step 2's `ON CONFLICT` clause.

- [ ] **Step 2: Add the query functions**

Add near the other area-related functions (e.g. after `getAllAreas`/`upsertArea`):

```js
const upsertAreaPortStmt = db.prepare(`
  INSERT INTO area_ports (area_key, name, lat, lon, sources, status, admin_reviewed, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  ON CONFLICT(area_key, name) DO UPDATE SET
    lat = excluded.lat,
    lon = excluded.lon,
    sources = excluded.sources,
    status = CASE WHEN area_ports.admin_reviewed = 1 THEN area_ports.status ELSE excluded.status END,
    updated_at = excluded.updated_at
`);
// Upserts one discovered/confirmed port candidate. `sources` is an array of
// strings (e.g. ['berths'] or ['gfw','locode']), stored as JSON. Re-running
// discovery for the same area+name never resurrects an admin-rejected port
// back to 'review'/'confirmed', nor downgrades an admin-confirmed one — see
// the ON CONFLICT clause above (admin_reviewed gates it).
function upsertAreaPort({ area_key, name, lat, lon, sources, status }) {
  const now = new Date().toISOString();
  upsertAreaPortStmt.run(area_key, name, lat, lon, JSON.stringify(sources), status, now, now);
}

function getAreaPorts(areaKey) {
  return db.prepare('SELECT * FROM area_ports WHERE area_key = ? ORDER BY name').all(areaKey)
    .map((r) => ({ ...r, sources: JSON.parse(r.sources) }));
}

function getConfirmedAreaPorts(areaKey) {
  return db.prepare("SELECT * FROM area_ports WHERE area_key = ? AND status = 'confirmed' ORDER BY name").all(areaKey)
    .map((r) => ({ ...r, sources: JSON.parse(r.sources) }));
}

function countAreaPorts(areaKey) {
  return db.prepare('SELECT COUNT(*) AS n FROM area_ports WHERE area_key = ?').get(areaKey).n;
}

const setAreaPortDecisionStmt = db.prepare(
  "UPDATE area_ports SET status = ?, admin_reviewed = 1, updated_at = ? WHERE id = ?"
);
function setAreaPortDecision(id, status) {
  setAreaPortDecisionStmt.run(status, new Date().toISOString(), id);
}

const setAreaPortMstPidStmt = db.prepare('UPDATE area_ports SET mst_pid = ?, updated_at = ? WHERE id = ?');
function setAreaPortMstPid(id, pid) {
  setAreaPortMstPidStmt.run(pid, new Date().toISOString(), id);
}
```

Add all six to the file's final `module.exports = { ... }` block.

- [ ] **Step 3: Add `area_ports` to `BACKUP_TABLES`**

In `db.js:3404`, append `'area_ports'` to the array.

- [ ] **Step 4: Verify with a throwaway script**

Create `dev-fixtures/verify-area-ports.js`:

```js
const db = require('../src/db');
db.upsertAreaPort({ area_key: 'toscana', name: 'Test Port', lat: 43.5, lon: 10.3, sources: ['berths'], status: 'confirmed' });
console.log('getAreaPorts:', db.getAreaPorts('toscana'));
const id = db.getAreaPorts('toscana')[0].id;
db.setAreaPortDecision(id, 'rejected');
console.log('after reject:', db.getAreaPorts('toscana'));
// re-upsert with a different status — admin_reviewed must protect the rejection:
db.upsertAreaPort({ area_key: 'toscana', name: 'Test Port', lat: 43.5, lon: 10.3, sources: ['berths','gfw'], status: 'confirmed' });
console.log('after re-discovery (must STILL be rejected):', db.getAreaPorts('toscana'));
console.log('countAreaPorts:', db.countAreaPorts('toscana'));
```

Run: `node dev-fixtures/verify-area-ports.js`
Expected: the final `getAreaPorts` call shows `status: 'rejected'` still (not reverted to `'confirmed'` by the second upsert) — confirms the `admin_reviewed` guard works. Add a one-line `dev-fixtures/README.md` entry describing this script and that it's safe to re-run (idempotent upsert).

- [ ] **Step 5: Lint and commit**

Run: `npm run lint`
Expected: no new errors.

```bash
git add src/db.js dev-fixtures/verify-area-ports.js dev-fixtures/README.md
git commit -m "feat(db): tabella area_ports per la scoperta porti per-area"
```

---

### Task 2: UN/LOCODE — stop discarding the port-function classification

**Files:**
- Modify: `scripts/build-locode.js`
- Create: `data/locode-ports.json` (generated by the script, then committed)

**Interfaces:**
- Produces: `data/locode-ports.json` — a JSON array of UN/LOCODE codes (e.g. `["ITLIV", "ITGOA", ...]`) that carry the "port" function classification (UN/LOCODE `Function` field, digit `1` at position 0 = "port, maritime"). Consumed by Task 7's cascade.

- [ ] **Step 1: Install the source package temporarily**

```bash
cd /Users/marco/projects/tracker-porti
npm install --no-save un-locode
```

- [ ] **Step 2: Inspect the raw `Function` field shape** (verify before coding against it)

```bash
node -e '
const data = require("./node_modules/un-locode/data/code-list.json");
const vals = Object.values(data);
const livorno = vals.find(e => e.Country === "IT" && e.Location === "LIV");
console.log(JSON.stringify(livorno, null, 2));
console.log("Function values sample:", [...new Set(vals.slice(0,500).map(e => e.Function))].slice(0,20));
'
```

Expected: an entry with a `Function` field, a short digit string (per the UN/LOCODE spec, position 0 = port/maritime, `1` or `0`/blank/`-`). Confirm the exact character used for "yes" (UN/LOCODE convention is `1` at index 0, `0` or blank otherwise) before writing the filter — **do not** assume without checking this output.

- [ ] **Step 3: Extend the script**

In `scripts/build-locode.js`, after the existing `lookup`/`coords` loop (the `for (const entry of Object.values(data))` block), add a third pass building the ports list, using whatever character Step 2 confirmed marks "port" (written here assuming `'1'` at index 0 per the standard — adjust if Step 2 showed otherwise):

```js
const ports = [];
for (const entry of Object.values(data)) {
  const code = entry.Country + entry.Location;
  if (code.length !== 5 || !entry.Name) continue;
  if ((entry.Function || '')[0] === '1') ports.push(code);
}
const portsPath = path.join(__dirname, '../data/locode-ports.json');
fs.writeFileSync(portsPath, JSON.stringify(ports));
console.log(`Written ${ports.length} port codes → ${portsPath} (${(fs.statSync(portsPath).size / 1024).toFixed(0)} KB)`);
```

- [ ] **Step 4: Run it and inspect the count**

```bash
node scripts/build-locode.js
```

Expected: three "Written ..." lines now (names, coords, ports). Sanity-check the port count is a plausible fraction of the total (a few thousand, not near-zero and not near the full ~useless-if-everything-matches count) — e.g.:

```bash
node -e 'console.log(require("./data/locode-ports.json").length, "of", Object.keys(require("./data/locode.json")).length)'
```

- [ ] **Step 5: Remove the dev-only package, check `.gitignore` exception**

```bash
npm uninstall un-locode
git check-ignore -v data/locode-ports.json || echo "not ignored, good"
```

If `git check-ignore` prints a match (meaning `data/*` swallows it), add `!data/locode-ports.json` to `.gitignore` next to the existing `!data/locode.json`/`!data/locode-coords.json` exceptions.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-locode.js data/locode-ports.json package.json package-lock.json .gitignore
git commit -m "feat(data): classificazione porto UN/LOCODE (Function), locode-ports.json"
```

---

### Task 3: World Port Index bundle

**Files:**
- Create: `scripts/build-wpi.js`
- Create: `data/wpi.json` (generated, committed)

**Interfaces:**
- Produces: `data/wpi.json` — `[{name, lat, lon}, ...]`. Consumed by Task 7's cascade.

⚠️ This task starts with a verification spike — the exact NGA download URL/format is not confirmed. Do not write the parser before Step 1 confirms the real shape.

- [ ] **Step 1: Verify the current public download**

```bash
node -e '
const https = require("https");
https.get("https://msi.nga.mil/api/publications/world-port-index?output=json", { headers: { "User-Agent": "curl/8.0", Accept: "*/*" } }, (res) => {
  console.log("STATUS", res.statusCode, res.headers["content-type"]);
  let body = "";
  res.on("data", (c) => body += c);
  res.on("end", () => console.log(body.slice(0, 500)));
}).on("error", (e) => console.log("ERR", e.message));
'
```

If that URL 404s (likely — it is a guess), search NGA's MSI site structure: fetch `https://msi.nga.mil/Publications/WPI` and grep the HTML for a real download link (`.json`, `.csv`, `.xlsx`, or a shapefile `.zip`) — e.g.:

```bash
node -e '
const https = require("https");
https.get("https://msi.nga.mil/Publications/WPI", { headers: { "User-Agent": "curl/8.0", Accept: "*/*" } }, (res) => {
  let body = "";
  res.on("data", (c) => body += c);
  res.on("end", () => {
    const links = [...body.matchAll(/href="([^"]+\.(json|csv|xlsx|zip))"/gi)].map(m => m[1]);
    console.log([...new Set(links)]);
  });
}).on("error", (e) => console.log("ERR", e.message));
'
```

Record the real, working URL and format found. If NGA's own site requires JS/a form POST to export and no plain GET link is discoverable within a reasonable effort, fall back to skipping this source for v1 (proceed with the 3-source cascade: GFW, LOCODE, VF — update `docs/superpowers/specs/2026-08-16-per-area-scrape-recovery-design.md`'s "da verificare" note with what was found, and tell the user directly rather than silently reducing the design) — do not fabricate a fake bundle.

- [ ] **Step 2: Write the generator against the confirmed format**

Once Step 1 has a working URL/format, write `scripts/build-wpi.js` following the exact same structure as `scripts/build-locode.js` (fetch or read the downloaded raw file → map to `{name, lat, lon}` → `fs.writeFileSync('../data/wpi.json', ...)`, with a console.log summary of count + file size). The precise field-mapping code depends on Step 1's findings and must be written against the real confirmed shape, not guessed here.

- [ ] **Step 3: Run it, sanity-check, `.gitignore` exception, commit**

```bash
node scripts/build-wpi.js
node -e 'const w = require("./data/wpi.json"); console.log(w.length, w[0])'
git check-ignore -v data/wpi.json || echo "not ignored, good"
```

Add `!data/wpi.json` to `.gitignore` if needed (same pattern as Task 2 Step 5).

```bash
git add scripts/build-wpi.js data/wpi.json .gitignore
git commit -m "feat(data): bundle World Port Index (data/wpi.json)"
```

---

### Task 4: Global Fishing Watch anchorages source

**Files:**
- Modify: `src/services/gfw.js`

**Interfaces:**
- Produces: `async function getAnchoragesInBbox(sw, ne)` → `Promise<{name, lat, lon}[]>`, exported from `gfw.js`. Consumed by Task 7's cascade.

⚠️ This task also starts with a verification spike — GFW's existing integration in this repo (`src/services/gfw.js`) is entirely **per-vessel** (`GET /vessels/search`, per-vessel events) using `GFW_TOKEN`. A bbox/area anchorages lookup is a different API surface not yet exercised here.

- [ ] **Step 1: Verify GFW's anchorages API surface**

```bash
node -e '
const { GFW_TOKEN } = require("/Users/marco/projects/tracker-porti/src/config");
const https = require("https");
if (!GFW_TOKEN) { console.log("no GLOBAL_FISHING_WATCH_TOKEN configured locally — check local.properties"); process.exit(0); }
https.get("https://gateway.api.globalfishingwatch.org/v3/datasets/public-anchorages:latest", {
  headers: { Authorization: `Bearer ${GFW_TOKEN}`, Accept: "application/json" },
}, (res) => {
  console.log("STATUS", res.statusCode);
  let body = "";
  res.on("data", (c) => body += c);
  res.on("end", () => console.log(body.slice(0, 800)));
}).on("error", (e) => console.log("ERR", e.message));
'
```

This URL is a best guess based on GFW's public dataset-naming convention (`public-anchorages`) — it may 404 or require a different dataset-download flow (GFW sometimes serves reference datasets as a direct CSV/GeoJSON download from their open-data portal rather than the authenticated Events API). If it 404s, check `https://globalfishingwatch.org/data-download/datasets/public-anchorages` for a plain download link, same technique as Task 3 Step 1.

- [ ] **Step 2: Write `getAnchoragesInBbox` against the confirmed shape**

Once Step 1 confirms the real access method, add to `src/services/gfw.js` (near the existing `fetchGfw`-style helper used by the per-vessel functions — reuse the same low-level HTTP helper, don't duplicate it):

```js
/** Anchorage points from GFW's public reference dataset, filtered to a bbox.
 *  Returns [] (not throw) if GFW_TOKEN is unset or the dataset is unreachable —
 *  this is one candidate source among several in the port-discovery cascade,
 *  never a hard dependency. */
async function getAnchoragesInBbox(sw, ne) {
  if (!GFW_TOKEN) return [];
  try {
    // Exact request built from Task 4 Step 1's confirmed endpoint/shape.
  } catch {
    return [];
  }
}
```

The exact request body/parsing depends on Step 1's findings — write it against the real response fields (name/lat/lon field names confirmed there), not invented ones.

- [ ] **Step 3: Verify with a throwaway script, lint, commit**

```bash
node -e '
const { getAnchoragesInBbox } = require("./src/services/gfw");
getAnchoragesInBbox([42.08597, 9.81083], [43.05081, 12.34592]).then(r => console.log(r.length, r.slice(0,3)));
'
npm run lint
git add src/services/gfw.js
git commit -m "feat(gfw): ancoraggi GFW per bbox (scoperta porti)"
```

---

### Task 5: VesselFinder ports scraper

**Files:**
- Create: `src/services/scrapers/vesselfinder-ports.js`

**Interfaces:**
- Produces: `async function searchVesselFinderPorts(name)` → `Promise<{name, lat, lon}[]>` (throws on network failure, like every other scraper in this codebase — the caller in Task 7 catches it). Consumed by Task 7's cascade.

⚠️ Verification spike first — only `/ports` responding (39KB) was confirmed earlier; the actual list/search structure was not parsed.

- [ ] **Step 1: Inspect the real page structure**

```bash
node -e '
const { fetchHttp } = require("/Users/marco/projects/tracker-porti/src/services/scrapers/http.js");
(async () => {
  const html = await fetchHttp("https://www.vesselfinder.com/ports");
  require("fs").writeFileSync("/tmp/vf-ports.html", html);
  console.log("LEN", html.length);
  const links = [...html.matchAll(/href="(\/ports\/[^"]+)"/g)].map(m => m[1]);
  console.log("SAMPLE LINKS:", [...new Set(links)].slice(0, 15));
})();
'
```

If `/ports` is a browse index (like MyShipTracking's was), also check for a search variant, following the same technique already used in this conversation for MST (`?name=`/`?search=` query param guesses, then grep the result for a matching port link and its embedded coordinates).

- [ ] **Step 2: Write the scraper against the confirmed structure**

```js
'use strict';

const { fetchHttp, stripHtml } = require('./http');

const VF_PORT_SEARCH_URL = (name) => `https://www.vesselfinder.com/ports?name=${encodeURIComponent(name)}`;

/**
 * Search VesselFinder's ports index for `name`. Returns [] on no match, throws
 * on network/parse failure (negative-cached by the caller like every other
 * scraper here). Exact row parsing depends on Task 5 Step 1's findings.
 */
async function searchVesselFinderPorts(name) {
  const html = await fetchHttp(VF_PORT_SEARCH_URL(name));
  // Row/link extraction implemented against the real markup found in Step 1.
  return [];
}

module.exports = { searchVesselFinderPorts };
```

Replace the placeholder `return []` with real regex-based extraction (name + coordinates, following the same hand-rolled-regex convention as `scrapers/myshiptracking.js`) once Step 1's markup is in hand — this file must not ship with a stub return.

- [ ] **Step 3: Verify, lint, commit**

```bash
node -e '
const { searchVesselFinderPorts } = require("./src/services/scrapers/vesselfinder-ports");
searchVesselFinderPorts("Livorno").then(r => console.log(r));
'
npm run lint
git add src/services/scrapers/vesselfinder-ports.js
git commit -m "feat(scrapers): ricerca porti VesselFinder (scoperta porti)"
```

---

### Task 6: MyShipTracking — port search + arrivals/departures scraper

**Files:**
- Modify: `src/services/scrapers/myshiptracking.js`

**Interfaces:**
- Produces: `async function searchPort(name)` → `Promise<{name, lat, lon, pid}[]>`; `async function crawlPortArrivals(pid)` → `Promise<{mmsi, name, event, at}[]>`. Both added to the file's `module.exports`. Consumed by Task 7 (via `searchPort`, for the LOCODE/GFW/WPI-confirmed candidate → MST `pid` resolution) and by the companion scrape-recovery plan (via `crawlPortArrivals`, for new-arrival discovery).

This task is **not** a spike — the exact URLs and markup were already verified live earlier in this project's design conversation (`?search=<name>` → `/ports/port-of-<slug>-id-<pid>`, and `/ports-arrivals-departures/?pid=<pid>` with a `<tbody class="table-body">` of `<tr>` rows each containing an event type, a timestamp, and a `<a href="/vessels/<slug>-mmsi-<mmsi>-imo-<imo>">NAME</a>` link) — reuse those exact patterns.

- [ ] **Step 1: Add `searchPort`**

```js
const MST_PORT_SEARCH_URL = (name) => `https://www.myshiptracking.com/ports?search=${encodeURIComponent(name)}`;

/** Search MyShipTracking's port catalog by name. Returns the matches found
 *  (each with its own `pid`, extractable from the result link
 *  `/ports/port-of-<slug>-in-<cc>-<country>-id-<pid>`) — empty array if none. */
async function searchPort(name) {
  const html = await fetchHttp(MST_PORT_SEARCH_URL(name));
  const links = [...html.matchAll(/href="\/ports\/([a-zA-Z0-9_-]+)-id-(\d+)"/g)];
  return links.map(([, slug, pid]) => ({
    name: slug.replace(/^(port|anchorage)-of-/, '').replace(/-in-[a-z]{2}-.*$/, '').replace(/-/g, ' '),
    pid,
  }));
}
```

Note this returns `{name, pid}` without coordinates — resolving a candidate's exact lat/lon (to verify it falls in the target bbox, per the spec's anti-false-positive step) requires fetching the port detail page `/ports/<slug>-id-<pid>` and extracting the `lat=`/`lng=` pair embedded in its inline `contributorMap.php` AJAX call (same pattern already found for Livorno: `lat=43.55760&lng=10.29930`). Add a second small helper:

```js
async function getPortCoords(slug, pid) {
  const html = await fetchHttp(`https://www.myshiptracking.com/ports/${slug}-id-${pid}`);
  const m = html.match(/lat=([\d.]+)&lng=([\d.]+)/);
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}
```

- [ ] **Step 2: Add `crawlPortArrivals`**

```js
const MST_PORT_ARRIVALS_URL = (pid) => `https://www.myshiptracking.com/ports-arrivals-departures/?pid=${encodeURIComponent(pid)}`;

/** Recent arrival/departure events for a port (by MST `pid`). Each entry has
 *  the ship name+mmsi (parsed from the vessel link), the event type, and the
 *  event timestamp (site-local, not corrected — same caveat as other MST
 *  timestamps elsewhere in this codebase). Throws on an empty/unparseable
 *  page (negative-cached by the caller), never returns null. */
async function crawlPortArrivals(pid) {
  const html = await fetchHttp(MST_PORT_ARRIVALS_URL(pid));
  const rows = [...html.matchAll(
    /<td[^>]*>(Arrival|Departure)<\/td>\s*<td[^>]*>([^<]*<b>([^<]*)<\/b>)<\/td>[\s\S]*?<a href="\/vessels\/[a-zA-Z0-9-]+-mmsi-(\d+)-imo-[^"]*">([^<]+)<\/a>/g
  )];
  if (!rows.length) throw new Error('MyShipTracking: nessun dato arrivi/partenze (porto sconosciuto o pagina cambiata)');
  return rows.map(([, event, , time, mmsi, name]) => ({
    mmsi: Number(mmsi),
    name: stripHtml(name).trim(),
    event: event.toLowerCase(),
    at: time.trim(),
  }));
}
```

- [ ] **Step 3: Update exports**

```js
module.exports = { crawlMyshiptracking, searchPort, getPortCoords, crawlPortArrivals };
```

- [ ] **Step 4: Verify against the real site**

```bash
node -e '
const { searchPort, getPortCoords, crawlPortArrivals } = require("./src/services/scrapers/myshiptracking");
(async () => {
  const matches = await searchPort("livorno");
  console.log("search:", matches);
  if (matches.length) {
    const coords = await getPortCoords(matches[0].name.replace(/ /g, "-"), matches[0].pid);
    console.log("coords:", coords);
    const arrivals = await crawlPortArrivals(matches[0].pid);
    console.log("arrivals sample:", arrivals.slice(0, 5));
  }
})();
'
```

Expected: `search` returns at least one match with a numeric `pid`; `coords` returns `{lat, lon}` close to Livorno's real position (43.5x, 10.3x); `arrivals` returns a non-empty array of `{mmsi, name, event, at}`. If the regex in Step 2 doesn't match (site markup drifted since this was checked), adjust it against the real fetched HTML (save it to a temp file and inspect, same technique used earlier in this conversation) — do not ship a regex that returns an empty array silently.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/services/scrapers/myshiptracking.js
git commit -m "feat(scrapers): ricerca porto e arrivi/partenze MyShipTracking"
```

---

### Task 7: Proximity clustering + discovery orchestrator

**Files:**
- Create: `src/services/port-discovery.js`

**Interfaces:**
- Consumes: `db.getBerths(areaKey)`, `db.upsertAreaPort(...)`, `db.getConfirmedAreaPorts(areaKey)`, `db.setAreaPortMstPid(id, pid)` (Task 1); `data/wpi.json`, `data/locode.json`, `data/locode-coords.json`, `data/locode-ports.json` (Tasks 2-3); `gfw.getAnchoragesInBbox(sw, ne)` (Task 4); `vesselfinderPorts.searchVesselFinderPorts(name)` (Task 5); `mst.searchPort(name)`, `mst.getPortCoords(slug, pid)` (Task 6); `config.BBOX_PRESETS[areaKey].box[0]` → `[[swLat,swLon],[neLat,neLon]]`.
- Produces: `async function discoverPortsForArea(areaKey)` → `Promise<void>` (persists via `db.upsertAreaPort`, never returns candidates directly — callers re-read via `db.getAreaPorts`); `async function resolveMstPidForConfirmedPorts(areaKey)` → `Promise<void>` (lazy `mst_pid` resolution, called after discovery).

- [ ] **Step 1: Write the haversine + clustering helper**

```js
'use strict';

const db = require('../db');
const { BBOX_PRESETS } = require('../config');
const gfw = require('./gfw');
const { searchVesselFinderPorts } = require('./scrapers/vesselfinder-ports');
const mst = require('./scrapers/myshiptracking');
const wpi = require('../../data/wpi.json');
const locodeNames = require('../../data/locode.json');
const locodeCoords = require('../../data/locode-coords.json');
const locodePortCodes = new Set(require('../../data/locode-ports.json'));

const EARTH_R_KM = 6371;
function haversineKm(a, b) {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.sqrt(h));
}

const CLUSTER_RADIUS_KM = 4;

/** Group candidate points from possibly-different sources into clusters when
 *  they're within CLUSTER_RADIUS_KM of each other. Each output cluster keeps
 *  the first-seen name/coords and the de-duplicated list of contributing
 *  source tags. */
function clusterCandidates(candidates) {
  const clusters = [];
  for (const c of candidates) {
    const hit = clusters.find((cl) => haversineKm(cl, c) <= CLUSTER_RADIUS_KM);
    if (hit) {
      if (!hit.sources.includes(c.source)) hit.sources.push(c.source);
    } else {
      clusters.push({ name: c.name, lat: c.lat, lon: c.lon, sources: [c.source] });
    }
  }
  return clusters;
}

module.exports = { clusterCandidates, haversineKm, discoverPortsForArea: null, resolveMstPidForConfirmedPorts: null };
```

(the last line's `null`s are placeholders overwritten by Steps 3-4 below — remove them once those functions exist; this step's own deliverable is just the clustering math, verified in isolation next.)

- [ ] **Step 2: Verify clustering in isolation**

```bash
node -e '
const { clusterCandidates } = require("./src/services/port-discovery");
const r = clusterCandidates([
  { name: "Livorno Port", lat: 43.5576, lon: 10.2993, source: "gfw" },
  { name: "Livorno", lat: 43.55, lon: 10.3167, source: "locode" },
  { name: "Piombino", lat: 42.9257, lon: 10.5267, source: "wpi" },
]);
console.log(JSON.stringify(r, null, 2));
'
```

Expected: 2 clusters — Livorno's two points merge (they are ~2km apart, under the 4km radius) with `sources: ["gfw","locode"]`; Piombino stays separate with `sources: ["wpi"]`.

- [ ] **Step 3: Write the local-source lookups (LOCODE + WPI, bbox-filtered, no network)**

Add to `port-discovery.js`:

```js
function bboxOf(areaKey) {
  const [[swLat, swLon], [neLat, neLon]] = BBOX_PRESETS[areaKey].box[0];
  return { swLat, swLon, neLat, neLon };
}
function inBbox(lat, lon, box) {
  return lat >= box.swLat && lat <= box.neLat && lon >= box.swLon && lon <= box.neLon;
}

function localocodeCandidates(box) {
  const out = [];
  for (const code of locodePortCodes) {
    const c = locodeCoords[code];
    if (!c) continue;
    const [lat, lon] = c;
    if (inBbox(lat, lon, box)) out.push({ name: locodeNames[code], lat, lon, source: 'locode' });
  }
  return out;
}

function wpiCandidates(box) {
  return wpi.filter((p) => inBbox(p.lat, p.lon, box)).map((p) => ({ ...p, source: 'wpi' }));
}
```

- [ ] **Step 4: Write `discoverPortsForArea` (berths-first, else cascade)**

```js
/** Discover and persist port candidates for `areaKey`. If the area already
 *  has real observed berth clusters, those ARE the ground truth (no external
 *  source consulted, auto-confirmed). Otherwise runs the 4-source cascade,
 *  clusters by proximity, and persists each cluster at 'confirmed' (>=2
 *  sources) or 'review' (1 source) — see db.upsertAreaPort's admin_reviewed
 *  guard for why re-running this is always safe. */
async function discoverPortsForArea(areaKey) {
  const berths = db.getBerths(areaKey);
  if (berths.length) {
    for (const b of berths) {
      db.upsertAreaPort({
        area_key: areaKey,
        name: b.name || `Banchina #${b.id}`,
        lat: b.centroid_lat,
        lon: b.centroid_lon,
        sources: ['berths'],
        status: 'confirmed',
      });
    }
    return;
  }

  const box = bboxOf(areaKey);
  const locodeCands = localocodeCandidates(box);
  const wpiCands = wpiCandidates(box);

  let gfwCands = [];
  try {
    gfwCands = (await gfw.getAnchoragesInBbox([box.swLat, box.swLon], [box.neLat, box.neLon]))
      .map((p) => ({ ...p, source: 'gfw' }));
  } catch { /* best-effort source */ }

  let vfCands = [];
  for (const cand of [...locodeCands, ...wpiCands].slice(0, 20)) {
    try {
      const matches = await searchVesselFinderPorts(cand.name);
      vfCands.push(...matches.filter((m) => inBbox(m.lat, m.lon, box)).map((m) => ({ ...m, source: 'vf' })));
    } catch { /* best-effort, one candidate's VF lookup failing doesn't block the rest */ }
  }

  const clusters = clusterCandidates([...gfwCands, ...wpiCands, ...locodeCands, ...vfCands]);
  for (const c of clusters) {
    db.upsertAreaPort({
      area_key: areaKey,
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      sources: c.sources,
      status: c.sources.length >= 2 ? 'confirmed' : 'review',
    });
  }
}
```

- [ ] **Step 5: Write `resolveMstPidForConfirmedPorts` (lazy, confirmed-only)**

```js
/** Resolve MST's own `pid` for every confirmed port of `areaKey` that doesn't
 *  have one yet — needed only by the companion scrape-recovery plan's
 *  new-arrival discovery. Never runs for 'review'/'rejected' ports (avoids
 *  wasting a request on a candidate that might get rejected). */
async function resolveMstPidForConfirmedPorts(areaKey) {
  for (const port of db.getConfirmedAreaPorts(areaKey)) {
    if (port.mst_pid) continue;
    try {
      const matches = await mst.searchPort(port.name);
      for (const m of matches) {
        const coords = await mst.getPortCoords(m.name.replace(/ /g, '-'), m.pid);
        if (coords && haversineKm(coords, port) <= CLUSTER_RADIUS_KM) {
          db.setAreaPortMstPid(port.id, m.pid);
          break;
        }
      }
    } catch { /* best-effort; no MST pid means no new-arrival discovery for this port, position refresh unaffected */ }
  }
}
```

- [ ] **Step 6: Fix the module.exports and verify end-to-end**

```js
module.exports = { clusterCandidates, haversineKm, discoverPortsForArea, resolveMstPidForConfirmedPorts };
```

```bash
node -e '
const pd = require("./src/services/port-discovery");
pd.discoverPortsForArea("toscana").then(async () => {
  const db = require("./src/db");
  console.log(db.getAreaPorts("toscana"));
  await pd.resolveMstPidForConfirmedPorts("toscana");
  console.log(db.getConfirmedAreaPorts("toscana"));
});
'
```

Expected: at least one port row for the Toscana bbox (Livorno, Piombino, or similar), each with a plausible `sources` array; confirmed ports get an `mst_pid` after the second call (unless MST search genuinely finds nothing for that name — acceptable, `mst_pid` stays null and new-arrival discovery simply skips that port later).

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add src/services/port-discovery.js
git commit -m "feat(port-discovery): cascata multi-fonte + clustering per prossimità"
```

---

### Task 8: Routes — discover, list, confirm, reject

**Files:**
- Modify: `src/routes/areas.js`

**Interfaces:**
- Consumes: `portDiscovery.discoverPortsForArea(areaKey)`, `portDiscovery.resolveMstPidForConfirmedPorts(areaKey)` (Task 7); `db.getAreaPorts(areaKey)`, `db.setAreaPortDecision(id, status)` (Task 1).
- Produces: `POST /api/areas/:key/discover-ports`, `GET /api/areas/:key/ports`, `POST /api/areas/:key/ports/:id/confirm`, `POST /api/areas/:key/ports/:id/reject` — all `requireAdmin`.

- [ ] **Step 1: Add the routes**

```js
const portDiscovery = require('../services/port-discovery');

router.get('/areas/:key/ports', requireAdmin, (req, res) => {
  res.json({ ports: db.getAreaPorts(req.params.key) });
});

router.post('/areas/:key/discover-ports', requireAdmin, async (req, res) => {
  try {
    await portDiscovery.discoverPortsForArea(req.params.key);
    await portDiscovery.resolveMstPidForConfirmedPorts(req.params.key);
    res.json({ ok: true, ports: db.getAreaPorts(req.params.key) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/areas/:key/ports/:id/confirm', requireAdmin, (req, res) => {
  db.setAreaPortDecision(Number(req.params.id), 'confirmed');
  res.json({ ok: true });
});

router.post('/areas/:key/ports/:id/reject', requireAdmin, (req, res) => {
  db.setAreaPortDecision(Number(req.params.id), 'rejected');
  res.json({ ok: true });
});
```

- [ ] **Step 2: Wire auto-trigger on area creation**

In the existing `POST /areas` handler (`areas.js:108-138`), right after `if (autostart !== false) stream.startStream(area.key);`, add a fire-and-forget call (not awaited — creating an area must not block on external scraping):

```js
portDiscovery.discoverPortsForArea(area.key)
  .then(() => portDiscovery.resolveMstPidForConfirmedPorts(area.key))
  .catch((e) => appLog.warn('AREE', `Scoperta porti fallita per ${area.key}: ${e.message}`));
```

- [ ] **Step 3: Verify with a running server**

```bash
npm start &
sleep 3
curl -s -X POST http://localhost:3000/api/areas/toscana/discover-ports -H "Cookie: <admin session cookie>" | head -c 500
curl -s http://localhost:3000/api/areas/toscana/ports -H "Cookie: <admin session cookie>" | head -c 500
kill %1
```

(Replace the cookie placeholder with a real logged-in admin session cookie obtained by logging in through the browser dev tools — this repo's session-auth has no API-key bypass for admin routes, so a manual login is required to get one.) Expected: both calls return `200` with the ports discovered in Task 7's verification.

- [ ] **Step 4: Lint and commit**

```bash
npm run lint
git add src/routes/areas.js
git commit -m "feat(areas): rotte scoperta/conferma porti + trigger su creazione area"
```

---

### Task 9: Boot-time backfill for pre-existing areas

**Files:**
- Modify: `src/server.js`

**Interfaces:**
- Consumes: `db.getActiveAreaKeys()` (already used elsewhere in `server.js`/`ais-stream.js`), `db.countAreaPorts(areaKey)` (Task 1), `portDiscovery.discoverPortsForArea`/`resolveMstPidForConfirmedPorts` (Task 7).

- [ ] **Step 1: Add the spaced backfill queue**

Near the other boot-time `setTimeout`/`setInterval` scheduling in `server.js` (e.g. next to `sweepOrphans`/`sweepHeatmap`):

```js
const portDiscovery = require('./services/port-discovery');

// One-time backfill for areas that predate the port-discovery feature: queued
// one area at a time (not parallel) so a deploy with many existing areas
// doesn't burst external requests (GFW/VesselFinder) all at once.
async function backfillAreaPorts() {
  const keys = db.getActiveAreaKeys();
  for (const key of keys) {
    if (db.countAreaPorts(key) > 0) continue;
    try {
      await portDiscovery.discoverPortsForArea(key);
      await portDiscovery.resolveMstPidForConfirmedPorts(key);
      appLog.info('AREE', `Scoperta porti (backfill) completata per ${key}`);
    } catch (e) {
      appLog.warn('AREE', `Scoperta porti (backfill) fallita per ${key}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 30 * 1000)); // spacing between areas
  }
}
setTimeout(() => backfillAreaPorts().catch(() => {}), 60 * 1000); // give boot (streams, DB) time to settle first
```

- [ ] **Step 2: Verify**

```bash
node --check src/server.js
```

Manually verify the log line appears by starting the server against a dev DB with at least one active area lacking `area_ports` rows (delete/rename the dev DB's `area_ports` rows for an area first, or use a fresh dev DB), waiting ~90s, and checking `data/db/ais_data.db` (or the app log viewer) for the "Scoperta porti (backfill) completata" line.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat(server): backfill scoperta porti in coda per aree già esistenti"
```

---

### Task 10: UI — Aree screen ports list + confirm/reject + manual refresh

**Files:**
- Modify: `public/js/areas.js`, `public/index.html`, `public/css/style.css`, `public/locales/it.js`, `public/locales/en.js`

**Interfaces:**
- Consumes: `GET /api/areas/:key/ports`, `POST /api/areas/:key/discover-ports`, `POST /api/areas/:key/ports/:id/confirm`, `POST /api/areas/:key/ports/:id/reject` (Task 8).

- [ ] **Step 1: Add i18n keys**

In both `public/locales/it.js` and `en.js`, near the existing `sidebar.areas`/area-related keys:

```js
'areas.ports.title': 'Porti', // en: 'Ports'
'areas.ports.refresh': 'Cerca porti ora', // en: 'Search ports now'
'areas.ports.empty': 'Nessun porto trovato per quest\'area.', // en: 'No ports found for this area.'
'areas.ports.confirmed': 'Confermato', // en: 'Confirmed'
'areas.ports.review': 'Da rivedere', // en: 'Needs review'
'areas.ports.rejected': 'Rifiutato', // en: 'Rejected'
'areas.ports.confirm': 'Conferma', // en: 'Confirm'
'areas.ports.reject': 'Rifiuta', // en: 'Reject'
'areas.ports.sources': 'Fonti: {list}', // en: 'Sources: {list}'
```

(write the actual EN value in `en.js`, not the inline comment shown here — the comment is a translation hint for whoever writes both files, per this codebase's convention of the two locale files staying at identical key positions.)

- [ ] **Step 2: Add markup**

In `public/index.html`, inside the per-area row template used by the Aree screen (find the existing area-row template — it already renders name/bbox/monitoring toggle), add a collapsible block:

```html
<div class="area-ports" data-area-key="">
  <button class="btn btn-sm btn-secondary area-ports-refresh" data-i18n="areas.ports.refresh">Cerca porti ora</button>
  <ul class="area-ports-list"></ul>
</div>
```

- [ ] **Step 3: Add render + action logic**

In `public/js/areas.js`, add (following the existing module's conventions for `api()` calls and `t()` i18n — mirror how the rest of that file already renders/re-fetches after an action):

```js
async function loadAreaPorts(areaKey, listEl) {
  const { ports } = await api(`/api/areas/${encodeURIComponent(areaKey)}/ports`);
  listEl.innerHTML = ports.length
    ? ports.map((p) => `
        <li data-id="${p.id}">
          <strong>${escHtml(p.name)}</strong>
          <span class="badge ${p.status}">${t(`areas.ports.${p.status}`)}</span>
          <small>${t('areas.ports.sources', { list: p.sources.join(', ') })}</small>
          ${p.status === 'review' ? `
            <button class="btn btn-sm area-port-confirm" data-id="${p.id}">${t('areas.ports.confirm')}</button>
            <button class="btn btn-sm btn-clear area-port-reject" data-id="${p.id}">${t('areas.ports.reject')}</button>
          ` : ''}
        </li>`).join('')
    : `<li class="health-muted">${t('areas.ports.empty')}</li>`;
}

// Delegated listeners on the areas container (mirrors health.js's pattern of
// binding once on a static parent instead of per-render, since innerHTML is
// rebuilt on every refresh).
el.areasList?.addEventListener('click', async (e) => {
  const refreshBtn = e.target.closest('.area-ports-refresh');
  if (refreshBtn) {
    const container = refreshBtn.closest('.area-ports');
    await api(`/api/areas/${encodeURIComponent(container.dataset.areaKey)}/discover-ports`, 'POST');
    await loadAreaPorts(container.dataset.areaKey, container.querySelector('.area-ports-list'));
    return;
  }
  const confirmBtn = e.target.closest('.area-port-confirm');
  const rejectBtn = e.target.closest('.area-port-reject');
  if (confirmBtn || rejectBtn) {
    const li = (confirmBtn || rejectBtn).closest('li');
    const container = (confirmBtn || rejectBtn).closest('.area-ports');
    const action = confirmBtn ? 'confirm' : 'reject';
    await api(`/api/areas/${encodeURIComponent(container.dataset.areaKey)}/ports/${li.dataset.id}/${action}`, 'POST');
    await loadAreaPorts(container.dataset.areaKey, container.querySelector('.area-ports-list'));
  }
});
```

Wire `loadAreaPorts(areaKey, listEl)` to be called once when each area row is rendered (find the existing per-area row render function in `areas.js` and add the call there, setting `data-area-key` on the `.area-ports` element to the real area key).

- [ ] **Step 4: Add minimal CSS**

In `public/css/style.css`:

```css
.area-ports { margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border); }
.area-ports-list { list-style: none; padding: 0; margin: 0.4rem 0 0; }
.area-ports-list li { padding: 0.3rem 0; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
```

- [ ] **Step 5: Manual browser verification**

Run `npm run dev`, log in as admin, open the Aree screen, click "Cerca porti ora" on an area, confirm the list populates and confirm/reject buttons update the badge without a full page reload. Check both light and dark theme render sensibly (reuse of `.badge`/`var(--border)` should make this automatic, but eyeball it).

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add public/js/areas.js public/index.html public/css/style.css public/locales/it.js public/locales/en.js
git commit -m "feat(frontend): elenco porti per area, conferma/rifiuto, ricerca manuale"
```

---

### Task 11: Documentation sync

**Files:**
- Modify: `docs/technical/README.it.md`, `docs/technical/README.en.md`
- Modify: `docs/manuale_admin/manuale_admin.md`, `docs/manuale_admin/manuale_admin.en.md` (+ regenerate `.html`/`.pdf` for both)
- Modify: `public/sw.js` (bump `CACHE`)

- [ ] **Step 1: Technical README (both languages)**

Add a new subsection under the existing AIS/fallback area (near where the per-area-scrape-recovery companion plan will also add its own section — coordinate so they read as one coherent "Recupero dati" area rather than two disconnected blocks) describing: the 4-source cascade + berths-first shortcut, the `area_ports` table shape, the confirmation threshold (≥2 sources), the admin UI location, the boot backfill behavior, and the ⚠️ caveats recorded during Tasks 3-5 about GFW/WPI/VF real endpoints (or their removal, if Task 3/4/5 concluded a source isn't viable — the docs must reflect what was ACTUALLY implemented, not the original plan, if they diverged).

- [ ] **Step 2: Admin manual (both languages)**

In `docs/manuale_admin/manuale_admin.md` and `.en.md`, add a "Porti di un'area" / "Area ports" section near the existing Aree-screen documentation: what the list shows, what confirmed/review/rejected mean, when discovery runs automatically vs the manual button.

- [ ] **Step 3: Regenerate HTML + PDF**

```bash
cd docs/manuale_admin
pandoc manuale_admin.md -o index.html --standalone --template=template.html --toc --toc-depth=3 --metadata title="Manuale Amministratore — Tracker Porti"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf-no-header --print-to-pdf="manuale_admin.pdf" "file://$(pwd)/index.html"
pandoc manuale_admin.en.md -o index.en.html --standalone --template=template.html --toc --toc-depth=3 --metadata title="Admin Manual — Tracker Porti" --metadata en=true
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf-no-header --print-to-pdf="manuale_admin.en.pdf" "file://$(pwd)/index.en.html"
cd ../..
```

- [ ] **Step 4: Bump the service worker cache**

In `public/sw.js`, increment the `CACHE` constant by 1 from whatever its current value is (check the file — this plan doesn't assume a specific current number since the companion plan may run first or after and also bump it; **do not** double-bump if the other plan already did in the same deploy — check `git log -1 -- public/sw.js` first).

- [ ] **Step 5: Commit**

```bash
git add docs/technical/README.it.md docs/technical/README.en.md docs/manuale_admin/ public/sw.js
git commit -m "docs: documentare scoperta porti (tecnico + manuale admin, IT+EN)"
```

---

### Task 12: Backup/restore verification

**Files:** none (verification only)

- [ ] **Step 1: Take a backup under the OLD schema**

Before this plan's Task 1 is applied, on a throwaway copy of the repo at the commit just before this plan started (or using `git stash`/a second checkout), start the app once and use Settings → Backup → Export to produce a `.zip`. (If that's not practical, a synthetic equivalent is acceptable: take a backup from the **current production** database, which per this conversation's earlier work already predates `area_ports`.)

- [ ] **Step 2: Restore it into the fully-implemented new code**

With all 11 previous tasks committed, start the app fresh (or use the existing restore-from-backup admin flow), restore the old backup, and confirm:
- No error during restore.
- `area_ports` table exists and is empty (correctly not present in the old backup, correctly created fresh by `CREATE TABLE IF NOT EXISTS`).
- The app boots and the Aree screen loads without error (an area with zero `area_ports` rows renders the "Nessun porto trovato" empty state, not a crash).

- [ ] **Step 3: Report and commit if any fix was needed**

If Step 2 revealed a problem, fix it (most likely a missing `BACKUP_TABLES` entry or a restore-path assumption) and re-run Step 2 until clean. If no fix was needed, no commit here — just note it in the final task summary when reporting completion.
