# User Manual — Tracker Porti

<p align="center">
  <img src="public/icons/icon-512.png" alt="Tracker Porti" width="128">
</p>

## What this software does

**Tracker Porti** monitors AIS maritime traffic in real time within a defined geographic area. It collects position data broadcast by vessels, analyzes it, calculates a risk score for each ship, and presents the information in visual and tabular form.

No technical knowledge is required to use it.

---

## Quick start

1. Open a browser and navigate to the server address (e.g. `http://localhost:3000`)
2. **Log in** with your credentials (if you don't have an account, register and wait for an administrator to approve it — see [Account and access](#account-and-access))
3. In the left sidebar, select the **geographic area** to monitor from the "Area:" dropdown
4. Press **▶ Start monitoring** to start receiving data
5. Ships will appear automatically in the table and on the map

---

## Account and access

The app is protected by a **login**: you must authenticate before using it. Each user has their own data, kept separate from everyone else's.

### Registering

From the login page, follow the **registration** link and enter your **first name, surname, email and password**. The new account is created in the **"pending"** state: you **cannot log in yet** until an **administrator approves it**. Once approved, you can log in normally.

> Email confirmation is planned but not active yet: approval is always manual, by an administrator.

### Logging in

On the login page, enter your password and, as the identifier, **either your username or your email** (both work). The session stays valid for several days: you normally don't need to re-enter your credentials on every visit.

### Logging out

Use the **account widget in the top-right corner** and choose **Log out** to end your session.

### Forgot password

The login page has a **"Password dimenticata?"** (forgot password) link. For now, however, email is not wired up: to reset your password **ask an administrator**, who will generate a **one-time link** for you (valid 24 hours) to set a new one.

### Your data

Each user has their own:

- monitoring **areas**;
- **settings** (notification preferences, map options, language, default area);
- **flagged** ships ★ and **followed** ships;
- **notifications**.

You see the AIS data of ships located **inside your areas**. The AISstream API key, the enrichment sources (VesselFinder, MarineTraffic, sanctions, etc.) and the risk-score configuration are instead **shared** and managed by administrators.

If you belong to a **user group** (see below), some of these things are **shared with the other group members**.

### User groups

An administrator can place you in a **group** together with other users. When you are in a group you **share with the other members** (as a **union** of what each one had):

- monitoring **areas**;
- **followed** ships, **flagged** ships ★ and **muted** ships 🔕;
- **notification preferences** (in-app and Telegram) and **map-display** options, plus the **default area**.

In practice: if you add an area, follow a ship or enable a notification, **the other members will find it too** on their next access — and vice versa. The following stay **personal to you**: your **Telegram link** (your chat) and the UI **language**. Admin-managed settings (data sources, risk weights) remain global for everyone.

If the administrator **removes you from the group**, you **keep** everything that had been shared in the meantime (areas, ships, settings): you simply stop syncing with the others.

### For administrators

Administrators see an **Admin** link in the top-right corner, which opens the **admin page** (`/admin`). From there an administrator can:

- **approve** pending new registrations;
- **enable or disable** an account;
- **change a user's role** (normal user ↔ administrator);
- **reset a user's password** (generates a one-time link to hand to them);
- **delete** a user;
- **create and manage user groups** — a group has a **name**, a **description** and **at least 2 members**; at creation you pick the **model user** whose settings seed the group. Members can be **added/removed** or the group **dissolved** (a removal that would leave a single member is blocked: dissolve the group instead);
- **impersonate** a user — view their areas, monitoring and followed ships in **read-only** mode, with a prominent banner and one-click exit;
- consult the **logs** (API log and activity log), which are shared and visible to administrators only.

---

## Main interface

### Sidebar (left)

| Element | Function |
|---|---|
| **🏠 Monitoring** | Return to the home (the Active / Past ships and Traffic tabs), where you monitor the areas |
| **▶ Start monitoring** | Start receiving AIS data in real time for the currently viewed area |
| **■ Ferma** | Stop receiving data for the current area (already collected data is retained) |
| **🗑 Cancella dati** | Delete readings for the currently viewed area — **irreversible** |
| **🗺 Areas** | Open the area management screen: list, map, add and remove areas (see [Area management](#area-management)) |
| **🌐 Coverage map** | Open the worldwide AIS coverage map, coloured by how many messages are received in each grid cell (see [Coverage map](#coverage-map)) |
| **⚙ Impostazioni** | Open application settings. Includes the technical tabs **API Log** (📋) and **AIS Diagnostics** (📡) |
| **🔔 Notifications** | Show/hide the notifications list in the sidebar. A red badge shows the number of unread notifications (see [Notifications](#notifications)) |
| **Area:** | Select the geographic zone to display. This does not start or stop any stream — each area has its own independent stream. Options show 🟢 if the stream is active or ⚪ if it is off. |
| **N letture** | Counter at the bottom: how many positions have been received this session |

### Status bar (top)

The **ACTIVE** badge (with a pulsing green dot) means the stream for the currently viewed area is running. **INACTIVE** means reception for that area is stopped.

---

## The three main tabs

### 1. Navi presenti (Active ships)

Shows ships detected in the area over the past few hours, with a live map and table.

**Map:** ships appear as markers on the interactive map. You can drag the bottom edge of the map to resize it.

**Table — columns:**

| Column | Meaning |
|---|---|
| Action icons | Buttons to flag, mark as seen, open on VesselFinder |
| Last contact | Date and time of the last position received |
| Ship name | Vessel name |
| MMSI | Unique vessel identification code |
| Ship type | Category (cargo, tanker, passenger, etc.) |
| Destination | Declared destination port. UN/LOCODE values (e.g. `ITTAR`, `IT TAR`) are automatically resolved to the port name (e.g. "Taranto"); already-readable values (e.g. "NAPOLI") are shown as-is |
| SOG | Speed over ground in knots |
| Direction | ↙ Inbound / ↗ Outbound / ⚓ Stationary |
| Risk score | Score 0–100 (green/yellow/red) |

**Sorting:** click any column header (except the action icons) to sort the table by that field. A second click reverses the order (▲ ascending / ▼ descending). The sort is preserved across automatic updates.

**Per-row buttons:**

- **☆ / ★ Flag** — Highlights the vessel in purple as "flagged for review". Click again to remove the flag.
- **✓ Seen** — Marks the vessel as already reviewed (row becomes faded). Useful for tracking what's new.
- **⧉ VesselFinder** — Opens the vessel page on VesselFinder (new browser tab).

**Row colors:**

| Color | Meaning |
|---|---|
| Red 🪖 | Military vessel (automatically flagged) |
| Red | High risk score (71–100) |
| Purple | Manually flagged by the user |
| Faded/transparent | Marked as "seen" |
| ⚓ In porto badge | Vessel is currently moored in port |

**Click any row** to open the full vessel detail view.

#### Berths (automatic mooring characterization)

On the active-ships map you can enable a **berths overlay**: the system learns by itself where vessels moor and what kind they are, highlighting "characterized" quays.

**How it works:**

1. **Mooring detection** — each vessel visit (port stay) records **one mooring point**, computed as the centroid of the vessel's positions while it sits still/moored in the area.
2. **Clustering into berths** — nearby mooring points are grouped automatically into **berths** (clusters). The outline drawn on the map is the convex hull of the cluster's points.
3. **Characterization** — for each berth the vessel categories are tallied (cargo, tanker, passenger, fishing, service/tug, military, pleasure, high-speed, other). When one category exceeds **60%** of moorings (over at least **10** moorings), the berth is **coloured** with that category; below the threshold it is labelled **"mixed"** (grey). Berths with fewer than 10 moorings stay dashed and uncharacterized.

**Using the overlay:**

- Tick the **Berths** checkbox in the filter bar above the map to show/hide the overlay (the choice is remembered).
- Each berth has a coloured polygon plus an always-visible **centre dot** (a berth polygon is only a few tens of metres wide and would be tiny at the area-wide zoom level: the dot keeps it findable).
- **Click a berth** (polygon or dot) to see its name, characterization, mooring count, per-category percentage distribution, **per-cargo-type distribution** (merchandise class of the vessels mooring there) and any hazmat share (☢).

**Correcting by hand** (the **⚓ Berths** button): opens the management panel, where you can:

- **Rename** a berth (e.g. "San Cataldo Quay").
- **Force the category** with the dropdown (manual override, takes precedence over the automatic characterization). Set it back to *(automatic)* to return to auto-calculation.
- **Merge** two or more berths into one (select them with the checkboxes and press *Merge*). The resulting berth has "locked" (hand-drawn) geometry and is no longer moved by recompute.
- **Delete** a berth: its moorings are freed and may be re-clustered on the next recompute.
- **Recompute** moorings and berths for the current area immediately (the system also does this periodically on its own).
- **Click a list row** to centre the map on that berth and open its details (enables the overlay if it was off).

> Hand-edited berths (geometry, name, forced category) survive automatic recomputes: your corrections are never overwritten. Automatic berths are rebuilt on every recompute, but keep the name and forced category you assigned.

**OpenSeaMap overlay.** Settings (→ General, on by default) has **two independent switches**: the **Nautical layer (tiles)** draws the OpenSeaMap nautical symbols (buoys, lights, marks, fairways, anchorages) over the maps — it's a single image, so it's all-or-nothing (the symbols that look like little towers with a magenta drop are **lights/beacons**, not wind turbines); the **Markers (selectable)** draw ⚓ markers on the active-ships map with the **official berths/moorings/harbours** mapped in OpenStreetMap, to compare against the berths the app computes by itself. Only the markers are filterable per category, and the map updates immediately when you change the boxes. Hover a marker to read what it is. The data comes from OpenSeaMap/OpenStreetMap (free, no API key) and may be incomplete in commercial ports.

> At startup the app runs an initial analysis (*backfill*) over all the history already collected, so berths are visible right away.

**Historical replay (review past traffic).** At the top of the toolbar there is a **▶ Replay** button: press it to review how the area's traffic moved over a past time window. Entering replay mode hides the "live" markers and shows a control bar:

- **Area** — pick which of your areas to review (the current one by default).
- **Window** — quick buttons **1h / 6h / 24h / all**, or set a **custom** range with the two date/time pickers. The range is anchored to the **most recent data** available (so you always find something to review) and can't go beyond the data actually recorded.
- **▶ / ⏸** play/pause, the **scrubber** (jump to a precise instant) and the **speed** buttons (1× / 5× / 20× / 60× of real time).

Each ship moves interpolated between its real positions, leaves a **fading trail** behind it, and is coloured by risk band; click it to open its detail. If a ship has a long **signal gap** (AIS off or it left the area) it is **hidden** during that stretch instead of "teleporting" in a straight line. At the bottom you see the current replay time and how many ships are visible. Press **✕ Exit** to return to the live view.

---

### 2. Navi passate (Past ships)

Shows vessels that visited the area previously. The table structure is similar to the "Active ships" tab, with additional columns:

- **First contact** — When the vessel was first seen
- **Stay duration** — How long it remained in the area

**Sorting:** click any column header (except the action icons) to sort the table by that field. A second click reverses the order (▲ ascending / ▼ descending). The sort is preserved across automatic updates.

---

### 3. Traffico (Traffic)

Statistics panel with charts and aggregated indicators.

**Stat cards at the top:**
- Arrivals today
- Arrivals in the last 7 days
- Total arrivals
- Average stay duration

**Charts:**

| Chart | What it shows |
|---|---|
| Arrivals by hour of day | Hourly bars (00:00–23:00). Hover over a bar for the count. |
| Arrivals by ship type | How many vessels per category (cargo, tanker, etc.) |
| Risk score distribution | Breakdown between low, medium, and high risk vessels |
| Main risk factors | Which factors contribute most to scores |
| Daily arrivals (last 30 days) | Monthly traffic trend |
| Highest scoring vessels | Vessels with the highest risk |

**Lower panels:**
- **Expected ships** — Vessels headed toward the area (filtered by destination keyword)
- **Latest port events** — Chronological log of recent arrivals and departures

---

## Followed ships

The **🗺 Followed ships** sidebar section tracks vessels wherever they go, even outside the monitored areas, via a dedicated AIS stream. A followed ship that leaves AIS coverage is **not lost**: it is kept on a worldwide re-acquisition net and resumes tracking automatically the moment it transmits again, wherever it reappears. Two sub-tabs: **Followed** (currently tracked) and **Followed in the past** (history; a ship is moved here automatically only after a very long total silence — default ~6 months — or when you unfollow it).

### Search and follow a ship

A **search bar** at the top of the section lets you look up a ship by **name** or **MMSI** and press **🔍 Search**.

1. A results window opens and stays open while we gather the data. If a name matches several ships, pick the right one from the list.
2. The card fills in **progressively**: identity and data from VesselFinder / MarineTraffic / Global Fishing Watch (with an icon showing where it was found), any **sanctions** or **PSC** warnings, and — as soon as available — the **live position** on a mini-map.
3. The position is recovered in real time from AISstream and may take a few seconds (up to ~90 s). If the ship is not transmitting or is out of coverage, a notice with **↻ Retry** appears.
4. Once a position is found, **🗺 Follow ship** is enabled: click it to add the ship to your followed list.

Closing the window (**Cancel**, the **✕**, clicking outside, or **Esc**) stops the search and the position recovery without following anything.

### Re-following a ship from "Followed in the past"

When you re-follow a ship that was in **Followed in the past** (open its detail and press **🗺 Follow ship**), the app moves it **immediately** to currently-followed and automatically starts the same AISstream position search in the background. You don't need to do anything else:

- if the ship is found (it's transmitting), it stays followed and its position updates;
- if it does **not** transmit within ~90 seconds, the ship **returns to "Followed in the past"** and you get a **notification** that it could not be found.

---

## Coverage map

Open it with the **🌐 Coverage map** entry in the sidebar. It shows a **world map** where each grid cell is coloured by **how many AIS messages are received there** — a scale from **blue** (few) to **red** (many). At a glance it reveals where AIS coverage is good and where the "holes" are.

**All users** can open the map and see the current data (read-only).

**Only administrators** can also:

- **start and stop** the data collection;
- see the **live connection stats** (bandwidth used, messages per second, populated cells, and so on);
- **clear** the collected data.

Once an administrator starts it, collection keeps running **in the background** — even if nobody has the page open — until an administrator stops it. It **auto-resumes after a server restart**. As a safety measure it **stops by itself if no user has been active for 10 minutes**.

**Buttons on the page (administrators):** **Start / Stop collection**, **Refresh map**, **Clear data**.

> **⚠️ Warning:** while collecting, the app continuously downloads data from the **whole world** — roughly **200–400 MB per hour**. This feature needs its own AISStream key from a **separate account** (different from the main one), set by the administrator in `local.properties` as `HEATMAP_AIS_API_KEY`. Without that key the feature stays **off**.

---

## Vessel detail

Clicking any row in a table opens the full vessel detail page.

### Header
- **← Back** — Return to the list
- **★ Flag** — Toggle flagging on/off
- **✓ Seen** — Mark as reviewed
- **🪖 Mark as military** — Classifies the vessel as military (row turns red)
- **🔔 / 🔕 Notifications** — Mute or re-enable automatic notifications for this vessel (see [Notifications](#notifications))
- **⧉ VesselFinder / MarineTraffic** — Open the external page (if available)

### Information bar

Grid with all available vessel data:

| Field | Meaning |
|---|---|
| Risk score | Color-coded badge 0–100 |
| Ship type | Category; "☢ Hazmat" if carrying dangerous cargo |
| Cargo type | Merchandise class (container ship, crude oil tanker, chemical tanker, gas carrier, bulk carrier, etc.) derived from the VesselFinder/MarineTraffic subtype, falling back to the AIS code. The source is shown in parentheses |
| Load state | Estimated laden / partial / in-ballast from the declared draught compared with the min/max observed for that vessel (marked "estimated") |
| Call sign | Radio call sign |
| IMO | IMO registration number |
| Destination | Declared port; UN/LOCODE codes resolved automatically |
| ETA | Estimated time of arrival |
| Max draught | Hull depth in water (meters) |
| Length / Beam | Physical dimensions |
| SOG / Course | Current speed and heading |
| Nav. status | Moored, underway, etc. |
| Direction | Inbound, outbound, stationary |
| Position | Last known latitude and longitude |
| Stay duration | Time elapsed since arrival |
| First / Last contact | Timestamps of first and last data received |

### Risk factors

List of factors that contributed to the score, with points assigned by each. If the vessel shows no anomalies, "No anomalies detected" is displayed.

### VesselFinder / MarineTraffic data

If enabled in settings, additional information fetched from these services is shown (flag, gross tonnage, year built, etc.), with an indication of whether the data is cached.

When you **enable** VesselFinder or MarineTraffic, the app fetches data in the background for every ship seen in the last few days that doesn't have it yet (one at a time, to avoid overloading the services). Ships the source **doesn't know** (typical of those without an IMO number) are not re-contacted on every re-enable: they are retried at most every `SCRAPE_NEG_CACHE_DAYS` days (default 3, editable in **Parameters**). **Restoring** a backup does **not** re-trigger these fetches: VF/MT data is already saved in the restored database.

### ShipFinder data and re-locating followed ships

If you enable **Import ShipFinder** in settings, the detail view shows a **ShipFinder data** panel. Besides static fields (flag, type, dimensions — mostly the same as VesselFinder/MarineTraffic, here as a fallback), ShipFinder offers something the other free sources do **not**: the vessel's **last-seen position**.

This position is used to **find followed ships AIS can no longer see**:

- **Automatic.** For every ship in your **Followed ships** that hasn't transmitted for a while (including those you never located, followed via search), the app periodically queries ShipFinder in the background. If it finds a position, it appears on the detail mini-map as a **distinct amber marker** ("Last known position (ShipFinder)"), separate from the AIS track and **without altering** the track, the risk score or replay. The worldwide AIS search keeps running in parallel. Requests are throttled (at most one per ship every 30 min) to avoid overloading the service.
- **Dedicated badge.** When a ShipFinder position exists, an orange **📍 seen on ShipFinder · &lt;date&gt;** badge appears next to the ship name (in the **Followed ships** list and in the detail), distinct from the yellow **🔍 searching** badge (which reflects the AIS state). The two can coexist: the ship is still dark on AIS (*searching*), but ShipFinder has its last known position. The "searching" badge clears **only** on a real AIS signal (or after the ~6-month auto-stop): a ShipFinder hit does **not** clear it.
- **Manual — the button.** In the **ShipFinder data** panel there's a **📍 Locate via ShipFinder** button: press it to fetch the ship's current position **immediately** and see it on the map. It works for any ship, not just followed ones.

The detail action bar also has **⧉ ShipFinder**, which simply opens the ship's page on the ShipFinder site.

> The panel and buttons **appear only if Import ShipFinder is enabled** (Settings → Import ShipFinder). It is off by default.

### Ownership / management (Equasis)

If the Equasis lookup is enabled in settings, the detail view shows an **Ownership / management (Equasis)** panel with a **Fetch Equasis information** button. Unlike VesselFinder/MarineTraffic it **never runs automatically**: the lookup happens only when you press the button, and queries Equasis by **IMO number** (if the ship has no IMO the lookup is not possible). It returns: ship particulars (flag, call sign, MMSI, tonnages, type, year, status), **ownership and management** (registered owner, ISM manager, operator, commercial manager), **classification** (society, status, date), **P&I cover**, **performance/risk** indicators (36-month detention rate, IACS class, Paris/Tokyo MOU performance, USCG targeting) and **recent positions** (areas the ship was seen in). The result is **stored once** and shown indefinitely (no expiry); the button disappears after the first fetch. Requires a free Equasis account configured in `local.properties`. Every fetch is also recorded in a log viewable from settings (see **View Equasis log**).

### Global Fishing Watch

If Global Fishing Watch enrichment is enabled (it is **on by default**), the detail view shows a **Global Fishing Watch** panel, above the map alongside the VesselFinder/MarineTraffic/Equasis panels. It shows the vessel's **identity** (flag, IMO, MMSI, call sign, type, year) and the **behavioural event** tables that GFW derives and classifies from the global AIS feed:

- **Encounters** — two vessels meeting at sea (the typical signature of a ship-to-ship transfer).
- **Loitering** — a prolonged stop in open sea.
- **Port visits** — reconstructed port calls.
- **AIS-off (gaps)** — transponder switched off while the ship was underway ("dark activity").

Each field/section has a hover ⓘ info icon explaining it. Like VesselFinder/MarineTraffic, the enrichment is **proactive**: it runs in the background on the ship's first detection (no button to press). Because these events are already AIS-derived and classified by GFW, they are **authoritative confirmations** of the behavioural signals and they **feed the risk score**.

GFW mainly tracks **fishing, support, and reefer/carrier vessels**: many merchant ships are not present, and in that case the panel shows a "not found in GFW" note. The feature requires a GFW **API token** configured in `local.properties` (`GLOBAL_FISHING_WATCH_TOKEN`); without a token it stays disabled and the settings show a "token not configured" hint. GFW data is free **for non-commercial use only** (research, NGO, public good); commercial use requires a dedicated license.

### Sanctions

When a ship matches a sanctions list (screening enabled, see settings), the detail view shows a **Sanctions** panel at the top — before the VesselFinder/MarineTraffic/GFW panels and with a red border. It briefly explains **what sanctions are** and shows the match data:

- **List** — the regime that produced the match: OFAC SDN (US Treasury), EU consolidated list, UK OFSI, or UN Security Council (res. 1718).
- **Programme** — the specific sanctions programme (e.g. EU-MARE, GB-RUS, UN-SC1718), when available.
- **Matched by** — the field the match was made on: **IMO** or **call sign** (high confidence), or **name** (weaker, possible homonym).
- **Listed name**, **flag**, **owner**, and **aliases** of the designated entity, when present in the source.

A box explains the matching regime (OFAC / EU / UK / UN) and a **warning** reminds you to always verify on the official source: in particular, a **name-only** match may be a false positive (homonym). When the entity id is available, the **Open official profile** button opens the vessel's public page (OpenSanctions for EU/UK/UN, OFAC Sanctions Search for OFAC). The panel appears **only** for ships actually on a list; it is hidden for all others.

### At-sea rendezvous

If this ship had a confirmed **rendezvous** with another ship (the two stayed close, slow and offshore long enough — the classic signature of a ship-to-ship transfer), the detail view shows a **Rendezvous** section: the list of encounters (other ship, date/time, closest distance reached, area). Each row is **clickable** and opens the detail of the ship involved.

A confirmed rendezvous also fires a **notification** (see [Notifications](#notifications)) and **adds points to the risk score of both ships**. Detection is automatic and uses only the app's own AIS data (no external source required).

### Position map

Map showing the vessel's track with animated playback controls.

- **Time window** — quick presets **6h / 24h / 7d / all** to filter the track to the most recent period. Or set a **custom range** with the two date/time pickers (From → To) and press **Apply**. When you first open the detail view the pickers are pre-filled with the full date range available in the archive.
- **▶ / ⏸** — play or pause the track animation (the ship marker moves along the route leaving a growing trail).
- **Scrubber** — drag it to jump to any point along the track.
- **Speed multipliers** — **1× / 5× / 20× / 60×** relative to the standard playback duration. Default is 20×. Can be changed mid-playback without interruption.

### AIS readings

Paginated table of all positions received in chronological order. Click any row to see the reading detail. The full **raw data** in JSON format is shown only for the vessel's static messages (name, dimensions, destination…); for plain position messages every useful field is already in the detail grid and the JSON section appears empty (`{}`), to avoid bloating the database.

**Page navigation:** use the ← Prev and Next → buttons below the table.

### Operational notes

Free-text area. Write any annotation about the vessel and press **Save notes**. Notes are saved to the database and are persistent.

### Port visit history

Log of all arrival (↙) and departure (↗) events recorded for this vessel, with destination, draught, and stay duration. UN/LOCODE values in the Destination column are automatically resolved (e.g. `ITNAP` → "Napoli").

---

## Settings

Open with the **⚙ Settings** button in the sidebar.

| Option | Function |
|---|---|
| **Area monitoring** | Panel at the top of the settings: shows all configured areas with a toggle to start or stop the stream for each one. 🟢 = stream active, ⚪ = stream off. Allows monitoring multiple areas simultaneously. |
| **VesselFinder** (toggle) | Fetch additional data from VesselFinder in the vessel detail view. Data cached for 6 hours. |
| **MarineTraffic** (toggle) | Fetch additional data from MarineTraffic in the vessel detail view. Data cached for 6 hours. |
| **Import ShipFinder** (toggle) | Fetch data from ShipFinder and — uniquely among the free sources — the **last-seen position**, used to re-locate followed ships AIS can no longer see (automatically, in the background) and via the **📍 Locate via ShipFinder** button in the detail view. Positions appear as distinct amber markers, without altering the AIS track/score/replay. Static data cached for 6 hours. Off by default. |
| **Sanctions screening** (toggle) | Matches every ship against the OFAC SDN sanctions list (US Treasury), downloaded locally. Matching is done by IMO number, name or call sign. A match is a very strong risk signal (large score contribution). The list is downloaded on enable and refreshed every 24 hours; the **Refresh list** button forces an immediate download. The number of sanctioned vessels loaded and the last refresh date are shown below the toggle. |
| **Additional sanctions lists (EU / UK / UN)** (toggle) | On top of the OFAC list, also matches every ship against the EU consolidated list, the UK OFSI list and the UN designated-vessels list. Indented sub-row under the **Sanctions screening** row, active only while sanctions screening is on. A match on any list contributes to the score like an OFAC match. The lists are downloaded and refreshed every 24 hours (via OpenSanctions). Default on. |
| **Port State Control screening (Paris/Tokyo MoU)** (toggle) | Matches every ship against two official Memorandum of Understanding lists: (1) the **flag performance** white/grey/black lists of Paris MoU and Tokyo MoU — a black-listed flag is a high-risk registry for detentions/inspections (medium-high score contribution), a white-listed one carries no penalty; (2) the **banned-ships list** of the Paris MoU (refusal of access after repeated detentions) — a strong signal, matched by IMO/name. The flag lists are bundled with the app and must be updated manually ~once a year; the banned-ships list is downloaded on enable and refreshed every 24 hours. The **Refresh lists** button forces a download. Below the toggle the flag counts (black/grey/white) and banned-ship count are shown with the last refresh date. |
| **Equasis lookup (ownership)** (toggle) | Enables the **Fetch Equasis information** button in the ship detail to retrieve registered owner, ISM manager and operator (by IMO number). **Never automatic**: runs only on request, one ship at a time. Data is stored once (no expiry). Requires Equasis credentials (`EQUASIS_USER` / `EQUASIS_PASSWORD` in `local.properties`); without credentials the button stays unusable. The **View Equasis log** button (below the description) opens the plain-text record of every lookup performed, with date, ship and retrieved data; the same window lets you **Clear the log**. |
| **Global Fishing Watch** (toggle) | Enriches every ship with identity and behavioural events (at-sea encounters, loitering, port visits, AIS-off gaps) derived by GFW from the global AIS feed, shown in a dedicated panel in the detail view; the events contribute to the risk score. **Proactive** like VesselFinder/MarineTraffic and **on by default**. Covers mainly fishing, support and reefer/carrier vessels (many merchant ships are not present). Requires a GFW **API token** (`GLOBAL_FISHING_WATCH_TOKEN` in `local.properties`); without a token the row shows a "token not configured" hint. Data is free for non-commercial use only. |
| **Notifications** (toggle) | Master switch: enable or disable all sidebar notifications. When off, the toggles below are disabled. |
| **Ship revisit alert** (toggle) | Alert when a ship returns to an area it had visited before. |
| **Area change alert** (toggle) | Alert when a ship seen in one area is later detected in a **different** area. |
| **High-risk score alert** (toggle) | Alert when a ship arrives with a risk score in the red band (71–100). |
| **New berth alert** (toggle) | Alert when a new berth is detected in an area. |
| **Berth characterisation alert** (toggle) | Alert when a berth is characterised for the first time (dominant ship category). |
| **Exclude tankers** (toggle) | Do not assign the ship-type risk points to tanker-hull vessels. Useful when monitoring arms transport, which tankers cannot carry. |
| **Check position jump** (toggle) | Include the "Impossible position jump" factor in the risk score. Turn off in areas with poor AIS coverage, where sparse position reports produce apparent jumps that are not real spoofing. On by default. |
| **Check AIS blackout** (toggle) | Include the "AIS blackout" factor in the risk score. Turn off in poorly-covered areas, where reception gaps look like deliberate transponder shutdowns. On by default. |
| **OpenSeaMap nautical layer (tiles)** (toggle) | Show the OpenSeaMap nautical tile layer (buoys, lights, marks, traffic separation, fairways, anchorages) on the maps. It's a single image: **all or nothing**, you can't hide individual symbols. Turn it off if you don't want these symbols (e.g. the lights/beacons that look like little towers with a magenta drop). Free data, **no API key**. On by default. |
| **OpenSeaMap markers (selectable)** (toggle) | Draw ⚓ markers on the active-ships map with the official berths/moorings/harbours pulled from OpenStreetMap, to compare against the app's auto-computed berths. Unlike the tile layer, these **are filterable per category** (row below). Hover a marker to read what it is. On by default. |
| **OpenSeaMap elements to show** (checkboxes) | Choose which marker categories to draw on the map (harbours, berths, anchorages, marinas, regulated areas, lights, beacons/buoys, hazards, pilot points). The map updates immediately when you tick/untick a category. Applies to the vector markers; the nautical tile layer always shows everything. Default: all on. |
| **Per-cargo-type risk weights** (grid) | Risk points assigned to each merchandise class (container ship, crude oil tanker, chemical tanker, gas carrier, bulk carrier, etc.). The class is derived from the VesselFinder/MarineTraffic subtype, falling back to the AIS code. Replaces the old fixed Cargo/Hazmat points. Edit the values and press **💾 Save weights** (immediate effect, no restart); **Reset to defaults** reloads the built-in values into the grid (save to apply). The weights are included in the settings and bundle export. |
| **⬇ Export CSV** | Download all readings as a CSV file (importable in Excel) |
| **⬇ Download backup** | Download the database file (.db) as a backup |
| **⬆ Restore** | Load a previously saved .db file to restore data |
| **Language** | Switch the interface language (Italiano / English) |

> **Warning:** Restoring the database replaces **all** current data. This operation is irreversible. Download a backup before proceeding. After restore, data is automatically assigned to the correct area based on geographic coordinates.

> **Auto-restore after a deploy:** the database is wiped when you update the application (deploy). If at startup the database **does not exist** and saved **auto-backups** are present (folder `data/backups/`), the app automatically restores the most recent backup (database only). This requires the backups folder to survive the deploy. It does not trigger if the database exists but was merely emptied via "Clear data". Disable with `AUTO_RESTORE_ON_DEPLOY=false` in `app.config.properties`.

Settings are organized into **tabs**: **General** (the table above), **Areas**, **External integrations** (Telegram notifications + outbound webhooks, see below), **Parameters** and **Backup / Restore**.

### External integrations tab

This tab is where you connect external channels to send notifications to: **Telegram** (at the top) and **outbound webhooks** (at the bottom).

Lets you receive your user's notifications on **Telegram**, via a bot. It only works if the administrator configured the bot token on the server (`TELEGRAM_BOT_TOKEN`); otherwise the tab shows "Telegram bot not configured".

**Linking your account:**

1. Press **Link**. A link (and a code) appear.
2. Open the link in Telegram (or send the bot the message `/start <code>`) and start the bot.
3. The bot replies "Account linked" and the tab updates by itself: you now receive notifications on Telegram.

To stop: press **Unlink** (or send `/stop` to the bot). Use **Send test** to check the link works.

**Which notifications to receive** — the master **Telegram notifications** switch turns everything on/off; below it, one toggle per category:

| Toggle | Alerts when… |
|---|---|
| **High-risk score** | a ship arrives with a risk score in the red band (71–100). |
| **Ship revisit** | a ship returns to a previously visited area. |
| **Area change** | a ship moves from one monitored area to another. |
| **New berth** | a new berth is detected in an area. |
| **Berth characterisation** | a berth is characterised for the first time. |
| **AIS outage** | the AIS feed becomes unavailable (start) and when it recovers (end). |
| **Area monitoring start/stop** | you start or stop monitoring one of your areas. |
| **Location map** | not an event category: when on, notifications that carry a position (berths and ships) get a **map image** of the point attached (same maps as the site: OpenStreetMap + the OpenSeaMap nautical layer) plus a **tappable pin** you can open in your phone's maps app. Turn it off to receive those notifications as text only. |

The Telegram toggles are **independent** of the sidebar notification toggles: you can receive a category on Telegram only, in-app only, or both. Messages arrive in the **language** set for your user.

**Follow / Flag buttons** — notifications about a ship (**High-risk score**, **Ship revisit**, **Area change**) show two buttons under the message:

- **🛰️ Follow** — adds the ship to your **Followed ships** (if not already there), exactly like the in-app follow; if the ship hasn't been transmitting for a while it kicks off a background search for its position.
- **⭐ Flag** — flags the ship, just like pressing the **star** in the list.

After a tap you get a short confirmation and the button updates (e.g. **✅ Following**, **⭐ Flagged**). The actions are "add only": pressing an already-active button does nothing. To un-follow or un-flag, use the ship list on the site.

**🔗 Outbound webhooks** — below the Telegram toggles you can also forward your areas' events to a **web address** (a *webhook*), to bring them into **Slack**, **Discord**, a security system (SIEM) or your own service. To add one:

1. Paste the webhook **URL** (the one Slack/Discord gives you, or your own endpoint).
2. Pick the **format**: *Generic* (raw event JSON, for SIEM/custom integrations), *Slack* or *Discord* (a ready-made text message for those services).
3. Tick **which events** to send (high risk, rendezvous, area change, revisit, berths, AIS outage).
4. (Optional) set a **secret**: if present, every delivery includes an `X-Tracker-Signature` signature the receiver can use to verify it really came from here.
5. **Add webhook**. Use **Test** to send a test event, the switch to enable/disable it, **Delete** to remove it.

Webhooks are **personal** (they only cover your areas) and independent of Telegram. For safety, internal/private addresses (localhost, local networks) are not allowed. Maximum 10 per user.

### Parameters tab

Lets you edit **all the app's operating parameters** (those in `app.config.properties`) from the UI: ship-state thresholds, time windows, database retention, backup interval, auto-restore, berth parameters and the **risk-score** weights.

- Parameters are grouped by category; **every field has a description** explaining what it configures (taken straight from the file's comments).
- Edit the values and press **💾 Save parameters**. Changed-but-unsaved fields are highlighted, with a count next to the button.
- **⚠️ Important:** these parameters are read by the server **only once at startup**. After saving you must therefore **restart the server** for changes to take effect — **reloading the browser is not enough**. The UI reminds you with a banner and after each save. To restart: stop and start with `npm start`, or `pm2 restart` if you use PM2.
- **Secrets** (API key, passwords) are **not** editable here for security: they stay in `local.properties`. Import and notification toggles are in the **General** tab.

---

## Area management

Open it with the **🗺 Areas** button in the sidebar. From here you can add and remove monitored areas **without restarting the application**.

The screen contains:

- an **"Add area" panel** (top left);
- a **map** showing all configured areas as rectangles (green = stream active, violet = area currently in view, blue = others);
- a **table** listing every area: name, South-West and North-East corner coordinates, keyword, stream status, amount of stored data, and a delete button.

### Adding an area

1. Type a **name** (required) and, optionally, a **keyword** (used by the "Expected ships" section to filter ships with a matching destination).
2. Define the area's bounds in **one** of two ways:
   - **GPS coordinates** — enter the latitude and longitude of the two corners by hand, in **decimal degrees**: SW (South-West) and NE (North-East). Example: SW `40.95, 16.60` — NE `41.30, 17.10`. A dashed preview rectangle appears on the map as you type.
   - **From the map** — pan and zoom the map until it frames exactly the area you want to monitor, then press **🎯 Capture current view**: the four coordinates are filled automatically from the visible viewport.
3. Press **＋ Add area**. The new area is saved and its AIS stream starts immediately.

> Decimal degrees are the simplest GPS format: e.g. `41.125, 16.866`. Latitude ranges from -90 to 90 (positive North), longitude from -180 to 180 (positive East). Corners can be entered in any order: they are reordered automatically.

### Removing an area

Press the 🗑 button on the area's row. **The area's entire related monitoring history is deleted along with it** (readings, ships and port events for that area).

For safety the deletion is **not immediate**: a notification appears at the bottom with a countdown and an **↶ Undo** button for **10 seconds**.

- If you press **↶ Undo**, nothing is deleted.
- The deletion becomes permanent when the 10 seconds elapse, **or** when you leave the Areas page (or close/reload the browser).

**At least one area** must remain: the delete button is disabled when only one is left.

---

## Editing the configuration files

Some advanced settings are not in the interface but in text files in the project folder. Open them with any text editor (Notepad, TextEdit, VS Code…), change the values and **restart the application** to apply them. Lines starting with `#` are comments and are ignored.

### `local.properties` — keys and secrets

Holds the API key and initial preferences. Format `KEY=value`, one per line. **Do not share it** (it contains the API key). If it doesn't exist, copy it from `local.properties.example`.

| Key | Meaning |
|---|---|
| `AIS_API_KEY` | Your AISStream.io access key (required) |
| `HEATMAP_AIS_API_KEY` | AISStream.io access key used **only** by the [Coverage map](#coverage-map). It must come from a **separate account** (different from `AIS_API_KEY`), because that map opens its own worldwide stream. Leave empty to keep the feature disabled. Write it "bare" — **no comment on the same line** |
| `BBOX_PRESET` | Area shown at startup (an area's key, e.g. `bari`) |
| `IMPORT_VF_DATA` | `true`/`false` — enable VesselFinder data import |
| `IMPORT_MT_DATA` | `true`/`false` — enable MarineTraffic data import |
| `IMPORT_SF_DATA` | `true`/`false` — enable ShipFinder data import + position to re-locate lost followed ships |
| `IMPORT_SANCTIONS` | `true`/`false` — enable screening against the OFAC SDN sanctions list |
| `IMPORT_SANCTIONS_EXTRA` | `true`/`false` — enable the additional EU / UK OFSI / UN sanctions lists on top of OFAC (only active with `IMPORT_SANCTIONS`); default `true` |
| `IMPORT_PSC` | `true`/`false` — enable Port State Control screening (Paris/Tokyo MoU flag performance + Paris MoU banned vessels) |
| `IMPORT_EQUASIS` | `true`/`false` — enable the on-demand Equasis lookup (ownership/management) in the ship detail |
| `EQUASIS_USER` | Equasis account email (free registration at https://www.equasis.org/) — required by the Equasis lookup |
| `EQUASIS_PASSWORD` | Equasis account password — required by the Equasis lookup |
| `IMPORT_GFW` | `true`/`false` — enable Global Fishing Watch enrichment (identity + behavioural events); **default `true`** |
| `GLOBAL_FISHING_WATCH_TOKEN` | Global Fishing Watch API token (Bearer), generated from the GFW API portal (https://globalfishingwatch.org/our-apis/) — required by the GFW enrichment. Data is free for non-commercial use only |
| `ADMIN_USERNAME` | Username of the built-in administrator (always re-created at startup if missing). Default `admin` |
| `ADMIN_EMAIL` | Email of the built-in administrator. Default `admin@local` |
| `ADMIN_PASSWORD` | Password of the built-in administrator. If empty, the shipped default value is used — **change it** on any server reachable by others |
| `COOKIE_SECURE` | `true`/`false` — send the session cookie over HTTPS only; set to `true` behind TLS |
| `SESSION_TTL_DAYS` | Session (login) lifetime in days. Default `30` |

> `BBOX_PRESET`, `IMPORT_VF_DATA` and `IMPORT_MT_DATA` can also be changed from the interface (area selector / Settings) and are rewritten to the file automatically.

### `app.config.properties` — operating parameters

Holds the app's thresholds and parameters (time windows, radii, retention, risk-score weights). Format `KEY=value`. Each parameter is documented by a comment in the file itself. **You can also edit these values from the UI** in **⚙ Settings → [Parameters](#parameters-tab)** (more convenient); either way a **server restart** is required to apply them. Examples:

| Key | Meaning | Default |
|---|---|---|
| `SOG_FERMA_KN` | Speed (knots) below which a ship counts as "stationary" | `0.5` |
| `ACTIVE_WINDOW_HOURS` | Hours a moving ship stays among "active" ships | `6` |
| `PORT_WINDOW_HOURS` | Hours an in-port ship stays among "active" ships | `24` |
| `POLL_INTERVAL_MS` | Interface refresh interval (milliseconds) | `300000` |
| `AIS_OUTAGE_CHECK` | Enable AIS outage detection (`false` to turn it off) | `true` |
| `AIS_OUTAGE_SILENCE_MIN` | Minutes without AIS signals before querying the uptime monitor | `10` |
| `AIS_UPTIME_SELFHOST_URL` | URL of your own self-hosted monitor instance (queried first; empty = none) | _(empty)_ |
| `AIS_UPTIME_URL` | URL of the public AISStream uptime monitor, used as a fallback | `https://aisuptime.buttermilkgreen.fyi` |
| `MAX_READINGS_PER_TYPE` | Max readings kept per message type | `10000` |
| `BERTH_CLUSTER_EPS_M` | Mooring → berth clustering radius (metres) | `80` |
| `BERTH_MIN_PTS` | Minimum nearby moorings to form a berth | `3` |
| `BERTH_MIN_MOORINGS` | Minimum moorings before a berth is characterized/coloured | `10` |
| `BERTH_DOMINANT_PCT` | Percentage a category must exceed to name the berth | `60` |
| `BERTH_RECOMPUTE_MIN` | Minutes between automatic berth recomputes | `30` |
| `RISK_*` | Risk-score weights and thresholds (see comments in the file) | various |
| `HEATMAP_GRID_DEG` | [Coverage map](#coverage-map) cell size, in degrees (~28 km at 0.25). Smaller = more precise but heavier; after changing it, press **Clear data** on the map | `0.25` |
| `HEATMAP_FLUSH_SEC` | How often (seconds) the Coverage map writes new counts to its database | `10` |
| `HEATMAP_STATS_SEC` | How often (seconds) the Coverage map refreshes the live stats shown to administrators | `2` |

### `bounding-boxes.json` — area definitions

Lists the monitoring areas. **The recommended way to manage them is the [🗺 Areas](#area-management) screen** (which rewrites this file for you). You can still edit it by hand for initial provisioning; if so, **restart** the app after your changes.

Each area has this shape:

```json
"bari": { "name": "Porto di Bari", "keyword": "BARI", "sw": [40.95, 16.60], "ne": [41.30, 17.10] }
```

| Field | Meaning |
|---|---|
| key (`bari`) | Internal area identifier (also used by `BBOX_PRESET`) |
| `name` | Name shown in the interface |
| `keyword` | (Optional, may be `null`) filters "Expected ships" by destination |
| `sw` | South-West corner `[lat, lon]` in decimal degrees |
| `ne` | North-East corner `[lat, lon]` in decimal degrees |

> Hand edits to this file while the app is running take effect only after a restart. If you use the Areas screen, the file's formatting is normalized (it stays valid, but the indentation changes).

---

## Risk score

Each vessel receives a score from 0 to 100 calculated automatically based on several factors. The score is indicative and does not replace expert assessment.

| Color | Range | Meaning |
|---|---|---|
| Green | 0–30 | Low risk |
| Yellow | 31–70 | Medium risk — monitor |
| Red | 71–100 | High risk — review required |

**Source indicators on the badge:**
- Magenta dot: score calculated using VesselFinder data
- Gold dot: score calculated using MarineTraffic data
- Red dot (with glow): ship present on a sanctions list (OFAC / EU / UK / UN)
- Orange dot: both sources used
- Blue label (Paris/Tokyo MoU ⚓): signal from the Port State Control lists (black/grey flag or banned vessel)
- Teal dot (Global Fishing Watch): score calculated using Global Fishing Watch data

Hover over the badge to see factor details and sources.

**Per-cargo-type weight:** one of the score factors depends on the vessel's merchandise class (see [Cargo type](#information-bar)). Each class has a weight configurable from **⚙ Settings → "Per-cargo-type risk weights"** (e.g. crude oil / chemical / gas carriers weigh more than container ships). Changes take effect immediately, no restart. With **"Exclude tankers"** on, tanker-hull classes contribute no points.

**Signal weights (Risk model):** how many points **each** risk signal is worth (AIS blackout, spoofing, loitering, draught increase, sanctions, PSC, GFW events, rendezvous, etc.) is adjustable from **⚙ Settings → the "⚖ Risk model" section** (admins only). You get a grid with one field per signal: change the values and press **💾 Save weights** — immediate effect, no restart. **Reset to defaults** restores the factory values. You can also save whole configurations as **risk profiles** (the *Risk profile* menu → *Save as…*) and recall them with *Apply* — handy for switching between setups on the fly (e.g. a more aggressive profile, or one tuned for areas with poor AIS coverage). Setting a weight to **0** disables that signal. *(Detection thresholds and multipliers stay in the config file, see [`app.config.properties`](#appconfigproperties--operating-parameters).)*

**Military vessels:** automatically classified at maximum risk.

---

## AIS diagnostics

Open from **⚙ Settings → 📡 AIS Diagnostics tab**. Shows the data stream connection status:

- **Connection** — Connected / Disconnected
- **Session uptime** — How long the stream has been active
- **WS frames received** — How many data packets have been received
- **Ship messages** — How many vessel positions have been processed
- **Message rate** — Messages per minute
- **Reconnections** — How many times the connection was re-established
- **Last error** — The most recent error recorded, if any

The panel updates automatically every 5 seconds.

### AIS outage banner

If for a few minutes (`AIS_OUTAGE_SILENCE_MIN`, default 10) an active monitor receives **no AIS signal at all**, the app checks the service status by querying an **independent uptime monitor** ([AISStream-Uptime](https://github.com/buttermilkgreen/AISStream-Uptime), public instance `https://aisuptime.buttermilkgreen.fyi`). Only if that monitor also confirms the AISStream service is **not active** does a yellow notice — prominent but non-intrusive — appear at the top of the monitoring pages:

> ⚠️ Possible AISStream outage: no incoming signals and the public monitor reports "…". Data may not be updating.

You can dismiss the notice with the **✕**; it reappears if a new outage is detected. When signals start arriving again, the notice disappears on its own. If the area is simply quiet but the service is running normally, **no** notice is shown (no false alarms). The feature can be turned off entirely with `AIS_OUTAGE_CHECK=false`. See also [Credits](#credits).

The AISStream-Uptime project is open source (MIT-licensed) and you can **host it yourself**: set your instance's URL in `AIS_UPTIME_SELFHOST_URL` and the app will query it first, falling back to the public monitor only when yours is unreachable (also useful to tell whether the outage is global). With a healthy self-hosted instance the public service is never contacted.

---

## Theme toggle

The **🌙 / ☀️** button at the bottom right switches between dark (default) and light theme.

---

## Automatic alerts

If a previously flagged vessel (★) enters the monitored area, a notification appears on screen:

> ⚠️ Flagged vessel in area!
> **[Vessel name]** — [Type]

The alert closes automatically after 10 seconds.

---

## Notifications

In addition to the temporary alerts, the application keeps a **notification history** in the sidebar. The list is visible by default (empty on first launch) and is opened/closed with the **🔔 Notifications** button. The open/closed state is remembered across sessions.

**When a notification is generated**

Automatic notifications are created in the following cases (each can be enabled/disabled independently from [Settings](#settings)):

Vessel events:
- **Ship revisit** — a vessel **previously seen in an area is detected again in that same area** (a new arrival after an absence). The very first sighting of a vessel does not generate a notification.
- **Area change** — a vessel seen in one area is later detected in a **different** monitored area (the move from one area to another).
- **High-risk score** — a vessel arrives with a risk score in the red band (71–100).

Berth events (see [Berths](#berths-automatic-mooring-characterization)):
- **New berth** — during the automatic recompute a new berth is detected in an area.
- **Berth characterisation** — a berth is characterised for the first time (it reaches its dominant ship category). The initial analysis (*backfill*) on an area with no berths does not generate notifications.

Other events:
- **At-sea rendezvous** — two distinct ships linger close, slow and offshore long enough (possible ship-to-ship transfer, see [At-sea rendezvous](#at-sea-rendezvous)). The notification includes a map with the **two** points joined by a line. Can be toggled separately, both in-app and on Telegram.

**Reading a notification**

| Element | Meaning |
|---|---|
| 🟢 / 🟡 / 🔴 dot | Vessel notifications: colour based on the computed risk score (green low, yellow medium, red high — see [Risk score](#risk-score)). Berth notifications have a dedicated dot. |
| Text | Vessel name and area (revisit/high-risk), origin and destination areas (area change), or berth name/category and area (berth events) |
| ✓ button | Mark the notification as read |
| 🗑 button | Delete the notification (visible on hover) |

**Click a notification** (outside the ✓ and 🗑 buttons): a vessel notification opens the vessel detail view; a berth notification jumps to the corresponding area's map (switching area if needed) and centres the berth, opening its details.

**Deleting a notification**

Press the 🗑 button on the notification. A message appears with an **↶ Undo** button for 5 seconds; when the time expires the notification is permanently removed.

**Muting notifications for a single vessel**

In the vessel detail view (open by clicking any table row or a notification) a button appears:

- **🔔** — notifications for this vessel are active; click to mute
- **🔕** — notifications for this vessel are muted; click to re-enable

When a vessel is muted it generates no revisit or area-change notifications, regardless of the global settings.

**Unread** notifications are shown in **bold** and counted in the red badge on the 🔔 button. Read notifications stay visible in the list (no longer bold). The history retains the **last 100 notifications**; older ones are pruned automatically. Clearing an area's data also removes its notifications.

---

## Installing the app (PWA)

Tracker Porti is an **installable app** (PWA): you can add it to your phone's home screen or install it as a desktop app, and it opens **full-screen**, without the browser chrome.

- **On a phone** — open the site in your browser → menu → **"Add to Home Screen"** (iPhone/Safari) or **"Install app"** (Android/Chrome). An anchor icon appears like a normal app.
- **On desktop** — in Chrome/Edge an install icon appears in the address bar, or menu → **"Install Tracker Porti"**.

The installed app **also works offline** as far as opening goes: with no connection it shows a **"You are offline"** screen with a *Retry* button, because AIS data is real-time and needs the network. As soon as you're back online, reload and it resumes normally. Access stays protected: login is always required.

---

## Frequently asked questions

**The table is empty — what do I do?**
Check that monitoring for this area is running (ACTIVE badge at the top) and that the selected area has maritime traffic. You can check which areas are being monitored in the "Area monitoring" panel under Settings. Use AIS Diagnostics to check the connection status.

**How do I keep track of vessels I have already checked?**
Use the **✓ Seen** button on each row: the vessel becomes faded and is immediately distinguishable from unreviewed ones.

**Can I export the data?**
Yes, in several ways, all downloaded straight from the browser:
- **CSV** — the **⬇ Filtered CSV** button in the active/past ships toolbar exports the current (filtered and sorted) view; **⚙ Settings → Export CSV** instead gives the raw export of all readings.
- **GeoJSON / KML** (for **QGIS** or **Google Earth**) — next to the CSV you'll find **⬇ GeoJSON** and **⬇ KML**. Four sources: the filtered **ship list** (points), a ship's **track** (from the detail view, under the map), an area **replay** (one line per ship, from the Replay bar), and the **berths** as polygons ("Berths GeoJSON/KML" buttons). If there's nothing to export, a warning appears.

> The [Coverage map](#coverage-map) data lives in a **separate database**. From the **Backup / Restore** settings you can **export and import it on its own**, and it is also included in the **full backup**.

**I changed area and the vessels disappeared — is that normal?**
Yes. Each area has its own independent data set and its own independent stream. Changing the area in the dropdown is a view change only: it shows the data for the selected area but does not start or stop any stream. Vessels from the previous area remain in the database; if you switch back, you will see them again. To receive data from multiple areas at the same time, use the "Area monitoring" panel in Settings.

**Can I monitor multiple areas at the same time?**
Yes. Open **⚙ Settings** → **Area monitoring** section and enable the toggle for each area you want to monitor. Each area collects data completely independently. You can then switch between areas using the dropdown to view their data.

**Are military vessels always red?**
Yes. Vessels identified as military are automatically marked with maximum score and a red row.

---

## Credits

AIS outage detection (the [outage banner](#ais-outage-banner)) relies on the **[AISStream-Uptime](https://github.com/buttermilkgreen/AISStream-Uptime)** project by buttermilkgreen, an uptime monitor for the AISStream service. The app does not bundle its code: it only consults the public API of its hosted instance (`https://aisuptime.buttermilkgreen.fyi`) to tell whether a stretch of data silence is caused by a service failure or simply by a low-traffic area.
