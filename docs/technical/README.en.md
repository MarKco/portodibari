# 🚢 Tracker Porti — Technical documentation

> 📖 Documentazione in italiano: [README.it.md](README.it.md) · Project overview: [root README](../../README.md)

<p align="center">
  <img src="../../public/icons/icon-512.png" alt="Tracker Porti" width="160">
</p>

App for tracking ships via [AISStream.io](https://aisstream.io). The monitoring area is configurable with arbitrary bounding boxes (see [Bounding box](#bounding-box)), making it usable for any port — no area ships pre-configured: areas are **added at runtime** from the **🗺 Areas** screen (no app restart). **Multiple areas can be monitored simultaneously**: each area has its own independent AIS stream.

## 🏗️ Architecture

```
Browser ←──polling 5min──→ Express (Node.js) ←──WebSocket──→ AISStream.io
                                 │         └──node-libcurl──→ MarineTraffic (Cloudflare)
                                 │         └──https───────────→ VesselFinder
                                 │         └──https (token)───→ Global Fishing Watch API
                             SQLite (ais_data.db)
```

The browser **cannot** connect directly to AISStream (CORS policy). The backend acts as a proxy: it maintains the WebSocket connection and saves data to SQLite. The frontend polls via HTTP every 5 minutes. The backend also enriches ship data with scraping from VesselFinder/MarineTraffic (see [MarineTraffic / VesselFinder Integration](#marinetraffic--vesselfinder-integration)).

## 🧰 Stack

| Component        | Technology                                                          |
| ------------------| ---------------------------------------------------------------------|
| Backend          | Node.js (v22+) + Express                                            |
| WebSocket client | `ws`                                                                |
| Database         | SQLite via `node:sqlite` (built-in Node.js, zero native dependencies) |
| ZIP Export       | `archiver`                                                          |
| Frontend         | HTML + CSS + vanilla JS (ES modules)                               |

## 📁 Project structure

```
.
├── src/                      # Backend (Node.js / Express)
│   ├── server.js             # Entry point: HTTP startup, departure scheduler, stream
│   ├── app.js                # Express app factory (middleware + routes)
│   ├── config.js             # local.properties/env loading, bbox presets, constants, runtime state
│   ├── db.js                 # SQLite data layer (schema, queries, prepared statements)
│   ├── realtime.js           # Shared buses: SSE log clients + alert queue
│   │                         #   (routes/ also includes notifications.js — notification feed)
│   ├── middleware/
│   │   └── api-logger.js      # Logging + broadcast of every /api call
│   ├── services/
│   │   ├── ais-stream.js      # AISStream WebSocket connection management + reconnection
│   │   ├── ship-analysis.js   # haversine, isInPort, computeDirection
│   │   ├── risk-score.js      # Arms transport risk score (0–100) from AIS signatures + VF/MT data + sanctions + PSC
│   │   ├── enrichment.js      # Proactive VF/MT enrichment on first ship detection
│   │   ├── sanctions.js       # OFAC SDN + EU/UK/UN sanctions lists (OpenSanctions): download, index, match by IMO/name/call sign
│   │   ├── psc.js             # Port State Control (Paris/Tokyo MoU): flag performance + banned vessels
│   │   ├── gfw.js             # Global Fishing Watch API client: vessel identity + behavioural events (encounters, loitering, port visits, AIS gaps)
│   │   ├── proximity.js       # Ship-to-ship rendezvous detection (periodic per-area scan, ship-to-ship transshipment signature)
│   │   ├── webhooks.js        # Per-user outbound webhooks (Slack/Discord/SIEM/custom; formats, HMAC signature, SSRF guard)
│   │   ├── group-sync.js      # User groups: union + write-through sync of areas/follows/flags/mutes + shared preferences; "taken in charge" activity log (not mirrored)
│   │   ├── equasis-log.js     # Append-only audit log of Equasis lookups (equasis.log)
│   │   ├── locode.js          # UN/LOCODE → human-readable port name lookup (loads data/locode.json on demand)
│   │   └── scrapers/
│   │       ├── http.js        # HTTP/node-libcurl helper + HTML parsing
│   │       ├── vesselfinder.js
│   │       ├── marinetraffic.js
│   │       └── equasis.js     # Ownership/management lookup by IMO (on-demand, login required)
│   ├── routes/                # Express routers, one per domain (ships, readings, areas, …)
│   └── lib/
│       └── csv.js             # CSV export helper (flatten + escape)
├── public/                   # Static frontend
│   ├── index.html
│   ├── css/style.css
│   └── js/                    # ES modules (loaded via <script type="module">)
│       ├── main.js            # Entry: status, settings, sidebar, polling, init
│       ├── views.js           # View switching
│       ├── ships.js, maps.js, traffico.js, logs.js, health.js, areas.js
│       ├── replay.js          # Area-wide historical replay (time-scrubber) on the area map
│       ├── geoexport.js       # Client-side GeoJSON/KML export (ships, track, replay, berths)
│       ├── webhooks.js        # Per-user outbound-webhook management (Settings → External integrations)
│       ├── tiles.js            # OSM base layer + OpenSeaMap nautical (seamark) overlay
│       ├── seamarks.js         # OpenSeaMap markers (harbours/berths/lights…) via Overpass API
│       ├── notifications.js   # Personal + "Group activity" notification feeds (badge + shared overlay)
│       ├── api.js, dom.js, store.js, toast.js, helpers.js
│       ├── theme.js           # Light/dark theme toggle + localStorage persistence
│   ├── manifest.webmanifest  # PWA manifest (name, icons, standalone display)
│   ├── sw.js                 # Service worker (offline shell, never caches /api or live data)
│   ├── offline.html          # Offline fallback page (served before the auth gate)
│   └── icons/                # PWA icons (generated by scripts/gen-icons.js)
├── scripts/
│   ├── gen-icons.js          # Regenerates the PWA icons from public/icons/source.png (auto-crop tile + resize via sips, macOS)
│   └── build-locode.js       # Builds data/locode.json from the un-locode npm package (run once after install)
├── data/
│   └── locode.json           # Compact UN/LOCODE lookup → port name (104 k entries, ~2.2 MB; generated by build-locode.js)
├── bounding-boxes.json       # Monitoring area presets (customizable)
├── local.properties          # Config + API key (gitignored)
├── local.properties.example  # Configuration template
└── ais_data.db               # SQLite database (created on first run, gitignored)
```

## ⚙️ Configuration (`local.properties`)

Configuration lives in the `local.properties` file at the project root (format `KEY=value`, lines starting with `//` or `#` are ignored). **The file is in `.gitignore`** because it contains the API key — do not commit it. Start from `local.properties.example` (`cp local.properties.example local.properties`). Keys can also be passed as environment variables.

| Key | Description | Default |
|---|---|---|
| `AIS_API_KEY` | [AISStream.io](https://aisstream.io) API key (required) — used by the **monitoring-area** streams | — |
| `FOLLOW_AIS_API_KEY` | API key from a **separate AISStream account** for the **followed-ships** stream (`services/ship-follow.js`). Empty = reuse `AIS_API_KEY`. A dedicated account is recommended: AISStream's connection limit is **per-account**, so sharing the key with the area streams gets the follow handshake rejected in a **429 loop** (see note below). | *(reuses `AIS_API_KEY`)* |
| `BBOX_PRESET` | Key of the area active at startup, among those defined in `bounding-boxes.json`/DB catalog | *(empty — no area until you add one)* |
| `IMPORT_VF_DATA` | Enable VesselFinder scraping (`true`/`false`) | `false` |
| `IMPORT_MT_DATA` | Enable MarineTraffic scraping (`true`/`false`) | `false` |
| `IMPORT_SF_DATA` | Enable ShipFinder scraping — static data + last-seen position to re-locate lost followed ships (`true`/`false`) | `false` |
| `IMPORT_MST_DATA` | Enable MyShipTracking scraping — second position-backup source, same role as ShipFinder (`true`/`false`) | `false` |
| `IMPORT_SANCTIONS` | Enable OFAC SDN sanctions list screening (`true`/`false`) | `false` |
| `IMPORT_SANCTIONS_EXTRA` | Enable additional EU/UK OFSI/UN sanctions lists on top of OFAC (`true`/`false`) | `true` |
| `IMPORT_PSC` | Enable Paris/Tokyo MoU Port State Control screening: flag performance + banned vessels (`true`/`false`) | `false` |
| `IMPORT_EQUASIS` | Enable the on-demand Equasis lookup (ownership/management) in the ship detail (`true`/`false`) | `false` |
| `EQUASIS_USER` | Equasis account email (free registration at [equasis.org](https://www.equasis.org/)) — required by the Equasis lookup | *(empty)* |
| `EQUASIS_PASSWORD` | Equasis account password — required by the Equasis lookup | *(empty)* |
| `IMPORT_GFW` | Enable Global Fishing Watch enrichment (identity + AIS-derived behavioural events) (`true`/`false`) | `true` |
| `GLOBAL_FISHING_WATCH_TOKEN` | Global Fishing Watch API token (Bearer), generated from the [GFW API portal](https://globalfishingwatch.org/our-apis/) — required by the GFW enrichment. GFW data is free **for non-commercial use only** (research/NGO/public good); commercial use requires a dedicated license. Without a token the feature silently no-ops | *(empty)* |
| `HEATMAP_AIS_API_KEY` | AISStream API key from a **separate account** for the Coverage map (see the [dedicated section](#-coverage-map-aisstream-coverage)). Empty = feature disabled. Bare value, no inline comments. | *(empty)* |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (from [@BotFather](https://t.me/BotFather)) for Telegram notifications. A single bot serves all users; each links their own chat from Settings → **External integrations** tab. Empty = bot off. **Secret, do not commit.** No public URL/webhook needed: the app long-polls | *(empty)* |
| `ADMIN_USERNAME` | Username of the built-in administrator, re-seeded at startup if missing (see [Authentication](#-authentication-multi-user)) | `admin` |
| `ADMIN_EMAIL` | Email of the built-in administrator | `admin@local` |
| `ADMIN_PASSWORD` | Password of the built-in administrator, **required for the account's first creation** (no built-in default: a deploy missing this key with no pre-existing admin **refuses to start**, see below) | *(required)* |
| `COOKIE_SECURE` | Send the session cookie over HTTPS only — set to `true` behind TLS (`true`/`false`) | `false` |
| `SESSION_TTL_DAYS` | Session (login) lifetime in days | `30` |

> ⚠️ **Recommended: three keys from three separate AISStream accounts.** AISStream's connection limit is **per-account, not per-key**. The app opens three independent kinds of WebSocket stream — **area monitoring** (`AIS_API_KEY`), **followed ships** (`FOLLOW_AIS_API_KEY`) and the **coverage map** (`HEATMAP_AIS_API_KEY`) — and if two of them use keys from the **same account** they fight over the same connection slot: the second handshake is rejected (429 loop / `1006` close with no error frame). To run all three features together, give each one a key from a **distinct AISStream account**. Leaving `FOLLOW_AIS_API_KEY` or `HEATMAP_AIS_API_KEY` empty keeps the respective feature on `AIS_API_KEY` (follow) or disabled (heatmap).

`BBOX_PRESET`, `IMPORT_VF_DATA` and `IMPORT_MT_DATA` can also be changed from the UI (area selector / Settings modal) and are persisted back to the file. `PORT` (environment variable) sets the HTTP port (default 3000). The `ADMIN_*`, `COOKIE_SECURE` and `SESSION_TTL_DAYS` keys are read only at startup (not editable from the UI).

Example `local.properties`:

```properties
AIS_API_KEY=your_api_key
IMPORT_VF_DATA=true
IMPORT_MT_DATA=true
```

## 🗺️ Bounding box

The monitoring area can be selected at runtime from the dropdown menu in the interface. Presets are defined in the **`bounding-boxes.json`** file (project root) and can be modified **without touching the code**.

Each preset has this shape:

```json
"bari": { "name": "Porto di Bari", "keyword": "BARI", "sw": [40.95, 16.60], "ne": [41.30, 17.10] }
```

| Field | Meaning |
|---|---|
| key (`bari`) | Preset identifier, used by `BBOX_PRESET` in `local.properties` |
| `name` | Label shown in the interface |
| `keyword` | (Optional, can be `null`) filters ships in the "Expected ships" section by destination |
| `sw` | South-West corner `[lat, lon]` |
| `ne` | North-East corner `[lat, lon]` |

The file **ships with no default presets**: on a fresh install `bounding-boxes.json` is empty (just `_comment`) and the Areas screen starts with no areas — add your own from there, or by hand in the file before the first boot.

There are **two ways** to manage areas:

1. **🗺 Areas screen (at runtime, no restart)** — the **🗺 Areas** sidebar button opens a page with the list of areas (with coordinates, status and amount of stored data), a map showing them all, and a panel to add new ones:
   - **by GPS coordinates** in decimal degrees (SW lat/lon and NE lat/lon fields), or
   - **from the map**: frame (zoom/pan) the area to monitor and press **🎯 Capture current view** to fill the coordinates automatically from the visible viewport.
   - Give it a **name** (required) and an optional **keyword**. The new area is saved to `bounding-boxes.json` and its stream starts immediately.
   - **Editing**: clicking a table row loads that area into the same panel (which becomes "Edit area"), frames it on the map and draws its box as a dashed rectangle; name, keyword and coordinates can be changed and saved with **💾 Save changes** (`PATCH /api/areas/:key` → `config.updateArea`). The **area key never changes**: it is the foreign key of every row collected so far, so the history stays attached even when the box moves (readings outside the new boundaries are **not** deleted). When the box changes and the stream is active, `startStream` on an already-active area re-sends the updated shared subscription. **Shared** areas can be edited too: the change applies to everyone monitoring that area (the catalog is global), so the client asks for a **double confirmation** (`areas.editSharedConfirm1/2`, shown when `sharedWith > 0` in the `GET /api/areas` response) and the server notifies every other owner with a `group_area_edit` group-activity notification (`groupSync.notifyAreaEdit`, see [User groups](#-user-groups)).
   - **Deletion**: the 🗑 trash button removes the area **and all related monitoring history** (readings, ships, port events, notifications, moorings, berths, risk history and scrape cache). Deletion is **deferred by 10 seconds** with an **↶ Undo** toast: it becomes effective when the timer elapses or when you leave the page; pressing Undo deletes nothing. **At least one area** must remain (the last one cannot be deleted). Deletion only takes effect **if you are the last owner** of the area (shared areas survive as long as another user still monitors them).

     > **Orphan rows and cleanup.** The schema uses no `ON DELETE CASCADE`: `deleteAll(area)` in `src/db.js` performs the deletes by hand. Because a ship keeps only its latest area in `last_area`, a ship that drifted between areas could leave "orphan" rows keyed by its `mmsi` in other areas (and the `ship_scrape_cache`, which has no area tag, was never touched). `deleteAll` now also purges by `mmsi` and clears dangling `from_area` references. As a safety net against leftovers from older versions, manual edits or interrupted writes, an idempotent job — `db.pruneOrphans()`, scheduled in `src/server.js` at startup and then every 24h — removes any row whose parent (area or ship) no longer exists, logging the removed total to the application log (`db.orphans_pruned`).
2. **`bounding-boxes.json` file (manual)** — add/edit an entry by hand and **restart** the app. Useful for initial provisioning or scripts.

> The Areas screen rewrites `bounding-boxes.json` (it preserves the `_comment` key but normalizes formatting). Preset keys are derived automatically from the name.

The **🏠 Monitoring** sidebar button returns to the home (active/past/traffic views).

Changing the area in the dropdown at the bottom of the sidebar is a **view change only**: it shows data for the selected area but does not start or stop any stream. Each area has its own independent stream — to start or stop an area's stream use the sidebar buttons or the **"Area monitoring"** panel in Settings. The selected area is persisted to `local.properties` (key `BBOX_PRESET`). The *keyword* is used by the "Expected ships" section to filter ships with a matching destination.

## 🔎 Port discovery for an area

For every area, the system keeps a list of **discovered ports** in a dedicated `area_ports` table (`id`, `area_key`, `name`, `lat`, `lon`, `sources` JSON, `status` `'confirmed'|'review'|'rejected'`, `admin_reviewed`, `mst_pid`, timestamps; `UNIQUE(area_key, name)`; in `BACKUP_TABLES`). Query functions in `src/db.js`: `getAreaPorts`, `getConfirmedAreaPorts`, `countAreaPorts`, `upsertAreaPort`, `setAreaPortDecision`, `setAreaPortMstPid`. The upsert never resurrects an admin decision (`admin_reviewed = 1`): a later discovery run never moves an already-rejected port back to `review`/`confirmed`, nor downgrades one an admin already confirmed by hand.

**Discovery cascade** (`src/services/port-discovery.js`, `discoverPortsForArea(areaKey)`):

- **Berths shortcut**: if the area already has real observed berth clusters (`db.getBerths`), those **are** the answer — no external source is contacted at all. Berths are first clustered by geographic proximity (same `clusterCandidates`/`haversineM` as the cascade below, ~4km radius), and **each cluster becomes one port row** (source `berths`), not one row per berth: a real port is a group of nearby berths, not a single berth (fixed after the first implementation, which had this granularity wrong).
- Otherwise, a 4-source cascade (every available source is queried, it doesn't stop at the first one that answers):
  - **Global Fishing Watch — not viable**. GFW's public "anchorages" dataset isn't reachable via API: `GET /v3/datasets/public-anchorages:latest` → 404 (dataset not found), `.../public-anchorages` without `:latest` → 403 (not authorized — the dataset exists but this tier can't access it), no version alias resolves. GFW's own documentation confirms it plainly ("Anchorages and Voyages are not yet available in the APIs & packages") — the only access is a browser-authenticated download portal, out of scope here. `gfw.getAnchoragesInBbox()` is therefore a **permanent stub** that always returns `[]` — not a TODO, a confirmed dead end documented in the code, re-activatable later if GFW opens the endpoint.
  - **World Port Index (NGA) — working, real data**. `https://msi.nga.mil/api/publications/world-port-index?output=json`, an unauthenticated public GET, returns 2951 world ports with ready decimal-degree coordinates. Bundled once as `data/wpi.json`, generated by `scripts/build-wpi.js` (rerun manually, rarely — same pattern as the LOCODE/PSC bundles).
  - **UN/LOCODE**: extended to use the classification field `Function` (digit `'1'` = maritime port), previously discarded. `scripts/build-locode.js` now also emits `data/locode-ports.json` (18388 port-classified codes), cross-referenced against the coordinates already in `data/locode-coords.json`.
  - **VesselFinder**: `/ports` has no working search parameter (`?name=`/`?q=`/`?search=` are silently ignored — byte-identical output with or without them). Implemented instead as a **binary search** over VF's paginated, globally alphabetically-sorted `/ports` index (`src/services/scrapers/vesselfinder-ports.js`, ~9-10 requests per lookup) — paced with jitter between its own requests (1.5-4.5s, same pattern as `fallback-mode.js`) and a module-level page cache so repeat lookups in the same process don't re-fetch pages already seen.
  - Candidates from whichever sources answered are clustered by geographic proximity (reusing `haversineM` from `ship-analysis.js`, already used by `proximity.js` for rendezvous — ~4km radius, no second haversine implementation). **≥2 independent sources agreeing on a cluster → auto-`confirmed`; 1 source → `review`** (awaits an admin decision).
  - `mst_pid` (MyShipTracking's own internal port id, needed by a later new-ship-arrival-discovery plan — not used by this feature) is resolved lazily, **only for already-`confirmed` ports**, via the new `searchPort`/`getPortCoords` in `src/services/scrapers/myshiptracking.js`.
  - This cascade (when berths aren't enough) also jitters between candidates — the same anti-ban principle applied throughout the project to external request volume.

**Triggers**:
- **Automatic** on new-area creation (fire-and-forget, doesn't block the create-area response).
- **Boot backfill**: one-time, **sequential** (not parallel) queue, one area every 30 seconds, for areas that predate this feature and have zero `area_ports` rows yet (`src/server.js`, starts 60s after boot to let streams/DB settle first).
- **Manual**: a minimal control in Settings → AIS Diagnostics (area select + "Search ports now" button), fire-and-forget (`POST /api/areas/:key/discover-ports` responds `{ok:true}` immediately; the real work — which can take minutes for a fresh no-berths area — runs in the background; the control just shows a "Search started" message, no polling/outcome).

**Admin routes** (`src/routes/areas.js`, all `requireAdmin`): `GET /areas/:key/ports`, `POST /areas/:key/discover-ports` (fire-and-forget), `POST /areas/:key/ports/:id/confirm`, `POST /areas/:key/ports/:id/reject`. The last three remain available but **aren't exposed by any current UI** — discovered ports are backend-only data today, with no screen showing their list/status (see note below).

**UI**: **none right now beyond the manual control in AIS Diagnostics**. The first version of this feature also exposed, on the "🗺 Areas" screen, a per-area ports list with status badges and confirm/reject buttons — removed (2026-08-22) as premature: that UI existed before the berth→port granularity fix above, and discovered ports don't yet have a real consumer that justifies manual review at this stage (that arrives with new-arrival discovery via port pages, not yet implemented). `area_ports` rows still get populated silently in the background for when that's needed.

## 📻 Received AIS message types

- `PositionReport` — position, speed (SOG), course (COG), heading, navigational status
- `ShipStaticData` — name, callsign, IMO, dimensions, destination, draught
- `ExtendedClassBPositionReport` — Class B with extended data
- `StandardClassBPositionReport` — standard Class B

## 🗃️ Data retention

Max 10,000 records per message type. Automatic rotation (deletes oldest) every 500 inserts per type. Notifications (table `notifications`) retain the last 100 records **per feed** (personal and "Group activity" rotate independently), with automatic rotation on every insert.

**On-disk compactness.** The raw AIS payload (`raw_json`) is kept **only** for the message types that carry extra fields with no dedicated column (`ShipStaticData`, `ExtendedClassBPositionReport`); for position reports — the bulk of the rows — it is empty, because it adds nothing to the columns already extracted. Only the CSV export uses it (and a reading's "raw data" modal, which shows `{}` for position reports). The database runs in WAL mode with `auto_vacuum = INCREMENTAL`: a periodic maintenance pass (`runMaintenance` in `src/db.js`, every 5 minutes) runs `wal_checkpoint(TRUNCATE)` — needed because the long-lived readers (AIS stream / SSE) prevent the passive checkpoint from truncating the WAL — and `incremental_vacuum` to return the pages freed by rotation to the OS. On the first startup after the upgrade a one-time `VACUUM` converts the file to incremental `auto_vacuum` and clears the `raw_json` of existing position reports.

## 🎛️ Configurable parameters

| Parameter                       | File                              | Where                                 | Default        |
| ---------------------------------| ----------------------------------| --------------------------------------| ---------------|
| UI polling interval             | `public/js/store.js`              | `POLL_INTERVAL = 300000`              | 300000 ms (5m) |
| "Active ships" time window      | `src/db.js`                       | `ACTIVE_WINDOW = '-6 hours'`          | 6 hours        |
| "In port" retention window      | `src/db.js`                       | `PORT_WINDOW = '-24 hours'`           | 24 hours       |
| "Stationary" speed threshold    | `src/config.js` (+ `src/db.js`)   | `SOG_FERMA = 0.5`                     | 0.5 kn         |
| "Same stop" radius (in port)    | `src/config.js`                   | `STILL_RADIUS_M = 100`                | 100 m          |
| Track merge radius (de-noise)   | `public/js/store.js`              | `TRACK_MERGE_RADIUS_M = 100`          | 100 m          |
| WebSocket reconnection delay    | `src/services/ais-stream.js`      | `setTimeout(startStream, 5000)`       | 5000 ms        |
| AIS outage detection            | `app.config.properties`           | `AIS_OUTAGE_CHECK`                   | `true`         |
| Silence minutes before outage check | `app.config.properties`       | `AIS_OUTAGE_SILENCE_MIN`             | 10 min         |
| Self-hosted monitor URL (hybrid, primary) | `app.config.properties` | `AIS_UPTIME_SELFHOST_URL`            | _(empty)_      |
| Public AISStream uptime monitor URL (fallback) | `app.config.properties` | `AIS_UPTIME_URL`                  | `https://aisuptime.buttermilkgreen.fyi` |
| Max records per message type    | `src/db.js`                       | `pruneStmt.run(..., 10000)`           | 10,000         |
| Max map track points            | `src/routes/ships.js` (`/track`)  | `Math.min(..., 2000)` and default `500` | 500 points   |
| VF/MT scraping cache TTL        | `src/config.js`                   | `SCRAPE_CACHE_TTL`                    | 6 hours        |
| VF/MT scraping negative cache   | `app.config.properties`           | `SCRAPE_NEG_CACHE_DAYS`               | 3 days         |
| Hours of AIS outage before entering fallback mode | `app.config.properties` | `AIS_FALLBACK_HOURS` | 6 hours |
| Minutes of stable service before exiting fallback mode | `app.config.properties` | `AIS_FALLBACK_EXIT_GRACE_MIN` | 20 min |
| Max fallback-mode scrape budget/hour (SF+MST combined) | `app.config.properties` | `FALLBACK_MAX_REQ_PER_HOUR` | 90 |
| Circuit breaker: 403/429 failures to trip | `app.config.properties` | `FALLBACK_CIRCUIT_TRIP_COUNT` | 5 |
| Circuit breaker: failure time window | `app.config.properties` | `FALLBACK_CIRCUIT_TRIP_WINDOW_MIN` | 10 min |
| Circuit breaker: paused-source cooldown | `app.config.properties` | `FALLBACK_CIRCUIT_COOLDOWN_MIN` | 30 min |
| Notification delete undo bounce | `app.config.properties`           | `NOTIF_DELETE_UNDO_SECONDS`           | 5 s            |
| Berth clustering radius         | `app.config.properties`           | `BERTH_CLUSTER_EPS_M`                 | 80 m           |
| Minimum moorings per berth      | `app.config.properties`           | `BERTH_MIN_PTS`                       | 3              |
| Minimum moorings to characterize| `app.config.properties`           | `BERTH_MIN_MOORINGS`                  | 10             |
| Dominant-category threshold     | `app.config.properties`           | `BERTH_DOMINANT_PCT`                  | 60 %           |
| Berth recompute interval        | `app.config.properties`           | `BERTH_RECOMPUTE_MIN`                 | 30 min         |
| Rendezvous scan interval        | `app.config.properties`           | `PROXIMITY_SCAN_MIN` (0 = off)        | 10 min         |
| Rendezvous pair distance        | `app.config.properties`           | `PROXIMITY_DIST_M`                    | 500 m          |
| Rendezvous min. dwell           | `app.config.properties`           | `PROXIMITY_MIN_MINUTES`               | 10 min         |
| Minimum call in area (transit search + area change) | `app.config.properties` | `TRANSIT_STOP_MIN_H`             | 3 hours        |
| Speed below which the ship is "stopped" in the visit | `app.config.properties` | `TRANSIT_STOP_MAX_SOG_KN`     | 0.5 kn         |
| Minimum average speed of a direct passage | `app.config.properties`       | `TRANSIT_MIN_KN`                      | 4 kn           |
| Floor of the time limit between two areas | `app.config.properties`       | `TRANSIT_MIN_SLACK_H`                 | 12 hours       |
| Cap of the time limit between two areas | `app.config.properties`         | `TRANSIT_MAX_GAP_DAYS`                | 30 days        |
| Max ships per transit search    | `app.config.properties`           | `TRANSIT_MAX_ROWS`                    | 500            |
| Area change only on a real call | `app.config.properties`           | `AREA_CHANGE_REQUIRE_STOP`            | `true`         |
| Area change only if the call is recent | `app.config.properties`    | `AREA_CHANGE_REQUIRE_PLAUSIBLE_TIME`  | `true`         |
| Area change: skip overlapping areas | `app.config.properties`       | `AREA_CHANGE_SKIP_OVERLAPPING`        | `true`         |
| Replay: max positions per query | `app.config.properties`           | `REPLAY_MAX_POINTS`                   | 40,000         |
| Replay: max gap (hide ship)     | `app.config.properties`           | `REPLAY_MAX_GAP_MIN`                  | 30 min         |
| Replay: trail length            | `app.config.properties`           | `REPLAY_TAIL_MIN`                     | 20 min         |
| Coverage map: grid cell size    | `app.config.properties`           | `HEATMAP_GRID_DEG`                    | 0.25° (≈28 km) |
| Coverage map: DB flush interval | `app.config.properties`           | `HEATMAP_FLUSH_SEC`                   | 10 s           |
| Coverage map: stats push interval | `app.config.properties`         | `HEATMAP_STATS_SEC`                   | 2 s            |
| Auto-restore DB after deploy    | `app.config.properties`           | `AUTO_RESTORE_ON_DEPLOY`              | `true`         |
| On-disk auto-backup interval    | `app.config.properties`           | `BACKUP_INTERVAL_MIN`                 | 120 min (2h)   |
| Max request/response body bytes in log | `app.config.properties`    | `MAX_BODY_BYTES`                      | 2048           |
| Max API log records             | `app.config.properties`           | `MAX_API_LOG_RECORDS`                 | 1,000          |
| DB compaction interval (WAL + vacuum) | `src/server.js`             | `setInterval(db.runMaintenance, …)`   | 5 min          |
| Orphan-row cleanup interval         | `src/server.js`               | `setInterval(sweepOrphans, …)`        | 24h (+ startup) |

### Applying changes

No build required. Node.js interprets files directly.

| Modified file | Required action |
|---|---|
| Any file in `src/` | Server restart: `npm start` (or `npm run dev` for watch mode) |
| `public/**` (HTML, CSS, JS modules) | Browser reload (`Cmd+R`) — no restart needed |
| `app.config.properties` | Server restart (values are read once at startup) |

> The `app.config.properties` parameters are also editable from the UI: **⚙ Settings → Parameters**. The form is built from the file itself (sections become groups, comments become descriptions); saving rewrites the file preserving the comments. It **still requires a server restart** to take effect — the UI says so. Secrets (`local.properties`) are not exposed in the form.

## 🖥️ UI conceptual model

The interface is organized around **ships** (MMSI), not individual readings:

| View               | Content                                                                            |
| --------------------| -----------------------------------------------------------------------------------|
| **Active ships**   | Ships seen in the last **6 hours**, **or** "in port" ships seen in the last **24 hours**. Toolbar with **search** (name/MMSI/IMO/destination) and **filters** (risk band, in-port only, flagged only) + **CSV export of the filtered view** (see [Search, filters and export](#-search-filters-and-list-export)) |
| **Past ships**     | Ships that no longer meet the "active" criteria (complement). Same search/filter/export toolbar (without the "in port" filter) |
| **Ship detail**    | Organized into **tabs**: **General** (static ship info — type, IMO, callsign, dimensions, destination… — + **aggregated data table** reconciling the main fields across every enabled source, see below + **[risk score over time](#-risk-score-history)** + notes + visit history in monitored areas), **Readings** (track map with collapsed stops and replay, **pinned at the top while the table below scrolls** — see below — + paginated table of raw AIS readings, with a **Source** column distinguishing AISStream from ShipFinder/MyShipTracking backup fixes) plus **one tab per enabled external source** (VesselFinder, MarineTraffic, ShipFinder, MyShipTracking, Equasis, Global Fishing Watch — a disabled source has no tab). **📄 Report** button to generate a [printable/PDF report](#-ship-pdf-report) |

**Readings tab** — clicking a row (with a known position) jumps the replay ship marker exactly to that point (`seekTrackTo` in `public/js/maps.js`): a direct teleport to the reading's raw coordinates, not an interpolation along the animated path — works even for ShipFinder/MyShipTracking fixes not included in the drawn path ("Includi SF/MST" toggle off). It does not touch the animation's slider/progress state (private to the `setupTrackAnim` closure): pressing ▶ after a seek resumes from wherever the animation was. The 📄 icon on each row opens the raw JSON detail, decoupled from the row click (which triggers the seek). The map (`#detail-map`) is `position: sticky` **inside its own scroll box** (`#detail-panel-readings { max-height: calc(100vh - 240px); overflow-y: auto }`), not the page scroll: `#app` has `overflow:auto`, but since `body`/`#layout` use `min-height:100vh` rather than a fixed height, `#app`'s content never actually exceeds its own box, so `#app` never really scrolls and the document scrolls instead; CSS still treats `#app` as the nearest "scrolling ancestor" for sticky purposes (mere `overflow:auto` qualifies, whether or not it ever scrolls), so a plain sticky rule would just ride along with the page instead of pinning — hence the dedicated scroll box.
| **Traffic**        | Aggregate statistics: summary cards, arrivals by hour-of-day chart, arrivals by ship type; **risk score distribution** (green/yellow/red tiles for ships in the last 7 days), **top risk factors** (frequency), **daily arrivals** (last 30 days), **highest-score ships** (top 8, clickable); expected ships (by preset keyword), latest port events |
| **Areas**          | Runtime area management: list with coordinates/status/stored data, map showing all areas, panel to add (GPS coordinates or map view capture), **edit** (click a row → the area is loaded into the panel and framed on the map) and delete areas (with related history and a 10s undo window) |

Accessory modals: **Settings**, organized into tabs: **General** (VF/MT/sanctions/PSC/Equasis import toggles and notifications, the **OpenSeaMap tile layer** and **OpenSeaMap markers** toggles with marker-category selection), **Areas** (per-area start/stop stream toggles), **External integrations** (Telegram bot linking + per-category toggles + outbound webhooks), **Parameters** (`app.config.properties` editor), **Backup/Restore** (auto-backup, CSV export, database backup/restore), **Activity log** (operational event log, live via SSE), **API Log** (live panel of API requests via SSE) and **AIS Diagnostics** (uptime, msg/min, reconnections, last error). Sidebar navigation buttons: **🏠 Monitoring** (home) and **🗺 Areas**. The sidebar also includes the **🔔 Notifications** button (unread badge, opens the shared overlay, see [Port events, statistics and alerts](#-port-events-statistics-and-alerts)) and, for group members, a second **👥 Group activity notifications** button with its own badge/overlay (see [User groups](#-user-groups)).

A ship "enters" the active list as soon as it receives its first reading. The window is wide (6 hours) because anchored ships transmit infrequently: a moored ship may update its position only every 3 hours (AIS Class A standard). Ships **in port** (see below) have an even wider retention (24 hours), so they remain visible after a server restart before their next transmission.

The "seen" flag (★/☆) is available in all three views: as a column in the active table, a column in the past table (★ moves the ship to the bottom of the list), and as a button in the ship detail header.

## ☢️ Ship type highlighting (Hazmat)

**AIS limitation**: the AIS `ship_type` field (ITU-R M.1371) distinguishes only broad classes — `70–79` = Cargo, `80–89` = Tanker, etc. It does **not** separate subtypes like General Cargo / Container / Ro-Ro / Heavy-Lift: they all fall under `70–79`. The precise subtype (e.g. "Ro-Ro", "Container Ship") is only available from MarineTraffic data downloaded for the individual ship (field `typeSpecific`, see below).

**Hazmat** subtypes (`71–74` / `81–84`, IMO dangerous goods — Class 1 is explosives/ammunition) receive a ☢ badge on the type. Helper `isHazmat(code)` in `public/js/helpers.js`.

> The "cargo/tanker for arms transport" relevance is no longer a standalone highlight: it has been folded into the **hull type** as a factor in the [risk score](#risk-score-potential-arms-transport) (cargo/tanker +5, hazmat +8, military → automatic score of 100). The old `isWeaponRelevant` function has been removed: it was a subset (only `70–79`) already covered by the risk model.

## 🛡️ Risk score (potential arms transport)

Every ship is assigned a **risk score 0–100** that estimates the probability that the ship is transporting weapons/ammunition, derived **exclusively from AIS data**. It is shown as a colored badge in the lists (column **Risk**) and in the ship detail view (value + factor breakdown).

| Band   | Color | Meaning |
|---|---|---|
| **0–30**   | 🟢 green (`risk-low`) | Normal navigation: consistent draught, standard commercial routes |
| **31–70**  | 🟡 yellow (`risk-med`) | Minor anomalies (e.g. brief AIS blackout, course change): routine monitoring |
| **71–100** | 🔴 red (`risk-high`) | Combination of critical factors → flagged for inspection |

### Fundamental limitation

AIS messages **do not describe hold contents**: they transmit only kinematics (position, course, SOG) and self-declared static/voyage data (name, destination, draught). The score therefore cannot "see" weapons — it translates into risk indicators the **behavioural signatures** (anomalies) derivable from the reading and event history of each ship, according to a **weighted sum** model with a final **geopolitical multiplier**.

### Calculation model

Implemented server-side in [`src/services/risk-score.js`](../../src/services/risk-score.js) — `computeRiskScore(ship, lang)`. For each ship it queries (read-only) the history via `db.getShipPositions` (positions last 168h), `db.getShipEvents` (port events), `db.getDistinctShipNames`. If VF/MT import is enabled, it also reads registry data **already in cache** via `db.getScrapedData` (see [Score enrichment from VF/MT](#score-enrichment-from-vfmt)) — read-only, no live scraping during calculation.

Each detected signature adds weighted points to an **anomaly subtotal**:

| Behavioural signature | Detection logic | Max weight |
|---|---|---|
| **AIS blackout (dark activity)** | Longest gap between consecutive readings **started while the ship was moving** (SOG ≥ `SOG_FERMA`). Ships in port transmit rarely → only silences while underway are counted. ≥ 6h → max; 2–6h → partial | 25 |
| **Spoofing / anomalous kinematics** | Implied speed between two consecutive positions (haversine distance / Δt, with Δt ≤ 1h, distance > 500 m). > 80 kn = physically impossible jump; > 50 kn = anomalous | 20 |
| **Draught increase (loading)** | Maximum positive increment of declared `draught` between consecutive port events (AIS unit = tenths of a metre). Indicates heavy cargo loaded. ≥ 0.5 m activates the score | 20 |
| **Loitering / anomalous stop** | Stationary positions (SOG < `SOG_FERMA`), **not** moored/at anchor (status ≠ 1/5), > 10 km from the bbox monitoring centre → possible ship-to-ship transfer in open sea | 15 |
| **Ship-to-ship rendezvous** | **Local** detection (from our own AIS feed, see the [dedicated section](#-ship-to-ship-rendezvous-detection)): a confirmed rendezvous — two distinct ships close, slow and offshore for ≥ `PROXIMITY_MIN_MINUTES` — adds points to **both** ships for rendezvous within the recent window (`RISK_PROXIMITY_WINDOW_DAYS`, default 7 days). Transshipment signature, independent of GFW. Counts distinct partner ships; 0 disables the factor | 18 |
| **Destination instability** | Number of distinct declared destinations (current field + events). More changes = more points | 10 |
| **Hull type** | Military (35) → **automatic score 100** (early return, no analysis); Cargo/Tanker Hazmat (71–74, 81–84) → 8; Cargo/Tanker (70–89) → 5 | 100 / 8 / 5 |
| **Military detection** | `isMilitary(ship)` in `risk-score.js`: **DB flag** `is_military = 1` **or** `ship_type === 35` **or** ship name contains military tokens (prefixes: `HMS`, `USS`, `FS`, `FGS`, `HNLMS`, `HMAS`, `HMCS`, `INS`, `BNS`, `HDMS`, `HTMS`, `TCG`, `ORP`, `ITS`, `ROKS`, `NRP`, `RFS`, `ESPS`, `SPS`; keywords: `WARSHIP`, `NATO`). Detected ships: receive `is_military: true` and `flagged: true` forced in the API response, row highlighted red with `.military-row` class (takes priority over `.flagged-row`). The manual flag (`is_military` in DB) allows marking military vessels that have neither `ship_type 35` nor a recognised prefix/keyword (e.g. Italian Navy ships transmitted without the "ITS" prefix). Set from the detail panel using the `🪖 Mark as military vessel` button. | — |
| **Hull name change** | Same MMSI transmitting multiple distinct names (flag/name hopping) | 8 |
| **External enrichment (VF/MT)** | Registry data from VesselFinder/MarineTraffic, **only if import is enabled and already cached** (see below): flag registered under embargo → 12, flag of convenience → 5, aged hull (≥ 35 years) → 6, home port in high-risk zone → 8 | 12 |
| **Sanctions (OFAC SDN + EU/UK/UN)** | Match against the sanctions lists by IMO/name/call sign, only if `IMPORT_SANCTIONS` (see `sanctions.js`): on top of OFAC SDN, also matches the EU consolidated list, the UK OFSI list and the UN designated-vessels list (via OpenSanctions), extra lists gated by `IMPORT_SANCTIONS_EXTRA`. Very strong direct signal | 60 |
| **Port State Control (Paris/Tokyo MoU)** | Only if `IMPORT_PSC` (see below): flag on MoU black list → 12, on grey list → 5; vessel on the Paris MoU banned list (refusal of access after repeated detentions) → 40 | 40 |
| **Global Fishing Watch events** | Only if `IMPORT_GFW` (see below): behavioural events derived and classified by GFW from the global AIS feed, **authoritative confirmations** of the signals the AIS-only model infers heuristically. At-sea encounter (ship-to-ship transshipment signature, `RISK_GFW_ENCOUNTER`) → 18, AIS-off/gap event while underway (`RISK_GFW_GAP`) → 15, loitering (`RISK_GFW_LOITERING`) → 12, port call in a high-risk area (`RISK_GFW_PORT_VISIT_HIGH_RISK`) → 15. Behavioural factors (pass through the geopolitical multiplier) | 18 |

**Geopolitical context multiplier** applied to the anomaly subtotal:

- `× +0.5` if the declared destination contains a port/country under embargo or conflict zone (list `HIGH_RISK_DEST`: Syria, Iran, North Korea, Libya, Yemen, Sudan, Russia/Crimea, Somalia…), **or** if the flag belongs to an embargoed state (`EMBARGO_MID`: NK 445, Syria 468, Iran 422, Libya 642, Russia 273).
- `× +0.2` if the ship flies a **flag of convenience** (`FOC_MID`: Panama, Liberia, Marshall Islands, Comoros, Togo, Tanzania, Cook Islands, Sierra Leone, Moldova, Cambodia, Palau, Mongolia…).

The **flag** is derived from the **MID** (Maritime Identification Digits = first 3 digits of the MMSI).

Final formula:

```
score = clamp( round( anomalySubtotal × multiplier ), 0, 100 )
```

`computeRiskScore(ship, lang)` returns `{ score, band, factors, sanctionMatch, sources }`, where `band` ∈ `low|med|high`, `factors` is the ordered list `{label, points}` of signatures that contributed (labels in the requested language), `sanctionMatch` is `null` or the structured sanctions-match detail (`{ source, sourceKey, program, flag, owner, aliases, listedName, matchedOn, matchedOnLabel, url }`, consumed by the Sanctions panel in the ship detail view), and `sources: { vf, mt, gfw, sanctions, psc }` indicates which external sources were present/consulted at calculation time (each `none`/`available`/`used`). The `lang` parameter (`'it'` default, `'en'` supported) is forwarded automatically by `api.js` based on the language selected in the frontend.

### Signal weights editable from the UI (Risk model)

The values in the table above are the **defaults** (from `app.config.properties`, `RISK_*` keys), but the **point weights** of the ~24 signals are also **editable at runtime** from Settings → the **⚖ Risk model** section, with no restart — the same mechanism as the [per-cargo-type weights](#cargo-type-and-load-state). Admins only. The **detection thresholds** (blackout hours, spoofing kn, loitering km/positions, draught Δ, vessel age, rendezvous window days) and the **geopolitical multipliers** stay boot-only in `app.config.properties`.

- **Live override**: the override is saved as a single JSON property `RISK_WEIGHTS` in `local.properties`, layered over the `RISK` defaults; `risk-score.js` always reads `state.riskWeights` (which carries the full `RISK` set with only the point weights overridable). Editing a weight invalidates the score cache so recomputation is immediate.
- **Risk profiles (presets)**: like the cargo "weight classes" — a built-in **Default** profile plus operator-saved profiles, stored as a JSON row in the `meta` table (key `risk_weight_presets`, included in backups). Endpoints: `POST /api/settings/risk-weights`, `GET|POST /api/settings/risk-presets`, `POST /api/settings/risk-presets/apply`, `DELETE /api/settings/risk-presets/:id` (all `requireAdmin`). Service in [`src/services/risk-presets.js`](../../src/services/risk-presets.js); the editable weights are listed in `config.EDITABLE_RISK_WEIGHTS`.

### Score enrichment from VF/MT

When VesselFinder and/or MarineTraffic import is enabled, the score also uses **registry data** downloaded from those sources (`loadEnrichment` in `risk-score.js`), which the AIS-only model cannot see:

| Field (VF/MT label) | Signal | Points |
|---|---|---|
| `Bandiera` / `Flag` | Flag **registered** under embargo (NK, Syria, Iran, Libya, Russia). Independent of the MMSI MID → catches **reflagging** | 12 |
| `Bandiera` / `Flag` | Flag of convenience (Panama, Liberia, Marshall Islands, Comoros, Togo, Tanzania, Cook Islands, Sierra Leone, Moldova, Cambodia, Palau, Mongolia, Ivory Coast) | 5 |
| `Anno costruzione` / `Year built` | Aged hull (≥ 35 years) — old vessels preferred for sanctioned trade | 6 |
| `Porto di armamento` / `Home port` | Home port in a high-risk zone (list `HIGH_RISK_DEST`) | 8 |

Rules:

- **Only enabled sources**: reads VF only if `IMPORT_VF_DATA`, MT only if `IMPORT_MT_DATA`. Import off → zero contribution.
- **Cache only, never live**: `loadEnrichment` reads only `ship_scrape_cache`. Score calculation remains synchronous and fast for list endpoints (`/ships/active`, `/ships/past`). The cache is populated by the [proactive enrichment on first detection](#proactive-enrichment-on-first-detection) or when the ship detail is opened.
- **VF + MT merged**: for each field the first source that provides it wins (no double counting). Each factor in `factors` reports its source (`fonte VesselFinder`/`fonte MarineTraffic`).
- If the ship has never been enriched (no cache), the score falls back to the AIS-only model.

### Port State Control screening (Paris/Tokyo MoU)

Enabled by `IMPORT_PSC`, implemented in [`src/services/psc.js`](../../src/services/psc.js) with the same **dataset** pattern as sanctions (`sanctions.js`): lists preloaded in memory, matched locally per ship, **no per-ship network call**. Two complementary signals:

| Level | Signal | Source | Match | Points |
|---|---|---|---|---|
| **1 — Flag performance** | Flag on MoU **black list** (high-risk registry for detentions/inspections) → 12; on **grey list** → 5; **white list** → 0 (quality registry) | Annual white/grey/black lists of **Paris MoU** + **Tokyo MoU**, bundled in the repo as `data/{paris,tokyo}-mou-flags.json` | By flag name (from the VF/MT registry field, normalized) | 12 / 5 |
| **2 — Banned vessels** | Vessel on the Paris MoU **banned list** (refusal of access after **repeated detentions**) — the strongest "many detentions" signal | OpenSanctions mirror of the EMSA/Paris MoU list (CSV, `latest` URL) | By IMO, then name | 40 |

Rules:

- **The flag lists are regional ground truth** and **override the hardcoded `FOC_FLAG_NAMES` heuristic**: a flag found on the MoU lists uses the MoU verdict (e.g. Panama = grey → 5, Liberia = white → 0), not the fixed list. The embargo-flag check still takes priority.
- **Paris over Tokyo**: on a conflicting verdict Paris MoU wins (monitored region = Paris area); Tokyo only fills flags Paris doesn't list.
- **PDFs aren't machine-readable**: the MoUs only publish PDFs, so the flag lists are transcribed by hand into the JSON files and **must be updated ~once a year** (source URL and validity date are in the files). The **banned list** is instead downloaded and refreshed every 24h like OFAC.
- **Offline-safe**: at startup it loads flag lists + banned list from the on-disk cache; it downloads the banned list only if not already cached.

### Frontend

Helpers in `public/js/helpers.js`: `riskClass(score)` (maps band → CSS class) and `riskBadge(risk)` (interactive colored badge). The score drives:

- **Risk column** in the active/past ship lists; rows in the red band have the `.risk-row` class (red border/background). Automatically detected military ships (`is_military`) have the `.military-row` class (red, takes priority over `.flagged-row`).
- **Ship detail**: score in the info-bar + weighted factor breakdown (`riskFactorsHtml`). Factor labels are returned in the current language by the server.
- **Markers on the overview map** (`renderActiveMap` in `public/js/maps.js`): color by risk band — 🟢 green (`low`) · 🟡 yellow (`med`) · 🔴 red (`high`). **Flagged** (★ `flagged`) ships take priority and are colored **🟣 purple**, both as markers and as list rows (`.flagged-row`). Auto-detected military ships retain red even when flagged. The marker popup shows the risk badge.

**Source indicator** — each badge shows a small dot in the top-right corner indicating which extra data was used in the calculation:

| Color | Meaning |
|---|---|
| Magenta | Score includes VesselFinder data |
| Yellow | Score includes MarineTraffic data |
| Orange | Score includes VesselFinder **+** MarineTraffic data |
| Red (Sanctions ⚠) | Vessel present on a sanctions list (OFAC / EU / UK / UN) |
| Blue (Paris/Tokyo MoU ⚓) | Signal from the Port State Control lists (black/grey flag or banned vessel) |
| Teal (Global Fishing Watch) | Score calculated using Global Fishing Watch events/identity |
| *(absent)* | AIS-only data |

The dot appears only if the data was already in cache at calculation time (same guarantee as the "Cache only, never live" point above).

**Hover tooltip** — hovering over the badge shows a panel with the score and risk band (colored), the list of factors with their weights, and the sources used in the calculation. Managed via global event delegation in `initRiskTooltip` (`public/js/main.js`); data is serialized in the badge's `data-risk` field (HTML-escaped JSON).

Styles `.risk-badge`/`.risk-low|med|high`/`.risk-src-dot`/`.src-vf|mt|both`/`.risk-tooltip`/`.rf-list`/`.risk-row`/`.flagged-row`/`.military-row` in `public/css/style.css`.

### Accuracy caveat

With **single bounding box** monitoring, a ship that leaves the area generates a long reading gap that the blackout detector interprets as "dark activity" — an inherent false positive, not a real transponder switch-off. The score is a **triage/screening** tool, not proof: ships in the red band should be verified with external sources (MT/VF) and physical inspection.

## 🔎 Search, filters and list export

The **Active ships** and **Past ships** views have a toolbar above the table to narrow the list without reloading from the server (**client-side** filtering over already-downloaded data):

- **Text search** — case-insensitive substring over name, MMSI, IMO, destination and callsign.
- **Risk band** — all / 🟢 green / 🟡 yellow / 🔴 red.
- **In port only** (Active only) and **Flagged only** (★).

A `shown / total` counter appears when a filter is active. The overview map reflects the same filters. The **⬇ Filtered CSV** button exports the **current** (filtered and sorted) view as CSV (one file per list, generated in the browser via `Blob`, with a UTF-8 BOM for Excel): columns MMSI, name, type, destination, SOG, COG, in-port, score/band, flagged, military, first/last seen, callsign, IMO, lat/lon. It complements the [full ZIP export](#-internal-api) (`/api/export`), which remains the raw export of all readings per message type.

### Geospatial export (GeoJSON / KML)

To take the data into **QGIS** or **Google Earth**, next to the CSV there are **⬇ GeoJSON** and **⬇ KML** buttons, all **client-side** (built in the browser from data already loaded, like the CSV). Coordinates are emitted in `[lon, lat]` order. Implemented in [`public/js/geoexport.js`](../../public/js/geoexport.js). Four sources:

- **Filtered ship list** (active/past toolbar) → one **Point** per positioned ship, with MMSI/name/type/destination/SOG/COG/score/band/flagged/military/IMO/call-sign properties.
- **Single ship track** (ship detail, under the map) → a **LineString** along the fixes + one **Point** per fix (with timestamp), from `/api/ships/:mmsi/track`.
- **Replay window** (Replay bar) → one **LineString per ship** over the loaded time window (MMSI/name/band/range properties).
- **Berths** ("Berths GeoJSON/KML" buttons in the toolbar) → one **Polygon** per berth (category, mooring count, hazmat %), from the `polygon_json`.

KML uses `Placemark` with `ExtendedData` for the properties; GeoJSON is a `FeatureCollection`. An empty export shows a toast warning.

## 📈 Risk score history

The [risk score](#-risk-score-potential-arms-transport) is recomputed on every request, but it is also **sampled and stored** over time (table `risk_history`) so the ship detail can plot its **trend** — an escalation is itself a signal.

- **Sparse sampling**: `db.recordRiskSnapshot(mmsi, score, band)` inserts a point **at most once per hour per ship**, plus whenever the score changes. No bloat: the table is also globally capped (rotation at 20,000 rows).
- **Sampling points**: on every ship **arrival** (the stream already computes the score for the `high_risk` notification) and when the **detail view is opened** (`GET /api/ships/:mmsi`).
- **Display**: band-colored bar chart in the ship detail (`renderRiskHistory` in `public/js/ships.js`), with overall change (▲/▼). At least two samples are needed; until they accumulate it shows a hint. Endpoint `GET /api/ships/:mmsi/risk-history`.
- History is included in the database backup and deleted together with the area's data (or all of it) by the delete functions.

## 📄 Ship PDF report

The **📄 Report** button in the detail header generates a **printable report** of the ship: it opens a window with a self-contained HTML document (inline styles) and triggers the browser print dialog — from which it can be saved as **PDF** (*Print → Save as PDF*). No server-side PDF dependency. The report includes a header (name, MMSI, date), **risk score with factors**, a ship-data table, **visit history in monitored areas** (with area, destination and draught) and operational notes, plus a disclaimer about using the score as a triage tool.

## ⚓ "In port" detection and track de-noising

A moored/anchored ship is not perfectly still: it swings on its anchor, drifts with the current, and has GPS noise. These small movements must be distinguished from actual movement.

> **AIS note**: *speed through water* (STW) is **not transmitted** by AIS messages — only **SOG** (Speed Over Ground) is available. Classification therefore uses SOG + distance between positions, not STW.

**Flag `in_port`** (`isInPort` in `src/services/ship-analysis.js`) — a ship is "in port" if:
1. the AIS navigational status is moored (`5`) or at anchor (`1`), **or**
2. *(hysteresis)* positions over the last 30 minutes all remain within `STILL_RADIUS_M` (100 m) of their centroid — it is stationary, just drifting/swinging, even if the instantaneous SOG occasionally exceeds the threshold, **or**
3. the last SOG is < `SOG_FERMA` (0.5 kn).

Hysteresis prevents anchor swing from causing the ship to "flicker" in and out of the in-port state. In-port ships are marked with the ⚓ badge (list, map popup, detail) and benefit from 24-hour retention.

**Track de-noising** (`collapseTrack` in `public/js/maps.js`) — in the detail map, consecutive stationary points (SOG < 0.5) within `TRACK_MERGE_RADIUS_M` (100 m) are collapsed into a single **⚓ Stop** node (popup with number of positions and time range). The polyline passes through the centroids → a clean track instead of a cloud of markers around the berth. Raw readings in the DB remain intact: the merge is display-only.

## ⏯️ Historical replay (time-scrubber on the area map)

The **single ship track** in the detail view (`setupTrackAnim`) now also has time filters (**6h / 24h / 7d / all**, or a custom from/to range) and **speed multipliers** (1× / 5× / 20× / 60×); endpoint `GET /api/ships/:mmsi/track?window=6h|24h|7d|all` or `?from=ISO&to=ISO`. Here too, when ShipFinder/MyShipTracking are enabled and the ship has scraped positions, an **Include SF/MST** toggle appears (under the detail map, on by default, `?scraped=1` → `db.getShipTrack`/`getShipTrackRange` with widened `sources`, `extraAvailable` via `db.hasShipScrapedPositions`, state `S.trackUseScraped`): the SF/MST fixes enter the animated route, with distinctly coloured nodes (amber SF / teal MST) and a source note in the popup. The **active-ships** map has a separate **area-wide historical replay**: review the traffic of every ship in an area over a chosen time window. Frontend in [`public/js/replay.js`](../../public/js/replay.js); endpoint `GET /api/replay`.

The **▶ Replay** button in the toolbar enters replay mode (hides the live markers, shows the controls bar). You pick:

- **Area** — one of the user's areas (defaults to the current one);
- **Window** — quick presets **1h / 6h / 24h / all**, or a **custom** from/to range with the two datetime pickers. The window is anchored to the area's **most recent data** (not the wall clock), so the scrubber always lands on data even after a quiet spell, and it is clamped to what's available in `readings` (rolling, capped at 10k/type).

**Playback model** — a **global clock** runs from the window start to its end. At any instant T each ship is drawn at the position **interpolated** between its two surrounding fixes — *unless* those fixes straddle a gap longer than `REPLAY_MAX_GAP_MIN` (default 30 min): then the ship is **hidden** (no fabricated motion across missing data, e.g. AIS off or the ship leaving the area). A **fading trail** of `REPLAY_TAIL_MIN` (default 20 min) shows the recent path. Markers are **risk-band coloured** (the score is the current one) and **clickable** to open the detail.

**Controls** — play/pause, a **scrubber** (manual seek) and **speed multipliers** (1× / 5× / 20× / 60× of real time). The status line shows ships loaded, the available range, and any truncation.

**Include SF/MST** — by default the replay uses **AIS fixes only**. When ShipFinder and/or MyShipTracking are enabled *and* there are positions from them in the window, an **Include SF/MST** toggle appears next to the controls (on by default): it also folds in the scraped positions when drawing the animated route, handy for filling the stretches where AIS went dark. Clearing it reverts the replay to AIS only. It is a **per-session** toggle (`S.replayUseScraped`), not persisted; changing it reloads the current window.

**Data** — `GET /api/replay?area=KEY&window=1h|6h|24h|all` (or `&from=ISO&to=ISO`) returns the positions inside the area bbox over the window, **grouped by ship** (`db.getAreaReplayPositions`), plus the available range (`db.getAreaReplayRange`) and the per-ship risk band. With `&scraped=1` the included sources become `('ais','sf','mst')` (only for the integrations actually enabled); without the param it stays `'ais'` only. The response carries `extraAvailable` (boolean: SF/MST fixes exist in the window regardless of the toggle — drives the client toggle's visibility, via `db.hasAreaReplayPositions`). The total is capped by `REPLAY_MAX_POINTS` (default 40,000); beyond that the response is flagged `truncated`. Read-only: it only reads existing `readings`.

## ⚓ Berths (automatic mooring characterization)

The system infers by itself **where** vessels moor and **what type** they are, highlighting "characterized" quays with a coloured overlay on the active-ships map. Everything is hand-editable.

**Pipeline** (`src/services/berths.js`, per area):

1. **`detectMoorings(area)`** — one mooring point per visit = centroid of the vessel's *stationary* readings (`sog < SOG_FERMA` or AIS moored/anchored status `5`/`1`) in the window between one arrival and the same vessel's next arrival (arrivals come from `port_events`). Pure-transit visits (no stationary reading) are dropped. Each point is tagged with the vessel **category** (`src/services/ship-categories.js`: cargo, tanker, passenger, fishing, service, military, pleasure, high-speed, other).
2. **Clustering** — DBSCAN with haversine distance (`BERTH_CLUSTER_EPS_M`, `BERTH_MIN_PTS`). Points inside a **manual** berth polygon are assigned first and excluded from clustering (hand-drawn geometry wins). An automatic berth's geometry is the **convex hull** of its points.
3. **Characterization** — category tally per berth: the dominant one (≥ `BERTH_DOMINANT_PCT`, over at least `BERTH_MIN_MOORINGS` moorings) names and colours the berth, otherwise it is **"mixed"**; below the minimum it stays uncharacterized (dashed). It also computes the **hazmat** share (☢, AIS codes 71–74/81–84).

**Edit persistence** — automatic berths are rebuilt on every recompute, but a renamed/overridden berth regains its identity by centroid proximity (within `eps`). **Manual** berths (geometry locked by `manual_geom=1`) are never moved. The automatic characterization is always recomputed, but the manual override (`char_override`) takes precedence at read time.

**Compute cycle** — one-shot *backfill* at startup (`berths.recomputeAll()` in `src/server.js`, idempotent) over all history, then periodic background recompute every `BERTH_RECOMPUTE_MIN` minutes.

**Frontend** (`public/js/berths.js`) — `L.polygon` overlay on a dedicated pane (below the ship markers, so it never steals their clicks) plus a constant-size **centroid marker** (the ~80 m polygon is invisible at the area-wide zoom level), a **Berths** toggle in the filter bar (state in `localStorage`), a popup with the percentage distribution, and a management panel (**⚓ Berths**): rename, force category, merge, delete, recompute; **clicking a list row** centres the map on the berth and opens its popup.

## 🌊 OpenSeaMap Overlay

**OpenSeaMap** integration (free CC-BY-SA data, **no API key**), enabled from Settings (default **on**). Two **independent** layers, one toggle each:

- **Nautical tile layer** — `showOpenSeaMap` toggle (`public/js/tiles.js`, `addBaseLayers`). Transparent raster overlay `tiles.openseamap.org/seamark/{z}/{x}/{y}.png` on **all 4 maps** (detail, active, followed, areas) above the OSM tiles. Shows buoys, lights, marks, traffic separation, fairways, anchorages. It's a single raster → **all or nothing, not filterable per element** (to hide lights/beacons etc. you turn off the whole layer). `applyOpenSeaMap()` adds/removes it live on every map.
- **Vector markers** — `showOpenSeaMapMarkers` toggle (`public/js/seamarks.js`). On the **active map**, official harbours/berths/moorings/anchorages/marinas (plus lights, beacons, hazards, pilot points) pulled from **OpenStreetMap via the Overpass API** (`overpass-api.de`, queried directly from the browser, CORS ok), cached per bbox, drawn in a dedicated pane (z360, above the auto-computed berths z350, below the ship markers z400). They let you **compare** official moorings against the app's own computed berths. Hover → tooltip with the name, category and a short explanation of the element.
  - **Category selection**: Settings lets you choose which marker categories to show (default all; live re-render on change). Categories live in `SEAMARK_CATEGORIES` (`seamarks.js`); the **hidden** set is persisted as `OPENSEAMAP_HIDDEN` (JSON array in `local.properties`) — the disabled set is stored, so categories added in a future version stay visible by default. Applies to the vector markers only (the tile layer always shows everything).

> **No database, no migration**: the toggles live in `local.properties` (`SHOW_OPENSEAMAP`, `SHOW_OPENSEAMAP_MARKERS`, `OPENSEAMAP_HIDDEN`) and the Overpass data is fetched live, never stored. OpenSeaMap's `depth-api3` is **not** used (it would need a self-hosted Django+PostGIS backend). **Coverage**: in commercial ports the `berth`/`mooring` tags are often missing — hence the Overpass query also covers harbours/basins/anchorages/marinas, and the tile layer stays the primary visual source.

## 🌐 Coverage map (AISStream coverage)

A **worldwide** AISStream subscription aggregates incoming position messages into a **lat/lon grid** (per-cell message count) to show where AIS coverage is dense and where the holes are. It is its own sidebar view (🌐): a world Leaflet map whose cells are coloured by density on a **log scale** (blue → red), drawn with the **canvas renderer** for performance. Frontend in [`public/js/coverage.js`](../../public/js/coverage.js).

**Privacy by design** — each cell stores **only** the per-cell message count and last-seen timestamp (`msg_count`, `last_seen`). **No** ship names, **no** positions, no MMSIs are persisted.

**Hot path** — the firehose is high-volume, so the pipeline is: parse → increment an **in-memory** per-cell counter → **batch-flush** to the database every `HEATMAP_FLUSH_SEC`. There is **never** one DB write per message.

### Visibility

- The **map** (current cells) is visible to **all authenticated users**, read-only, via `GET /api/heatmap/cells`.
- **Collection start/stop**, live connection stats and **export/import** are **admin-only**.
- A **public page** (no login required) is available at `GET /heatmap`: a standalone Leaflet map served from `GET /api/heatmap/public-cells` (rate-limited to 30 req/min per IP), exposing only aggregated cell counts — no ship or user data.

### Collection (admin-controlled background task)

Collection is an **admin-controlled background task**: pressing **Start** runs the worldwide firehose **in the background** until an admin presses **Stop**, regardless of who has the page open. The desired state is **persisted** (key `heatmap_collecting` in the main DB `meta` table) and **auto-resumes on server restart**.

> ℹ️ **Safety sweep**: a **10-minute** periodic sweep stops the firehose if **no user has been active in the last 10 minutes** — so the bandwidth-heavy stream never runs unattended forever.

**Admin panel** — shows: status, current bandwidth, downloaded (this session), messages/s, messages (this session), connection (uptime + reconnects), populated cells and total messages. Buttons: **Start/Stop**, **Refresh map**, **Clear data**. A warning banner reminds the operator about the bandwidth use and the need for a separate account.

### Dedicated AISStream account

> ℹ️ **Separate key required.** The feature needs `HEATMAP_AIS_API_KEY` in `local.properties`, taken from a **separate AISStream account**. AISStream's connection limit is **per-account, not per-key**: a key on the **same** account as `AIS_API_KEY` is rejected (the WebSocket opens, then closes with code **1006** and no error frame) and would **starve the area streams** of their connection slot. Without the key the feature is **inert**. The value is **bare** — the parser does **not** strip inline `//` comments on a value line, so do not append a comment.

**Measured bandwidth**: ~100–300 msg/s ≈ ~200–400 MB/hour.

**Reconnect hardening** — exponential backoff (`5s × 2^failures`, capped at 5 min) on sessions that close having received **no** messages; after **3 consecutive** failures it surfaces a diagnosis (likely per-account limit / invalid key).

### Separate database

The coverage data lives in a **separate** database, `data/db/heatmap_data.db` (module [`src/heatmap-db.js`](../../src/heatmap-db.js)) — **not** in the main DB and **not** in `BACKUP_TABLES`. It can be **exported/imported on its own** from **Settings → Backup** (`GET /api/heatmap/export` / `POST /api/heatmap/import`, **replace** semantics), and it is also embedded in the **full bundle** (v3 format `TPB3`: header + main DB + heatmap DB, both length-prefixed and streamed). Older **v1/v2** bundles still restore (they simply carry no heatmap section).

**Grid** — `HEATMAP_GRID_DEG` in `app.config.properties` (default **0.25°** ≈ 28 km). Smaller cells are more precise but the cost grows **quadratically** (render, payload, DB rows). Changing the grid **invalidates** stored cells (a cell index is `floor(coord/grid)`) → use **Clear data** after a change.

### Noise filtering: (0,0) position and "singleton" cells

Analyzing a real export surfaced two distinct forms of noise, both **external data** (AISStream/its feeders), not a parsing bug on our side (same `MetaData.latitude/longitude` extraction as `ais-stream.js`/`ship-follow.js`):

- **"Null Island" (0°,0°)** — the classic "GPS not fixed" sentinel some feeders emit instead of the proper ITU-R M.1371 invalid-position code (91°/181°, already rejected by the existing lat/lon range check). It slipped through because 0 is a finite, in-range value. **Fix**: `heatmap-stream.js` now explicitly discards `lat===0 && lon===0` before buffering the cell (same spot as the range check). This only affects **future** ingestion — (0,0) cells already accumulated in the DB stay until manually removed (`DELETE FROM heatmap_cells WHERE lat_idx=0 AND lon_idx=0` on the heatmap DB, or "Clear data" which wipes everything).
- **Isolated "singleton" cells** (`msg_count = 1`, no populated cell nearby) — the typical signature of a **satellite-AIS** positioning artifact: when the receiver can't properly resolve a ship's position from a marginal detection, some feeds fall back to the satellite's own sub-point/ground-track (near-constant longitude during a single orbital pass, wide latitude spread) instead of dropping the message — different from a real transit, which would leave more messages per cell along a diagonal path. Not reliably distinguishable without identity/course data (which the heatmap DB **deliberately doesn't store**, see above), so no ingestion-side heuristic: **read-time filter only**, opt-out for the user.

**"Hide singletons" toggle** (🧹, **on by default**): same UI pattern as the name/trail toggles (`createMapToggleControl`/`setToggleBtnState`, exported from `public/js/maps.js` and reused in `public/js/coverage.js` — icon-only, explanation via a hover `data-tip` overlay, not text/`title`). User pref `hideHeatmapSingletons` (default `true`) in `user-prefs.js`, shared within a group (`group-sync.js` `SHARED_SETTING_KEYS`), read/written like the others via `GET`/`POST /api/settings`.

- **Server-side filter** — `heatmapDb.getCellsAgg({ level, bbox, hideSingletons })` ([`src/heatmap-db.js`](../../src/heatmap-db.js)) drops **fine** cells with `msg_count = 1` **before** LOD aggregation, not after: a coarse block that also contains real traffic keeps it — only the noise cell's own contribution is dropped. Query param `?hideSingletons=1` on both routes (`GET /api/heatmap/cells` authenticated, `GET /api/heatmap/public-cells` public). The world-view cache (`aggCache`) is keyed by `factor:hideSingletons` so the two variants don't clobber each other.
- **Public page** (`public/heatmap.html`, `/heatmap`, no session) — filter **always on, not toggleable** (nothing to persist a preference against without a logged-in user).

**Key files**: [`src/services/heatmap-stream.js`](../../src/services/heatmap-stream.js), [`src/heatmap-db.js`](../../src/heatmap-db.js), [`src/routes/heatmap.js`](../../src/routes/heatmap.js), [`src/routes/heatmap-public.js`](../../src/routes/heatmap-public.js), [`public/js/coverage.js`](../../public/js/coverage.js), [`public/js/maps.js`](../../public/js/maps.js) (`createMapToggleControl`/`setToggleBtnState`), [`public/heatmap.html`](../../public/heatmap.html).

## 🔗 MarineTraffic / VesselFinder Integration

In the ship detail view, two tabs enrich AIS data with data downloaded (scraped) from external sources, cached in the `ship_scrape_cache` table (TTL configurable via `SCRAPE_CACHE_TTL`).

**VesselFinder** — server-rendered page; HTML scraping (`crawlVesselFinder`) extracts photo + data table via `fetchHttp` (the `https` module).

**MarineTraffic** — more complex, two obstacles:

1. **Internal ID**: MT pages are a React SPA indexed by proprietary `shipid`, not by MMSI/IMO/callsign. The `shipid` is resolved via the endpoint `GET /{lang}/global_search/search?term=<MMSI|IMO|callsign>&types=1,3,7,9` → `results[0].id`. The resolved `shipid` is saved in `ships.mt_ship_id` and used for the direct link. Ship data is then read from `GET /{lang}/vesselDetails/vesselInfo/shipid:<id>` (clean JSON, includes `typeSpecific` = ship subtype).
2. **Cloudflare**: MT blocks Node's TLS clients (`https`/`http2`) with HTTP 403 via JA3/JA4 fingerprint, regardless of headers. **libcurl's TLS stack passes**, so MT requests are made via **`node-libcurl`** (`fetchViaCurl` in `src/services/scrapers/http.js`).

> ℹ️ **Deploy**: no system `curl` needed on the host. `node-libcurl` bundles its own libcurl (prebuilt binaries downloaded at `npm install`; source build as fallback). Note: the TLS fingerprint can vary between libcurl builds and Cloudflare may treat them differently — verify in production.

**ShipFinder** — server-rendered page; HTML scraping (`crawlShipfinder` in [`src/services/scrapers/shipfinder.js`](../../src/services/scrapers/shipfinder.js)) via `fetchHttp` (no Cloudflare, no libcurl). Fields are keyed by `<label id="ais-…">`; the flag is the filename of the `<img>` (ISO code). Unlike VF/MT (whose free pages carry **no** coordinates), ShipFinder exposes the vessel's **last-seen position** in plain HTML (lat/lon in degrees-decimal-minutes, e.g. `44-35.056 N`, converted to decimals by [`src/lib/coords.js`](../../src/lib/coords.js) `parseDdm`), plus SOG/COG/status/destination/ETA. The static fields (flag/type/dimensions) mostly duplicate VF/MT and serve only as a fallback: **the unique value is the position**.

**MyShipTracking** — server-rendered page; HTML scraping (`crawlMyshiptracking` in [`src/services/scrapers/myshiptracking.js`](../../src/services/scrapers/myshiptracking.js)) via `fetchHttp` (no Cloudflare). Same role as ShipFinder: a **second, independent position backup**. Particulars/speed/course/AIS status come from the `<th>label</th><td>value</td>` tables; the **last-seen position** (lat/lon in **signed decimal degrees**, lat/lon order) and the report timestamp come from the page's SEO sentence (the table blanks lat/lon to `---` for stale vessels, while the sentence always carries the last fix). Coverage is **terrestrial** AIS (T-AIS): good near coasts/ports, weak offshore — fine for the monitored port areas.

MT/VF/SF/MST integration can be enabled/disabled via the `IMPORT_MT_DATA` / `IMPORT_VF_DATA` / `IMPORT_SF_DATA` / `IMPORT_MST_DATA` properties in `local.properties` (or from the toggle switches in the UI settings, which persist them).

#### ShipFinder: re-locating lost followed ships (position)

Unlike VF/MT, the ShipFinder position is used to **find followed ships our AIS stream can no longer see** (see [Followed ships](#-followed-ships)): a "lost" ship that doesn't reappear on the worldwide AIS box often still has a relayed position on ShipFinder.

- **Tagged storage.** Scraped positions land in the `readings` table with `source='sf'` (column added by migration, default `'ais'`) and `message_type='ShipfinderPosition'`. They are **excluded** from the risk score (the risk queries filter `source='ais'`) and — *by default* — from the single-ship track and the replay, but can be folded into both via the **Include SF/MST** toggle (see [Historical replay](#️-historical-replay-time-scrubber-on-the-area-map)); and they do **not** touch the `ships` row (so `last_seen_at` stays the AIS freshness signal and the worldwide box keeps searching in parallel). On the map they render as **distinct amber markers, not connected** to the AIS polyline (`renderSfPositions` in `maps.js`). These markers are **clamped to the same time window as the track** (`S.trackFrom`/`S.trackTo`, set by `loadTrack` for the chosen preset/range/segment): a replay cut (**🧹 Azzera replay**) or a segment trims the scatter exactly like the AIS fixes — without the clamp the scatter redrew the whole scraped history on every poll and cuts appeared to have no effect. The `S.sfPositions`/`S.mstPositions` cache lets it re-clamp without a refetch; the **📍 Locate** button (`focus`) bypasses the clamp so a freshly fetched fix always shows.
- **Automatic sweep.** In the follow refresh loop (every `FOLLOW_REFRESH_MIN`, default 5 min), `reacquireStaleViaShipfinder` scrapes **stale** followed ships (no fresh AIS position) — including those **never located** (followed by search, via `getAllFollowedShips`). Per-MMSI throttle (`SF_REACQUIRE_THROTTLE_MIN`, default 30 min), per-sweep cap (`SF_REACQUIRE_MAX_PER_SWEEP`, default 20), 2 s between requests and negative-cache on failures → low volume / captcha-safe.
- **Manual button.** In the ship detail, **📍 Locate via ShipFinder** (`POST /api/ships/:mmsi/sflocate`) forces an immediate position scrape and centers the marker — works for **any** visible ship, not just followed ones.

**MyShipTracking** replicates this exact mechanism as a **second, independent backup**: tagged storage `source='mst'` (same exclusion from track/score/replay), `reacquireStaleViaMst` sweep (same `SF_REACQUIRE_*` throttle/cap), **📍 Locate via MyShipTracking** button (`POST /api/ships/:mmsi/mstlocate`). When both sources are enabled a stale ship is queried on both; on the map MST markers are **teal/cyan** to tell them apart from ShipFinder's amber.

#### "Followed ships" map: SF/MST fallback position

On the **Followed ships** map, a ship whose AIS stream has gone dark — but which has been **re-located via ShipFinder or MyShipTracking** — is shown at its **most recent scraped position** instead of sticking to a stale AIS position (or vanishing). The marker stays **grey** (as for ships "in search"), so it's clear it isn't a live AIS fix.

- **Trigger rule** — identical to the "seen on…" badges: the scraped fix is plotted **only** when AIS is **not fresh** (older than `FOLLOW_FRESH_MS`, default 60 min) **and** the scrape is **newer** than the last AIS fix (`scrapeBadgeAt` in [`src/routes/ships.js`](../../src/routes/ships.js)). A fresh AIS fix **always wins**: the marker **snaps back** to the AIS position the moment the stream re-acquires the ship (the backend stops emitting the `fallback_*` fields).
- **Source** — if both SF and MST have a valid fix, the **most recent** is plotted. The backend (`scrapeFallbackFix`, endpoint `GET /api/ships/followed/active`) attaches `fallback_lat`/`fallback_lon`/`fallback_at`/`fallback_source`; `renderFollowedMap` ([`public/js/maps.js`](../../public/js/maps.js)) prefers them over a stale AIS position. The popup shows the **scrape time** and **source** ("📡 via ShipFinder/MyShipTracking"), without SOG/COG (scrapes don't carry them reliably).
- **No impact on track/risk** — the fallback position is purely for **display**: it stays in `readings` with `source='sf'/'mst'`, never touches the `ships` row or the AIS freshness signal, and the track/risk queries still filter `source='ais'`. (The **replay** can optionally include it via the *Include SF/MST* toggle.)

##### Architecture: "Followed ships" map rendering & position sources

| Aspect | File:line | Details |
|---|---|---|
| **Followed-ships map view (frontend)** | `public/js/maps.js` → `renderFollowedMap()` | Draws the markers; called from `public/js/followed.js` when the active table renders. Treats a ship as "positioned" if it has an AIS position **or** an SF/MST fallback fix. |
| **Marker colour** | `public/js/maps.js` (`RISK_STYLE` / `GRAY_STYLE`) | Risk-band default: `high` red #dc2626, `med` amber #d97706, `low` green #059669. **Flagged** override violet #7c3aed. **Grey** #6b7280 when `search_mode` **or** when plotting an SF/MST fallback fix. |
| **Followed-positions API** | `src/routes/ships.js` → `GET /api/ships/followed/active` | Returns followed ships with `last_seen_at`, `is_stale`, `search_mode`, `sf_last_at`, `mst_last_at` and — when applicable — `fallback_lat`/`fallback_lon`/`fallback_at`/`fallback_source`. |
| **"Current" position** | `src/db.js` → `getShip(mmsi)` + upsert | The `ships` row (`last_latitude`/`last_longitude`/`last_seen_at`) is updated **only** from AIS readings (`source='ais'`). |
| **Position queries filtered by source** | `src/db.js` (`getShipPositions`/`getRecentPositions`) | Explicitly filter `WHERE source='ais'`: SF/MST excluded from the current position and risk. The **single-ship track** (`getShipTrack`/`getShipTrackRange`) and the **replay** (`getAreaReplayPositions`/`getAreaReplayRange`) instead take a `sources` list and include SF/MST when the *Include SF/MST* toggle is on. |
| **SF/MST storage** | `src/db.js` → `insertScrapedPosition(mmsi, pos, source)` | Inserts into `readings` with `source='sf'`/`'mst'`. Read via `getLatestScrapedPosition(mmsi, source)`. |
| **Badge / fallback logic** | `src/routes/ships.js` → `scrapeBadgeAt()`, `scrapeFallbackFix()` | A scraped fix is surfaced (badge or marker) only when AIS is stale **and** the scrape is newer; a fresh AIS fix hides it. |
| **Freshness threshold** | `src/config.js` → `FOLLOW_FRESH_MS` (default 60 min) | A ship is "stale" when `now - last_seen_at > FOLLOW_FRESH_MS`. |
| **Follow auto-stop** | `src/config.js` → `FOLLOW_STALE_HOURS` (default 4320 h ≈ 6 months) | After that long a silence the follow is auto-stopped and moved to "Followed in the past". |
| **Stale re-acquire via SF/MST** | `src/services/ship-follow.js` → `reacquireStaleViaShipfinder()` / `reacquireStaleViaMst()` | Every `FOLLOW_REFRESH_MS` (~5 min) they scrape stale follows and store fixes with `source='sf'/'mst'`. |

**In short**: AIS is the **primary** source for ship state (risk, current position), and exclusive for risk. SF and MST are **display-only fallbacks**: they show as amber/teal breadcrumbs in the detail view, as a **grey marker on the followed-ships map** when AIS has gone dark, and — optionally, via the *Include SF/MST* toggle — in the **single-ship track** and the area **historical replay**; never overwriting the AIS position.

### 🔀 Fallback mode (prolonged AIS outage)

When the AIS outage (above) stays open for more than `AIS_FALLBACK_HOURS` (default 6h), [`src/services/fallback-mode.js`](../../src/services/fallback-mode.js) activates a **fallback mode**: instead of only re-locating followed ships (the SF/MST mechanism described above), it steps up scraping to keep a minimum level of monitoring during a prolonged outage — with explicit precautions against generating a volume that risks a ban from the source platforms.

- **Trigger and hysteresis** — the module has no detection logic of its own: it reuses `outage.since` from [`ais-uptime.js`](../../src/services/ais-uptime.js) (already the source of truth for "confirmed down since when"). Entry: `outage.serviceDown && now - since >= AIS_FALLBACK_HOURS`. Exit: a single clean check isn't enough — it needs `AIS_FALLBACK_EXIT_GRACE_MIN` (default 20 min) of **continuously** stable service, otherwise a brief blip would flip fallback mode on and off pointlessly (the pending exit is cancelled if it goes down again before the timer elapses).
- **Scope: always auto-starts as "followed ships only"** — `state.fallbackScopeAreas` is **forced to `false`** on every `enter()`, regardless of what an admin chose last time: the safer choice must never be a fixed config default, it always needs eyes-on confirmation. An admin can widen it to "full monitoring" (also ships currently in the monitored bboxes, not just followed ones — `db.getStaleAreaShips`) from the **Settings → AIS Diagnostics** panel, which shows the real scraping history (last 48h, hourly buckets, from `db.getScrapeCountsHourly`) **side by side** with the requests/hour estimate for both scopes (`fallbackMode.getEstimate()`), so the decision is made with a number in hand instead of blind. Widening the scope doesn't multiply the budget: the same hourly cap gets redistributed over more ships (each revisited less often). The panel also shows the **current session's duration** (from `fallback_mode_since`) and, per source, a **suspected-block counter for this session** (`tripCounts` in `fallbackMode.getStatus()`, in-memory, reset on every `enter()`) next to the open/closed circuit state — an intermittent issue that already resolved itself stays visible instead of disappearing the moment the circuit closes again. The 48h history is a **small multiple per source** (ShipFinder/MyShipTracking shown separately, no longer summed) with stacked succeeded/failed bars (status colors, green/red, not identity) and hour labels every 6h. A **sidebar entry** ("🔀 Fallback mode", visible to admins only while fallback is active, refreshed on every `/api/stream/status` poll like the outage banner) jumps straight to this panel from any screen.
- **Live call log** ("🔀 Fallback mode log", same admin+fallback-active visibility gate, above "Activity log" in the sidebar) — a floating window showing calls to ShipFinder/MyShipTracking in real time as they happen. Same mechanism as the operational log (`app-log.js`/`realtime.js`): `fallback-mode.js`'s `scrapeOne()` calls the new `broadcastFallbackScrape({ts,source,mmsi,ok})` (new, in `realtime.js`, same SSE-client-Set + `res.write` pattern as `broadcastAppLog`) after every attempt, success or failure; `GET /api/fallback-scrape/stream` (SSE, `requireAdmin`, new dedicated `routes/fallback-scrape.js`) fans it out to connected clients, `GET /api/fallback-scrape` backfills from an in-memory buffer of the last 200 calls (`fallbackMode.getRecentScrapeEvents()`, same in-memory-only tradeoff as the circuit breaker). Frontend (`public/js/fallback-scrape-log.js`): one `EventSource` per window, two small stacked succeeded/failed bar charts (same color semantics as sourceHistoryChart) bucketed at 30s over the last 10 minutes, recomputed on every event — unlike the 48h historical chart in AIS Diagnostics (hourly buckets, from `scrape_log`), this one is push-based and fine-grained, meant for "are we scraping right now, and is it working?" not history.
- **VF/MT suspended** — during fallback, [`enrichment.js`](../../src/services/enrichment.js) suspends VesselFinder/MarineTraffic enrichment **entirely** (`enrichNewShip`, `enrichAllExisting`, `enrichActiveShips`): they carry no coordinates (a paid feature) so they contribute nothing to the position-continuity goal, and MarineTraffic in particular is the most fragile source (Cloudflare bypass via `node-libcurl`, at risk of a permanent block if volume rises). All scrape budget goes to SF/MST.
- **`ship-follow.js` hands off its sweep** — its `refresh()` (the periodic cycle that today scrapes SF/MST only for followed ships) turns itself off while `fallbackMode.isActive()`: during fallback all scraping logic (followed ships **and**, if enabled, area ships) lives in the new module, with a budget/priority/rotation the old cycle never had.
- **Anti-ban measures, in order of importance**:
  - **Global hourly budget** (`FALLBACK_MAX_REQ_PER_HOUR`, default 90, SF+MST combined) with a **priority queue**: ships not revisited the longest are scraped first, instead of today's fixed per-sweep cap.
  - **Per-ship source rotation** — round-robin SF/MST instead of always querying both for the same ship, halving per-source load for the same coverage.
  - **Jitter** — a randomized stagger (1.5–4.5s) between requests instead of today's fixed 2s delay, so there's no recognizable timing pattern.
  - **User-Agent rotation** — a pool of realistic desktop UAs (`scrapers/http.js` → `pickUA()`), picked per request instead of a single fixed string.
  - **Per-source circuit breaker** — `http.js` now classifies HTTP errors (`classifyFailure`, parsing `Retry-After`); `fallback-mode.js` tracks 403/429 failures **across distinct ships** in a sliding window (`FALLBACK_CIRCUIT_TRIP_COUNT` over `FALLBACK_CIRCUIT_TRIP_WINDOW_MIN` minutes) and, once the threshold is crossed, **pauses the whole source** for `FALLBACK_CIRCUIT_COOLDOWN_MIN` minutes — a step up from the existing per-ship negative cache, which never aggregates failures at the source level. State is **in-memory only** (not in `meta`/DB): losing it on a restart is an acceptable tradeoff against the complexity of persisting/expiring it correctly.
- **"Suspected ban" alert** — a circuit opening/closing raises an alert **for admins only** (`db.getAdminUserIds()`): in-app notification (type `suspected_ban`/`suspected_ban_cleared`, reuses the existing `notifications` table) + Telegram (`telegram.broadcastAdminAlert`, personal toggle `telegramNotifySuspectedBan`) + in-app banner (extends the existing AIS-outage banner with a line visible only when `me.isAdmin`). Bypasses `notify-categories.js` like the `outage` event, being a system-level event not tied to a single ship.
- **Zero schema migrations** — no new table: the `fallback_mode_active`/`fallback_mode_since` flag lives in `meta` (already in `BACKUP_TABLES`), and the ship-discovery queries (`getStaleAreaShips`, `getAdminUserIds`, `getScrapeCountsHourly`) read already-existing tables. A pre-feature backup simply lacks those `meta` keys — `db.getMeta` treats them as absent (default OFF), so restoring an old backup works with no special handling.
- **`outage.since` comes from an authoritative external source, not local detection** — `ais-uptime.js` doesn't count `AIS_FALLBACK_HOURS` from when *this instance* first notices the outage: `probeOne()` also reads `lastMessageReceived` from the uptime monitor's response (the last message the monitor itself saw, not us), used as `since` when available — falling back to `meta` (`ais_outage_since`, persisted to survive restarts) and finally to "now" if neither is available. This way a **first-ever deploy made days into an already-ongoing outage** correctly computes the real hours of downtime right away, instead of restarting the countdown from zero on every deploy.
- **Restart mid-outage: banner and verdict without the wait** — `outage.serviceDown`/`monitorState`/`monitorSource` are now rehydrated from `meta` at module load (alongside `since`, already persisted), so the banner immediately shows the last known state instead of going blank until `evaluate()` recomputes it. A restart also resets the stream's **local silence** (it reconnects from scratch): without a fix, `evaluate()` would have to wait `AIS_OUTAGE_SILENCE_MIN` minutes of silence all over again before even re-contacting the monitor — a delay that, on a restart right as `AIS_FALLBACK_HOURS` is about to trip, would have wrongly postponed entering fallback mode. `init()` therefore calls `reconfirmOnBoot()` once when the rehydrated state says "was down": an immediate probe to the monitor (still respecting `MIN_PROBE_GAP_MS` for every check after it) that either reconfirms the ongoing outage (no new notification — it's not a new detection) or clears it right away if it resolved during the restart. `evaluate()` and `reconfirmOnBoot()` share the same transition logic (`applyDown`/`applyUp`) so the `since` fallback chain can't drift between the two call sites.

#### Map overlay buttons: name labels, recent trail, crowding threshold

The followed-ships and area ("Navi presenti") maps share a small Leaflet button factory (`public/js/maps.js` → `createMapToggleControl(map, buttons)`): a top-right control bar with one icon per toggle, each bound to a persisted `S[key]` boolean. Each button is **icon-only** (🏷/〰): the explanation of what it does is a **hover overlay**, not visible text next to the icon nor the browser's native `title` — a short "Names"-style caption next to the icon turned out too terse to be clear. The button carries `data-tip="<explanation>"` and reuses the **glossary-tooltip system already built for the Equasis "ⓘ" icons** (`initGlossaryTooltip()` in `public/js/main.js`, selector extended to `.map-toggle-buttons a[data-tip]`): a fixed div positioned below/above the element on `mouseover`, no new component.

- **Followed ships** (`initFollowedMap`) — two buttons: **🏷** (`showFollowedShipNames`) and **〰** (`showFollowedTrails`, small trail — thin polyline in the marker's own colour, drawn behind it). `syncFollowedMapToggleButtons()` re-syncs button state after `/api/settings` resolves.
- **Area/current ships** (`initActiveMap`) — two buttons: **🏷** (`showActiveShipNames`, default **on**) and **〰** (`showActiveTrails`, default **off** — an area can hold far more ships than a hand-picked followed list, so the trail starts disabled). `syncActiveMapToggleButtons()` is the equivalent for this map.

**Shared crowding threshold** (`ACTIVE_MAP_CROWD_THRESHOLD` = 20 plotted ships, in `maps.js`) governs both area-map toggles:

| Below threshold (≤20 ships) | Above threshold (>20 ships) |
|---|---|
| Name: **permanent** Leaflet tooltip | Name: **hover-only** tooltip (`permanent:false`, Leaflet's default hover behaviour, no extra listeners) |
| Trail: polyline drawn for **every** ship | Trail: **no** permanent polyline; drawn **only for the ship under the mouse** (`marker.on('mouseover'/'mouseout')`, a single transient polyline kept in `activeHoverTrail`, removed on `mouseout` or the next render) |

Avoids unreadable overlap in busy ports without hiding the information outright: the user recovers it by hovering the individual ship.

Both name labels share the `.ship-name-label` CSS class; the buttons share `.map-toggle-buttons`.

- **Trail data source** — `db.getRecentTrails(mmsis, limit, sinceIso, sources)` ([`src/db.js`](../../src/db.js)) is a generic function (renamed from `getFollowedTrails`): one batch query with `ROW_NUMBER() OVER (PARTITION BY mmsi ...)` for the whole ship group instead of N per-ship round trips. `TRAIL_LIMIT`/`TRAIL_HOURS` (12 points / 6h) and `trailSources()` (`['ais']` plus `sf`/`mst` when enabled) are shared in [`src/routes/ships.js`](../../src/routes/ships.js) by both routes:
  - `GET /api/ships/followed/active` always attaches a `trail` field to each followed ship (small list, no cost worth avoiding).
  - `GET /api/ships/active` computes `trail` **only if** the query string includes `?trails=1` — the client adds it when `S.showActiveTrails` is on (`ships.js` → `loadActive()`), so the extra batch query never runs while the toggle (default off) stays off.
- **Persistence** — all four toggles (`showFollowedShipNames`, `showFollowedTrails`, `showActiveShipNames` default `true`; `showActiveTrails` default `false`) live in `user_settings`, managed by [`src/services/user-prefs.js`](../../src/services/user-prefs.js) and mirrored to group co-members like the other map-display toggles ([`src/services/group-sync.js`](../../src/services/group-sync.js) `SHARED_SETTING_KEYS`). No DB schema impact: plain key/value rows in the existing table, not new columns.
- **No impact on track/risk** — purely illustrative: same `readings` queries used elsewhere, no new table.

### Proactive enrichment on first detection

In addition to on-demand loading in the detail view, enrichment starts **automatically when a new ship appears** on the AIS stream, so the [risk score](#score-enrichment-from-vfmt) can immediately use registry data without waiting for the detail view to be opened.

Flow ([`src/services/enrichment.js`](../../src/services/enrichment.js)):

1. `db.insert` signals the first appearance of an MMSI by returning `{ arrivedFlagged, newShip }` (`newShip` = mmsi if the MMSI had never been seen before).
2. In `ais-stream.js`, on `newShip`, `enrichment.enrichNewShip(mmsi)` is called.
3. `enrichNewShip` queries in the background **only the enabled sources** and saves the result to `ship_scrape_cache`.

Guarantees:

- **Once only**: skips if cache already exists for that source, with an `inFlight` guard against duplicate concurrent fetches. Does not restart for already known ships (not even after a restart).
- **Non-blocking**: fire-and-forget, no `await` in the AIS ingest loop. Errors are logged (`[ENRICH:vf|mt]`), never propagated.
- If the MMSI appears before static data (IMO/callsign absent), VF/MT still resolve via MMSI.

#### Backfill on enable, restore and negative cache

- **Backfill on toggle**: enabling VesselFinder or MarineTraffic from settings (`POST /api/settings`) runs `enrichAllExisting(source)`, which enriches in the background every ship seen in the **last 7 days** still missing cache for that source (one at a time, 2 s apart). The two sources are independent (cache keyed by `mmsi`+`source`).
- **Restore never re-scrapes**: applying settings from a backup/bundle (`applyImportedSettings`) does **not** run the backfill. VF/MT data lives in `ship_scrape_cache`, which is part of the DB backup and is restored with it — re-scraping every loaded ship would be pointless and hammer the sources. Backfill stays only on the interactive toggle.
- **Negative cache** (`SCRAPE_NEG_CACHE_DAYS`, default 3 days): a failed lookup (the source doesn't know the ship — typical for ships without IMO, looked up by MMSI → 404/redirect) writes nothing to `ship_scrape_cache`, so the ship would stay "uncached" and be re-contacted on **every** re-enable. The failure is therefore recorded in `ship_scrape_failures` (also part of the backup); the backfill skips a ship whose last failure is newer than `SCRAPE_NEG_CACHE_DAYS`, then retries it. `0` = disabled (always retry). A successful fetch clears the marker.
- VesselFinder redirects to **relative** paths (e.g. `/vessels` for unknown ships) are resolved against the current URL in `fetchHttp`, avoiding the `Invalid URL` error.

### Equasis lookup (ownership/management, on-demand)

[Equasis](https://www.equasis.org/) is a free EU/US database exposing a ship's **ownership and management** data (registered owner, ISM manager, operator, DOC company) which AIS never broadcasts and VF/MT don't offer for free. The scraper [`src/services/scrapers/equasis.js`](../../src/services/scrapers/equasis.js) (`crawlEquasis(imo)`) is deliberately **outside** the proactive enrichment path: it runs **only** when the user presses **Fetch Equasis information** in the detail view.

Differences from VF/MT:

- **On request only**: no automatic fetch on appearance or on opening the detail. The endpoint serves the cache; it scrapes only with `?fetch=1` (the button).
- **No expiry**: the result is stored in `ship_scrape_cache` under source `eq` and shown forever (unlike the `SCRAPE_CACHE_TTL` of VF/MT). After the first fetch the button disappears.
- **Queries by IMO**: Equasis is indexed by IMO number only; without an IMO the lookup fails with an error.
- **Login required**: every query needs an authenticated session, so `EQUASIS_USER` / `EQUASIS_PASSWORD` are required. Without credentials the feature stays hidden/unusable (`equasisConfigured`).

Flow (`crawlEquasis`, reverse-engineered): `POST /EquasisWeb/authen/HomePage` (`j_email`+`j_password`) → session cookie → `POST /EquasisWeb/restricted/ShipInfo` (`P_IMO`) → detail HTML. Cookies live in a throwaway jar for the lifetime of the two calls. Like MarineTraffic, it **uses `node-libcurl`** (no system `curl` dependency). The detail page is split into commented sections (`<!-- Overview -->`, `<!-- MGT DET -->`, `<!-- Classification -->`, `<!-- PI -->`, `<!-- Geo -->`, …), each duplicated as desktop (`<table>`) and mobile (`hidden-md hidden-lg`) markup: the parser always reads the desktop copy and ignores the duplicate. It extracts six blocks: `particulars` (name/IMO from the `<h4>` plus flag, call sign, MMSI, tonnages, type, year, status from the `<b>label</b>` blocks), `management` (`parseManagement`, the *Management detail(s)* table mapped by column header so it survives Equasis reordering its columns), `classification` (society, status, date), `pi` (P&I club + inception), `risk` (36-month detention rate, IACS class, Paris/Tokyo MOU performance, USCG targeting from the *Overview* section) and `positions` (most recent areas the ship was seen in).

**Audit log**: every lookup (success or error) is appended to a plain-text file `equasis.log` (project root, gitignored) by [`src/services/equasis-log.js`](../../src/services/equasis-log.js): timestamp, MMSI, IMO, ship name and the retrieved data (or the error message). The log is viewable from the UI via the **View Equasis log** button in Settings (endpoint `GET /api/equasis-log`, read tail-truncated to 256 KB; `DELETE /api/equasis-log` clears it).

### Global Fishing Watch enrichment

[Global Fishing Watch](https://globalfishingwatch.org/) (GFW) enriches each ship with its **identity** (flag, IMO, MMSI, call sign, type, year) and with the **behavioural events** that GFW derives and classifies from the global AIS feed: **encounters** (two vessels meeting at sea = ship-to-ship transshipment signature), **loitering** (a prolonged stop in open sea), **port visits** (reconstructed port calls) and **gaps** (AIS switched off while underway = "dark activity"). Because these events are already AIS-derived and classified by GFW, they are **authoritative confirmations** of the behavioural signals the app otherwise infers heuristically from raw positions, and they feed the [risk score](#-risk-score-potential-arms-transport) directly. Implemented in [`src/services/gfw.js`](../../src/services/gfw.js).

The port name in **port visits** (`normPortVisit`) sometimes comes from GFW as a readable name, sometimes as a UN/LOCODE-style code when the anchorage has no known name on file: `portLabelWithCode` tries to resolve it against the same LOCODE registry used for AIS destinations (`src/services/locode.js`, `data/locode.json`), showing "Name (CODE)" when the code is recognized; if it's not a code or isn't in the registry, it's left unchanged. The transform happens **once, at scrape time** (it persists in the cached value) — entries already cached update on the next GFW refetch (6h TTL), not retroactively.

Unlike VF/MT/Equasis/PSC, GFW is **on by default** (`IMPORT_GFW=true`). Like VF/MT, the enrichment is **proactive**: it runs in the background on the ship's first detection and backfills existing ships when first enabled, cached in the same `ship_scrape_cache` (source code `gfw`). **Restoring** a backup does **not** re-fetch the data (it is already in the restored DB), exactly like VF/MT.

- **API token (not username/password)**: a GFW Bearer token is required, configured in `local.properties` as `GLOBAL_FISHING_WATCH_TOKEN` and generated from the [GFW API portal](https://globalfishingwatch.org/our-apis/). Without a token the feature silently no-ops and the settings panel shows a "token not configured" hint.
- **Non-commercial license**: GFW data is free **for non-commercial use only** (research, NGO, public good); commercial use requires a dedicated license from GFW.
- **Coverage**: GFW mainly tracks **fishing, support, and reefer/carrier vessels** — many merchant ships are simply not in GFW (the detail panel shows a "not found in GFW" note for those).

In the ship detail view a **Global Fishing Watch** tab appears (when enabled): it shows the identity table and the event tables (encounters, loitering, port visits, AIS-off), each field/section with a hover ⓘ info icon explaining it. Every event table is sortable by column (default: date, most recent first) and paginated client-side (10 rows/page) — `gfw.js` already paginates the GFW API response upstream (see `EVENT_MAX_TOTAL`/`fetchEvents`, which follows GFW's `nextOffset` instead of stopping at the first page), so even a very active vessel reaches the frontend with its complete behavioural history.

### Cross-provider aggregated ship data

The **General** tab of the ship detail also shows a table reconciling the identity/spec fields (name, IMO, MMSI, call sign, flag, type, year, length, beam, draught, GT, DWT, home port) across **every** enabled source, so nobody has to open each tab to compare them. Logic lives in `public/js/ships.js` (`buildAggregateRows`/`renderAggregateTable`), client-side, over the data already loaded for the detail view:

- **Per-provider extraction**: one extractor per source reads its own keys. VF is open-set (scraped labels vary page to page) → matched by normalized label (`scrapeGet`/`scrapeNormLabel`, the same mechanism as `SCRAPE_LABEL_GLOSSARY`). MT/SF/MST/Equasis use fixed keys (`MT_FIELD_LABELS`, the `put()` calls in `shipfinder.js`/`myshiptracking.js`, Equasis's `particulars`) → direct lookup. GFW uses the already-structured `identity` object.
- **Deliberately excluded fields**: destination, ETA, live draught, nav status — fields that change often and that sources scrape at different times: comparing them would produce false "conflicts" from staleness alone, not a real disagreement.
- **Normalization for comparison only** (the displayed value is always the raw one): flag → canonical name via `Intl.DisplayNames` for ISO alpha-2 codes, a small alpha-3→name table (`AGG_ISO3_TO_NAME`, the same deliberately-limited scope as `ISO3_TO_NAME` in `gfw.js` — an unmapped code fails "safe": it shows an extra source chip instead of wrongly merging two different flags); numeric fields (`length`/`beam`/`draught`/`year`/`gt`/`dwt`) are rounded before comparing, so "202.80" and "203" match.
- **Grouping**: values sharing the same normalized form land in one chip, with one dot per source reporting it; different normalized values stay separate chips on the same row, with a light background tint (`.agg-conflict`) flagging the disagreement.
- The dots reuse the same 6 colors as the provider tabs (`.src-dot--vf/mt/sf/mst/eq/gfw` in `style.css`) and show the source name on hover (the same `data-tip` tooltip system as `initGlossaryTooltip`).

## 🤝 Ship-to-ship rendezvous detection

A rendezvous on the open sea — two distinct vessels lingering side by side offshore — is the classic signature of a **ship-to-ship transfer** (transshipment). Unlike the encounters reported by Global Fishing Watch (which only enriches the ships it is queried for), this detection is **local and free**: it uses our own AISStream feed, with no external API. Implemented in [`src/services/proximity.js`](../../src/services/proximity.js).

**Scan.** A periodic job ([`proximity.init`](../../src/services/proximity.js), started by `src/server.js`) runs every `PROXIMITY_SCAN_MIN` minutes (default 10; `0` disables it). For each area it considers ships with a recent fix (`PROXIMITY_FRESH_MIN`) and keeps only the pairs that satisfy **all** of these — deliberately conservative to cut false positives:

- both **slow**: SOG < `PROXIMITY_MAX_SOG_KN` (default 3 kn — a fast ship is just passing through);
- both **not** moored/anchored (nav status ≠ 1, 5);
- both **offshore**: more than `PROXIMITY_FAR_KM` km from the area bbox centre (default 10 — excludes berths in port, where ships are naturally close);
- pair within `PROXIMITY_DIST_M` metres (default 500).

**State machine (table `proximity_events`, canonical pair `mmsi_a < mmsi_b`).** A contact **opens** when a pair first comes within `PROXIMITY_DIST_M`; it **stays open** while the pair is within `PROXIMITY_DIST_M × PROXIMITY_CLOSE_MULT` (hysteresis: a single noisy fix can't flap it shut); it **closes** when the pair separates or a ship leaves the area / goes silent. On the first scan where the contact's dwell reaches `PROXIMITY_MIN_MINUTES` (default 10) it fires **a single** notification and the contact is marked confirmed (`alerted`).

**Notification** (type `proximity`, see [Notifications](#-port-events-statistics-and-alerts)) — in-app + Telegram, with a **two-pin static map** joined by a line (server-rendered, [`static-map.js`](../../src/services/static-map.js) extended for multiple points) centred on the midpoint, plus the "open in map" link. Controlled by `notifyProximity` (in-app) and `telegramNotifyProximity` (Telegram), independent of each other.

**Risk score** — a confirmed rendezvous adds `RISK_PROXIMITY_POINTS` (default 18) to the score of **both** ships, for rendezvous within the `RISK_PROXIMITY_WINDOW_DAYS` window (default 7 days); the factor counts distinct partner ships. `RISK_PROXIMITY_POINTS=0` disables the factor while leaving the scan running (so the history still accrues). See [Risk score](#-risk-score-potential-arms-transport).

**Ship detail** — a **Rendezvous** section lists the vessel's confirmed encounters (other ship, date/time, minimum distance, area); each row is clickable and opens the partner ship's detail.

## 🔀 Ship search by transit areas

Discovery of ships linking two monitored areas, including never-followed ones: `public/js/transits.js` (view `#transits`, opened from the button in **Followed ships**), route `src/routes/transits.js`, engine `db.getAreaTransits(areaA, areaB, sinceIso)`.

**Why port events and not positions.** `readings` has a global per-message-type cap (`MAX_READINGS_PER_TYPE`, default 10,000) and is pruned continuously: it covers days, not months. `port_events`, on the other hand, has **no time-based retention** — it is the only long history available, so counts and legs are rebuilt from it.

**Visit** = an `arrived` plus the first following `departed` in the same area (or still open, if the ship is there now).

**Call** (the visit was a destination, not a crossing of the bbox):

- if the departure carries the measured evidence (columns `port_events.stop_min_sog` / `stopped`, written by `checkAndLogDepartures` while the visit's positions are still in the DB), that decides: dwell ≥ `TRANSIT_STOP_MIN_H` **and** minimum speed ≤ `TRANSIT_STOP_MAX_SOG_KN`;
- otherwise dwell alone ≥ `TRANSIT_STOP_MIN_H`. `stopped` is **nullable**: NULL means "not measured" (rows predating this version, or positions already pruned), not "did not stop".

**Leg** = two consecutive calls in the two chosen areas, with no call at **any other** catalog area in between (`port_events` are global, so other users' areas count too), and elapsed time within the gate from `db.areaHopGate(a, b)`:

```
gateH = min( max(TRANSIT_MIN_SLACK_H, distance_nm / TRANSIT_MIN_KN), TRANSIT_MAX_GAP_DAYS × 24 )
```

`TRANSIT_MIN_KN` (4 kn) is far below real cruising speed, so a voyage with intermediate calls still fits; the floor avoids thresholds of minutes between nearby areas; the cap prevents treating a leg months apart as direct. **The same gate feeds the area-change notification filter**, so the two criteria cannot drift apart.

**Route.** `GET /api/transits?a=KEY&b=KEY&period=all|12m|6m|3m|30d&includeNoLeg=0|1` — 400 when areas are missing or identical, 403 when the user does not monitor both. It answers with ships decorated as in the other lists (`flagged`/`seen`/`followed`/`risk`/`chargedBy` via batch queries), sorted by number of legs, `truncated` past `TRANSIT_MAX_ROWS`. Ships with zero legs are excluded by default (`includeNoLeg=1` includes them).

**Leg replay** — the **▶ Trip** button opens `#modal-overlay` with a Leaflet map (created once and re-attached on every open, so no dead instances pile up in the `tiles.js` layer registry) and reuses `GET /api/ships/:mmsi/track?from&to&scraped=1`. Segments whose time gap exceeds `REPLAY_MAX_GAP_MIN` are drawn as a **dashed grey** line and labelled as estimated: outside the monitored areas no positions exist, so the offshore route is a hypothetical straight line.

**Visibility.** `canSeeShip` (in `src/routes/ships.js`) also accepts ships with a recorded call in one of the user's areas (`db.hasShipAreaHistory`): a ship discovered here may be anywhere in the world, and without this its detail page would answer 404.

## 📋 Port events, statistics and alerts

**Port events** (table `port_events`) — the backend automatically detects:
- **Arrival** (`arrived`): a ship appears after > 60 minutes of absence (or for the first time).
- **Departure** (`departed`): detected by `checkAndLogDepartures`, which marks as departed ships whose last contact falls in the `-62…-60 minutes` window without a departure already recorded recently.

**Statistics** (`/api/stats`, Traffic view) — arrivals today / this week / total, average stop duration (by pairing each arrival with the following departure), arrivals distribution by hour of day and ship type.

**Aggregate scores** (`/api/stats/scores`, Traffic view) — calculated on ships seen in the last 7 days: distribution by risk band (`byBand`), top 8 ships by score (`topShips`), most frequent factors across all ships (`byFactor`), daily arrivals time series for the last 30 days (`dailyArrivals`). The calculation invokes `computeRiskScore` for each ship in the window, so response time scales with the number of recent ships.

**Expected ships** (`/api/ships/expected`) — ships with a `destination` containing the current preset keyword (e.g. `TARANTO`), that left the area in the last 48 hours — useful for anticipating arrivals.

**Flagged ship alerts** (`/api/alerts`) — when a flagged (★) ship re-enters the area, the arrival is queued and shown as a toast in the frontend on the next poll.

**Notifications** (table `notifications`, `/api/notifications`) — persistent history shown in an **overlay window** (the same `#modal-overlay` used for reading detail / berth / backup restore, so it's responsive on mobile by default) opened from the **🔔 Notifications** sidebar button; the button only carries the unread badge, content loads fresh on every open (no live refresh while it stays open). Six notification types are generated (each can be enabled/disabled independently from Settings, on top of the master `notificationsEnabled` switch):

- `revisit` — a ship **that already arrived in the same area in the past** returns to it after an absence (`db.insert` returns `revisit`); controlled by `notifyRevisit` / `NOTIFY_REVISIT`.
- `area_change` — a ship that **called** at one area is later detected in a **different** area (`db.insert` returns `areaChange` by comparing the ship's `last_area` with the message's area before the upsert); the notification stores the origin area in `from_area` and the destination in `area`; controlled by `notifyAreaChange` / `NOTIFY_AREA_CHANGE`.

  Before the fan-out, `ais-stream.js` discards the event in three cases, in this order (each would otherwise be reported with the wrong reason by the next one). Every skip is written to the activity log with its reason:

  | Reason | Condition | Why |
  |---|---|---|
  | `overlap` | `areaChange.overlappingAreas` (`db.boxesOverlap`), disable with `AREA_CHANGE_SKIP_OVERLAPPING=false` | Two intersecting boxes hold the same positions: the area credited depends on which subscription delivered the message, and a ship moored in the shared part "changes area" while standing still |
  | `transito` | `!areaChange.fromWasStop` (`db.lastAreaVisitWasStop`), disable with `AREA_CHANGE_REQUIRE_STOP=false` | An area is a rectangle of interest, possibly hundreds of km wide: announcing "moved from X" for a ship that only crossed X claims a call that never happened. Positive evidence is required: with no recorded arrival to point at, the event is dropped |
  | `stale` | `!areaChange.timePlausible` (gate from `db.areaHopGate`, see [Ship search by transit areas](#-ship-search-by-transit-areas)), disable with `AREA_CHANGE_REQUIRE_PLAUSIBLE_TIME=false` | The origin call is too old to explain the ship being here: whatever it did in between happened outside the monitored areas, so its provenance is not ours to state |

  Recipients are still those from `db.getUsersWithBothAreas` (you must monitor **both** areas by key): the two mechanisms are complementary — one decides *whether the event exists*, the other *who receives it*.
- `high_risk` — a ship **arrives** (new, or after > 60 min absence, `db.insert` returns `arrived`) with a **risk score in the red band** (71–100); controlled by `notifyHighRisk` / `NOTIFY_HIGH_RISK`. Useful for immediate triage of critical cases without waiting for the Traffic view.
- `berth_new` — during the berth recompute (`berths.recomputeArea`) a **new automatic berth** is detected (a cluster with no inherited identity); controlled by `notifyBerthNew` / `NOTIFY_BERTH_NEW`.
- `berth_characterized` — a berth (automatic or manual) is **characterized for the first time** (its computed `char_label` goes from `NULL` to a category); the category is stored in `band`; controlled by `notifyBerthChar` / `NOTIFY_BERTH_CHAR`.
- `proximity` — a confirmed **ship-to-ship rendezvous** is detected (two ships close, slow and offshore for ≥ `PROXIMITY_MIN_MINUTES`, see the [dedicated section](#-ship-to-ship-rendezvous-detection)); generated by `proximity.scanArea`, stores the midpoint in `berth_lat`/`berth_lon` and the two names in `ship_name` (`A ↔ B`); controlled by `notifyProximity` (in-app) / `telegramNotifyProximity` (Telegram).

For ship notifications `ais-stream` computes the score and calls `db.addNotification` (ships with `notif_muted` are skipped); for berth notifications `berths.recomputeArea` calls it, storing the referenced berth in `berth_id` for navigation. The first recompute on an area with no pre-existing berths does **not** generate notifications (to avoid a burst of "new berth" alerts on the initial backfill). Each ship notification stores the risk band (`band`) and `score` computed at event time, shown as a green/yellow/red dot; berth notifications show a dedicated dot. **Clicking** a ship notification opens the ship detail view; clicking a berth notification jumps to that area's map with the berth centred. Endpoints: `GET /api/notifications` (list + unread count), `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`, `DELETE /api/notifications/:id` (single), `DELETE /api/notifications` (all) — all accept `?kind=personal|group` (default `personal`) because the same table/API also serves the "Group activity" feed (see [User groups](#-user-groups)): the two are independent lists (separate badge, overlay and 100-row retention — `actor_id`/`target_user_id` are only set on `group_*` rows).

**Ship-type and "seen" filter** (Settings → **Notifications** tab, [`src/services/notify-categories.js`](../../src/services/notify-categories.js)) — applies to the four **ship-tied** notifications (`revisit`, `area_change`, `high_risk`, `proximity`), not to berth ones. Two per-user prefs in `user-prefs.js`:

- `notifyShipTypesHidden` (array, default empty = all active) — ship categories to **exclude**: `cargo`, `container`, `tanker`, `passenger`, `fishing`, `highspeed`, `sailing_pleasure`, `tug_service`, `coastguard`, `military`, `other`. Category resolved by `categoryOf(ship)`: raw AIS type code for most buckets; `container` vs `cargo` (AIS 70–79) reuses the same VF/MT cache `cargo-type.js` uses for scoring (no network call on the hot notification path) — a freshly-seen cargo ship with no VF/MT data yet falls back to `cargo` until it's enriched. `coastguard` (AIS 55) and `military` (AIS 35 / manual flag / name prefix, same `isMilitary()` used by the score) are **deliberately distinct categories**: a coastguard vessel doesn't force score 100 the way a real military ship does. Resolver independent from `services/ship-categories.js` (the one behind berth stats, untouched). For a **rendezvous** (2 ships), it's enough for one of the two to be an active category.
- `notifyIncludeSeen` (bool, default `true`) — set to `false` to suppress those same four notifications for ships the user marked "seen" 👁 (`db.isUserSeen`, per-user `user_seen` table, see [Per-user vs global data](#per-user-vs-global-data)).

The combined gate (`shouldNotifyShip`) is evaluated **once per (user, event)** and applies uniformly to the in-app notification and to Telegram/webhooks — see [Telegram notifications](#-telegram-notifications). **Different from `excludeTankers`** (Settings → Risk model, admin/global): that zeroes the "cargo type" factor in the **shared score** everyone sees; this filter is **personal** and only affects what reaches you as a notification, without touching the score — the two aren't redundant.

**Delete with undo** — both a single notification (🗑 trash on the row) and the **🗑 clear-all** button (in the toolbar at the top of the overlay) delete with an **undo window** ("↶ Undo" toast) before the deletion becomes effective. The bounce duration is configurable in `app.config.properties` via `NOTIF_DELETE_UNDO_SECONDS` (default 5 s; `0` = immediate delete) and exposed to the frontend via `/api/config`.

### 📲 Telegram notifications

Beyond the sidebar feed, each user can receive their own notifications on **Telegram** via a bot. A single bot (token `TELEGRAM_BOT_TOKEN` in `local.properties`, created with [@BotFather](https://t.me/BotFather)) serves all users; without a token the feature is inert. The backend receives messages by **long-polling** (`getUpdates`) — no public URL or webhook, works behind NAT alongside the AIS streams (`src/services/telegram.js`, started in `server.js`).

- **Linking** — from **Settings → External integrations tab** the user clicks "Link": the backend generates a one-time code (`user_settings.telegramLinkCode`) and a deep link `https://t.me/<bot>?start=<code>`. The user starts the bot; the backend maps code → user and stores the `chat_id` in `user_settings.telegramChatId`. `/stop` (or the "Unlink" button) clears the binding. If the user blocks the bot, a 403 send auto-unlinks them.
- **Per-category toggles** — independent of the in-sidebar notifications (a user may get a category on Telegram while it's off in-app, and vice versa). Per-user master `telegramEnabled` + seven categories: high-risk score, ship revisit, area change, new berth, berth characterisation, **AIS outage** (a global event sent to every linked user with the toggle on) and **area monitoring start/stop** (when the user adds/removes one of their own areas) — plus **suspected ban** (`telegramNotifySuspectedBan`, a system event like outage but sent **to admins only**, see [Fallback mode](#-fallback-mode-prolonged-ais-outage)) and **six more categories** for the ["Group activity" notifications](#-user-groups) (`telegramNotifyGroupArea` etc., only for group members). Persisted as per-user prefs (`telegramNotify*`). The four **ship-tied** categories (high-risk score, revisit, area change, rendezvous) also follow the ship-type filter and the "seen" flag from the Notifications tab (see above) — it's the same gate as the in-app notification, not a separate filter; new berth/characterisation/outage/area-monitor/suspected-ban aren't tied to a ship and are never filtered.
- **Language** — every message is rendered in the user's language (`it`/`en`).
- **Location map** (`telegramSendMap`, default on) — notifications that carry coordinates (berths and ships) get a **static map image** centred on the point. The map is rendered server-side by `src/services/static-map.js`: it stitches the OpenStreetMap base raster tiles (the same as the client, see `public/js/tiles.js`) into a PNG with `pngjs`. The **OpenSeaMap nautical overlay is disabled** in these screenshots (its symbols clutter a small notification map; the renderer still supports it via the `seamark` option, used elsewhere) (pure JS — no native build, no headless browser, no API key), draws the marker and uploads it via `sendPhoto` (multipart). A failed render falls back automatically to text only. Notifications fan out per-user, so four measures bound the cost: (A) **`file_id` reuse** — the first recipient uploads the bytes, the rest reuse the Telegram `file_id` (no re-render, no re-upload; in-burst dedupe via a shared promise); (B) **tile cache** of decoded tiles (LRU+TTL, keeps us within the OSM tile usage policy by avoiding bulk refetching); (C) **rendered-map cache** keyed by rounded coords+zoom; (D) **render concurrency cap** (max 2) to bound CPU/RAM spikes.
- **Location & compact data** — instead of the old **native pin** (`sendVenue`/`sendLocation`, a second large map widget redundant with the screenshot), every notification with coordinates carries a **📍 Open in map** line — a tappable `https://www.google.com/maps?q=lat,lon` link that hands off to the device's maps app (one notification, one-tap navigation). **Ship** notifications (high risk, revisit, area change) additionally enrich the caption — without bloating it — with: **flag** (emoji derived from the MMSI's MID), **ship type** (e.g. Cargo/Tanker, ☢ if Hazmat), **risk reason** (the highest-weighted factor from the risk score, rendered in the recipient's language) and **kinematics + destination** (SOG/COG → declared port). Each line appears only when its data is present. Flag and type: `src/services/vessel-format.js` (`flagEmoji`, `shipTypeLabel`).
- **Action buttons (Follow / Flag)** — **ship** notifications (high risk, revisit, area change) attach an **inline keyboard** with two one-tap actions: **🛰️ Follow** (adds the ship to followed via `shipFollow.applyFollow` — the **same** helper the web button uses, worldwide re-acquisition included) and **⭐ Flag** (flags it, like the list's star). `callback_data` encodes action+MMSI (`f:<mmsi>` / `s:<mmsi>`, well under the 64-byte cap) and the button labels are **stateful** (already show "✅ Following"/"⭐ Flagged" if the ship already is, for that user). The tap arrives as a `callback_query` on the **same long-poll** as notifications (`getUpdates` with `allowed_updates: ['message','callback_query']`, no webhook/public URL): `handleCallback` resolves the user from `chat_id`, applies the action (**add-only**, idempotent), replies with `answerCallbackQuery` (confirmation toast) and refreshes the keyboard via `editMessageReplyMarkup`. The follow logic is shared with the HTTP route (`shipFollow.applyFollow`); the `require('./ship-follow')` is **lazy** inside `handleCallback` to break the ship-follow ⇆ telegram require cycle. Reply markup is also passed by `sendPhoto` (multipart field) for map messages.
- **API** — `GET /api/telegram` (state + toggles), `POST /api/telegram/link` (generate code), `POST /api/telegram/unlink`, `POST /api/telegram/settings` (toggles), `POST /api/telegram/test` (test message).

The token lives only in `local.properties` (gitignored, **not** in backups, stays per-deployment); the `chat_id` and toggles live in `user_settings` and are therefore included in backups.

### 🔗 Outbound webhooks

Besides Telegram, each user can forward the events of their **own areas** to an **arbitrary URL** (Slack, Discord, a SIEM or a custom endpoint). Per-user like the Telegram link: a webhook only fires for events visible to that user. Backend in [`src/services/webhooks.js`](../../src/services/webhooks.js), routes in [`src/routes/webhooks.js`](../../src/routes/webhooks.js), UI in the Settings **External integrations** tab ([`public/js/webhooks.js`](../../public/js/webhooks.js)).

- **Per webhook**: URL, **format** (`generic` = raw event JSON for SIEM/custom · `slack` = `{text}` · `discord` = `{content}`), **subscribed events** (any subset of `high_risk`, `revisit`, `area_change`, `berth_new`, `berth_characterized`, `proximity`, `outage`, plus the 13 `group_*` events from the [group activity notifications](#-user-groups) — these also have a per-category master switch in Settings, checked before this filter), **enabled** on/off, and an optional **secret**.
- **HMAC signature**: if the webhook has a secret, the POST includes `X-Tracker-Signature: sha256=<HMAC-SHA256(body)>` so the receiver can verify authenticity.
- **Delivery**: fire-and-forget POST with a timeout (8s), no retry; errors go to the activity log. The `outage` (AIS outage) event is global: forwarded to every user that has a subscribed webhook.
- **Security**: URLs pointing at **internal/private** hosts (localhost, 127/10/192.168/169.254/172.16–31, IPv6 loopback/link-local/ULA) are **rejected** to limit SSRF; `http`/`https` only. Max 10 webhooks per user.
- **Storage**: a JSON list in `user_settings` (key `webhooks`), therefore included in backups; secrets are masked in API responses (`hasSecret`).
- **API** (per-user): `GET /api/webhooks` (list + event types + formats), `POST /api/webhooks` (add), `PATCH /api/webhooks/:id` (edit/enable), `DELETE /api/webhooks/:id`, `POST /api/webhooks/:id/test` (test event). A **Test** button sends a synthetic high-risk event.

---

## 🚀 Local startup

```bash
# Requirements: Node.js v22 or higher
node --version   # must be v22+

git clone <repo> tracker-porti   # or copy the folder
cd tracker-porti
npm install
cp local.properties.example local.properties   # then insert your AIS_API_KEY
npm start

# App available at http://localhost:3000
```

### Development

```bash
npm run dev      # start with --watch (restarts on every change in src/)
npm run lint     # ESLint (backend Node/CommonJS + frontend browser/ESM)
npm run format   # Prettier
```

## 🧭 Usage

1. Open `http://localhost:3000`
2. The **left sidebar** contains all main controls; it can be collapsed (icons only) with the `‹` button at the top. The state (expanded/collapsed) is saved in localStorage
3. (Optional) select the **area** from the selector at the bottom of the sidebar — this changes the data view only, it does not affect active streams
4. Click **▶ Start monitoring** in the sidebar to start the stream for the currently viewed area — the badge turns green
5. Tab **Active ships**: ships detected in the active window (6h / 24h in port), updated every 5 minutes. High-risk ships (score 71–100) have a red row, flagged ★ ships a purple row, auto-detected military ships a red row with automatic ★, ships at rest the ⚓ In port badge. **Risk** column with the 0–100 colored score. Toolbar on top to **search/filter** the list and **export it to CSV** ([details](#-search-filters-and-list-export))
6. Click a ship row → **Detail** view: info-bar + VesselFinder/MarineTraffic data (if enabled) + **risk score trend** + notes + visit history in monitored areas (General tab); track map (collapsed stops, replay) + paginated readings in the **Readings** tab. **📄 Report** button for the [PDF report](#-ship-pdf-report)
7. Click a reading row in the detail → modal with raw AIS data
8. **← Back** to return to the previous list
9. Tab **Past ships**: ships no longer meeting the "active" criteria; click ★ to flag them / ✓ to mark them as seen
10. Tab **Traffic**: statistics, arrivals by hour/type charts; risk score distribution (green/yellow/red), most frequent factors, arrivals by day (30 days), top 8 ships by score (clickable); expected ships, latest port events
11. **⚙ Settings**: **Area monitoring** panel (start/stop toggle per area, with 🟢/⚪ status); enable/disable VesselFinder and MarineTraffic import; **Export CSV** (ZIP with one CSV per message type); database **backup** and **restore** (see below)
11b. **🗺 Areas**: runtime area management — list with coordinates, status and stored data; map of all areas; add a new area by **GPS coordinates** or with **🎯 Capture current view** (framing the area on the map); edit an existing area (click a row → name/keyword/coordinates in the panel, **💾 Save changes**); delete an area and its history, with a **10s undo toast**. The **🏠 Monitoring** button returns to the home.
12. **📡 AIS Diagnostics** (tab in Settings): connection status (uptime, msg/min, reconnections, errors) for the currently viewed area
13. **🗑 Clear data** → deletes readings, ships and port events for the **currently viewed area** only (confirmation dialog shows the area name)
14. Click **■ Stop** to stop the stream (data remains in the DB)
15. The 🌙/☀️ button at the bottom right toggles dark/light theme (saved in localStorage)

The `ais_data.db` database persists across app restarts.

### Database backup and restore

From the **⚙ Settings** modal:

- **Backup database** → downloads the entire DB as a single `.db` file (`tracker-porti-backup-<timestamp>.db`). This is a consistent snapshot (`VACUUM INTO`), safe even with the AIS stream active and without WAL/`-shm` sidecar files.
- **Restore database** → uploads a backup `.db` file: **all** current data is replaced (irreversible operation, with confirmation). The file is validated (SQLite header) and tables are copied column-by-column on the column intersection, so a backup with an older schema restores correctly. No app restart required. After restore, rows with an empty `area` value are automatically assigned to the correct area based on coordinates (most specific bounding box containing the point).

- **Export / Import coverage data** → the separate [Coverage-map database](#-coverage-map-aisstream-coverage) (`data/db/heatmap_data.db`) has its **own** export/import in the same tab (`GET /api/heatmap/export` / `POST /api/heatmap/import`, **replace** semantics), since it is **not** part of the main DB.

The server also writes a full **auto-backup** bundle (database + areas + settings) at a regular interval (default **every 2 hours**, configurable via `BACKUP_INTERVAL_MIN` in `app.config.properties`) to `data/backups/` (last 5 kept), plus on-demand from the Backup/Restore tab. The bundle now also **embeds** the separate coverage-map database (**v3** format `TPB3`: header + main DB + heatmap DB, both length-prefixed and streamed); older **v1/v2** bundles still restore (no heatmap section).

> ℹ️ **Database location.** The SQLite databases (`ais_data.db` + `heatmap_data.db`) now live under `data/db/`. Older versions kept them at the **project root**; on the first start of the new version they are **auto-relocated** into `data/db/` (including the `-wal`/`-shm` sidecars). Bundles store **DB content, not file paths**, so export/import between an old-layout and a new-layout version works regardless.

#### Auto-restore after a deploy

`ais_data.db` is gitignored: a deploy that recreates the app folder **wipes it**. At startup, if the database file **does not exist** (just re-created empty) and `data/backups/` holds at least one auto-backup, the server **automatically restores the most recent backup** — the database only (areas in `bounding-boxes.json` and settings in `local.properties` are files that survive a deploy, so they are left untouched). See the log `[RESTORE] DB assente dopo il deploy → ripristinato l'ultimo backup …`.

- Triggers **only** when the `.db` file was absent at startup: an existing-but-empty DB (e.g. after **🗑 Clear data** + restart) is **not** restored, so intentionally deleted data is never resurrected.
- Disable with `AUTO_RESTORE_ON_DEPLOY=false` in `app.config.properties`.
- **Important**: for this to work, `data/backups/` must **survive the deploy** (e.g. on a persistent volume / outside the replaced directory). See [Deploy on a Linux server](#-deploy-on-a-linux-server-vps).
- The auto-restore also **rehydrates the heatmap DB** (`data/db/heatmap_data.db`) from the latest bundle's embedded coverage section, when present.

---

## 🔐 Authentication (multi-user)

The whole app is gated behind a **session login**: no route is reachable without being authenticated. The session rides in a **signed `httpOnly` cookie**; passwords are stored hashed with **scrypt** (nothing is recoverable in cleartext). There is no longer any `localhost` bypass: even locally you must log in.

### Registration and approval

From the login page a visitor can **register** with first name, surname, email and password. New accounts start in the **"pending"** state and **cannot log in** until an administrator approves them. (Email confirmation is planned but currently inert: no SMTP is wired up yet.)

### Roles

There are two roles: **user** (normal) and **admin**. Everyone registers as a normal user; an administrator can promote or demote accounts. In addition to the normal features, an administrator can: **view the logs** (the API log and the activity log are global/shared and admin-only), **approve** registrations, **enable/disable** accounts, **change roles**, **reset passwords**, **delete** users, and **impersonate** a user (a **read-only** view of that user's areas/monitoring/followed ships, with a banner and one-click exit). All of this from the **admin page** at `/admin`, reachable via the **Admin** link in the account widget (top-right). In the user table each row exposes **a single inline button** (the action that row is waiting for: Approve when pending, Re-enable when disabled) plus a **···** menu with everything else, grouped by intent (status → role → utilities → destructive); the menu is appended to `<body>` with `position:fixed`, because `.tablewrap` has `overflow-x:auto` and would clip a dropdown positioned inside the cell. There is also a third **tester** role (limits on area count/size and followed ships), assignable **only at approval time** via "Approve as tester"; the **Promote to user** menu entry turns it back into a regular user (`POST /api/admin/users/:id/role` with `role: 'user'`), and the reverse transition is not allowed on an already-approved account.

### Built-in administrator

A built-in administrator is **created at startup if missing**, with username `admin` and the password read from `ADMIN_PASSWORD` in `local.properties` (gitignored, never committed):

```properties
ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@local
ADMIN_PASSWORD=a_strong_password
COOKIE_SECURE=false      # → true when serving over HTTPS
SESSION_TTL_DAYS=30
```

Login accepts **either the username or the email**.

> ⚠️ **`ADMIN_PASSWORD` no longer has a default value in the code.** If `ADMIN_PASSWORD` is not configured (neither in `local.properties` nor as an environment variable) **and** no admin account exists yet (first boot on an empty DB, or restoring a backup with no users), the boot **stops** with a log error — no admin is ever created with a weak or empty password. Configure `ADMIN_PASSWORD` and restart. If an admin already exists (even under a different username), boot proceeds normally regardless of this key.

### Per-user vs global data

Each user has **their own** data:

- their **areas** (monitoring bounding boxes);
- their **settings** (notification preferences, OpenSeaMap map-display options, language, default area);
- their **flagged** ships ★, **followed** ships, and ships marked **seen** 👁;
- ships they have **taken in charge** 🧑‍✈️ (only within a group — see below);
- their own **notifications** feed.

Ship visibility is **geographic**: a user sees AIS data whose position falls inside one of their areas' bounding boxes.

The following are instead **shared/global** (admin-managed, **not** per-user):

- the **AISstream API key** and other API keys/tokens;
- the **enrichment sources** (VesselFinder, MarineTraffic, OFAC/EU/UK/UN sanctions, Port State Control, Global Fishing Watch, Equasis);
- the **risk-score configuration** (cargo weights, exclude-tankers, spoofing/dark-activity checks).

There is **one AISstream connection set** system-wide (one WebSocket per distinct area bounding box, plus one shared "follow" stream), and the **risk score is a single shared value** per ship.

### 👥 User groups

An administrator can bundle users into **groups** (from the `/admin` page). Each user belongs to **at most one group**; a group must have **at least 2 members**. Group members **share** — as a **union** — five resource sets plus a subset of settings:

- monitoring **areas**;
- **followed** ships (active);
- **flagged** ships ★;
- **muted** ships 🔕;
- ships marked **seen** 👁 (handy for splitting up triage work: whoever checked a ship marks it seen for the whole group);
- **notification preferences** (in-app and per-category Telegram + ship-type filter + send-map) and **map-display** (OpenSeaMap) options + the **default area**.

These stay **personal** (never synced): each user's **Telegram connection** (linked chat + link code), the UI **language**, and of course credentials and session. **Admin-managed global** settings (enrichment sources, risk weights, etc.) stay global and apply to everyone, as before — they are **not** part of the group.

**How sync works (write-through):**

- **On creation / when a member joins**, areas/follows/flags/mutes become the **union** across all members and are written back to each. The group's initial settings are taken from a **"model" user** picked by the admin at creation; a member who joins later **adopts** the group's current settings.
- **During use**, every change a member makes propagates to the others — both **additions** and **removals** (areas/ships), and every change to a shared preference. The others see it **on their next access/refresh**. The **notification feed** converges naturally (same areas ⇒ same events), but **read/unread state stays personal**.
- **Disassociating** a member: it **keeps** everything it accumulated (areas, ships, latest settings) and simply **stops syncing**.

**The 2-member rule:** a removal that would drop a group to 1 is **blocked** — to break up a 2-member group use **"Dissolve group"** (everyone reverts to solo, keeping their data). The only exception: **deleting** a user is an explicit destructive action, so if the deletion leaves the group with a single member the group is **dissolved automatically**.

**Group activity log** (table `group_activity_log`, populated by [`src/services/group-sync.js`](../../src/services/group-sync.js)): the write-through mirror is silent by itself, so every mirrored action — area add/remove, follow/unfollow, flag/unflag, mute/unmute, seen/unseen, a shared-setting change (including the default area) — is also recorded with **who** did it, **when**, and the data needed to build a readable sentence (ship/area name **resolved at write time**, so the row stays readable even if the ship/area is later renamed or removed). Retention is configurable (`GROUP_ACTIVITY_LOG_RETENTION_DAYS` in `app.config.properties`, default 90 days — periodic cleanup, same pattern as the other historical tables); included in `BACKUP_TABLES` and in `pruneOrphans()` (rows left behind by a dissolved group). Every user in a group sees this log — newest first, paginated ("Load more") — in the sidebar's **Group activity** section (below Monitoring/Followed ships, visible only to users in a group), which also shows the group name and member list in a separate tab. API: `GET /api/group` (group info + members) and `GET /api/group/activity?limit=&offset=` (paginated feed) — both resolve the logged-in user's own group, no group id is accepted as input.

**Taking a ship in charge** (group triage, table `user_ship_charges`: `user_id, mmsi, assigned_by_id, created_at`): unlike the five resource sets above, this is **not** mirror-shared — several members can hold the same ship "in charge" at once, and each row belongs to whoever actually took it (or was assigned it), not a union propagated to the whole group. Any member can **take charge of a ship themselves** or **assign** it to a co-member; any group member may remove anyone's charge (same open model as flag/follow/mute/seen — [`src/services/group-sync.js`](../../src/services/group-sync.js) `logCharge` only writes the audit-log entry, the actual row is written by `routes/ships.js`, which checks the target is a co-member). Visible in the ship-detail header (tags of who has it + a "take charge" 🧑‍✈️ button + an "assign to a member" menu), and in the lists (Monitoring/Followed ships, active and past) as a dedicated background/icon (`.charged-row`, teal) + user tags on the row. Filterable both from the free-text search box (matches user names) and from a dedicated dropdown (all / taken by me / not taken / a specific member). Every change is still logged to the group activity feed (`charge_on`/`charge_off`/`charge_assign`), same mechanism as the paragraph above. API: `PATCH /api/ships/:mmsi/charge {on, targetUserId?}` (`targetUserId` absent = self; if present it must be a co-member, else 403). Table included in `BACKUP_TABLES` and in the `deleteUser` cascade; no impact on restoring older backups (new table, the restore loop skips it when absent from the backup).

**"Group activity" notifications** — the actions above (the five mirror-shared sets plus taking a ship in charge) can optionally **notify co-members**, on top of silently staying in the log. Each user controls **what they receive**, but not which of their own actions notify others (the rules apply to the whole group, being shared preferences — see above). Six categories (one per set: areas, followed ships, flag, mute, seen, charge), each with **three independent gates**, all default ON:

- **In-app** (`notifyGroupArea`/`notifyGroupFollow`/`notifyGroupFlag`/`notifyGroupMute`/`notifyGroupSeen`/`notifyGroupCharge`) — drives the **Group activity notifications** feed, a second sidebar button (next to **🔔 Notifications**, visible only to group members) opening the **same shared overlay** with its own independent badge/content (`?kind=group` on the same API as above).
- **Telegram** (`telegramNotifyGroupArea` etc., same mechanism as the other Telegram categories — see [Telegram notifications](#-telegram-notifications)).
- **Webhook** (`webhookNotifyGroupArea` etc.) — a per-category master checked **before** each webhook's own `events` filter (`webhooks.dispatch`); the 14 types `group_area_add/remove/edit`, `group_follow_on/off`, `group_flag_on/off`, `group_mute_on/off`, `group_seen_on/off`, `group_charge_on/off/assign` are selectable like any other webhook event. This is the **only** gate of this kind in the app: the 7 pre-existing webhook categories have no per-category master, only the per-webhook subscription.

The fan-out (`groupSync.notifyGroupActivity`, called from every `sync*`, from `logCharge` and from `notifyAreaEdit`) iterates the co-members (never the actor) — with one exception, an **area edit** (`group_area_edit`), whose recipient list is passed explicitly and holds **every other owner of that area**, group or not (the area catalog is global: the edit moves the area for them too). That is why the "Group activity notifications" feed also appears in the sidebar of a user with **no group** who has at least one notification in it (`hasGroupNotifications` in `/api/auth/me`), and why `getNotifications` resolves the actor's name server-side (`actor_name`, LEFT JOIN on `users`) — the client cannot derive it from its own group roster. For whoever has the in-app gate on, it writes a `notifications` row with `type` prefixed `group_` (e.g. `group_flag_on`), `actor_id` = who performed the action, and — for taking a ship in charge — `target_user_id` = the other user involved. The message text (`"<Actor> …"`) reuses **the same i18n keys** as the "Group activity" log view (`groupActivity.msg.*`), so the two presentations (log and notification) always stay in sync. All eighteen preferences are in `SHARED_SETTING_KEYS` (mirrored within the group, like the other notification preferences).

### Forgot password

Since email is not wired up yet, password reset is **admin-initiated**: the user list on the `/admin` page has a **"Reset password"** action that generates a **one-time link** (valid **24h**) to hand to the user. The login page still shows a **"Password dimenticata?"** (forgot password) link and a registration link.

### Migration from the single-user version

When upgrading from a previous (single-user) version: when an **old database** (pre-multi-user) is restored/imported, all of its existing areas, flagged ships, followed ships, seen ships and notifications are **automatically migrated to the built-in administrator account**. The "seen" flag — global on `ships.seen` before the ship-type notification filter was introduced — gets the same treatment: `migrateMultiUser` (`src/db.js`) re-homes it to the admin's `user_seen` and zeroes the legacy column, so older backups keep importing cleanly without losing already-marked ships.

> ⚠️ The session cookie itself **does not encrypt traffic**. For direct internet exposure put **TLS** in front (HTTPS reverse proxy, Caddy, Cloudflare Tunnel…) and set `COOKIE_SECURE=true` so the cookie is only sent over HTTPS.

---

## 📱 Installable app (PWA)

The app is a **Progressive Web App**: it installs to the home screen (Android/iOS) or as a desktop app (Chrome/Edge) and opens **standalone** (no browser chrome). No store, no build step — these are static files served from `public/`.

- **Manifest** ([`public/manifest.webmanifest`](../../public/manifest.webmanifest)) — name, icons, `display: standalone`, theme/background colour `#0a0d13`.
- **Icons** ([`public/icons/`](../../public/icons/)) — derived from the brand logo [`public/icons/source.png`](../../public/icons/source.png) (blue tile, white anchor over a map): [`scripts/gen-icons.js`](../../scripts/gen-icons.js) detects the blue tile, crops it full-bleed (no white corners) and resizes it with `sips` (macOS) into 192/512, 512 *maskable*, `apple-touch-icon` 180, favicon 32. To regenerate after replacing `source.png`: `node scripts/gen-icons.js` (requires macOS; the PNGs are committed, production never runs it).
- **Service worker** ([`public/sw.js`](../../public/sw.js)) — registered by `index.html`. Strategy tuned for a **live** tracker: `/api/*` and external origins (Leaflet CDN, OSM/OpenSeaMap tiles) are **never** intercepted or cached (no authenticated or live data lands in the browser cache); the **shell** (HTML/CSS/JS, locales, icons) is *stale-while-revalidate* so the app opens fast and even offline; navigations are *network-first* with a fallback to the cached shell or [`offline.html`](../../public/offline.html). Bump `CACHE` in `sw.js` to invalidate everything.
- **Access without a session** — `manifest.webmanifest`, `/sw.js`, `/icons/*` and `/offline.html` are served **before the auth gate** ([`src/app.js`](../../src/app.js)): the browser loads them on the login page too and registers the SW at scope `/`. The app and data (`/index.html`, `/api/*`) stay protected.

To install: open the site → browser menu → "Install app" / "Add to Home Screen".

---

## 🐧 Deploy on a Linux server (VPS)

### Server requirements

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

node --version   # v22+
npm --version

# The MarineTraffic/Equasis crawlers use node-libcurl (bundled libcurl via npm).
# No system `curl` required. On minimal distros, the source-build fallback needs
# build-essential: sudo apt-get install -y build-essential
```

### Manual deploy

```bash
# On the server
mkdir -p /opt/tracker-porti
# Copy files (from local via scp or rsync)
scp -r /Users/marco/projects/tracker-porti/{package.json,package-lock.json,src,public} user@server:/opt/tracker-porti/

# Create local.properties on the server (do NOT copy the local one if it contains different keys)
# Must contain at least AIS_API_KEY — see "Configuration" section

ssh user@server
cd /opt/tracker-porti
npm install --omit=dev
```

> **Persistence across deploys**: `ais_data.db` is gitignored and is re-created empty on every deploy that replaces the folder. If you keep the `data/backups/` folder across deploys (don't overwrite it — e.g. on a persistent volume, or exclude it from `rsync --delete`), the app **automatically restores the most recent auto-backup** at startup (see [Auto-restore after a deploy](#auto-restore-after-a-deploy)). Alternatively, preserve `ais_data.db` directly.

### Starting with PM2 (persistent process)

PM2 keeps the process alive, restarts it after crashes and starts it at boot.

```bash
npm install -g pm2

# Start
pm2 start src/server.js --name tracker-porti

# Save configuration for auto-start at boot
pm2 save
pm2 startup   # follow the printed instructions

# Useful commands
pm2 status              # process status
pm2 logs tracker-porti       # real-time logs
pm2 restart tracker-porti    # restart
pm2 stop tracker-porti       # stop
```

### Port and firewall

By default the app runs on port 3000. To make it accessible:

```bash
# Open the port in the firewall
sudo ufw allow 3000

# Or use a custom port
PORT=8080 pm2 start src/server.js --name tracker-porti
```

> ⚠️ Opening the port exposes the app to anyone who can reach the server. The app is still gated by login (see [Authentication](#-authentication-multi-user)): **change the built-in administrator's password** (`ADMIN_PASSWORD`) first and set `COOKIE_SECURE=true`, ideally with TLS in front.

### Nginx as reverse proxy (optional, recommended)

To expose the app on port 80/443 with a domain:

```bash
sudo apt install nginx

# /etc/nginx/sites-available/tracker-porti
server {
    listen 80;
    server_name tuo-dominio.it;   # or server IP

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tracker-porti /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Environment variable for port

```bash
# With pm2
pm2 start src/server.js --name tracker-porti --env production -- --port 3000

# Or with env in ecosystem file
```

Or create `/opt/tracker-porti/ecosystem.config.js`:

```js
module.exports = {
  apps: [{
    name: 'tracker-porti',
    script: 'src/server.js',
    env: {
      PORT: 3000,
      NODE_ENV: 'production'
    },
    restart_delay: 5000,
    max_restarts: 10
  }]
};
```

```bash
pm2 start ecosystem.config.js
pm2 save
```

---

## 📂 Main files

| File                          | Description                                                       |
| ------------------------------| -------------------------------------------------------------------|
| `src/server.js` / `src/app.js`| Entry point + Express app factory                                  |
| `src/config.js`               | Config (local.properties/env), bbox presets, constants, runtime state; runtime add/remove of areas (`addArea`/`removeArea`, persisted to `bounding-boxes.json`); exports `areaForPoint(lat, lon)` to resolve a coordinate to the most specific containing preset key |
| `src/db.js`                   | SQLite wrapper: `readings`/`ships`/`port_events`/`api_log`/`ship_scrape_cache`/`ship_scrape_failures`/`notifications`/`risk_history`/`moorings`/`berths` schema, insert/upsert, queries, active predicate |
| `src/services/ais-stream.js`  | Multi-area AISStream WebSocket client (`Map<areaKey, state>`) + reconnection + port events + revisit and area-change notifications |
| `src/services/berths.js`      | Mooring detection + DBSCAN clustering + berth characterization (convex hull, point-in-polygon, backfill/recompute) + new-berth and characterization notifications |
| `src/services/ship-categories.js` | AIS ship-type code → broad category (cargo/tanker/passenger/…) + hazmat flag, used to characterize berths |
| `src/services/scrapers/`      | VesselFinder (https), MarineTraffic (node-libcurl) and Equasis (node-libcurl, login, on-demand) scraping |
| `src/services/risk-score.js`  | Arms transport risk score (0–100) from AIS behavioural signatures + cached VF/MT registry data |
| `src/services/enrichment.js`  | Proactive VF/MT enrichment (once) on first ship detection         |
| `src/services/sanctions.js`   | OFAC SDN + EU/UK/UN sanctions lists (OpenSanctions): CSV download, in-memory index, ship match by IMO/name/call sign |
| `src/services/psc.js`         | Port State Control (Paris/Tokyo MoU): flag performance (bundled JSON) + banned list (OpenSanctions CSV), match by flag name / IMO |
| `src/routes/`                 | Express routers per domain (ships, readings, events, notifications, logs, settings, app-config, stream, areas, berths, export) |
| `public/index.html`           | SPA: collapsible sidebar, tab nav, 4 views + modals (settings/diagnostics/logs) |
| `public/js/`                  | ES modules: SPA state machine, polling, Leaflet maps, track de-noising, charts, export |
| `public/css/style.css`        | Design system with CSS tokens; dark theme (default) and light theme (selectable) |
| `local.properties`            | Configuration + API key (gitignored, do not commit)               |
| `ais_data.db`                 | SQLite database (created on first run, gitignored)                |

## 🗄️ DB Schema

**`readings`** — every received AIS message (max 10,000 per type, automatic rotation); includes the column `area TEXT NOT NULL DEFAULT ''` that identifies the monitoring area for each record.

**`ships`** — one row per MMSI, updated on every reading:

| Column | Type | Description |
|---|---|---|
| `mmsi` | INTEGER PK | Ship identifier |
| `ship_name` | TEXT | Ship name |
| `first_seen_at` / `last_seen_at` | TEXT | First/last contact timestamp |
| `last_latitude` / `last_longitude` | REAL | Last position |
| `last_sog` / `last_cog` | REAL | Last speed (kn) / course (°) |
| `last_navigational_status` | TEXT | Last AIS navigational status |
| `ship_type` | INTEGER | Ship/cargo type code (ITU-R M.1371) |
| `destination` | TEXT | Declared destination |
| `max_draught` | REAL | Maximum draught (tenths of a metre) |
| `call_sign` | TEXT | Radio callsign |
| `imo_number` | INTEGER | IMO number |
| `dim_bow` / `dim_stern` / `dim_port` / `dim_starboard` | INTEGER | Ship dimensions (m) |
| `eta` | TEXT | Declared ETA |
| `flagged` | INTEGER | "Flagged" flag (★, 0/1) |
| `seen` | INTEGER | "Seen" flag (✓, 0/1) |
| `notes` | TEXT | Free-form notes on the ship |
| `mt_ship_id` | INTEGER | MarineTraffic internal `shipid` (resolved on first MT scraping) |
| `last_area` | TEXT NOT NULL DEFAULT '' | Key of the last area in which the ship was detected |

Auxiliary table **`ship_scrape_cache`** — cache of data downloaded from VesselFinder / MarineTraffic / Equasis for `(mmsi, source)`, with `scraped_at`. Source: `vf`/`mt` with `SCRAPE_CACHE_TTL`; `eq` (Equasis) with no expiry (stored once).

Auxiliary table **`ship_scrape_failures`** — negative cache of failed VF/MT lookups per `(mmsi, source)`, with `failed_at` and `reason`. The backfill skips a ship while its failure is newer than `SCRAPE_NEG_CACHE_DAYS`; a successful fetch deletes the row. Avoids re-contacting, on every re-enable, the ships the sources don't know.

**`port_events`** — automatically detected arrival/departure events: `mmsi`, `ship_name`, `event_type` (`arrived`/`departed`), `ts`, `ship_type`, `destination`, `draught`, `area TEXT NOT NULL DEFAULT ''` (area where the event occurred), plus the stop evidence written on the `departed` row: `stop_min_sog REAL` (minimum speed observed during the visit) and `stopped INTEGER` (1 = real call, 0 = crossing). Both **nullable**: NULL = not measured (rows older than this version, or positions already pruned by departure time), not "did not stop" — readers fall back to dwell alone.

**`api_log`** — HTTP request log (max 1,000, automatic rotation): `ts`, `method`, `path`, `status`, `duration_ms`, `request_body`, `response_body`.

**`notifications`** — two independent feeds shown in an overlay (see [Notifications](#-port-events-statistics-and-alerts)), distinguished by `type` and filtered with `?kind=personal|group` (100-row rotation **per feed**, not shared): `type` (`revisit`, `area_change`, `high_risk`, `berth_new`, `berth_characterized`, `proximity` for the personal feed; `group_area_add/remove`, `group_follow_on/off`, `group_flag_on/off`, `group_mute_on/off`, `group_seen_on/off`, `group_charge_on/off/assign` for the "Group activity" feed), `mmsi`, `ship_name` (for berths: the berth name, if it has one), `area` (destination area), `from_area` (origin area, only for `area_change`), `band` (`low`/`med`/`high` for ship notifications; the berth category for `berth_characterized`) and risk `score` computed at event time, `berth_id`/`berth_lat`/`berth_lon` (referenced berth, only for berth notifications), `actor_id`/`target_user_id` (only on `group_*` rows: who performed the action / the other user involved when taking a ship in charge), `ts`, `read` (0/1).

**`risk_history`** — risk-score snapshots over time for the trend chart (see [Risk score history](#-risk-score-history)): `mmsi`, `ts`, `score`, `band`. Sparsely sampled (max 1/hour per ship) and globally capped (rotation at 20,000 rows).

**`moorings`** — one mooring point per visit (see [Berths](#-berths-automatic-mooring-characterization)): `area`, `mmsi`, `ship_type`, `category` (broad category), `lat`, `lon`, `ts`, `berth_id` (assigned berth, `NULL` if unclustered). Rebuilt by the berths service on every recompute.

**`berths`** — detected/drawn berths: `area`, `name`, `polygon_json` (`[[lat,lon],…]`), `centroid_lat`/`centroid_lon`, `manual_geom` (1 = hand-locked geometry), `char_label` (computed dominant category or `mixed` or `NULL`), `char_override` (hand-forced category, takes precedence), `mooring_count`, `dist_json` (distribution `[{category,n,pct}]`), `hazmat_pct`, `updated_at`. Both included in backups (`BACKUP_TABLES`).

**`proximity_events`** — [ship-to-ship rendezvous](#-ship-to-ship-rendezvous-detection) contacts: one row per encounter between a canonical pair (`mmsi_a < mmsi_b`), with `name_a`/`name_b`, `area`, `started_at`, `last_seen_at`, `ended_at` (`NULL` = contact still open), `min_dist_m` (closest distance reached), `lat_a`/`lon_a`/`lat_b`/`lon_b` (last positions), `alerted` (1 = dwell threshold reached, notification already sent). Feeds the risk score (both ships) and the "Rendezvous" section of the detail view. Retention: cap of 5,000 closed contacts. Included in backups (`BACKUP_TABLES`).

## 🔌 Internal API

| Method | Path | Description |
|---|---|---|
| POST | `/api/stream/start` | Start WebSocket connection to AISStream for the specified area — body `{area}` required |
| POST | `/api/stream/stop` | Close the connection for the specified area — body `{area}` required |
| GET | `/api/stream/status` | `{streams: {areaKey: {active, totalReceived}}, dbCount}` — status of all streams |
| GET | `/api/stream/health` | Connection statistics (uptime, msg/min, errors) for the specified area (`?area=`) |
| GET | `/api/ships/active` | "Active" ships in the area (`?area=`), 6h / 24h in-port window, + fields `direction`, `in_port`, `risk`, `is_military`, `flagged` (forced to `true` if military) |
| GET | `/api/ships/past` | "Past" ships in the area (`?area=`), complement of active, sorted by flag/date, + fields `risk`, `is_military`, `flagged` |
| GET | `/api/ships/:mmsi` | Static data for a ship (+ fields `direction`, `in_port`, `risk`, `is_military`, `flagged`) |
| GET | `/api/ships/:mmsi/readings` | Readings for a ship (`?limit=50&offset=0`), includes `source` (`ais`/`sf`/`mst`) |
| GET | `/api/ships/:mmsi/track` | Position points for map track (`?limit=500`) |
| GET | `/api/replay` | Historical positions of all ships in an area for the replay (`?area=KEY&window=1h\|6h\|24h\|all` or `&from=ISO&to=ISO`), grouped by ship + available range. With `&scraped=1` it also folds in SF/MST positions (enabled integrations); response carries `extraAvailable` |
| GET | `/api/transits` | Ships that called at **two** of the user's monitored areas and the legs between them (`?a=KEY&b=KEY&period=all\|12m\|6m\|3m\|30d&includeNoLeg=0\|1`). 400 for missing/identical areas, 403 when the user doesn't monitor both; response carries `gate` (thresholds used) and `truncated` |
| GET | `/api/ships/:mmsi/vfdata` | Data downloaded from VesselFinder (with cache) |
| GET | `/api/ships/:mmsi/mtdata` | Data downloaded from MarineTraffic (with cache); resolves and saves `mt_ship_id` |
| GET | `/api/ships/:mmsi/equasis` | Equasis data (ownership/management) from cache; scrapes only with `?fetch=1` (detail button). Never automatic, no expiry |
| GET / DELETE | `/api/equasis-log` | Reads (tail 256 KB) / clears the plain-text audit log of Equasis lookups (`equasis.log`) |
| GET | `/api/ships/:mmsi/events` | Port events (arrivals/departures) for a ship, with `area_name` (joined on `areas.key`, the global name of the monitored area the event occurred in) |
| GET | `/api/ships/:mmsi/risk-history` | Risk-score snapshot time series for the ship (`{history:[{ts,score,band}]}`) |
| GET | `/api/ships/expected` | Expected ships in the area (`?area=`): destination = preset keyword, departed < 48h ago |
| PATCH | `/api/ships/:mmsi/flag` | Set flagged flag `{flagged: 0\|1}` |
| PATCH | `/api/ships/:mmsi/seen` | Set seen flag `{seen: 0\|1}`, per-user (`user_seen`), group-mirrored |
| PATCH | `/api/ships/:mmsi/charge` | Group triage "take charge" `{on: 0\|1, targetUserId?}`, per-user (`user_ship_charges`), NOT mirrored — `targetUserId` absent = self, otherwise must be a co-member (403 otherwise) |
| PATCH | `/api/ships/:mmsi/notes` | Set free-form notes `{notes: "…"}` |
| PATCH | `/api/ships/:mmsi/military` | Set manual military flag `{is_military: 0\|1}` → forces score 100 and red row |
| GET | `/api/readings` | Global readings (`?type=&limit=50&offset=0`) |
| GET | `/api/readings/:id` | Single record detail with raw JSON |
| DELETE | `/api/readings` | Delete readings, ships and port events for the specified area (`?area=`, default: current area) |
| GET | `/api/events` | Port events for the area (`?area=&limit=100&offset=0`) |
| GET | `/api/stats` | Aggregate statistics for the area (`?area=`) — arrivals, average stop, by hour/type |
| GET | `/api/stats/scores` | Aggregate risk scores for the area (`?area=`) for ships in the last 7 days: `byBand` (count per band), `topShips` (top 8 by score), `byFactor` (most frequent factors), `dailyArrivals` (arrivals per day last 30 days) |
| GET | `/api/alerts` | Alert queue of flagged ships that re-entered the area (cleared on read) |
| GET | `/api/notifications` | Notification feed (last 100) + unread count: `{notifications, unread}` — `?kind=personal\|group` (default `personal`) selects the feed |
| POST | `/api/notifications/:id/read` | Mark a notification as read → `{ok, unread}` (`?kind=` for the returned count) |
| DELETE | `/api/notifications/:id` | Delete a notification → `{ok, unread}` (`?kind=`) |
| DELETE | `/api/notifications` | Delete **all** notifications in the `?kind=` feed → `{ok, unread:0}` |
| POST | `/api/notifications/read-all` | Mark all notifications in the `?kind=` feed as read → `{ok, unread:0}` |
| GET | `/api/export` | Download ZIP with CSV per message type |
| GET | `/api/backup` | Download entire database as a `.db` file (`VACUUM INTO` snapshot) |
| POST | `/api/restore` | Restore the entire DB from an uploaded `.db` file (body `application/octet-stream`) |
| GET | `/api/app-config` | `app.config.properties` parameters grouped, with descriptions extracted from the file comments; `{groups, applies:'restart'}` |
| POST | `/api/app-config` | Write edited parameters `{values:{KEY:value}}` (only keys already present in the file); `{ok, changed, restart}` |
| GET | `/api/settings` | Current bbox preset, preset list, VF/MT import status |
| POST | `/api/settings` | Change preset, import toggles, notification toggles and OpenSeaMap overlay `{preset?, importVfData?, importMtData?, notificationsEnabled?, notifyRevisit?, notifyAreaChange?, notifyHighRisk?, notifyBerthNew?, notifyBerthChar?, notifyProximity?, notifyShipTypesHidden?, notifyIncludeSeen?, showOpenSeaMap?, showOpenSeaMapMarkers?, openSeaMapHidden?}` |
| GET | `/api/areas` | List of areas with bbox, stream status, `current` flag and data `counts`; `{areas, preset, minAreas}` |
| POST | `/api/areas` | Add an area `{name, sw:[lat,lon], ne:[lat,lon], keyword?, autostart?}` → saves to `bounding-boxes.json` and starts the stream (unless `autostart:false`) |
| PATCH | `/api/areas/:key` | Edit an existing area `{name?, keyword?, sw?, ne?}` → the **key never changes** (history stays attached), rewrites `bounding-boxes.json` + the DB catalog and, when the box changed and the stream is active, re-sends the subscription. When the area is shared, every other owner gets a `group_area_edit` group notification |
| DELETE | `/api/areas/:key` | Delete an area and all its history (readings/ships/events); refuses if it's the only one left. If it was the active area, selects another |
| GET | `/api/berths` | Berths for the area (`?area=`, default: current area) with geometry, effective label, distribution and counts; `{berths, minMoorings, dominantPct}` |
| POST | `/api/berths/recompute` | Recompute moorings and berths: with `?area=` just that one, otherwise all areas |
| POST | `/api/berths` | Create a manual berth by drawing a polygon `{area, polygon:[[lat,lon],…], name?, override?}` |
| PATCH | `/api/berths/:id` | Edit a berth `{name?, override?, polygon?}` (a polygon locks the geometry as manual) |
| POST | `/api/berths/merge` | Merge several berths into a single manual one `{ids:[…], name?}` |
| DELETE | `/api/berths/:id` | Delete a berth (its moorings are freed) |
| GET | `/api/logs` | HTTP request log (`?limit=200&offset=0`) |
| GET | `/api/logs/stream` | SSE: live stream of API logs |
| GET | `/api/logs/:id` | Single log entry detail with request/response body |
| DELETE | `/api/logs` | Delete all logs |

## 📝 Notes

- **Empty area**: a port may have no AIS ships during overnight hours or low-activity periods. The app works correctly — the "active" list is simply empty. Data remains in the "past" tab and in the DB.
- **Automatic reconnection**: if an area's WebSocket closes unexpectedly while its stream is active, the backend attempts reconnection after 5 seconds (independently per area).
- **AIS outage detection**: when an active stream receives no ship messages for `AIS_OUTAGE_SILENCE_MIN` minutes (default 10), the backend queries an **independent uptime monitor** ([AISStream-Uptime](https://github.com/buttermilkgreen/AISStream-Uptime)) that keeps its own connection to `stream.aisstream.io`. **Hybrid** mode: a **self-hosted** instance (`AIS_UPTIME_SELFHOST_URL`) is queried first and, only if unreachable, the **public** fallback instance (`AIS_UPTIME_URL`, default `https://aisuptime.buttermilkgreen.fyi`) — which also indicates whether the outage is global. Only if the responding monitor reports the service as not active (state ≠ *Up*) does a non-intrusive **outage banner** appear on the monitoring pages — so a genuinely quiet area never raises a false alarm. Disable with `AIS_OUTAGE_CHECK=false`. See the **Credits / third-party sources** section at the bottom.
  The silence + external cross-check mechanism above has a blind spot: if the stream can't even hold a connection open (it keeps closing seconds after connecting, e.g. `503`/`socket hang up`/`1006`), `connectedAt` resets on every attempt and silence never accumulates enough to reach the cross-check. So on top of the above, all three streams (**area monitoring**, **followed ships**, **coverage heatmap**) also track their own connection health directly: if a stream stays stuck never reconnecting for `AIS_OUTAGE_SILENCE_MIN` minutes, or **reconnects repeatedly** (3+ times within the same window, "flapping") even though each attempt only lasts a few seconds, the banner still appears, naming which stream (`monitoring`/`follow`/`heatmap`) is in trouble. No external cross-check needed here — our own socket being down isn't ambiguous, unlike a quiet area which could just be genuinely low-traffic. See `getConnTrouble()` in `ais-stream.js`/`ship-follow.js`/`heatmap-stream.js` and `stuckStreams()` in `ais-uptime.js`.
- **Restart and data**: the DB (`ais_data.db`, WAL) persists across restarts. After a restart, ships that transmit infrequently (moored) may not appear immediately in "active" until they transmit again — see the 6h/24h windows.
- **`node-libcurl`**: MarineTraffic/Equasis scraping uses `node-libcurl` for the Cloudflare bypass (bundled libcurl, no system `curl`). If the native binary fails to install, MT/Equasis import fails but the rest of the app works.
- **Node.js version**: the `node:sqlite` module is built-in from Node 22.5+. It does not work on earlier versions.

## 🙏 Credits / third-party sources

AIS outage detection relies on the **[AISStream-Uptime](https://github.com/buttermilkgreen/AISStream-Uptime)** project by [buttermilkgreen](https://github.com/buttermilkgreen) (**MIT** license) — an uptime monitor for `stream.aisstream.io`. None of its source code is bundled: the app only consumes the **REST API** (`GET /api/v1/status`) through a client written for this project ([`src/services/ais-uptime.js`](../../src/services/ais-uptime.js)). Being MIT-licensed, the monitor can be **self-hosted**: set your instance's URL in `AIS_UPTIME_SELFHOST_URL` (queried first) and the [public instance](https://aisuptime.buttermilkgreen.fyi) stays only as a fallback. Configurable/disableable via `AIS_UPTIME_SELFHOST_URL` / `AIS_UPTIME_URL` / `AIS_OUTAGE_CHECK`.

Other third-party data sources used by the app, each under its own terms: [AISStream.io](https://aisstream.io) (AIS feed), [VesselFinder](https://www.vesselfinder.com) / [MarineTraffic](https://www.marinetraffic.com) (ship enrichment), [Equasis](https://www.equasis.org) (ownership/management), [Global Fishing Watch](https://globalfishingwatch.org) (behavioural events, **free for non-commercial use only**), [OpenSeaMap](https://www.openseamap.org) / [OpenStreetMap](https://www.openstreetmap.org) (nautical layer), and the sanctions/PSC lists (OFAC, EU, UK OFSI, UN, Paris/Tokyo MoU).
