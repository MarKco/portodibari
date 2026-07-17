<h1 align="center">🚢 Tracker Porti</h1>

<p align="center">
  <img src="public/icons/icon-512.png" alt="Tracker Porti" width="140">
</p>

<p align="center">
  <b>Real-time AIS vessel tracking, risk scoring and port analytics for one or more geographic areas.</b>
</p>

Tracker Porti connects to [AISStream.io](https://aisstream.io), collects the AIS messages that ships broadcast, analyses them, computes a **risk score** (potential weapons transport) for every vessel, and shows everything on interactive maps and tables. It enriches vessel data from external sources (VesselFinder, MarineTraffic, ShipFinder, MyShipTracking, Equasis, Global Fishing Watch), screens against **sanctions** lists (OFAC / EU / UK / UN) and **Port State Control** (Paris/Tokyo MoU), and can send notifications in-app, to Telegram, or to outbound webhooks.

Areas are added and removed at runtime — no restart, no code changes — so the app works for any port.

## ✨ Features

- **Multi-area monitoring** — each area has its own independent AIS stream.
- **Live map & tables** — present ships, past ships, and aggregate traffic statistics.
- **Follow ships anywhere** — a dedicated stream tracks chosen vessels worldwide, with ShipFinder/MyShipTracking as position backup when AIS goes dark.
- **Risk score (0–100)** — from AIS behaviour + external data; signal weights editable live.
- **Sanctions & PSC screening**, **Global Fishing Watch** behavioural events, **Equasis** ownership lookup.
- **Automatic berth detection**, **ship-to-ship rendezvous** detection, **historical replay**.
- **Notifications** — in-app, Telegram (with static maps), and outbound webhooks (Slack/Discord/SIEM).
- **Coverage heatmap**, **GeoJSON/KML export**, **installable PWA**, multi-user auth with roles and groups.

## 🚀 Quick start

**Requirements:** Node.js **≥ 22.5** (uses the built-in `node:sqlite` — no native DB deps).

```bash
git clone <repo-url> && cd tracker-porti
npm install
cp local.properties.example local.properties   # then set at least AIS_API_KEY
npm start                                        # → http://localhost:3000
```

Development with auto-reload: `npm run dev`. Lint / format: `npm run lint` / `npm run format`.

You need a free [AISStream.io](https://aisstream.io) API key in `local.properties` (`AIS_API_KEY`). See the technical docs below for all configuration keys and the recommendation to use **separate AISStream accounts** for the area / follow / heatmap streams.

## 📚 Documentation

| Document | For whom |
|---|---|
| **User manual** — [Markdown](docs/manuale/manuale.md) · [HTML](docs/manuale/index.html) · [PDF](docs/manuale/manuale.pdf) | End users (everyday use). Also served in-app at `/manuale/`. |
| **Admin manual** — [Markdown](docs/manuale_admin/manuale_admin.md) · [HTML](docs/manuale_admin/index.html) · [PDF](docs/manuale_admin/manuale_admin.pdf) | Administrators (users/groups, config files, risk model, logs). Served in-app at `/manuale_admin/` (admin only). |
| **Technical documentation** — [English](docs/technical/README.en.md) · [Italiano](docs/technical/README.it.md) | Developers: architecture, data model, configuration, every feature in depth. |

## 🧰 Stack

Node.js + Express backend · SQLite via built-in `node:sqlite` · vanilla HTML/CSS/JS frontend (ES modules, no build step) · `ws` for the AIS WebSocket.

## 📄 License

[GNU General Public License v3.0](LICENSE).
