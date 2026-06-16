# User Manual — Tracker Porti

## What this software does

**Tracker Porti** monitors AIS maritime traffic in real time within a defined geographic area. It collects position data broadcast by vessels, analyzes it, calculates a risk score for each ship, and presents the information in visual and tabular form.

No technical knowledge is required to use it.

---

## Quick start

1. Open a browser and navigate to the server address (e.g. `http://localhost:3000`)
2. In the left sidebar, select the **geographic area** to monitor from the "Area:" dropdown
3. Press **▶ Start monitoring** to start receiving data
4. Ships will appear automatically in the table and on the map

---

## Main interface

### Sidebar (left)

| Element | Function |
|---|---|
| **🏠 Monitoring** | Return to the home (the Active / Past ships and Traffic tabs), where you monitor the areas |
| **▶ Start monitoring** | Start receiving AIS data in real time for the currently viewed area |
| **■ Ferma** | Stop receiving data for the current area (already collected data is retained) |
| **🗑 Cancella dati** | Delete readings for the currently viewed area — **irreversible** |
| **📋 Log API** | Open the API log panel (for diagnostics) |
| **📡 Diagnostica AIS** | Show connection status to the AIS stream for the current area |
| **🗺 Areas** | Open the area management screen: list, map, add and remove areas (see [Area management](#area-management)) |
| **⚙ Impostazioni** | Open application settings |
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
| Destination | Declared destination port |
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
- **Click a berth** (polygon or dot) to see its name, characterization, mooring count, per-category percentage distribution and any hazmat share (☢).

**Correcting by hand** (the **⚓ Berths** button): opens the management panel, where you can:

- **Rename** a berth (e.g. "San Cataldo Quay").
- **Force the category** with the dropdown (manual override, takes precedence over the automatic characterization). Set it back to *(automatic)* to return to auto-calculation.
- **Merge** two or more berths into one (select them with the checkboxes and press *Merge*). The resulting berth has "locked" (hand-drawn) geometry and is no longer moved by recompute.
- **Delete** a berth: its moorings are freed and may be re-clustered on the next recompute.
- **Recompute** moorings and berths for the current area immediately (the system also does this periodically on its own).
- **Click a list row** to centre the map on that berth and open its details (enables the overlay if it was off).

> Hand-edited berths (geometry, name, forced category) survive automatic recomputes: your corrections are never overwritten. Automatic berths are rebuilt on every recompute, but keep the name and forced category you assigned.

> At startup the app runs an initial analysis (*backfill*) over all the history already collected, so berths are visible right away.

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
| Call sign | Radio call sign |
| IMO | IMO registration number |
| Destination | Declared port |
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

### Ownership / management (Equasis)

If the Equasis lookup is enabled in settings, the detail view shows an **Ownership / management (Equasis)** panel with a **Fetch Equasis information** button. Unlike VesselFinder/MarineTraffic it **never runs automatically**: the lookup happens only when you press the button, and queries Equasis by **IMO number** (if the ship has no IMO the lookup is not possible). It returns registered owner, ISM manager, operator and other ship particulars. The result is **stored once** and shown indefinitely (no expiry); the button disappears after the first fetch. Requires a free Equasis account configured in `local.properties`. Every fetch is also recorded in a log viewable from settings (see **View Equasis log**).

### Position map

Map showing the vessel's last known position.

### AIS readings

Paginated table of all positions received in chronological order. Click any row to see the full raw data in JSON format.

**Page navigation:** use the ← Prev and Next → buttons below the table.

### Operational notes

Free-text area. Write any annotation about the vessel and press **Save notes**. Notes are saved to the database and are persistent.

### Port visit history

Log of all arrival (↙) and departure (↗) events recorded for this vessel, with destination, draught, and stay duration.

---

## Settings

Open with the **⚙ Settings** button in the sidebar.

| Option | Function |
|---|---|
| **Area monitoring** | Panel at the top of the settings: shows all configured areas with a toggle to start or stop the stream for each one. 🟢 = stream active, ⚪ = stream off. Allows monitoring multiple areas simultaneously. |
| **VesselFinder** (toggle) | Fetch additional data from VesselFinder in the vessel detail view. Data cached for 6 hours. |
| **MarineTraffic** (toggle) | Fetch additional data from MarineTraffic in the vessel detail view. Data cached for 6 hours. |
| **OFAC sanctions screening** (toggle) | Matches every ship against the OFAC SDN sanctions list (US Treasury), downloaded locally. Matching is done by IMO number, name or call sign. A match is a very strong risk signal (large score contribution). The list is downloaded on enable and refreshed every 24 hours; the **Refresh list** button forces an immediate download. The number of sanctioned vessels loaded and the last refresh date are shown below the toggle. |
| **Port State Control screening (Paris/Tokyo MoU)** (toggle) | Matches every ship against two official Memorandum of Understanding lists: (1) the **flag performance** white/grey/black lists of Paris MoU and Tokyo MoU — a black-listed flag is a high-risk registry for detentions/inspections (medium-high score contribution), a white-listed one carries no penalty; (2) the **banned-ships list** of the Paris MoU (refusal of access after repeated detentions) — a strong signal, matched by IMO/name. The flag lists are bundled with the app and must be updated manually ~once a year; the banned-ships list is downloaded on enable and refreshed every 24 hours. The **Refresh lists** button forces a download. Below the toggle the flag counts (black/grey/white) and banned-ship count are shown with the last refresh date. |
| **Equasis lookup (ownership)** (toggle) | Enables the **Fetch Equasis information** button in the ship detail to retrieve registered owner, ISM manager and operator (by IMO number). **Never automatic**: runs only on request, one ship at a time. Data is stored once (no expiry). Requires Equasis credentials (`EQUASIS_USER` / `EQUASIS_PASSWORD` in `local.properties`); without credentials the button stays unusable. The **View Equasis log** button (below the description) opens the plain-text record of every lookup performed, with date, ship and retrieved data; the same window lets you **Clear the log**. |
| **Notifications** (toggle) | Master switch: enable or disable all sidebar notifications. When off, the toggles below are disabled. |
| **Ship revisit alert** (toggle) | Alert when a ship returns to an area it had visited before. |
| **Area change alert** (toggle) | Alert when a ship seen in one area is later detected in a **different** area. |
| **⬇ Export CSV** | Download all readings as a CSV file (importable in Excel) |
| **⬇ Download backup** | Download the database file (.db) as a backup |
| **⬆ Restore** | Load a previously saved .db file to restore data |
| **Language** | Switch the interface language (Italiano / English) |

> **Warning:** Restoring the database replaces **all** current data. This operation is irreversible. Download a backup before proceeding. After restore, data is automatically assigned to the correct area based on geographic coordinates.

> **Auto-restore after a deploy:** the database is wiped when you update the application (deploy). If at startup the database **does not exist** and saved **auto-backups** are present (folder `data/backups/`), the app automatically restores the most recent backup (database only). This requires the backups folder to survive the deploy. It does not trigger if the database exists but was merely emptied via "Clear data". Disable with `AUTO_RESTORE_ON_DEPLOY=false` in `app.config.properties`.

Settings are organized into **tabs**: **General** (the table above), **Areas**, **Developer options**, **Parameters** and **Backup / Restore**.

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
| `BBOX_PRESET` | Area shown at startup (an area's key, e.g. `bari`) |
| `IMPORT_VF_DATA` | `true`/`false` — enable VesselFinder data import |
| `IMPORT_MT_DATA` | `true`/`false` — enable MarineTraffic data import |
| `IMPORT_SANCTIONS` | `true`/`false` — enable screening against the OFAC SDN sanctions list |
| `IMPORT_PSC` | `true`/`false` — enable Port State Control screening (Paris/Tokyo MoU flag performance + Paris MoU banned vessels) |
| `IMPORT_EQUASIS` | `true`/`false` — enable the on-demand Equasis lookup (ownership/management) in the ship detail |
| `EQUASIS_USER` | Equasis account email (free registration at https://www.equasis.org/) — required by the Equasis lookup |
| `EQUASIS_PASSWORD` | Equasis account password — required by the Equasis lookup |

> `BBOX_PRESET`, `IMPORT_VF_DATA` and `IMPORT_MT_DATA` can also be changed from the interface (area selector / Settings) and are rewritten to the file automatically.

### `app.config.properties` — operating parameters

Holds the app's thresholds and parameters (time windows, radii, retention, risk-score weights). Format `KEY=value`. Each parameter is documented by a comment in the file itself. **You can also edit these values from the UI** in **⚙ Settings → [Parameters](#parameters-tab)** (more convenient); either way a **server restart** is required to apply them. Examples:

| Key | Meaning | Default |
|---|---|---|
| `SOG_FERMA_KN` | Speed (knots) below which a ship counts as "stationary" | `0.5` |
| `ACTIVE_WINDOW_HOURS` | Hours a moving ship stays among "active" ships | `6` |
| `PORT_WINDOW_HOURS` | Hours an in-port ship stays among "active" ships | `24` |
| `POLL_INTERVAL_MS` | Interface refresh interval (milliseconds) | `300000` |
| `MAX_READINGS_PER_TYPE` | Max readings kept per message type | `10000` |
| `BERTH_CLUSTER_EPS_M` | Mooring → berth clustering radius (metres) | `80` |
| `BERTH_MIN_PTS` | Minimum nearby moorings to form a berth | `3` |
| `BERTH_MIN_MOORINGS` | Minimum moorings before a berth is characterized/coloured | `10` |
| `BERTH_DOMINANT_PCT` | Percentage a category must exceed to name the berth | `60` |
| `BERTH_RECOMPUTE_MIN` | Minutes between automatic berth recomputes | `30` |
| `RISK_*` | Risk-score weights and thresholds (see comments in the file) | various |

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
- Red dot (with glow): ship present on the OFAC SDN sanctions list
- Orange dot: both sources used
- Blue label (Paris/Tokyo MoU ⚓): signal from the Port State Control lists (black/grey flag or banned vessel)

Hover over the badge to see factor details and sources.

**Military vessels:** automatically classified at maximum risk.

---

## AIS diagnostics

Open with **📡 Diagnostica AIS** in the sidebar. Shows the data stream connection status:

- **Connection** — Connected / Disconnected
- **Session uptime** — How long the stream has been active
- **WS frames received** — How many data packets have been received
- **Ship messages** — How many vessel positions have been processed
- **Message rate** — Messages per minute
- **Reconnections** — How many times the connection was re-established
- **Last error** — The most recent error recorded, if any

The panel updates automatically every 5 seconds.

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

Automatic notifications are created in two cases (both can be enabled/disabled from [Settings](#settings)):

- **Ship revisit** — a vessel **previously seen in an area is detected again in that same area** (a new arrival after an absence). The very first sighting of a vessel does not generate a notification.
- **Area change** — a vessel seen in one area is later detected in a **different** monitored area (the move from one area to another).

**Reading a notification**

| Element | Meaning |
|---|---|
| 🟢 / 🟡 / 🔴 dot | Colour based on the risk score computed for that vessel (green low, yellow medium, red high — see [Risk score](#risk-score)) |
| Text | Vessel name and the area it returned to, or the origin and destination areas for an area change |
| ✓ button | Mark the notification as read |
| 🗑 button | Delete the notification (visible on hover) |

**Click a notification** (outside the ✓ and 🗑 buttons) to open the vessel detail view directly.

**Deleting a notification**

Press the 🗑 button on the notification. A message appears with an **↶ Undo** button for 5 seconds; when the time expires the notification is permanently removed.

**Muting notifications for a single vessel**

In the vessel detail view (open by clicking any table row or a notification) a button appears:

- **🔔** — notifications for this vessel are active; click to mute
- **🔕** — notifications for this vessel are muted; click to re-enable

When a vessel is muted it generates no revisit or area-change notifications, regardless of the global settings.

**Unread** notifications are shown in **bold** and counted in the red badge on the 🔔 button. Read notifications stay visible in the list (no longer bold). The history retains the **last 100 notifications**; older ones are pruned automatically. Clearing an area's data also removes its notifications.

---

## Frequently asked questions

**The table is empty — what do I do?**
Check that monitoring for this area is running (ACTIVE badge at the top) and that the selected area has maritime traffic. You can check which areas are being monitored in the "Area monitoring" panel under Settings. Use AIS Diagnostics to check the connection status.

**How do I keep track of vessels I have already checked?**
Use the **✓ Seen** button on each row: the vessel becomes faded and is immediately distinguishable from unreviewed ones.

**Can I export the data?**
Yes. Go to **⚙ Settings** → **Export CSV**. The file downloads directly from the browser.

**I changed area and the vessels disappeared — is that normal?**
Yes. Each area has its own independent data set and its own independent stream. Changing the area in the dropdown is a view change only: it shows the data for the selected area but does not start or stop any stream. Vessels from the previous area remain in the database; if you switch back, you will see them again. To receive data from multiple areas at the same time, use the "Area monitoring" panel in Settings.

**Can I monitor multiple areas at the same time?**
Yes. Open **⚙ Settings** → **Area monitoring** section and enable the toggle for each area you want to monitor. Each area collects data completely independently. You can then switch between areas using the dropdown to view their data.

**Are military vessels always red?**
Yes. Vessels identified as military are automatically marked with maximum score and a red row.
