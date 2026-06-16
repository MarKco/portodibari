# 🚢 Tracker Porti

> 📖 Italian documentation: [README.md](README.md)

```
          /\
         /  \
     ___/    \___
    |  TRACKER   |
    |  PORTI     |
     \__________/
    ~~~~~~~~~~~~~~
```

App for tracking ships via [AISStream.io](https://aisstream.io). The monitoring area can be selected at runtime from multiple presets (Bari, Taranto, North Adriatic, Puglia — see [Bounding box](#bounding-box)) and is configurable with arbitrary bounding boxes, making it usable for any port. Areas can be **added and removed at runtime** from the **🗺 Areas** screen (no app restart). **Multiple areas can be monitored simultaneously**: each area has its own independent AIS stream.

## 🏗️ Architecture

```
Browser ←──polling 5min──→ Express (Node.js) ←──WebSocket──→ AISStream.io
                                 │         └──curl subprocess──→ MarineTraffic (Cloudflare)
                                 │         └──https───────────→ VesselFinder
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
│   │   ├── sanctions.js       # OFAC SDN sanctions list: download, index, match by IMO/name/call sign
│   │   ├── psc.js             # Port State Control (Paris/Tokyo MoU): flag performance + banned vessels
│   │   ├── equasis-log.js     # Append-only audit log of Equasis lookups (equasis.log)
│   │   └── scrapers/
│   │       ├── http.js        # HTTP/curl helper + HTML parsing
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
│       ├── notifications.js   # Sidebar notification feed (badge, list, mark as read)
│       ├── api.js, dom.js, store.js, toast.js, helpers.js
│       ├── theme.js           # Light/dark theme toggle + localStorage persistence
├── bounding-boxes.json       # Monitoring area presets (customizable)
├── local.properties          # Config + API key (gitignored)
├── local.properties.example  # Configuration template
└── ais_data.db               # SQLite database (created on first run, gitignored)
```

## ⚙️ Configuration (`local.properties`)

Configuration lives in the `local.properties` file at the project root (format `KEY=value`, lines starting with `//` or `#` are ignored). **The file is in `.gitignore`** because it contains the API key — do not commit it. Start from `local.properties.example` (`cp local.properties.example local.properties`). Keys can also be passed as environment variables.

| Key | Description | Default |
|---|---|---|
| `AIS_API_KEY` | [AISStream.io](https://aisstream.io) API key (required) | — |
| `BBOX_PRESET` | Initial area preset (`bari` \| `taranto` \| `nord_adriatico` \| `puglia`) | `bari` |
| `IMPORT_VF_DATA` | Enable VesselFinder scraping (`true`/`false`) | `false` |
| `IMPORT_MT_DATA` | Enable MarineTraffic scraping (`true`/`false`) | `false` |
| `IMPORT_SANCTIONS` | Enable OFAC SDN sanctions list screening (`true`/`false`) | `false` |
| `IMPORT_PSC` | Enable Paris/Tokyo MoU Port State Control screening: flag performance + banned vessels (`true`/`false`) | `false` |
| `IMPORT_EQUASIS` | Enable the on-demand Equasis lookup (ownership/management) in the ship detail (`true`/`false`) | `false` |
| `EQUASIS_USER` | Equasis account email (free registration at [equasis.org](https://www.equasis.org/)) — required by the Equasis lookup | *(empty)* |
| `EQUASIS_PASSWORD` | Equasis account password — required by the Equasis lookup | *(empty)* |
| `AUTH_USER` | Username for HTTP Basic authentication (see [Authentication](#-authentication)) | `admin` |
| `AUTH_PASSWORD` | Password for HTTP Basic authentication. **Empty = auth disabled** | *(empty)* |

`BBOX_PRESET`, `IMPORT_VF_DATA` and `IMPORT_MT_DATA` can also be changed from the UI (area selector / Settings modal) and are persisted back to the file. `PORT` (environment variable) sets the HTTP port (default 3000). `AUTH_USER`/`AUTH_PASSWORD` are read only at startup (not editable from the UI).

Example `local.properties`:

```properties
AIS_API_KEY=la_tua_api_key
BBOX_PRESET=taranto
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

Default presets: `bari`, `taranto`, `nord_adriatico`, `puglia`.

There are **two ways** to manage areas:

1. **🗺 Areas screen (at runtime, no restart)** — the **🗺 Areas** sidebar button opens a page with the list of areas (with coordinates, status and amount of stored data), a map showing them all, and a panel to add new ones:
   - **by GPS coordinates** in decimal degrees (SW lat/lon and NE lat/lon fields), or
   - **from the map**: frame (zoom/pan) the area to monitor and press **🎯 Capture current view** to fill the coordinates automatically from the visible viewport.
   - Give it a **name** (required) and an optional **keyword**. The new area is saved to `bounding-boxes.json` and its stream starts immediately.
   - **Deletion**: the 🗑 trash button removes the area **and all related monitoring history** (readings, ships, port events). Deletion is **deferred by 10 seconds** with an **↶ Undo** toast: it becomes effective when the timer elapses or when you leave the page; pressing Undo deletes nothing. **At least one area** must remain (the last one cannot be deleted).
2. **`bounding-boxes.json` file (manual)** — add/edit an entry by hand and **restart** the app. Useful for initial provisioning or scripts.

> The Areas screen rewrites `bounding-boxes.json` (it preserves the `_comment` key but normalizes formatting). Preset keys are derived automatically from the name.

The **🏠 Monitoring** sidebar button returns to the home (active/past/traffic views).

Changing the area in the dropdown at the bottom of the sidebar is a **view change only**: it shows data for the selected area but does not start or stop any stream. Each area has its own independent stream — to start or stop an area's stream use the sidebar buttons or the **"Area monitoring"** panel in Settings. The selected area is persisted to `local.properties` (key `BBOX_PRESET`). The *keyword* is used by the "Expected ships" section to filter ships with a matching destination.

## 📻 Received AIS message types

- `PositionReport` — position, speed (SOG), course (COG), heading, navigational status
- `ShipStaticData` — name, callsign, IMO, dimensions, destination, draught
- `ExtendedClassBPositionReport` — Class B with extended data
- `StandardClassBPositionReport` — standard Class B

## 🗃️ Data retention

Max 10,000 records per message type. Automatic rotation (deletes oldest) every 500 inserts per type. Notifications (table `notifications`) retain the last 100 records, with automatic rotation on every insert.

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
| Max records per message type    | `src/db.js`                       | `pruneStmt.run(..., 10000)`           | 10,000         |
| Max map track points            | `src/routes/ships.js` (`/track`)  | `Math.min(..., 2000)` and default `500` | 500 points   |
| VF/MT scraping cache TTL        | `src/config.js`                   | `SCRAPE_CACHE_TTL`                    | 6 hours        |
| Notification delete undo bounce | `app.config.properties`           | `NOTIF_DELETE_UNDO_SECONDS`           | 5 s            |
| Berth clustering radius         | `app.config.properties`           | `BERTH_CLUSTER_EPS_M`                 | 80 m           |
| Minimum moorings per berth      | `app.config.properties`           | `BERTH_MIN_PTS`                       | 3              |
| Minimum moorings to characterize| `app.config.properties`           | `BERTH_MIN_MOORINGS`                  | 10             |
| Dominant-category threshold     | `app.config.properties`           | `BERTH_DOMINANT_PCT`                  | 60 %           |
| Berth recompute interval        | `app.config.properties`           | `BERTH_RECOMPUTE_MIN`                 | 30 min         |

### Applying changes

No build required. Node.js interprets files directly.

| Modified file | Required action |
|---|---|
| Any file in `src/` | Server restart: `npm start` (or `npm run dev` for watch mode) |
| `public/**` (HTML, CSS, JS modules) | Browser reload (`Cmd+R`) — no restart needed |

## 🖥️ UI conceptual model

The interface is organized around **ships** (MMSI), not individual readings:

| View               | Content                                                                            |
| --------------------| -----------------------------------------------------------------------------------|
| **Active ships**   | Ships seen in the last **6 hours**, **or** "in port" ships seen in the last **24 hours**. Toolbar with **search** (name/MMSI/IMO/destination) and **filters** (risk band, in-port only, flagged only) + **CSV export of the filtered view** (see [Search, filters and export](#-search-filters-and-list-export)) |
| **Past ships**     | Ships that no longer meet the "active" criteria (complement). Same search/filter/export toolbar (without the "in port" filter) |
| **Ship detail**    | Static ship info (type, IMO, callsign, dimensions, destination…) + VesselFinder/MarineTraffic data (if enabled, above the map) + **[risk score over time](#-risk-score-history)** + track map (with collapsed stops) + paginated readings + notes + port visit history. **📄 Report** button to generate a [printable/PDF report](#-ship-pdf-report) |
| **Traffic**        | Aggregate statistics: summary cards, arrivals by hour-of-day chart, arrivals by ship type; **risk score distribution** (green/yellow/red tiles for ships in the last 7 days), **top risk factors** (frequency), **daily arrivals** (last 30 days), **highest-score ships** (top 8, clickable); expected ships (by preset keyword), latest port events |
| **Areas**          | Runtime area management: list with coordinates/status/stored data, map showing all areas, panel to add (GPS coordinates or map view capture) and delete areas (with related history and a 10s undo window) |

Accessory modals: **Settings** (Area monitoring panel with per-area start/stop toggles, toggle VF/MT import, CSV export, database backup/restore), **AIS Stream Diagnostics** (uptime, msg/min, reconnections, last error), **Logs** (live panel of API requests via SSE). Sidebar navigation buttons: **🏠 Monitoring** (home) and **🗺 Areas**. The sidebar also includes the **🔔 notification feed** (list with an unread badge, see [Port events, statistics and alerts](#-port-events-statistics-and-alerts)).

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

Implemented server-side in [`src/services/risk-score.js`](src/services/risk-score.js) — `computeRiskScore(ship, lang)`. For each ship it queries (read-only) the history via `db.getShipPositions` (positions last 168h), `db.getShipEvents` (port events), `db.getDistinctShipNames`. If VF/MT import is enabled, it also reads registry data **already in cache** via `db.getScrapedData` (see [Score enrichment from VF/MT](#score-enrichment-from-vfmt)) — read-only, no live scraping during calculation.

Each detected signature adds weighted points to an **anomaly subtotal**:

| Behavioural signature | Detection logic | Max weight |
|---|---|---|
| **AIS blackout (dark activity)** | Longest gap between consecutive readings **started while the ship was moving** (SOG ≥ `SOG_FERMA`). Ships in port transmit rarely → only silences while underway are counted. ≥ 6h → max; 2–6h → partial | 25 |
| **Spoofing / anomalous kinematics** | Implied speed between two consecutive positions (haversine distance / Δt, with Δt ≤ 1h, distance > 500 m). > 80 kn = physically impossible jump; > 50 kn = anomalous | 20 |
| **Draught increase (loading)** | Maximum positive increment of declared `draught` between consecutive port events (AIS unit = tenths of a metre). Indicates heavy cargo loaded. ≥ 0.5 m activates the score | 20 |
| **Loitering / anomalous stop** | Stationary positions (SOG < `SOG_FERMA`), **not** moored/at anchor (status ≠ 1/5), > 10 km from the bbox monitoring centre → possible ship-to-ship transfer in open sea | 15 |
| **Destination instability** | Number of distinct declared destinations (current field + events). More changes = more points | 10 |
| **Hull type** | Military (35) → **automatic score 100** (early return, no analysis); Cargo/Tanker Hazmat (71–74, 81–84) → 8; Cargo/Tanker (70–89) → 5 | 100 / 8 / 5 |
| **Military detection** | `isMilitary(ship)` in `risk-score.js`: **DB flag** `is_military = 1` **or** `ship_type === 35` **or** ship name contains military tokens (prefixes: `HMS`, `USS`, `FS`, `FGS`, `HNLMS`, `HMAS`, `HMCS`, `INS`, `BNS`, `HDMS`, `HTMS`, `TCG`, `ORP`, `ITS`, `ROKS`, `NRP`, `RFS`, `ESPS`, `SPS`; keywords: `WARSHIP`, `NATO`). Detected ships: receive `is_military: true` and `flagged: true` forced in the API response, row highlighted red with `.military-row` class (takes priority over `.flagged-row`). The manual flag (`is_military` in DB) allows marking military vessels that have neither `ship_type 35` nor a recognised prefix/keyword (e.g. Italian Navy ships transmitted without the "ITS" prefix). Set from the detail panel using the `🪖 Mark as military vessel` button. | — |
| **Hull name change** | Same MMSI transmitting multiple distinct names (flag/name hopping) | 8 |
| **External enrichment (VF/MT)** | Registry data from VesselFinder/MarineTraffic, **only if import is enabled and already cached** (see below): flag registered under embargo → 12, flag of convenience → 5, aged hull (≥ 35 years) → 6, home port in high-risk zone → 8 | 12 |
| **Sanctions (OFAC SDN)** | Match against the OFAC SDN sanctions list by IMO/name/call sign, only if `IMPORT_SANCTIONS` (see `sanctions.js`). Very strong direct signal | 60 |
| **Port State Control (Paris/Tokyo MoU)** | Only if `IMPORT_PSC` (see below): flag on MoU black list → 12, on grey list → 5; vessel on the Paris MoU banned list (refusal of access after repeated detentions) → 40 | 40 |

**Geopolitical context multiplier** applied to the anomaly subtotal:

- `× +0.5` if the declared destination contains a port/country under embargo or conflict zone (list `HIGH_RISK_DEST`: Syria, Iran, North Korea, Libya, Yemen, Sudan, Russia/Crimea, Somalia…), **or** if the flag belongs to an embargoed state (`EMBARGO_MID`: NK 445, Syria 468, Iran 422, Libya 642, Russia 273).
- `× +0.2` if the ship flies a **flag of convenience** (`FOC_MID`: Panama, Liberia, Marshall Islands, Comoros, Togo, Tanzania, Cook Islands, Sierra Leone, Moldova, Cambodia, Palau, Mongolia…).

The **flag** is derived from the **MID** (Maritime Identification Digits = first 3 digits of the MMSI).

Final formula:

```
score = clamp( round( anomalySubtotal × multiplier ), 0, 100 )
```

`computeRiskScore(ship, lang)` returns `{ score, band, factors, sources }`, where `band` ∈ `low|med|high`, `factors` is the ordered list `{label, points}` of signatures that contributed (labels in the requested language), and `sources: { vf, mt, sanctions, psc }` indicates which external sources were present/consulted at calculation time (each `none`/`available`/`used`). The `lang` parameter (`'it'` default, `'en'` supported) is forwarded automatically by `api.js` based on the language selected in the frontend.

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

Enabled by `IMPORT_PSC`, implemented in [`src/services/psc.js`](src/services/psc.js) with the same **dataset** pattern as sanctions (`sanctions.js`): lists preloaded in memory, matched locally per ship, **no per-ship network call**. Two complementary signals:

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
| Red (OFAC SDN ⚠) | Vessel present on the OFAC SDN sanctions list |
| Blue (Paris/Tokyo MoU ⚓) | Signal from the Port State Control lists (black/grey flag or banned vessel) |
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

## 📈 Risk score history

The [risk score](#-risk-score-potential-arms-transport) is recomputed on every request, but it is also **sampled and stored** over time (table `risk_history`) so the ship detail can plot its **trend** — an escalation is itself a signal.

- **Sparse sampling**: `db.recordRiskSnapshot(mmsi, score, band)` inserts a point **at most once per hour per ship**, plus whenever the score changes. No bloat: the table is also globally capped (rotation at 20,000 rows).
- **Sampling points**: on every ship **arrival** (the stream already computes the score for the `high_risk` notification) and when the **detail view is opened** (`GET /api/ships/:mmsi`).
- **Display**: band-colored bar chart in the ship detail (`renderRiskHistory` in `public/js/ships.js`), with overall change (▲/▼). At least two samples are needed; until they accumulate it shows a hint. Endpoint `GET /api/ships/:mmsi/risk-history`.
- History is included in the database backup and deleted together with the area's data (or all of it) by the delete functions.

## 📄 Ship PDF report

The **📄 Report** button in the detail header generates a **printable report** of the ship: it opens a window with a self-contained HTML document (inline styles) and triggers the browser print dialog — from which it can be saved as **PDF** (*Print → Save as PDF*). No server-side PDF dependency. The report includes a header (name, MMSI, date), **risk score with factors**, a ship-data table, **port visit history** and operational notes, plus a disclaimer about using the score as a triage tool.

## ⚓ "In port" detection and track de-noising

A moored/anchored ship is not perfectly still: it swings on its anchor, drifts with the current, and has GPS noise. These small movements must be distinguished from actual movement.

> **AIS note**: *speed through water* (STW) is **not transmitted** by AIS messages — only **SOG** (Speed Over Ground) is available. Classification therefore uses SOG + distance between positions, not STW.

**Flag `in_port`** (`isInPort` in `src/services/ship-analysis.js`) — a ship is "in port" if:
1. the AIS navigational status is moored (`5`) or at anchor (`1`), **or**
2. *(hysteresis)* positions over the last 30 minutes all remain within `STILL_RADIUS_M` (100 m) of their centroid — it is stationary, just drifting/swinging, even if the instantaneous SOG occasionally exceeds the threshold, **or**
3. the last SOG is < `SOG_FERMA` (0.5 kn).

Hysteresis prevents anchor swing from causing the ship to "flicker" in and out of the in-port state. In-port ships are marked with the ⚓ badge (list, map popup, detail) and benefit from 24-hour retention.

**Track de-noising** (`collapseTrack` in `public/js/maps.js`) — in the detail map, consecutive stationary points (SOG < 0.5) within `TRACK_MERGE_RADIUS_M` (100 m) are collapsed into a single **⚓ Stop** node (popup with number of positions and time range). The polyline passes through the centroids → a clean track instead of a cloud of markers around the berth. Raw readings in the DB remain intact: the merge is display-only.

## ⚓ Berths (automatic mooring characterization)

The system infers by itself **where** vessels moor and **what type** they are, highlighting "characterized" quays with a coloured overlay on the active-ships map. Everything is hand-editable.

**Pipeline** (`src/services/berths.js`, per area):

1. **`detectMoorings(area)`** — one mooring point per visit = centroid of the vessel's *stationary* readings (`sog < SOG_FERMA` or AIS moored/anchored status `5`/`1`) in the window between one arrival and the same vessel's next arrival (arrivals come from `port_events`). Pure-transit visits (no stationary reading) are dropped. Each point is tagged with the vessel **category** (`src/services/ship-categories.js`: cargo, tanker, passenger, fishing, service, military, pleasure, high-speed, other).
2. **Clustering** — DBSCAN with haversine distance (`BERTH_CLUSTER_EPS_M`, `BERTH_MIN_PTS`). Points inside a **manual** berth polygon are assigned first and excluded from clustering (hand-drawn geometry wins). An automatic berth's geometry is the **convex hull** of its points.
3. **Characterization** — category tally per berth: the dominant one (≥ `BERTH_DOMINANT_PCT`, over at least `BERTH_MIN_MOORINGS` moorings) names and colours the berth, otherwise it is **"mixed"**; below the minimum it stays uncharacterized (dashed). It also computes the **hazmat** share (☢, AIS codes 71–74/81–84).

**Edit persistence** — automatic berths are rebuilt on every recompute, but a renamed/overridden berth regains its identity by centroid proximity (within `eps`). **Manual** berths (geometry locked by `manual_geom=1`) are never moved. The automatic characterization is always recomputed, but the manual override (`char_override`) takes precedence at read time.

**Compute cycle** — one-shot *backfill* at startup (`berths.recomputeAll()` in `src/server.js`, idempotent) over all history, then periodic background recompute every `BERTH_RECOMPUTE_MIN` minutes.

**Frontend** (`public/js/berths.js`) — `L.polygon` overlay on a dedicated pane (below the ship markers, so it never steals their clicks) plus a constant-size **centroid marker** (the ~80 m polygon is invisible at the area-wide zoom level), a **Berths** toggle in the filter bar (state in `localStorage`), a popup with the percentage distribution, and a management panel (**⚓ Berths**): rename, force category, merge, delete, recompute; **clicking a list row** centres the map on the berth and opens its popup.

## 🔗 MarineTraffic / VesselFinder Integration

In the ship detail view, two panels enrich AIS data with data downloaded (scraped) from external sources, cached in the `ship_scrape_cache` table (TTL configurable via `SCRAPE_CACHE_TTL`).

**VesselFinder** — server-rendered page; HTML scraping (`crawlVesselFinder`) extracts photo + data table via `fetchHttp` (the `https` module).

**MarineTraffic** — more complex, two obstacles:

1. **Internal ID**: MT pages are a React SPA indexed by proprietary `shipid`, not by MMSI/IMO/callsign. The `shipid` is resolved via the endpoint `GET /{lang}/global_search/search?term=<MMSI|IMO|callsign>&types=1,3,7,9` → `results[0].id`. The resolved `shipid` is saved in `ships.mt_ship_id` and used for the direct link. Ship data is then read from `GET /{lang}/vesselDetails/vesselInfo/shipid:<id>` (clean JSON, includes `typeSpecific` = ship subtype).
2. **Cloudflare**: MT blocks Node's TLS clients (`https`/`http2`) with HTTP 403 via JA3/JA4 fingerprint, regardless of headers. **`curl` passes** (different TLS stack), so MT requests are made via a `curl` subprocess (`fetchViaCurl` in `src/services/scrapers/http.js`).

> ⚠️ **Deploy dependency**: the MarineTraffic crawler requires **`curl` to be installed** on the host. On Linux/macOS it is almost always present. Note: the TLS fingerprint of `curl` can vary between builds (e.g. curl-OpenSSL on Linux vs curl-SecureTransport on macOS) and Cloudflare may treat them differently — verify in production.

MT/VF integration can be enabled/disabled via the `IMPORT_MT_DATA` / `IMPORT_VF_DATA` properties in `local.properties` (or from the toggle switches in the UI settings, which persist them).

### Proactive enrichment on first detection

In addition to on-demand loading in the detail view, enrichment starts **automatically when a new ship appears** on the AIS stream, so the [risk score](#score-enrichment-from-vfmt) can immediately use registry data without waiting for the detail view to be opened.

Flow ([`src/services/enrichment.js`](src/services/enrichment.js)):

1. `db.insert` signals the first appearance of an MMSI by returning `{ arrivedFlagged, newShip }` (`newShip` = mmsi if the MMSI had never been seen before).
2. In `ais-stream.js`, on `newShip`, `enrichment.enrichNewShip(mmsi)` is called.
3. `enrichNewShip` queries in the background **only the enabled sources** and saves the result to `ship_scrape_cache`.

Guarantees:

- **Once only**: skips if cache already exists for that source, with an `inFlight` guard against duplicate concurrent fetches. Does not restart for already known ships (not even after a restart).
- **Non-blocking**: fire-and-forget, no `await` in the AIS ingest loop. Errors are logged (`[ENRICH:vf|mt]`), never propagated.
- If the MMSI appears before static data (IMO/callsign absent), VF/MT still resolve via MMSI.

### Equasis lookup (ownership/management, on-demand)

[Equasis](https://www.equasis.org/) is a free EU/US database exposing a ship's **ownership and management** data (registered owner, ISM manager, operator, DOC company) which AIS never broadcasts and VF/MT don't offer for free. The scraper [`src/services/scrapers/equasis.js`](src/services/scrapers/equasis.js) (`crawlEquasis(imo)`) is deliberately **outside** the proactive enrichment path: it runs **only** when the user presses **Fetch Equasis information** in the detail view.

Differences from VF/MT:

- **On request only**: no automatic fetch on appearance or on opening the detail. The endpoint serves the cache; it scrapes only with `?fetch=1` (the button).
- **No expiry**: the result is stored in `ship_scrape_cache` under source `eq` and shown forever (unlike the `SCRAPE_CACHE_TTL` of VF/MT). After the first fetch the button disappears.
- **Queries by IMO**: Equasis is indexed by IMO number only; without an IMO the lookup fails with an error.
- **Login required**: every query needs an authenticated session, so `EQUASIS_USER` / `EQUASIS_PASSWORD` are required. Without credentials the feature stays hidden/unusable (`equasisConfigured`).

Flow (`crawlEquasis`, reverse-engineered): `POST /EquasisWeb/authen/HomePage` (`j_email`+`j_password`) → session cookie → `POST /EquasisWeb/restricted/ShipInfo` (`P_IMO`) → detail HTML. Cookies live in a throwaway jar for the lifetime of the two calls. Like MarineTraffic, it **uses `curl`** in a subprocess (same deploy dependency). The parser extracts the *Management detail(s)* table (`parseManagement`) and a curated set of *ship particulars* (`parseParticulars`).

**Audit log**: every lookup (success or error) is appended to a plain-text file `equasis.log` (project root, gitignored) by [`src/services/equasis-log.js`](src/services/equasis-log.js): timestamp, MMSI, IMO, ship name and the retrieved data (or the error message). The log is viewable from the UI via the **View Equasis log** button in Settings (endpoint `GET /api/equasis-log`, read tail-truncated to 256 KB; `DELETE /api/equasis-log` clears it).

## 📋 Port events, statistics and alerts

**Port events** (table `port_events`) — the backend automatically detects:
- **Arrival** (`arrived`): a ship appears after > 60 minutes of absence (or for the first time).
- **Departure** (`departed`): detected by `checkAndLogDepartures`, which marks as departed ships whose last contact falls in the `-62…-60 minutes` window without a departure already recorded recently.

**Statistics** (`/api/stats`, Traffic view) — arrivals today / this week / total, average stop duration (by pairing each arrival with the following departure), arrivals distribution by hour of day and ship type.

**Aggregate scores** (`/api/stats/scores`, Traffic view) — calculated on ships seen in the last 7 days: distribution by risk band (`byBand`), top 8 ships by score (`topShips`), most frequent factors across all ships (`byFactor`), daily arrivals time series for the last 30 days (`dailyArrivals`). The calculation invokes `computeRiskScore` for each ship in the window, so response time scales with the number of recent ships.

**Expected ships** (`/api/ships/expected`) — ships with a `destination` containing the current preset keyword (e.g. `TARANTO`), that left the area in the last 48 hours — useful for anticipating arrivals.

**Flagged ship alerts** (`/api/alerts`) — when a flagged (★) ship re-enters the area, the arrival is queued and shown as a toast in the frontend on the next poll.

**Notifications** (table `notifications`, `/api/notifications`) — persistent history shown in the sidebar. Three notification types are generated (each can be enabled/disabled independently from Settings, on top of the master `notificationsEnabled` switch):

- `revisit` — a ship **that already arrived in the same area in the past** returns to it after an absence (`db.insert` returns `revisit`); controlled by `notifyRevisit` / `NOTIFY_REVISIT`.
- `area_change` — a ship seen in one area is later detected in a **different** area (`db.insert` returns `areaChange` by comparing the ship's `last_area` with the message's area before the upsert); the notification stores the origin area in `from_area` and the destination in `area`; controlled by `notifyAreaChange` / `NOTIFY_AREA_CHANGE`.
- `high_risk` — a ship **arrives** (new, or after > 60 min absence, `db.insert` returns `arrived`) with a **risk score in the red band** (71–100); controlled by `notifyHighRisk` / `NOTIFY_HIGH_RISK`. Useful for immediate triage of critical cases without waiting for the Traffic view.

In all cases `ais-stream` computes the score and calls `db.addNotification` (ships with `notif_muted` are skipped). Each notification stores the risk band (`band`) and `score` computed at event time, shown as a green/yellow/red dot. Endpoints: `GET /api/notifications` (list + unread count), `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`, `DELETE /api/notifications/:id` (single), `DELETE /api/notifications` (all). The last 100 are retained (automatic rotation on every insert).

**Delete with undo** — both a single notification (🗑 trash on the row) and the **🗑 clear-all** button (next to the unread badge in the sidebar) delete with an **undo window** ("↶ Undo" toast) before the deletion becomes effective. The bounce duration is configurable in `app.config.properties` via `NOTIF_DELETE_UNDO_SECONDS` (default 5 s; `0` = immediate delete) and exposed to the frontend via `/api/config`.

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
6. Click a ship row → **Detail** view: info-bar + VesselFinder/MarineTraffic data (if enabled) + **risk score trend** + track map (collapsed stops) + paginated readings + notes + port visit history. **📄 Report** button for the [PDF report](#-ship-pdf-report)
7. Click a reading row in the detail → modal with raw AIS data
8. **← Back** to return to the previous list
9. Tab **Past ships**: ships no longer meeting the "active" criteria; click ★ to flag them / ✓ to mark them as seen
10. Tab **Traffic**: statistics, arrivals by hour/type charts; risk score distribution (green/yellow/red), most frequent factors, arrivals by day (30 days), top 8 ships by score (clickable); expected ships, latest port events
11. **⚙ Settings**: **Area monitoring** panel (start/stop toggle per area, with 🟢/⚪ status); enable/disable VesselFinder and MarineTraffic import; **Export CSV** (ZIP with one CSV per message type); database **backup** and **restore** (see below)
11b. **🗺 Areas**: runtime area management — list with coordinates, status and stored data; map of all areas; add a new area by **GPS coordinates** or with **🎯 Capture current view** (framing the area on the map); delete an area and its history, with a **10s undo toast**. The **🏠 Monitoring** button returns to the home.
12. **📡 AIS Diagnostics**: connection status (uptime, msg/min, reconnections, errors) for the currently viewed area
13. **🗑 Clear data** → deletes readings, ships and port events for the **currently viewed area** only (confirmation dialog shows the area name)
14. Click **■ Stop** to stop the stream (data remains in the DB)
15. The 🌙/☀️ button at the bottom right toggles dark/light theme (saved in localStorage)

The `ais_data.db` database persists across app restarts.

### Database backup and restore

From the **⚙ Settings** modal:

- **Backup database** → downloads the entire DB as a single `.db` file (`tracker-porti-backup-<timestamp>.db`). This is a consistent snapshot (`VACUUM INTO`), safe even with the AIS stream active and without WAL/`-shm` sidecar files.
- **Restore database** → uploads a backup `.db` file: **all** current data is replaced (irreversible operation, with confirmation). The file is validated (SQLite header) and tables are copied column-by-column on the column intersection, so a backup with an older schema restores correctly. No app restart required. After restore, rows with an empty `area` value are automatically assigned to the correct area based on coordinates (most specific bounding box containing the point).

---

## 🔐 Authentication

The app has **no authentication by default**: it is not needed locally (`localhost`). As soon as you expose it on a network or the internet (see [Deploy](#-deploy-on-a-linux-server-vps)), **every** route — including the destructive ones (`POST /api/restore`, `DELETE /api/areas/:key`, `DELETE /api/readings`) — is reachable by anyone. To prevent this, the app ships an application-level **HTTP Basic Auth** gate (`src/middleware/auth.js`), with no reverse proxy to configure.

**Enabling it** — set a password in `local.properties` (gitignored, never committed — same scheme as `AIS_API_KEY`):

```properties
AUTH_USER=admin
AUTH_PASSWORD=a_strong_password
```

- `AUTH_PASSWORD` **empty or absent → auth disabled** (default behavior, local development unchanged).
- With the password set, the browser shows the **native login dialog** and resends credentials automatically on every request: API, static files and SSE stream. No frontend changes, no login page.
- The middleware is mounted **before** static and API in `app.js`, so it protects the whole app. Credentials are compared in **constant time** (`crypto.timingSafeEqual`).
- The keys are read **only at startup**: after changing `AUTH_PASSWORD`, restart the server.

> ⚠️ **Basic auth does not encrypt**: credentials travel in base64 (≈ cleartext) on every request. On a trusted network, VPN, or **SSH tunnel** (`ssh -L 3000:localhost:3000 user@server`) this is adequate. For direct internet exposure, still put **TLS** in front (HTTPS reverse proxy, Caddy, Cloudflare Tunnel…). Even without TLS, though, it blocks scanners and anonymous access to the destructive endpoints: far better than no protection.

---

## 🐧 Deploy on a Linux server (VPS)

### Server requirements

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

node --version   # v22+
npm --version

# curl is required by the MarineTraffic crawler (see MT/VF integration section)
curl --version   # if absent: sudo apt-get install -y curl
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

> ⚠️ Opening the port exposes the app to anyone who can reach the server. **Set `AUTH_PASSWORD`** first (see [Authentication](#-authentication)), ideally with TLS in front.

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
| `src/db.js`                   | SQLite wrapper: `readings`/`ships`/`port_events`/`api_log`/`ship_scrape_cache`/`notifications`/`risk_history`/`moorings`/`berths` schema, insert/upsert, queries, active predicate |
| `src/services/ais-stream.js`  | Multi-area AISStream WebSocket client (`Map<areaKey, state>`) + reconnection + port events + revisit and area-change notifications |
| `src/services/berths.js`      | Mooring detection + DBSCAN clustering + berth characterization (convex hull, point-in-polygon, backfill/recompute) |
| `src/services/ship-categories.js` | AIS ship-type code → broad category (cargo/tanker/passenger/…) + hazmat flag, used to characterize berths |
| `src/services/scrapers/`      | VesselFinder (https), MarineTraffic (curl) and Equasis (curl, login, on-demand) scraping |
| `src/services/risk-score.js`  | Arms transport risk score (0–100) from AIS behavioural signatures + cached VF/MT registry data |
| `src/services/enrichment.js`  | Proactive VF/MT enrichment (once) on first ship detection         |
| `src/services/sanctions.js`   | OFAC SDN sanctions list: CSV download, in-memory index, ship match by IMO/name/call sign |
| `src/services/psc.js`         | Port State Control (Paris/Tokyo MoU): flag performance (bundled JSON) + banned list (OpenSanctions CSV), match by flag name / IMO |
| `src/routes/`                 | Express routers per domain (ships, readings, events, notifications, logs, settings, stream, areas, berths, export) |
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

**`port_events`** — automatically detected arrival/departure events: `mmsi`, `ship_name`, `event_type` (`arrived`/`departed`), `ts`, `ship_type`, `destination`, `draught`, `area TEXT NOT NULL DEFAULT ''` (area where the event occurred).

**`api_log`** — HTTP request log (max 20,000, automatic rotation): `ts`, `method`, `path`, `status`, `duration_ms`, `request_body`, `response_body`.

**`notifications`** — notification feed shown in the sidebar (max 100, automatic rotation): `type` (`revisit`, `area_change` or `high_risk`), `mmsi`, `ship_name`, `area` (destination area), `from_area` (origin area, only for `area_change`), `band` (`low`/`med`/`high`) and risk `score` computed at event time, `ts`, `read` (0/1).

**`risk_history`** — risk-score snapshots over time for the trend chart (see [Risk score history](#-risk-score-history)): `mmsi`, `ts`, `score`, `band`. Sparsely sampled (max 1/hour per ship) and globally capped (rotation at 20,000 rows).

**`moorings`** — one mooring point per visit (see [Berths](#-berths-automatic-mooring-characterization)): `area`, `mmsi`, `ship_type`, `category` (broad category), `lat`, `lon`, `ts`, `berth_id` (assigned berth, `NULL` if unclustered). Rebuilt by the berths service on every recompute.

**`berths`** — detected/drawn berths: `area`, `name`, `polygon_json` (`[[lat,lon],…]`), `centroid_lat`/`centroid_lon`, `manual_geom` (1 = hand-locked geometry), `char_label` (computed dominant category or `mixed` or `NULL`), `char_override` (hand-forced category, takes precedence), `mooring_count`, `dist_json` (distribution `[{category,n,pct}]`), `hazmat_pct`, `updated_at`. Both included in backups (`BACKUP_TABLES`).

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
| GET | `/api/ships/:mmsi/readings` | Readings for a ship (`?limit=50&offset=0`) |
| GET | `/api/ships/:mmsi/track` | Position points for map track (`?limit=500`) |
| GET | `/api/ships/:mmsi/vfdata` | Data downloaded from VesselFinder (with cache) |
| GET | `/api/ships/:mmsi/mtdata` | Data downloaded from MarineTraffic (with cache); resolves and saves `mt_ship_id` |
| GET | `/api/ships/:mmsi/equasis` | Equasis data (ownership/management) from cache; scrapes only with `?fetch=1` (detail button). Never automatic, no expiry |
| GET / DELETE | `/api/equasis-log` | Reads (tail 256 KB) / clears the plain-text audit log of Equasis lookups (`equasis.log`) |
| GET | `/api/ships/:mmsi/events` | Port events (arrivals/departures) for a ship |
| GET | `/api/ships/:mmsi/risk-history` | Risk-score snapshot time series for the ship (`{history:[{ts,score,band}]}`) |
| GET | `/api/ships/expected` | Expected ships in the area (`?area=`): destination = preset keyword, departed < 48h ago |
| PATCH | `/api/ships/:mmsi/flag` | Set flagged flag `{flagged: 0\|1}` |
| PATCH | `/api/ships/:mmsi/seen` | Set seen flag `{seen: 0\|1}` |
| PATCH | `/api/ships/:mmsi/notes` | Set free-form notes `{notes: "…"}` |
| PATCH | `/api/ships/:mmsi/military` | Set manual military flag `{is_military: 0\|1}` → forces score 100 and red row |
| GET | `/api/readings` | Global readings (`?type=&limit=50&offset=0`) |
| GET | `/api/readings/:id` | Single record detail with raw JSON |
| DELETE | `/api/readings` | Delete readings, ships and port events for the specified area (`?area=`, default: current area) |
| GET | `/api/events` | Port events for the area (`?area=&limit=100&offset=0`) |
| GET | `/api/stats` | Aggregate statistics for the area (`?area=`) — arrivals, average stop, by hour/type |
| GET | `/api/stats/scores` | Aggregate risk scores for the area (`?area=`) for ships in the last 7 days: `byBand` (count per band), `topShips` (top 8 by score), `byFactor` (most frequent factors), `dailyArrivals` (arrivals per day last 30 days) |
| GET | `/api/alerts` | Alert queue of flagged ships that re-entered the area (cleared on read) |
| GET | `/api/notifications` | Notification feed (last 100) + unread count: `{notifications, unread}` |
| POST | `/api/notifications/:id/read` | Mark a notification as read → `{ok, unread}` |
| DELETE | `/api/notifications/:id` | Delete a notification → `{ok, unread}` |
| DELETE | `/api/notifications` | Delete **all** notifications → `{ok, unread:0}` |
| POST | `/api/notifications/read-all` | Mark all notifications as read → `{ok, unread:0}` |
| GET | `/api/export` | Download ZIP with CSV per message type |
| GET | `/api/backup` | Download entire database as a `.db` file (`VACUUM INTO` snapshot) |
| POST | `/api/restore` | Restore the entire DB from an uploaded `.db` file (body `application/octet-stream`) |
| GET | `/api/settings` | Current bbox preset, preset list, VF/MT import status |
| POST | `/api/settings` | Change preset, import toggles and notification toggles `{preset?, importVfData?, importMtData?, notificationsEnabled?, notifyRevisit?, notifyAreaChange?, notifyHighRisk?}` |
| GET | `/api/areas` | List of areas with bbox, stream status, `current` flag and data `counts`; `{areas, preset, minAreas}` |
| POST | `/api/areas` | Add an area `{name, sw:[lat,lon], ne:[lat,lon], keyword?, autostart?}` → saves to `bounding-boxes.json` and starts the stream (unless `autostart:false`) |
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
- **Restart and data**: the DB (`ais_data.db`, WAL) persists across restarts. After a restart, ships that transmit infrequently (moored) may not appear immediately in "active" until they transmit again — see the 6h/24h windows.
- **`curl` required**: MarineTraffic scraping uses a `curl` subprocess (Cloudflare bypass). If `curl` is absent, MT import fails but the rest of the app works.
- **Node.js version**: the `node:sqlite` module is built-in from Node 22.5+. It does not work on earlier versions.
