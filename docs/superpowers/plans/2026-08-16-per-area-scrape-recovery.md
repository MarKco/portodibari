# Per-Area Scrape Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global on/off "modalità fallback" with a continuous, silent, per-area mechanism: each monitored area independently decides whether its own AIS data is sufficient right now; when it isn't (global AISStream outage, or a naturally AIS-poor port), that area's ships fall into the existing budget/priority/circuit-breaker-protected scraping sweep — no "mode" to enter or exit.

**Architecture:** New per-area silence tracking in `ais-stream.js` (nothing currently tracks per-area recency — it's all global). `fallback-mode.js` loses its `isActive()`/`enter()`/`exit()` gate; its sweep runs unconditionally and consults per-area silence + a per-area scope opt-in to decide which area-monitored ships (beyond the always-included followed ships) are eligible. The global outage banner (`ais-uptime.js`/`outage.js`) keeps its existing mechanism and thresholds, decoupled from scraping, only its copy changes. New-ship discovery (via the companion port-discovery plan's confirmed ports + MST arrivals pages) piggybacks on the same per-area insufficiency signal.

**Tech Stack:** Node.js, `node:sqlite`, no new dependencies, no test framework (verification via `node --check`, `npm run lint`, throwaway `dev-fixtures/` scripts, manual boot checks — matches this repo's actual conventions).

**Spec:** `docs/superpowers/specs/2026-08-16-per-area-scrape-recovery-design.md` (all sections except 4, which is the companion `docs/superpowers/plans/2026-08-16-port-discovery.md` — **that plan must be implemented and merged first**, this plan's Task 6 (new-arrival discovery) depends directly on its `area_ports`/`mst_pid`/`crawlPortArrivals` output, and Task 8 (UI) extends the same Aree-screen area row this plan's companion built).

## Global Constraints

- `AIS_FALLBACK_HOURS` / `AIS_FALLBACK_EXIT_GRACE_MIN` / `FALLBACK_MAX_REQ_PER_HOUR` / `FALLBACK_CIRCUIT_*` keep their current values and config keys — only their *role* narrows (banner-only for the first two; budget/circuit-breaker stay exactly as-is for the rest).
- No increase to the shared hourly scrape budget under any circumstance — multiple areas being simultaneously insufficient must redistribute the existing `FALLBACK_MAX_REQ_PER_HOUR`, never multiply it. Any task that touches `sweep()`'s candidate selection must preserve this.
- New columns via the existing `try { db.exec('ALTER TABLE ... ADD COLUMN ...') } catch {}` idiom; nothing is a bare destructive schema change.
- Every new/changed UI string goes in both `public/locales/it.js` and `en.js`.
- The user-facing term is **"Recupero dati via scraping"** (never "modalità fallback") in all new/changed copy — the backend file `fallback-mode.js` keeps its name (internal, not user-facing).
- Verify the exact current value of `public/sw.js`'s `CACHE` constant before bumping it (the companion port-discovery plan may have already bumped it in this same deploy — bump once total, not twice).

---

## File Structure

**New files:**
- `src/services/port-arrivals-discovery.js` — polls confirmed ports' arrivals pages, creates ship stubs for new arrivals.
- `public/js/scrape-recovery.js` — new Settings tab's render logic (global + per-area charts).

**Modified files:**
- `src/config.js` — new `AREA_SCRAPE_SILENCE_MIN`/`AREA_SCRAPE_EXIT_GRACE_MIN`; remove `state.fallbackScopeAreas` (global) and its setter.
- `src/db.js` — `areas.scrape_scope_full` column + get/set; new scrape-log query variants filtered by area (for per-area charts).
- `src/services/ais-stream.js` — per-area `lastFrameAt`, `getAreaSilenceInfo(areaKey)`, `getAllAreaSilenceInfo()`.
- `src/services/fallback-mode.js` — remove mode gate, always-on sweep, per-area candidate pool, reshaped `getStatus()`/`getEstimate()`.
- `src/services/ais-uptime.js` — banner text no longer reads a single global fallback flag.
- `src/routes/areas.js` — `POST /api/areas/:key/scrape-scope` (replaces global `/api/settings/fallback-scope`).
- `src/routes/settings.js` — remove the old global fallback-scope route; new `GET /api/settings/scrape-recovery` (aggregate + per-area data for the new tab).
- `src/routes/stream.js` — `/api/stream/status` payload's outage/fallback summary reshaped to "how many areas in recovery" instead of one global object.
- `src/server.js` — new-arrival discovery polling loop.
- `public/index.html` — remove sidebar fallback button; add new Settings tab button+panel; Aree-screen per-area scope toggle (next to the ports list from the companion plan).
- `public/js/main.js` — remove sidebar wiring; wire new tab's open/close like `health.js`'s pattern.
- `public/js/outage.js` — remove sidebar toggle line; banner text from the new per-area summary.
- `public/js/dom.js` — remove `btnFallbackNav`; add new tab/panel refs.
- `public/js/health.js` — remove `fallbackModeBlock`/`sourceHistoryChart`/`FALLBACK_SOURCE_LABEL` (moves to `scrape-recovery.js`).
- `public/js/areas.js` — add the per-area scope toggle next to the companion plan's ports list.
- `public/locales/it.js`, `en.js` — retire old global fallback keys, add new ones.
- `public/sw.js` — `CACHE` bump (last task).
- `docs/technical/README.it.md`, `.en.md`; `docs/manuale_admin/manuale_admin.md`, `.en.md` (+ regenerated `.html`/`.pdf`).

---

### Task 1: Config — new per-area thresholds, retire the global scope flag

**Files:**
- Modify: `src/config.js`

**Interfaces:**
- Produces: exported `AREA_SCRAPE_SILENCE_MIN` (number, minutes, default 10), `AREA_SCRAPE_EXIT_GRACE_MIN` (number, minutes, default 5).
- Removes: `state.fallbackScopeAreas` and `setFallbackScopeAreas()` (both currently exported/used globally) — callers move to Task 2's per-area DB column.

- [ ] **Step 1: Add the two new constants**

Next to the existing `AIS_FALLBACK_HOURS`/`AIS_FALLBACK_EXIT_GRACE_MIN` block (`config.js:305-315`):

```js
// Per-area scrape-recovery thresholds — decoupled from the global outage
// banner's AIS_OUTAGE_SILENCE_MIN/AIS_FALLBACK_HOURS above (those two stay
// banner-only). An area is "insufficient" once it's gone this long without a
// single AIS message; AREA_SCRAPE_EXIT_GRACE_MIN avoids flapping the sweep's
// candidate pool on/off if messages trickle in right at the threshold.
const AREA_SCRAPE_SILENCE_MIN = num('AREA_SCRAPE_SILENCE_MIN', 10);
const AREA_SCRAPE_EXIT_GRACE_MIN = num('AREA_SCRAPE_EXIT_GRACE_MIN', 5);
```

Add both to the final `module.exports`.

- [ ] **Step 2: Remove `state.fallbackScopeAreas` / `setFallbackScopeAreas`**

Find and delete the `fallbackScopeAreas` field from the `state` object literal, and the `setFallbackScopeAreas(bool)` function + its export. (Leave a grep-check as the verification step below — don't guess at exact line numbers here, since Task 1 of the *previous* session already touched this area of the file.)

- [ ] **Step 3: Verify no dangling references**

```bash
grep -rn "fallbackScopeAreas\|setFallbackScopeAreas" src/ public/js/
```

Expected: **zero matches** after this task (later tasks in this plan remove the remaining call sites in `fallback-mode.js`/`settings.js` — if this grep still shows hits from those files at this point in the plan, that's expected and will clear by Task 4/7; re-run this same grep again after Task 7 and expect zero then).

- [ ] **Step 4: Lint and commit**

```bash
node --check src/config.js && npm run lint
git add src/config.js
git commit -m "feat(config): soglie scrape-recovery per-area, ritiro flag scope globale"
```

---

### Task 2: DB — per-area scope column, per-area scrape-log queries

**Files:**
- Modify: `src/db.js`

**Interfaces:**
- Produces: `db.getAreaScrapeScopeFull(areaKey)` → boolean, `db.setAreaScrapeScopeFull(areaKey, bool)`; `db.getScrapeCountsHourlyForArea(areaKey, hours)` (per-area variant of the existing `getScrapeCountsHourly`, needed by the new Settings tab's per-area chart — the existing global one remains unchanged and is reused as-is for the tab's global aggregate chart).

- [ ] **Step 1: Add the `areas.scrape_scope_full` column**

Next to the existing `areas` column-add loop (`db.js:456-458`):

```js
for (const col of ['scrape_scope_full INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(`ALTER TABLE areas ADD COLUMN ${col}`); } catch { /* already exists */ }
}
```

(If the existing loop already lists `'active INTEGER NOT NULL DEFAULT 0'` as a single-element array, extend that same array with the new column rather than adding a second loop — one loop, two entries.)

- [ ] **Step 2: Add the get/set functions**

```js
function getAreaScrapeScopeFull(areaKey) {
  const row = db.prepare('SELECT scrape_scope_full FROM areas WHERE key = ?').get(areaKey);
  return !!(row && row.scrape_scope_full);
}
const setAreaScrapeScopeFullStmt = db.prepare('UPDATE areas SET scrape_scope_full = ? WHERE key = ?');
function setAreaScrapeScopeFull(areaKey, full) {
  setAreaScrapeScopeFullStmt.run(full ? 1 : 0, areaKey);
}
```

Add both to `module.exports`.

- [ ] **Step 3: Add the per-area scrape-count query**

This is a straightforward variant of the existing `getScrapeCountsHourly(hours)` (`db.js`, `scrape_log` table) — but `scrape_log` today has no `area` column (it's a global vendor-scoped log: `{id, source, ok, at}`). Two options, pick the one matching what Task 5 (fallback-mode sweep rewrite) actually writes:

If Task 5 is written to also record which area a scrape was performed for (recommended — small addition), add the column here first:

```js
for (const col of ['area TEXT']) {
  try { db.exec(`ALTER TABLE scrape_log ADD COLUMN ${col}`); } catch { /* already exists */ }
}
```

then:

```js
function getScrapeCountsHourlyForArea(areaKey, hours = 48) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  return db.prepare(`
    SELECT strftime('%Y-%m-%dT%H:00:00Z', at) AS hour, source,
           COUNT(*) AS total, SUM(ok) AS ok, SUM(1 - ok) AS failed
    FROM scrape_log WHERE area = ? AND at >= ? GROUP BY hour, source ORDER BY hour
  `).all(areaKey, cutoff);
}
```

(Mirror the exact column/aggregation shape of the existing `getScrapeCountsHourly` so `health.js`'s — now `scrape-recovery.js`'s — chart code from the earlier session can be reused almost unchanged.) Add to `module.exports`.

- [ ] **Step 4: Verify with a throwaway script**

```bash
node -e '
const db = require("./src/db");
console.log("scope before:", db.getAreaScrapeScopeFull("toscana"));
db.setAreaScrapeScopeFull("toscana", true);
console.log("scope after:", db.getAreaScrapeScopeFull("toscana"));
console.log("hourly-for-area:", db.getScrapeCountsHourlyForArea("toscana", 48));
'
```

Expected: `false` then `true`; the hourly query returns an array (empty is fine if no scrapes yet recorded with an `area` value).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/db.js
git commit -m "feat(db): scope scraping per-area, query scrape_log per-area"
```

---

### Task 3: Per-area silence tracking in `ais-stream.js`

**Files:**
- Modify: `src/services/ais-stream.js`

**Interfaces:**
- Produces: `getAreaSilenceInfo(areaKey)` → `{active, silentMs}` (mirrors the shape of the existing global `getSilenceInfo()`, minus `lastFrameAt` which stays global-only); `getAllAreaSilenceInfo()` → `{ [areaKey]: {active, silentMs} }` for every currently-active area (used by the admin tab to list all areas at once without N separate calls).

- [ ] **Step 1: Extend the per-area `Map` entry with a timestamp**

The `areas` Map today holds `{active, totalReceived}` (`ais-stream.js:55-64`, via `areaMeta(areaKey)`). Find `areaMeta()` and its initializer and add a third field:

```js
function areaMeta(areaKey) {
  if (!areas.has(areaKey)) areas.set(areaKey, { active: true, totalReceived: 0, lastFrameAt: null });
  return areas.get(areaKey);
}
```

(Adjust to match the exact current initializer shape at that line — the point is adding `lastFrameAt: null` alongside the two existing fields, not replacing them.)

- [ ] **Step 2: Stamp it at the existing per-area counting site**

At `ais-stream.js:379-380` (`const m = areas.get(areaKey); if (m) m.totalReceived++;`), add the timestamp on the same line:

```js
const m = areas.get(areaKey);
if (m) { m.totalReceived++; m.lastFrameAt = Date.now(); }
```

- [ ] **Step 3: Add the two new exported functions**

Near `getSilenceInfo()` (`ais-stream.js:538-542`):

```js
/** Per-area analog of getSilenceInfo() — silence measured against THIS area's
 *  own last message, not the shared connection's. `active` mirrors whether the
 *  area is currently subscribed at all (a never-started or stopped area has no
 *  meaningful silence reading). */
function getAreaSilenceInfo(areaKey) {
  const m = areas.get(areaKey);
  if (!m || !m.active) return { active: false, silentMs: 0 };
  const ref = m.lastFrameAt || conn.connectedAt || Date.now();
  return { active: true, silentMs: Date.now() - ref };
}

function getAllAreaSilenceInfo() {
  const out = {};
  for (const key of activeKeys()) out[key] = getAreaSilenceInfo(key);
  return out;
}
```

- [ ] **Step 4: Add both to `module.exports`**

Append `getAreaSilenceInfo, getAllAreaSilenceInfo,` to the existing export block (`ais-stream.js:628-639`).

- [ ] **Step 5: Verify with a running server**

```bash
npm start &
sleep 5
node -e '
const stream = require("./src/services/ais-stream");
console.log(stream.getAllAreaSilenceInfo());
'
kill %1
```

Expected: an object keyed by each currently-active area, each with `{active: true, silentMs: <some number>}` — a freshly-started area should show a small or moderate `silentMs` (time since boot, not yet having received a message is fine and expected immediately after start).

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add src/services/ais-stream.js
git commit -m "feat(ais-stream): silenzio AIS per-area (lastFrameAt per area, getAreaSilenceInfo)"
```

---

### Task 4: `fallback-mode.js` — always-on sweep, per-area candidate pool

**Files:**
- Modify: `src/services/fallback-mode.js`

**Interfaces:**
- Consumes: `stream.getAreaSilenceInfo(areaKey)` (Task 3), `db.getAreaScrapeScopeFull(areaKey)` (Task 2), `AREA_SCRAPE_SILENCE_MIN`/`AREA_SCRAPE_EXIT_GRACE_MIN` (Task 1), `db.getActiveAreaKeys()` (existing).
- Removes: `isActive()`, `enter()`, `exit()`, the `META_ACTIVE`/`META_SINCE` meta keys, the global `state.fallbackScopeAreas` read.
- Produces (replacing the old exports): `sweep()` (unchanged signature, now unconditional), `isAreaInRecovery(areaKey)` → boolean (used by Task 6's new-arrival discovery and Task 8's UI), `getStatus(areaKey)` → per-area status object, `getAllStatus()` → `{ [areaKey]: status }`, `getEstimate(areaKey)` (unchanged shape, now takes an area param), `tripCounts` semantics change from "this fallback session" to "since process start" (module load) — reflected in copy, not in a behavior a caller needs to know about.

- [ ] **Step 1: Replace the active/since meta-backed state with per-area hysteresis in memory**

Remove `isActive`, `enter`, `exit`, `META_ACTIVE`, `META_SINCE`. Add an in-memory per-area hysteresis tracker (in-memory is fine — same tradeoff already accepted for the circuit breaker: a restart just re-derives it within one `AREA_SCRAPE_EXIT_GRACE_MIN` window, never wrongly skips recovery):

```js
// Per-area recovery hysteresis: `since` marks when an area was first observed
// insufficient; `exitPendingSince` marks when a clean read started, so a brief
// blip right at the threshold doesn't flap the candidate pool on and off.
const areaRecovery = new Map(); // areaKey -> { since: number|null, exitPendingSince: number|null }

function areaState(areaKey) {
  if (!areaRecovery.has(areaKey)) areaRecovery.set(areaKey, { since: null, exitPendingSince: null });
  return areaRecovery.get(areaKey);
}

/** Is `areaKey` currently in scrape recovery (its own AIS silence has been
 *  sustained past AREA_SCRAPE_SILENCE_MIN, with AREA_SCRAPE_EXIT_GRACE_MIN
 *  hysteresis on the way out)? Call once per sweep per active area — see
 *  updateAreaRecovery() below, which both updates and returns this. */
function isAreaInRecovery(areaKey) {
  return !!areaState(areaKey).since;
}

function updateAreaRecovery(areaKey) {
  const info = stream.getAreaSilenceInfo(areaKey);
  const st = areaState(areaKey);
  const insufficient = info.active && info.silentMs >= AREA_SCRAPE_SILENCE_MIN * 60 * 1000;
  const now = Date.now();
  if (insufficient) {
    st.exitPendingSince = null;
    if (!st.since) st.since = now;
  } else if (st.since) {
    if (st.exitPendingSince === null) st.exitPendingSince = now;
    else if (now - st.exitPendingSince >= AREA_SCRAPE_EXIT_GRACE_MIN * 60 * 1000) {
      st.since = null;
      st.exitPendingSince = null;
    }
  }
  return isAreaInRecovery(areaKey);
}
```

Import `AREA_SCRAPE_SILENCE_MIN, AREA_SCRAPE_EXIT_GRACE_MIN` from `../config` and `stream` from `./ais-stream` at the top of the file (add to the existing `require`/destructure block).

- [ ] **Step 2: Rewrite `candidatePool()` to be per-area aware**

Replace the current `candidatePool()` (module-global, reads `state.fallbackScopeAreas`):

```js
function candidatePool() {
  const now = Date.now();
  const followed = db.getAllFollowedShips().filter((sh) => isStale(sh, now));
  const areaShips = [];
  for (const areaKey of db.getActiveAreaKeys()) {
    const inRecovery = updateAreaRecovery(areaKey);
    if (inRecovery && db.getAreaScrapeScopeFull(areaKey)) {
      areaShips.push(...db.getStaleAreaShips(FOLLOW_FRESH_MS).filter((sh) => sh.last_area === areaKey));
    }
  }
  return [...followed, ...areaShips];
}
```

Note `db.getStaleAreaShips` doesn't filter by area today (confirmed during design) — the `.filter((sh) => sh.last_area === areaKey)` above is a stopgap; if this proves too slow at scale (repeated full-table scan per active area), that's a legitimate follow-up optimization (add a `db.getStaleAreaShipsForArea(areaKey, freshMs)` SQL-side filter) but is **not required** for correctness at this stage — flag it in the PR description, don't silently skip verifying correctness first.

- [ ] **Step 3: Update `sweep()` to always run**

Remove the leading `if (!isActive()) return;` guard from `sweep()` — the rest of the function (budget check, priority sort, circuit breaker, jitter) is unchanged.

- [ ] **Step 4: Reshape `getStatus()`/`getEstimate()` to per-area**

```js
function getGlobalCircuitStatus() {
  return {
    circuits: {
      sf: { open: circuit.sf.open, until: circuit.sf.open ? new Date(circuit.sf.until).toISOString() : null },
      mst: { open: circuit.mst.open, until: circuit.mst.open ? new Date(circuit.mst.until).toISOString() : null },
    },
    tripCounts: { sf: tripCounters.sf, mst: tripCounters.mst },
  };
}

function getStatus(areaKey) {
  return {
    inRecovery: isAreaInRecovery(areaKey),
    since: areaState(areaKey).since,
    scopeFull: db.getAreaScrapeScopeFull(areaKey),
  };
}

function getAllStatus() {
  const out = {};
  for (const areaKey of db.getActiveAreaKeys()) out[areaKey] = getStatus(areaKey);
  return out;
}
```

`circuits`/`tripCounts` moved to their **own** `getGlobalCircuitStatus()` (add to `module.exports` in Step 6 below), rendered **once** in the new tab (Task 8), not duplicated inside every area's status — per the design, SF/MST ban risk is a source-level property, not per-area, so it doesn't belong nested in `getStatus(areaKey)`. `tripCounters` also loses its `enter()`-triggered reset — since there's no more `enter()`, leave it reset only at module load (process start); update the comment above its declaration to say "since process start" instead of "this session", and update the corresponding UI copy in Task 8/9 to match (`health.fallbackTripCount` copy said "in questa sessione" — becomes "dal riavvio del server" / "since the last restart").

`getEstimate(areaKey)` keeps its existing shape (`followedStaleCount`, `areaStaleCount`, `budgetPerHour`, `followOnly`/`full` comparisons, `recentHistory`) but `recentHistory` now calls `db.getScrapeCountsHourlyForArea(areaKey, 48)` (Task 2) instead of the global `db.getScrapeCountsHourly(48)` — the global version is still used separately by the new Settings tab's aggregate chart (Task 8), not by this per-area function anymore.

- [ ] **Step 5: Update `scrapeOne()` to record the area (for Task 2's per-area chart query)**

`scrapeOne(source, sh)` currently calls `db.recordScrape(source, ok)`. If Task 2 added an `area` column to `scrape_log`, thread it through: `scrapeOne(source, sh, areaKey)` → `db.recordScrape(source, ok, areaKey)` (extend `recordScrape`'s signature in `db.js` with an optional third param, defaulting to `null` for followed-ship scrapes which have no single "area"). Update `sweep()`'s call site to pass `sh.last_area` when scraping an area-ship, `null` for a followed ship.

- [ ] **Step 6: Fix `module.exports`**

```js
module.exports = { sweep, isAreaInRecovery, getStatus, getAllStatus, getGlobalCircuitStatus, getEstimate };
```

- [ ] **Step 7: Verify with a throwaway script**

```bash
node -e '
const fb = require("./src/services/fallback-mode");
console.log("all status:", fb.getAllStatus());
fb.sweep().then(() => console.log("sweep ran without throwing"));
'
```

Expected: no crash, `getAllStatus()` returns an object keyed by active areas, each with `inRecovery: false` initially (assuming AIS is currently healthy in the dev environment) and `scopeFull: false`.

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add src/services/fallback-mode.js src/db.js
git commit -m "refactor(fallback-mode): sweep sempre attivo, candidate pool per-area, niente più modalità on/off"
```

---

### Task 5: Update callers of the retired global fallback API

**Files:**
- Modify: `src/services/ais-uptime.js`
- Modify: `src/routes/settings.js`, `src/routes/areas.js`
- Modify: `src/server.js`

**Interfaces:**
- Consumes: `fallbackMode.getAllStatus()`, `fallbackMode.getStatus(areaKey)` (Task 4); `db.setAreaScrapeScopeFull` (Task 2).

- [ ] **Step 1: `ais-uptime.js` — remove `handleFallbackTransition`'s enter/exit calls**

`ais-uptime.js`'s `handleFallbackTransition(down)` currently calls `fallbackMode.enter()`/`fallbackMode.exit()` — both are gone (Task 4). Delete `handleFallbackTransition` entirely and its call sites inside `applyDown`/`applyUp` (added in the previous session) — the global outage banner's own state machine (`serviceDown`/`since`/hysteresis) is untouched, only the two lines that used to bridge into fallback-mode's old on/off switch are removed. `getOutage()` currently does `fallbackMode: fallbackMode.getStatus()` (singular, global-shaped) — replace with:

```js
function getOutage() {
  return { ...outage, streamIssues: stuckStreams(), scrapeRecovery: fallbackMode.getAllStatus() };
}
```

- [ ] **Step 2: `settings.js` — remove the old global route, keep the estimate route per-area**

Delete `POST /settings/fallback-scope` (`settings.js:619-624`) entirely — replaced by Task 3 below. Change `GET /settings/fallback-mode/estimate` to require an `?area=` query param and call `fallbackMode.getEstimate(req.query.area)`.

- [ ] **Step 3: `areas.js` — add the per-area scope route**

```js
router.post('/areas/:key/scrape-scope', requireAdmin, (req, res) => {
  const { full } = req.body || {};
  db.setAreaScrapeScopeFull(req.params.key, !!full);
  appLog.info('SETTINGS', `Recupero dati: scope "${full ? 'completo' : 'solo seguite'}" per l'area ${req.params.key}`);
  res.json({ ok: true, area: req.params.key, scopeFull: !!full });
});
```

- [ ] **Step 4: `server.js` — remove now-nonexistent references**

Grep for any remaining `fallbackMode.enter`/`fallbackMode.exit`/`fallbackMode.isActive` call in `server.js` (there shouldn't be any beyond the sweep-interval wiring, which stays as-is since `sweep()` itself still exists, just unconditional now) and delete if found.

- [ ] **Step 5: Verify no dangling references anywhere**

```bash
grep -rn "fallbackMode\.\(enter\|exit\|isActive\)\|fallback-scope'" src/ public/js/
```

Expected: zero matches.

- [ ] **Step 6: Lint, boot-check, commit**

```bash
npm run lint
node --check src/services/ais-uptime.js src/routes/settings.js src/routes/areas.js src/server.js
git add src/services/ais-uptime.js src/routes/settings.js src/routes/areas.js src/server.js
git commit -m "refactor: aggiornare i chiamanti della vecchia API globale modalità fallback"
```

---

### Task 6: New-ship discovery via confirmed ports' arrivals pages

**Files:**
- Create: `src/services/port-arrivals-discovery.js`
- Modify: `src/server.js`

**Interfaces:**
- Consumes: `fallbackMode.isAreaInRecovery(areaKey)` (Task 4), `db.getConfirmedAreaPorts(areaKey)` (companion port-discovery plan, Task 1), `mst.crawlPortArrivals(pid)` (companion plan, Task 6), `db.ensureShipStub(mmsi, name)` (existing), `db.insertScrapedPosition(mmsi, pos, source)` (existing), `db.getActiveAreaKeys()` (existing).
- Produces: `async function pollDueArrivals()` → `Promise<void>`, called on its own interval from `server.js`.

- [ ] **Step 1: Write the per-port due-for-refresh tracker + poll function**

```js
'use strict';

const db = require('../db');
const fallbackMode = require('./fallback-mode');
const mst = require('./scrapers/myshiptracking');
const appLog = require('./app-log');
const { invalidateRiskCache } = require('./risk-score');

const PORT_POLL_INTERVAL_MS = 20 * 60 * 1000; // ~20min per port, within the 15-30min range decided in the design
const lastPolledAt = new Map(); // area_ports.id -> epoch ms

/** For every area currently in scrape recovery with confirmed, mst_pid-resolved
 *  ports due for a refresh, poll the arrivals/departures page and register any
 *  ship we've never tracked. Runs on its own interval (see server.js) — NOT
 *  tied to fallback-mode's 3min sweep, since discovery doesn't need that
 *  freshness and this keeps its share of the shared hourly budget small. */
async function pollDueArrivals() {
  const now = Date.now();
  for (const areaKey of db.getActiveAreaKeys()) {
    if (!fallbackMode.isAreaInRecovery(areaKey)) continue;
    for (const port of db.getConfirmedAreaPorts(areaKey)) {
      if (!port.mst_pid) continue;
      const due = !lastPolledAt.has(port.id) || now - lastPolledAt.get(port.id) >= PORT_POLL_INTERVAL_MS;
      if (!due) continue;
      lastPolledAt.set(port.id, now);
      try {
        const events = await mst.crawlPortArrivals(port.mst_pid);
        for (const ev of events) {
          registerIfNew(ev.mmsi, ev.name, port);
        }
      } catch (e) {
        appLog.warn('SCRAPE', `Arrivi/partenze porto ${port.name} falliti: ${e.message}`);
      }
    }
  }
}

/** A ship we've never tracked: create its stub (no-op if it already exists —
 *  ensureShipStub is INSERT OR IGNORE, never clobbers an AIS-fed row) and give
 *  it an approximate initial position (the port's own centroid) via the same
 *  scrape-position path used everywhere else, so a real fix from the next
 *  fallback-mode sweep — or AIS itself, once it recovers — supersedes it
 *  exactly like any other scraped fix (see ensureShipStub's own doc comment on
 *  why last_seen_at's 1970 sentinel is what makes that overwrite automatic). */
function registerIfNew(mmsi, name, port) {
  db.ensureShipStub(mmsi, name);
  const stored = db.insertScrapedPosition(mmsi, { lat: port.lat, lon: port.lon, name }, 'mst');
  if (stored) invalidateRiskCache(mmsi);
}

module.exports = { pollDueArrivals };
```

- [ ] **Step 2: Wire the interval in `server.js`**

Next to the existing `FALLBACK_SWEEP_MS` interval:

```js
const portArrivalsDiscovery = require('./services/port-arrivals-discovery');
const PORT_ARRIVALS_POLL_MS = 5 * 60 * 1000; // checks which ports are due; actual per-port cadence gated inside pollDueArrivals
setInterval(() => {
  portArrivalsDiscovery.pollDueArrivals().catch((e) => appLog.error('SCRAPE', 'Poll arrivi porto fallito', { error: e.message }));
}, PORT_ARRIVALS_POLL_MS);
```

- [ ] **Step 3: Verify with a throwaway script**

```bash
node -e '
const db = require("./src/db");
db.upsertAreaPort({ area_key: "toscana", name: "Test Port", lat: 43.55, lon: 10.3, sources: ["berths"], status: "confirmed" });
const id = db.getAreaPorts("toscana").find(p => p.name === "Test Port").id;
db.setAreaPortMstPid(id, "275"); // Livorno, per this design conversation
const { pollDueArrivals } = require("./src/services/port-arrivals-discovery");
pollDueArrivals().then(() => console.log("poll ran (check app log / ships table for new stubs if the test area is currently in recovery)"));
'
```

Note this only actually registers anything if `fallbackMode.isAreaInRecovery('toscana')` is true at the moment — if AIS is healthy in the dev environment, temporarily lower `AREA_SCRAPE_SILENCE_MIN` to `0` in `local.properties`/env for this one manual test, then revert.

- [ ] **Step 4: Lint and commit**

```bash
npm run lint
git add src/services/port-arrivals-discovery.js src/server.js
git commit -m "feat(port-arrivals-discovery): scoperta nuove navi via arrivi/partenze porto"
```

---

### Task 7: UI — remove the old sidebar entry, retire the old chart block

**Files:**
- Modify: `public/index.html`, `public/js/main.js`, `public/js/outage.js`, `public/js/dom.js`, `public/js/health.js`

- [ ] **Step 1: Remove the sidebar button**

In `public/index.html`, delete the `<button id="btn-fallback-nav" ...>` block added in the previous session (right after `#btn-settings`).

- [ ] **Step 2: Remove its wiring**

In `public/js/main.js`, delete the `el.btnFallbackNav?.addEventListener('click', ...)` block. In `public/js/outage.js`, delete the `el.btnFallbackNav?.classList.toggle('hidden', ...)` line inside `applyOutageBanner()`. In `public/js/dom.js`, delete the `btnFallbackNav: $('btn-fallback-nav'),` entry.

- [ ] **Step 3: Remove the old chart block from `health.js`**

Delete `FALLBACK_SOURCE_LABEL`, `sourceHistoryChart()`, and `fallbackModeBlock()` from `public/js/health.js`, and their call site inside `fetchHealth()` (the `${fallbackModeBlock(h.fallbackMode, h.fallbackEstimate)}` line and whatever populated `h.fallbackMode`/`h.fallbackEstimate` on the `/api/stream/health` response — check `src/routes/stream.js`'s `GET /stream/health` handler and remove those two fields from its response object, since the replacement lives in the new tab now, not Diagnostica AIS).

- [ ] **Step 4: Verify nothing references the removed pieces**

```bash
grep -rn "btn-fallback-nav\|btnFallbackNav\|fallbackModeBlock\|sourceHistoryChart\|FALLBACK_SOURCE_LABEL" public/
```

Expected: zero matches.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add public/index.html public/js/main.js public/js/outage.js public/js/dom.js public/js/health.js src/routes/stream.js
git commit -m "refactor(frontend): rimossa voce sidebar e grafici globali \"modalità fallback\""
```

---

### Task 8: UI — new admin Settings tab "Recupero dati via scraping"

**Files:**
- Create: `public/js/scrape-recovery.js`
- Modify: `public/index.html`, `public/js/main.js`, `public/js/dom.js`, `public/locales/it.js`, `public/locales/en.js`, `src/routes/settings.js`

**Interfaces:**
- Consumes: new `GET /api/settings/scrape-recovery` → `{ areas: { [areaKey]: {status, estimate} }, globalHistory: [...] }` (this task adds the route); reuses `db.getScrapeCountsHourly(48)` (existing, global) for `globalHistory` and `fallbackMode.getAllStatus()`/per-area `getEstimate(areaKey)` for `areas`.

- [ ] **Step 1: Add the aggregate route**

In `src/routes/settings.js`:

```js
router.get('/settings/scrape-recovery', requireAdmin, (req, res) => {
  const statuses = fallbackMode.getAllStatus();
  const areas = {};
  for (const [key, status] of Object.entries(statuses)) {
    areas[key] = { status, estimate: fallbackMode.getEstimate(key) };
  }
  res.json({
    areas,
    globalCircuits: fallbackMode.getGlobalCircuitStatus(),
    globalHistory: db.getScrapeCountsHourly(48),
  });
});
```

- [ ] **Step 2: Add the tab button + panel markup**

In `public/index.html`, next to the existing `#settings-tab-health` button (inside `#settings-tabs`):

```html
<button id="settings-tab-scrape-recovery" class="tab" data-panel="scrape-recovery" style="display:none"
        data-i18n="settings.tab.scrapeRecovery">Recupero dati via scraping</button>
```

(`style="display:none"` by default, revealed for admins the same way `auth-ui.js` already reveals other admin-only controls — add this element's id to that reveal list.) And its panel, next to `#settings-panel-health`:

```html
<div id="settings-panel-scrape-recovery" class="settings-panel hidden">
  <div id="scrape-recovery-body"></div>
</div>
```

- [ ] **Step 3: Write `public/js/scrape-recovery.js`**

Model this closely on the removed `health.js` chart code (Task 7) — same `.hourly-bars`/`.hour-bar-stack`/`.hour-bar-ok`/`.hour-bar-fail` CSS classes (still in `style.css`, untouched by Task 7), same emoji legend, same per-source small-multiple approach — but now render **one global aggregate chart first**, then **one card per area**:

```js
import { el } from './dom.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { fmtUptime, formatTime, escHtml } from './helpers.js';

let timer = null;

const SOURCE_LABEL = { sf: 'ShipFinder', mst: 'MyShipTracking' };

// One small-multiple hourly chart for a single source: stacked ok/failed bars,
// shared scale across whatever byHour/hours/maxTotal the caller passes (either
// the two sources of the global aggregate, or the two sources of one area's
// own history) — identical bar-building math either way.
function sourceHistoryChart(source, byHour, hours, maxTotal) {
  const bars = hours
    .map((h, i) => {
      const c = byHour.get(h) || { ok: 0, failed: 0 };
      const total = c.ok + c.failed;
      const totalPct = total ? Math.max(2, Math.round((total / maxTotal) * 100)) : 0;
      const failPct = total ? Math.round(totalPct * (c.failed / total)) : 0;
      const okPct = totalPct - failPct;
      const label = i % 6 === 0 ? `<span class="hour-label">${escHtml(h.slice(11, 16))}</span>` : '';
      return `
      <div class="hour-bar-wrap" title="${escHtml(h.slice(0, 16).replace('T', ' '))} — ${t('health.fallbackOkLabel')}: ${c.ok} · ${t('health.fallbackFailedLabel')}: ${c.failed}">
        <div class="hour-bar-stack" style="height:${totalPct}%">
          ${failPct ? `<div class="hour-bar-fail" style="height:${failPct}%"></div>` : ''}
          ${okPct ? `<div class="hour-bar-ok" style="height:${okPct}%"></div>` : ''}
        </div>
        ${label}
      </div>`;
    })
    .join('');
  return `<p class="health-section-desc" style="margin:0.6rem 0 0.3rem"><strong>${SOURCE_LABEL[source]}</strong></p>
    <div class="hourly-bars">${bars}</div>`;
}

function byHourFromRows(rows) {
  const out = { sf: new Map(), mst: new Map() };
  for (const row of rows) {
    if (row.source !== 'sf' && row.source !== 'mst') continue;
    out[row.source].set(row.hour, { ok: row.ok || 0, failed: row.failed || 0 });
  }
  return out;
}

function maxTotalOf(byHour, hours) {
  return Math.max(
    1,
    ...hours.map((h) => (byHour.sf.get(h)?.ok || 0) + (byHour.sf.get(h)?.failed || 0)),
    ...hours.map((h) => (byHour.mst.get(h)?.ok || 0) + (byHour.mst.get(h)?.failed || 0))
  );
}

function areaCard(areaKey, { status, estimate }) {
  const statusVal = status.inRecovery
    ? `<span class="health-err">${t('scrapeRecovery.inRecovery')}</span>`
    : `<span class="health-ok">${t('scrapeRecovery.sufficient')}</span>`;
  const rows = [`<div class="health-item"><label>${t('health.fallbackStatus')}</label><span>${statusVal}</span></div>`];
  if (status.inRecovery && status.since) {
    const durationSec = Math.max(0, Math.round((Date.now() - status.since) / 1000));
    rows.push(
      `<div class="health-item"><label>${t('health.fallbackSince')}</label><span>${formatTime(new Date(status.since).toISOString())}</span></div>`,
      `<div class="health-item"><label>${t('health.fallbackDuration')}</label><span>${fmtUptime(durationSec)}</span></div>`
    );
  }
  rows.push(
    `<div class="health-item"><label>${t('health.fallbackScope')}</label><span>${
      status.scopeFull ? t('health.fallbackModeFull') : t('health.fallbackModeFollow')
    }</span></div>`
  );

  const byHour = byHourFromRows(estimate?.recentHistory || []);
  const hours = [...new Set([...byHour.sf.keys(), ...byHour.mst.keys()])].sort();
  const historyChart = hours.length
    ? `${sourceHistoryChart('sf', byHour.sf, hours, maxTotalOf(byHour, hours))}
       ${sourceHistoryChart('mst', byHour.mst, hours, maxTotalOf(byHour, hours))}`
    : `<p class="health-muted">${t('health.fallbackNoHistory')}</p>`;

  return `
    <div class="health-section">
      <h4 class="health-subtitle">${escHtml(areaKey)}</h4>
      <div class="health-grid">${rows.join('')}</div>
      ${historyChart}
    </div>`;
}

function globalCircuitsBlock(gc) {
  const rows = ['sf', 'mst'].map((src) => {
    const c = gc.circuits[src];
    const trips = gc.tripCounts[src] || 0;
    const val = c.open
      ? `<span class="health-err">${t('health.circuitOpen', { until: formatTime(c.until) })}</span>`
      : `<span class="health-ok">${t('health.circuitClosed')}</span>`;
    const tripsVal = trips ? ` · <span class="health-warn">${t('health.fallbackTripCount', { n: trips })}</span>` : ` · ${t('health.fallbackNoProblems')}`;
    return `<div class="health-item"><label>${SOURCE_LABEL[src]}</label><span>${val}${tripsVal}</span></div>`;
  });
  return `
    <div class="health-section">
      <h4 class="health-subtitle">${t('scrapeRecovery.circuitsTitle')}</h4>
      <div class="health-grid">${rows.join('')}</div>
    </div>`;
}

async function fetchScrapeRecovery() {
  const { areas, globalCircuits, globalHistory } = await api('/api/settings/scrape-recovery');
  const byHour = byHourFromRows(globalHistory);
  const hours = [...new Set([...byHour.sf.keys(), ...byHour.mst.keys()])].sort();
  const maxTotal = maxTotalOf(byHour, hours);
  el.scrapeRecoveryBody.innerHTML = `
    <h4 class="health-subtitle">${t('scrapeRecovery.globalTitle')}</h4>
    ${sourceHistoryChart('sf', byHour.sf, hours, maxTotal)}
    ${sourceHistoryChart('mst', byHour.mst, hours, maxTotal)}
    ${globalCircuitsBlock(globalCircuits)}
    ${Object.entries(areas).map(([key, v]) => areaCard(key, v)).join('')}
  `;
}

export function openScrapeRecovery() {
  clearInterval(timer);
  fetchScrapeRecovery();
  timer = setInterval(fetchScrapeRecovery, 5000);
}
export function closeScrapeRecovery() {
  clearInterval(timer);
  timer = null;
}
```

- [ ] **Step 4: Wire tab open/close in `main.js`**

In `activateSettingsPanel(panel)` (`main.js`, next to the `if (panel === 'health') openHealth(); else closeHealth();` line):

```js
if (panel === 'scrape-recovery') openScrapeRecovery(); else closeScrapeRecovery();
```

Import `openScrapeRecovery, closeScrapeRecovery` from `./scrape-recovery.js` at the top of `main.js`. Add the same call to `stopSettingsFeeds()`.

- [ ] **Step 5: Add `el.scrapeRecoveryBody` in `dom.js`**

```js
scrapeRecoveryBody: $('scrape-recovery-body'),
```

- [ ] **Step 6: i18n keys (both languages)**

```js
'settings.tab.scrapeRecovery': 'Recupero dati via scraping', // en: 'Scrape data recovery'
'scrapeRecovery.globalTitle': 'Andamento generale (tutte le aree)', // en: 'Overall trend (all areas)'
'scrapeRecovery.inRecovery': 'In recupero dati', // en: 'In data recovery'
'scrapeRecovery.sufficient': 'Dati AIS sufficienti', // en: 'AIS data sufficient'
'scrapeRecovery.circuitsTitle': 'Stato sorgenti (globale)', // en: 'Source status (global)'
```

(plus whatever additional keys `areaCard()`'s full implementation ends up needing for since/scope/circuit/trip-count labels — reuse the existing `health.fallback*` key **values** where the copy is unchanged, e.g. `health.circuitOpen`/`health.circuitClosed`/`health.fallbackTripCount` stay as-is, just now rendered from `scrape-recovery.js` instead of `health.js`.)

- [ ] **Step 7: Manual browser verification**

`npm run dev`, log in as admin, open Settings, confirm the new "Recupero dati via scraping" tab appears (and is absent for a non-admin test account), shows the global chart plus one card per active area, and that the old "Diagnostica AIS" tab no longer shows the fallback block (Task 7 removed it).

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add public/js/scrape-recovery.js public/index.html public/js/main.js public/js/dom.js public/locales/it.js public/locales/en.js src/routes/settings.js public/js/auth-ui.js
git commit -m "feat(frontend): nuovo tab Impostazioni \"Recupero dati via scraping\" (globale + per-area)"
```

---

### Task 9: UI — per-area scope toggle in the Aree screen

**Files:**
- Modify: `public/js/areas.js`, `public/index.html`, `public/locales/it.js`, `public/locales/en.js`

**Interfaces:**
- Consumes: `POST /api/areas/:key/scrape-scope` (Task 5).

- [ ] **Step 1: Add markup next to the companion plan's `.area-ports` block**

In the same per-area row template (`public/index.html`), right next to the `<div class="area-ports">` block the companion port-discovery plan added:

```html
<div class="area-scope-toggle">
  <label>
    <input type="checkbox" class="area-scope-full-checkbox">
    <span data-i18n="areas.scopeFull">Includi anche le navi di quest'area (non solo seguite) nel recupero dati</span>
  </label>
</div>
```

- [ ] **Step 2: Wire it in `areas.js`**

```js
el.areasList?.addEventListener('change', async (e) => {
  const cb = e.target.closest('.area-scope-full-checkbox');
  if (!cb) return;
  const areaKey = cb.closest('[data-area-key]').dataset.areaKey;
  await api(`/api/areas/${encodeURIComponent(areaKey)}/scrape-scope`, 'POST', { full: cb.checked });
});
```

And initialize each checkbox's checked state when the area row renders, from whatever per-area data the row-render function already fetches (or a small dedicated `GET` if it doesn't already have `scrape_scope_full` — check the existing area-list payload shape first; if `scrape_scope_full` isn't already included, add it to whatever `GET /areas` handler serializes an area row).

- [ ] **Step 3: i18n**

```js
'areas.scopeFull': 'Includi anche le navi di quest\'area (non solo seguite) nel recupero dati', // en: 'Also include this area's ships (not just followed) in data recovery'
```

- [ ] **Step 4: Manual verification, lint, commit**

`npm run dev`, toggle the checkbox for a test area, confirm `GET /api/settings/scrape-recovery`'s response for that area shows `scopeFull: true` afterward.

```bash
npm run lint
git add public/js/areas.js public/index.html public/locales/it.js public/locales/en.js
git commit -m "feat(frontend): toggle scope scraping per-area nella schermata Aree"
```

---

### Task 10: Documentation sync

**Files:**
- Modify: `docs/technical/README.it.md`, `.en.md`
- Modify: `docs/manuale_admin/manuale_admin.md`, `.en.md` (+ regenerate `.html`/`.pdf`)
- Modify: `public/sw.js`

- [ ] **Step 1: Rewrite the "🔀 Modalità fallback" section in both technical READMEs**

Replace the entire section (added across the previous two sessions) with one describing: per-area silence detection (`AREA_SCRAPE_SILENCE_MIN`/`AREA_SCRAPE_EXIT_GRACE_MIN`), the always-on sweep, per-area scope opt-in, the decoupled banner (`AIS_FALLBACK_HOURS`/`EXIT_GRACE_MIN` now banner-only), the new-arrival discovery mechanism, and the new admin tab. Keep the anti-ban bullet list (budget/priority/rotation/circuit-breaker) — it's unchanged — but reframe its intro sentence away from "during fallback mode" to "during scrape recovery, continuously."

- [ ] **Step 2: Update the admin manual (both languages)**

Replace the "Modalità fallback" section under "Diagnostica AIS" with: the new tab's location and content, the per-area scope toggle's new home in the Aree screen, and that the mechanism is now continuous per-area rather than a global on/off (screenshot `images/26-impostazioni-diagnostica.png` likely needs updating too, since the old fallback block used to live in that screenshot's tab — flag this to the user rather than guessing at a new screenshot without being able to drive a real browser session with an admin login in this environment).

- [ ] **Step 3: Regenerate HTML + PDF**

Same four commands as the companion plan's Task 11 Step 3.

- [ ] **Step 4: Bump `public/sw.js`'s `CACHE`**

Check `git log -1 -- public/sw.js` first — if the companion plan already bumped it in this deploy, don't bump again.

- [ ] **Step 5: Commit**

```bash
git add docs/technical/README.it.md docs/technical/README.en.md docs/manuale_admin/ public/sw.js
git commit -m "docs: documentare il recupero dati via scraping per-area (tecnico + manuale admin, IT+EN)"
```

---

### Task 11: Backup/restore verification

**Files:** none (verification only)

- [ ] **Step 1: Take a backup under the schema that predates BOTH plans**

Same approach as the companion plan's Task 12 — ideally the actual production backup taken before any of this work (which has `fallback_mode_active`/`fallback_mode_since` in `meta`, no `area_ports`, no `areas.scrape_scope_full`, no `scrape_log.area` column).

- [ ] **Step 2: Restore it into the fully-implemented new code (both plans applied)**

Confirm:
- No error during restore.
- `areas.scrape_scope_full` defaults to `0` for every restored area (nothing in the old backup set it, the `ALTER TABLE` default applies).
- The old `fallback_mode_active`/`fallback_mode_since` meta rows, if present in the backup, are silently ignored (no code reads those keys anymore after Task 4).
- The app boots, the new Settings tab loads without error, and every restored active area shows `inRecovery: false`/`scopeFull: false` until real data says otherwise.
- `scrape_log` rows from the old backup (no `area` column) restore fine (the column is nullable, added via `ALTER TABLE`, old rows just get `NULL`) and the existing global chart (Task 8's aggregate) still renders using them.

- [ ] **Step 3: Report and fix**

If Step 2 reveals a problem, fix it and re-run until clean. This task, together with the companion plan's Task 12, is the concrete answer to the explicit "verifica che l'export/import funzioni" requirement from the design conversation — do not skip it or treat it as optional.

---

### Task 12: Production verification note (not a code task)

After this plan and its companion are deployed, per the user's explicit request in the design conversation: watch for the ~10-20 minute CPU-spike/notification-flap pattern observed on 2026-08-16. This plan's per-area redesign removes the most plausible cause of the *banner* flapping (a quiet-but-healthy area repeatedly crossing a threshold meant for a global outage) but does **not** have a confirmed fix for the CPU spike itself (see the spec's Rischi section — root cause wasn't isolated from static code alone). If the spike recurs after this deploy, the next debugging step is getting real process/host logs for that time window (this plan's code changes don't add new instrumentation for that — if it recurs, add targeted logging as a follow-up, don't guess again).
