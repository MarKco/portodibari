# 🚢 Tracker Porti — Documentazione tecnica

> 🇬🇧 English documentation: [README.en.md](README.en.md) · Panoramica del progetto: [README radice](../../README.md)

<p align="center">
  <img src="../../public/icons/icon-512.png" alt="Tracker Porti" width="160">
</p>

App per tracciare navi via [AISStream.io](https://aisstream.io). L'area di monitoraggio è configurabile con bounding box arbitrarie (vedi [Bounding box](#bounding-box)), quindi utilizzabile per qualsiasi porto — nessuna area è pre-configurata: si **aggiungono a runtime** dalla schermata **🗺 Aree** (senza riavviare l'app). È possibile monitorare **più aree contemporaneamente**: ogni area ha il proprio stream AIS indipendente.

## 🏗️ Architettura

```
Browser ←──polling 5min──→ Express (Node.js) ←──WebSocket──→ AISStream.io
                                 │         └──node-libcurl──→ MarineTraffic (Cloudflare)
                                 │         └──https───────────→ VesselFinder
                                 │         └──https (token)───→ Global Fishing Watch API
                             SQLite (ais_data.db)
```

Il browser **non** può connettersi direttamente ad AISStream (CORS policy). Il backend fa da proxy: mantiene la connessione WebSocket e salva i dati in SQLite. Il frontend fa polling HTTP ogni 5 minuti. Il backend arricchisce inoltre i dati nave con scraping da VesselFinder/MarineTraffic (vedi [Integrazione MarineTraffic / VesselFinder](#integrazione-marinetraffic--vesselfinder)).

## 🧰 Stack

| Componente       | Tecnologia                                                          |
| ------------------| ---------------------------------------------------------------------|
| Backend          | Node.js (v22+) + Express                                            |
| WebSocket client | `ws`                                                                |
| Database         | SQLite via `node:sqlite` (built-in Node.js, zero dipendenze native) |
| Export ZIP       | `archiver`                                                          |
| Frontend         | HTML + CSS + JS vanilla (ES modules)                               |

## 📁 Struttura del progetto

```
.
├── src/                      # Backend (Node.js / Express)
│   ├── server.js             # Entry point: avvio HTTP, scheduler partenze, stream
│   ├── app.js                # Factory dell'app Express (middleware + rotte)
│   ├── config.js             # Caricamento local.properties/env, preset bbox, costanti, stato runtime
│   ├── db.js                 # Data layer SQLite (schema, query, prepared statements)
│   ├── realtime.js           # Bus condivisi: client SSE log + coda alert
│   │                         #   (routes/ include anche notifications.js — feed notifiche)
│   ├── middleware/
│   │   └── api-logger.js      # Logging + broadcast di ogni chiamata /api
│   ├── services/
│   │   ├── ais-stream.js      # Gestione connessione WebSocket AISStream + riconnessione
│   │   ├── ship-analysis.js   # haversine, isInPort, computeDirection
│   │   ├── risk-score.js      # Score rischio trasporto armi (0–100) da firme AIS + dati VF/MT + sanzioni + PSC
│   │   ├── enrichment.js      # Arricchimento proattivo VF/MT alla prima rilevazione nave
│   │   ├── sanctions.js       # Liste sanzioni OFAC SDN + UE/UK/ONU (OpenSanctions): download, indice, match per IMO/nome/call sign
│   │   ├── psc.js             # Port State Control (Paris/Tokyo MoU): performance bandiera + navi bandite
│   │   ├── gfw.js             # Client API Global Fishing Watch: identità nave + eventi comportamentali (incontri, loitering, port visit, gap AIS)
│   │   ├── proximity.js       # Rilevamento rendezvous nave-nave (scansione periodica per area, firma di trasbordo ship-to-ship)
│   │   ├── webhooks.js        # Webhook in uscita per-utente (Slack/Discord/SIEM/custom; formati, firma HMAC, SSRF guard)
│   │   ├── group-sync.js      # Gruppi di utenti: unione + sincronizzazione write-through di aree/follow/flag/mute + preferenze condivise; log attività "presa in carico" (non mirrorata)
│   │   ├── equasis-log.js     # Log di audit append-only dei lookup Equasis (equasis.log)
│   │   ├── locode.js          # Lookup UN/LOCODE → nome porto + coordinate (carica data/locode.json e locode-coords.json a richiesta)
│   │   └── scrapers/
│   │       ├── http.js        # Helper HTTP/node-libcurl + parsing HTML
│   │       ├── vesselfinder.js
│   │       ├── marinetraffic.js
│   │       └── equasis.js     # Lookup proprietà/gestione per IMO (on-demand, login richiesto)
│   ├── routes/                # Router Express, uno per dominio (ships, readings, …)
│   └── lib/
│       └── csv.js             # Helper export CSV (flatten + escape)
├── public/                   # Frontend statico
│   ├── index.html
│   ├── css/style.css
│   └── js/                    # Moduli ES (caricati via <script type="module">)
│       ├── main.js            # Entry: status, settings, sidebar, polling, init
│       ├── views.js           # Switch tra le viste
│       ├── ships.js, maps.js, traffico.js, logs.js, health.js, areas.js
│       ├── replay.js          # Replay storico time-scrubber sulla mappa dell'area
│       ├── geoexport.js       # Export client-side GeoJSON/KML (navi, traccia, replay, banchine)
│       ├── webhooks.js        # Gestione webhook in uscita per-utente (Impostazioni → Integrazioni esterne)
│       ├── tiles.js            # Layer base OSM + overlay nautico OpenSeaMap (seamark)
│       ├── seamarks.js         # Marker OpenSeaMap (porti/ormeggi/luci…) via Overpass API
│       ├── notifications.js   # Feed notifiche personali + "Attività di gruppo" (badge + overlay condiviso)
│       ├── api.js, dom.js, store.js, toast.js, helpers.js
│       ├── theme.js           # Toggle tema chiaro/scuro + persistenza localStorage
├── bounding-boxes.json       # Preset aree di monitoraggio (personalizzabili)
├── data/                     # Dataset statici e backup locali
│   ├── backups/              # Auto-backup locali (creati a runtime, gitignored)
│   ├── ofac-sdn.csv          # Lista sanzioni OFAC SDN (cache su disco)
│   ├── eu-sanctions.csv      # Lista sanzioni UE consolidata (cache su disco)
│   ├── uk-sanctions.csv      # Lista sanzioni UK OFSI (cache su disco)
│   ├── un-sanctions.csv      # Lista sanzioni ONU navi designate (cache su disco)
│   ├── paris-mou-*.json/csv  # Liste Paris MoU (flag + banned)
│   ├── tokyo-mou-flags.json  # Liste Tokyo MoU
│   ├── locode.json           # Lookup compatto UN/LOCODE → nome porto (104 k voci, ~2.2 MB; generato da scripts/build-locode.js)
│   └── locode-coords.json    # Lookup UN/LOCODE → [lat, lon] (78 k voci, ~1.8 MB; coordinate del porto di destinazione, ~75% dei codici)
├── scripts/
│   ├── gen-icons.js          # Rigenera le icone PWA da public/icons/source.png (sips, macOS)
│   └── build-locode.js       # Genera data/locode.json + locode-coords.json dal pacchetto npm un-locode (una-tantum; `npm i --no-save un-locode`)
├── local.properties          # Config + API key (gitignored)
├── local.properties.example  # Template di configurazione
└── ais_data.db               # Database SQLite (creato al primo avvio, gitignored)
```

## ⚙️ Configurazione (`local.properties`)

La configurazione sta nel file `local.properties` nella root (formato `CHIAVE=valore`, righe con `//` o `#` ignorate). **Il file è in `.gitignore`** perché contiene la API key — non committarlo. Parti da `local.properties.example` (`cp local.properties.example local.properties`). Le chiavi possono anche essere passate come variabili d'ambiente.

| Chiave | Descrizione | Default |
|---|---|---|
| `AIS_API_KEY` | API key di [AISStream.io](https://aisstream.io) (obbligatoria) — usata dagli stream delle **aree di monitoraggio** | — |
| `FOLLOW_AIS_API_KEY` | API key di un **account AISStream separato** per lo stream delle **navi seguite** (`services/ship-follow.js`). Vuota = riusa `AIS_API_KEY`. Consigliata da un account dedicato: il limite di connessioni di AISStream è **per-account**, quindi condividere la chiave con gli stream delle aree fa rifiutare l'handshake del follow con un **429 in loop** (vedi nota sotto). | *(riusa `AIS_API_KEY`)* |
| `BBOX_PRESET` | Chiave dell'area attiva all'avvio, tra quelle definite in `bounding-boxes.json`/catalogo DB | *(vuoto — nessuna area finché non ne aggiungi una)* |
| `IMPORT_VF_DATA` | Abilita scraping VesselFinder (`true`/`false`) | `false` |
| `IMPORT_MT_DATA` | Abilita scraping MarineTraffic (`true`/`false`) | `false` |
| `IMPORT_SF_DATA` | Abilita scraping ShipFinder — dati statici + posizione ultimo avvistamento per ri-localizzare le navi seguite perse (`true`/`false`) | `false` |
| `IMPORT_MST_DATA` | Abilita scraping MyShipTracking — seconda fonte di posizione di backup, stesso ruolo di ShipFinder (`true`/`false`) | `false` |
| `IMPORT_SANCTIONS` | Abilita screening lista sanzioni OFAC SDN (`true`/`false`) | `false` |
| `IMPORT_SANCTIONS_EXTRA` | Abilita liste sanzioni aggiuntive UE/UK OFSI/ONU oltre a OFAC (`true`/`false`) | `true` |
| `IMPORT_PSC` | Abilita screening Port State Control Paris/Tokyo MoU: performance bandiera + navi bandite (`true`/`false`) | `false` |
| `IMPORT_EQUASIS` | Abilita il lookup Equasis on-demand (proprietà/gestione) nel dettaglio nave (`true`/`false`) | `false` |
| `EQUASIS_USER` | Email account Equasis (registrazione gratuita su [equasis.org](https://www.equasis.org/)) — richiesta dal lookup Equasis | *(vuota)* |
| `EQUASIS_PASSWORD` | Password account Equasis — richiesta dal lookup Equasis | *(vuota)* |
| `IMPORT_GFW` | Abilita l'arricchimento Global Fishing Watch (identità + eventi comportamentali ricavati dall'AIS) (`true`/`false`) | `true` |
| `GLOBAL_FISHING_WATCH_TOKEN` | Token API (Bearer) di Global Fishing Watch, generato dal [portale API GFW](https://globalfishingwatch.org/our-apis/) — richiesto dall'arricchimento GFW. Dati GFW free **solo per uso non commerciale** (ricerca/ONG/interesse pubblico); l'uso commerciale richiede una licenza dedicata. Senza token la feature è disattivata silenziosamente | *(vuoto)* |
| `TELEGRAM_BOT_TOKEN` | Token del bot Telegram (da [@BotFather](https://t.me/BotFather)) per le notifiche su Telegram. Un solo bot serve tutti gli utenti; ognuno collega la propria chat dalle Impostazioni → tab **Integrazioni esterne**. Vuoto = bot disattivato. **Segreto, non committare.** Nessun URL pubblico/webhook: l'app fa long-polling | *(vuoto)* |
| `ADMIN_USERNAME` | Username dell'amministratore predefinito, ri-seedato all'avvio se assente (vedi [Autenticazione](#-autenticazione-multi-utente)) | `admin` |
| `ADMIN_EMAIL` | Email dell'amministratore predefinito | `admin@local` |
| `ADMIN_PASSWORD` | Password dell'amministratore predefinito. Se vuota usa il valore di default incluso nell'app | *(default incluso)* |
| `COOKIE_SECURE` | Forza sempre il flag `Secure` sul cookie di sessione. **Di norma non serve**: il flag è applicato **automaticamente** quando la richiesta arriva in HTTPS (`X-Forwarded-Proto`). Impostare a `true` solo se il proxy termina il TLS ma **non** inoltra `X-Forwarded-Proto`. Lasciare `false` per deploy in chiaro/locali, altrimenti il browser scarta il cookie e il login non funziona (`true`/`false`) | `false` |
| `SESSION_TTL_DAYS` | Durata in giorni della sessione di login | `30` |
| `HEATMAP_AIS_API_KEY` | API key di un **account AISStream separato** per la Mappa delle zone coperte (vedi [sezione dedicata](#-mappa-delle-zone-coperte-copertura-aisstream)). Vuota = funzione disattivata. Valore nudo, niente commenti inline. | *(vuota)* |

> ⚠️ **Consigliato: tre chiavi da tre account AISStream separati.** Il limite di connessioni di AISStream è **per-account, non per-chiave**. L'app apre tre tipi di stream WebSocket indipendenti — **monitoraggio aree** (`AIS_API_KEY`), **navi seguite** (`FOLLOW_AIS_API_KEY`) e **mappa di copertura** (`HEATMAP_AIS_API_KEY`) — e se due di questi usano chiavi dello **stesso account** competono per lo stesso slot di connessione: il secondo handshake viene rifiutato (429 in loop / chiusura `1006` senza frame di errore). Per far convivere le tre funzioni assegna a ciascuna una chiave di un **account AISStream distinto**. Lasciare vuota `FOLLOW_AIS_API_KEY` o `HEATMAP_AIS_API_KEY` mantiene la rispettiva funzione su `AIS_API_KEY` (follow) o disattivata (heatmap).

`BBOX_PRESET`, `IMPORT_VF_DATA` e `IMPORT_MT_DATA` sono modificabili anche dalla UI (cambio area / modal Impostazioni) e vengono ri-persistiti nel file. `PORT` (variabile d'ambiente) imposta la porta HTTP (default 3000). Le chiavi `ADMIN_*`, `COOKIE_SECURE` e `SESSION_TTL_DAYS` si leggono solo all'avvio (non modificabili dalla UI).

Esempio `local.properties`:

```properties
AIS_API_KEY=la_tua_api_key
IMPORT_VF_DATA=true
IMPORT_MT_DATA=true
```

## 🗺️ Bounding box

L'area di monitoraggio è selezionabile a runtime dal menu a tendina nell'interfaccia. I preset sono definiti nel file **`bounding-boxes.json`** (radice del progetto) e sono modificabili **senza toccare il codice**.

Ogni preset ha questa forma:

```json
"bari": { "name": "Porto di Bari", "keyword": "BARI", "sw": [40.95, 16.60], "ne": [41.30, 17.10] }
```

| Campo | Significato |
|---|---|
| chiave (`bari`) | Identificatore del preset, usato da `BBOX_PRESET` in `local.properties` |
| `name` | Etichetta mostrata nell'interfaccia |
| `keyword` | (Facoltativa, può essere `null`) filtra le navi nella sezione "Navi attese" per destinazione |
| `sw` | Angolo Sud-Ovest `[lat, lon]` |
| `ne` | Angolo Nord-Est `[lat, lon]` |

Il file **non ha preset di default**: a una prima installazione `bounding-boxes.json` è vuoto (solo `_comment`) e la schermata Aree parte senza aree — aggiungile da lì o a mano nel file prima del primo avvio.

Ci sono **due modi** per gestire le aree:

1. **Schermata 🗺 Aree (a runtime, senza riavvio)** — il bottone **🗺 Aree** nella sidebar apre una pagina con l'elenco delle aree (con coordinate, stato e quantità di dati salvati), una mappa che le visualizza tutte, e un pannello per aggiungerne di nuove:
   - **per coordinate GPS** in gradi decimali (campi SW lat/lon e NE lat/lon), oppure
   - **da mappa**: inquadra (zoom/pan) l'area da monitorare e premi **🎯 Cattura vista corrente** per riempire automaticamente le coordinate dal riquadro visibile.
   - Assegna un **nome** (obbligatorio) e una **parola chiave** facoltativa. La nuova area viene salvata in `bounding-boxes.json` e il suo stream parte subito.
   - **Modifica**: un click su una riga della tabella carica quell'area nello stesso pannello (che diventa "Modifica area"), la inquadra sulla mappa e ne mostra il box come rettangolo tratteggiato; si possono cambiare nome, parola chiave e coordinate e salvare con **💾 Salva modifiche** (`PATCH /api/areas/:key` → `config.updateArea`). La **chiave dell'area non cambia mai**: è la foreign key di tutte le righe già raccolte, quindi lo storico resta agganciato anche se il box si sposta (le letture fuori dai nuovi confini **non** vengono eliminate). Se il box cambia e lo stream è attivo, `startStream` su un'area già attiva rispedisce la subscription condivisa aggiornata. Anche le aree **condivise** sono modificabili: la modifica vale per tutti quelli che monitorano quell'area (catalogo globale), quindi il client chiede una **doppia conferma** (`areas.editSharedConfirm1/2`, mostrata quando `sharedWith > 0` nella risposta di `GET /api/areas`) e il server notifica ogni altro proprietario con una notifica di attività di gruppo `group_area_edit` (`groupSync.notifyAreaEdit`, vedi [Gruppi di utenti](#-gruppi-di-utenti)).
   - **Eliminazione**: il cestino 🗑 rimuove l'area **e tutto lo storico dei monitoraggi correlati** (letture, navi, eventi porto, notifiche, ormeggi, banchine, storico rischio e cache di scraping). La cancellazione è **ritardata di 10 secondi** con un toast **↶ Annulla**: diventa effettiva allo scadere del timer o quando si lascia la pagina; premendo Annulla non viene eliminato nulla. Deve restare **almeno un'area** (l'ultima non è eliminabile). L'eliminazione è effettiva **solo se sei l'ultimo proprietario** dell'area (le aree condivise sopravvivono finché un altro utente le monitora).

     > **Righe orfane e pulizia.** Lo schema non usa `ON DELETE CASCADE`: `deleteAll(area)` in `src/db.js` esegue le cancellazioni a mano. Poiché una nave conserva in `last_area` solo l'ultima area in cui è stata vista, una nave che si è spostata tra aree poteva lasciare righe "orfane" agganciate al suo `mmsi` in altre aree (e la `ship_scrape_cache`, priva di tag area, non veniva mai toccata). `deleteAll` ora purga anche per `mmsi` e azzera i riferimenti `from_area` pendenti. A difesa di residui da versioni precedenti, edit manuali o scritture interrotte, un job idempotente — `db.pruneOrphans()`, schedulato in `src/server.js` all'avvio e poi ogni 24h — ripulisce qualunque riga il cui genitore (area o nave) non esiste più, registrando il totale rimosso nel log applicativo (`db.orphans_pruned`).
2. **File `bounding-boxes.json` (manuale)** — aggiungere/modificare una voce a mano e **riavviare** l'app. Utile per il provisioning iniziale o gli script.

> La schermata Aree riscrive `bounding-boxes.json` (preserva la chiave `_comment` ma normalizza la formattazione). Le chiavi dei preset vengono derivate automaticamente dal nome.

Il bottone **🏠 Monitoraggi** nella sidebar riporta alla home (vista navi presenti/passate/traffico).

Il cambio di area nel menu a tendina in fondo alla sidebar è un **cambio di vista**: mostra i dati dell'area selezionata ma non avvia né ferma alcuno stream. Ogni area ha il proprio stream indipendente — per avviare o fermare lo stream di un'area usa i pulsanti nella sidebar oppure il pannello **"Monitoraggio aree"** nelle Impostazioni. La selezione dell'area viene persistita in `local.properties` (chiave `BBOX_PRESET`). La *keyword* serve alla sezione "Navi attese" per filtrare le navi con destinazione corrispondente.

## 📻 Tipi di messaggio AIS ricevuti

- `PositionReport` — posizione, velocità (SOG), rotta (COG), prua, stato navigazionale
- `ShipStaticData` — nome, callsign, IMO, dimensioni, destinazione, pescaggio
- `ExtendedClassBPositionReport` — classe B con dati estesi
- `StandardClassBPositionReport` — classe B standard

## 🗃️ Dati conservati

Max 10.000 record per tipo di messaggio. Rotazione automatica (cancella i più vecchi) ogni 500 inserimenti per tipo. Le notifiche (tabella `notifications`) conservano gli ultimi 100 record **per feed** (personale e "Attività del gruppo" ruotano indipendentemente), con rotazione automatica a ogni inserimento.

**Compattezza su disco.** Il payload AIS grezzo (`raw_json`) viene conservato **solo** per i tipi che hanno campi extra non mappati su colonne (`ShipStaticData`, `ExtendedClassBPositionReport`); per i position report — la maggior parte delle righe — è vuoto, perché non aggiunge nulla alle colonne già estratte. Lo usa solo l'export CSV (e il modal "dati grezzi" di una lettura, che per i position report mostra `{}`). Il database è in modalità WAL con `auto_vacuum = INCREMENTAL`: una manutenzione periodica (`runMaintenance` in `src/db.js`, ogni 5 minuti) esegue `wal_checkpoint(TRUNCATE)` — necessario perché i lettori a lunga durata (stream AIS / SSE) impediscono al checkpoint passivo di troncare il WAL — e `incremental_vacuum` per restituire al sistema operativo le pagine liberate dalle rotazioni. Al primo avvio dopo l'aggiornamento gira una `VACUUM` una-tantum che converte il file ad `auto_vacuum` incrementale e azzera i `raw_json` dei position report già presenti.

## 🎛️ Parametri configurabili

| Parametro                       | File                              | Dove                                  | Default        |
| ---------------------------------| ----------------------------------| --------------------------------------| ---------------|
| Intervallo polling UI           | `public/js/store.js`              | `POLL_INTERVAL = 300000`              | 300000 ms (5m) |
| Finestra "navi presenti"        | `src/db.js`                       | `ACTIVE_WINDOW = '-6 hours'`          | 6 ore          |
| Finestra retention "in porto"   | `src/db.js`                       | `PORT_WINDOW = '-24 hours'`           | 24 ore         |
| Soglia velocità "ferma"         | `src/config.js` (+ `src/db.js`)   | `SOG_FERMA = 0.5`                     | 0.5 kn         |
| Raggio "stessa sosta" (in porto)| `src/config.js`                   | `STILL_RADIUS_M = 100`                | 100 m          |
| Raggio merge traccia (de-noise) | `public/js/store.js`              | `TRACK_MERGE_RADIUS_M = 100`          | 100 m          |
| Replay: max posizioni per query | `app.config.properties`           | `REPLAY_MAX_POINTS`                   | 40.000         |
| Replay: buco max (oltre → tieni ultima pos.) | `app.config.properties`  | `REPLAY_MAX_GAP_MIN`                  | 30 min         |
| Replay: lunghezza scia          | `app.config.properties`           | `REPLAY_TAIL_MIN`                     | 20 min         |
| Ritardo riconnessione WebSocket | `src/services/ais-stream.js`      | `setTimeout(startStream, 5000)`       | 5000 ms        |
| Rilevamento disservizio AIS     | `app.config.properties`           | `AIS_OUTAGE_CHECK`                    | `true`         |
| Minuti di silenzio prima del check disservizio | `app.config.properties` | `AIS_OUTAGE_SILENCE_MIN`            | 10 min         |
| URL monitor self-hosted (ibrido, prioritario) | `app.config.properties` | `AIS_UPTIME_SELFHOST_URL`            | _(vuoto)_      |
| URL monitor uptime AISStream pubblico (ripiego) | `app.config.properties` | `AIS_UPTIME_URL`                    | `https://aisuptime.buttermilkgreen.fyi` |
| Max record per tipo messaggio   | `src/db.js`                       | `pruneStmt.run(..., 10000)`           | 10.000         |
| Max punti track mappa           | `src/routes/ships.js` (`/track`)  | `Math.min(..., 2000)` e default `500` | 500 punti      |
| TTL cache scraping VF/MT        | `src/config.js`                   | `SCRAPE_CACHE_TTL`                    | 6 ore          |
| Timeout recupero posizione (cerca/ri-segui nave) | `app.config.properties`  | `SEARCH_LOOKUP_TIMEOUT_SEC`  | 90 s           |
| Freschezza posizione follow (oltre la soglia → ri-acquisizione worldwide) | `app.config.properties` | `FOLLOW_FRESH_MIN`   | 60 min         |
| Auto-stop follow silente → "passate" (esce dal net worldwide) | `app.config.properties` | `FOLLOW_STALE_HOURS`  | 4320 h (~6 mesi) |
| Throttle scrape ShipFinder per nave (sweep ri-localizzazione follow) | `app.config.properties` | `SF_REACQUIRE_THROTTLE_MIN` | 30 min |
| Tetto navi scrapate da ShipFinder per singola passata | `app.config.properties` | `SF_REACQUIRE_MAX_PER_SWEEP` | 20 |
| Negative cache scraping VF/MT   | `app.config.properties`           | `SCRAPE_NEG_CACHE_DAYS`               | 3 giorni       |
| Bounce annullamento eliminazione notifiche | `app.config.properties` | `NOTIF_DELETE_UNDO_SECONDS`           | 5 s            |
| Raggio clustering banchine      | `app.config.properties`           | `BERTH_CLUSTER_EPS_M`                 | 80 m           |
| Attracchi minimi per banchina   | `app.config.properties`           | `BERTH_MIN_PTS`                       | 3              |
| Attracchi minimi caratterizzazione | `app.config.properties`        | `BERTH_MIN_MOORINGS`                  | 10             |
| Soglia % categoria dominante    | `app.config.properties`           | `BERTH_DOMINANT_PCT`                  | 60 %           |
| Intervallo ricalcolo banchine   | `app.config.properties`           | `BERTH_RECOMPUTE_MIN`                 | 30 min         |
| Intervallo scansione rendezvous | `app.config.properties`           | `PROXIMITY_SCAN_MIN` (0 = off)        | 10 min         |
| Distanza coppia rendezvous      | `app.config.properties`           | `PROXIMITY_DIST_M`                    | 500 m          |
| Esclusione rendezvous in porto  | `app.config.properties`           | `PROXIMITY_BERTH_M`                   | 600 m          |
| Permanenza min. rendezvous      | `app.config.properties`           | `PROXIMITY_MIN_MINUTES`               | 10 min         |
| Sosta minima in area (ricerca transiti + cambio area) | `app.config.properties`  | `TRANSIT_STOP_MIN_H`                  | 3 ore          |
| Velocità sotto cui la nave è "ferma" nella visita | `app.config.properties` | `TRANSIT_STOP_MAX_SOG_KN`         | 0.5 kn         |
| Velocità media minima di una traversata diretta | `app.config.properties`  | `TRANSIT_MIN_KN`                      | 4 kn           |
| Pavimento del limite temporale fra due aree | `app.config.properties`     | `TRANSIT_MIN_SLACK_H`                 | 12 ore         |
| Tetto del limite temporale fra due aree | `app.config.properties`         | `TRANSIT_MAX_GAP_DAYS`                | 30 giorni      |
| Max navi per ricerca transiti   | `app.config.properties`           | `TRANSIT_MAX_ROWS`                    | 500            |
| Cambio area solo su scalo reale | `app.config.properties`           | `AREA_CHANGE_REQUIRE_STOP`            | `true`         |
| Cambio area solo se lo scalo è recente | `app.config.properties`    | `AREA_CHANGE_REQUIRE_PLAUSIBLE_TIME`  | `true`         |
| Cambio area: salta le aree sovrapposte | `app.config.properties`    | `AREA_CHANGE_SKIP_OVERLAPPING`        | `true`         |
| Auto-ripristino DB dopo deploy  | `app.config.properties`           | `AUTO_RESTORE_ON_DEPLOY`              | `true`         |
| Intervallo auto-backup su disco | `app.config.properties`           | `BACKUP_INTERVAL_MIN`                 | 120 min (2h)   |
| Max byte body request/response nel log | `app.config.properties`    | `MAX_BODY_BYTES`                      | 2048           |
| Max record log API              | `app.config.properties`           | `MAX_API_LOG_RECORDS`                 | 1.000          |
| Griglia copertura (lato cella in gradi) | `app.config.properties`   | `HEATMAP_GRID_DEG`                    | 0.25° (≈28 km) |
| Intervallo flush celle copertura su DB | `app.config.properties`    | `HEATMAP_FLUSH_SEC`                   | 10 s           |
| Intervallo statistiche live copertura | `app.config.properties`     | `HEATMAP_STATS_SEC`                   | 2 s            |
| Intervallo compattazione DB (WAL + vacuum) | `src/server.js`        | `setInterval(db.runMaintenance, …)`   | 5 min          |
| Intervallo pulizia righe orfane | `src/server.js`                   | `setInterval(sweepOrphans, …)`        | 24h (+ avvio)  |

### Applicare le modifiche

Nessuna build necessaria. Node.js interpreta i file direttamente.

| File modificato | Azione richiesta |
|---|---|
| Qualsiasi file in `src/` | Riavvio server: `npm start` (o `npm run dev` per il watch) |
| `public/**` (HTML, CSS, moduli JS) | Reload browser (`Cmd+R`) — nessun riavvio |
| `app.config.properties` | Riavvio server (i valori sono letti una sola volta all'avvio) |

> I parametri di `app.config.properties` sono modificabili anche dall'interfaccia: **⚙ Impostazioni → Parametri**. Il form è costruito dal file stesso (le sezioni diventano gruppi, i commenti diventano descrizioni); il salvataggio riscrive il file preservando i commenti. **Richiede comunque il riavvio del server** per avere effetto — l'interfaccia lo segnala. I segreti (`local.properties`) non sono esposti nel form.

## 🖥️ Modello concettuale UI

L'interfaccia è organizzata per **nave** (MMSI), non per singola lettura:

| Vista              | Contenuto                                                                          |
| --------------------| -----------------------------------------------------------------------------------|
| **Navi presenti**  | Navi viste negli ultimi **6 ore**, **oppure** navi "in porto" viste nelle ultime **24 ore**. Toolbar con **ricerca** (nome/MMSI/IMO/destinazione) e **filtri** (fascia di rischio, solo in porto, solo segnalate) + **export CSV della vista filtrata** (vedi [Ricerca, filtri ed export](#-ricerca-filtri-ed-export-liste)) |
| **Navi passate**   | Navi che non rientrano nel criterio "presenti" (complemento). Stessa toolbar di ricerca/filtri/export (senza il filtro "in porto") |
| **Dettaglio nave** | Organizzato in **tab**: **Generale** (info statiche nave — tipo, IMO, callsign, dimensioni, destinazione… — + **tabella dati aggregati** con i campi principali riconciliati tra tutte le fonti abilitate, vedi sotto + **andamento dello [score di rischio nel tempo](#-storico-dello-score-di-rischio)** + note + storico visite nelle aree monitorate), **Letture** (mappa track con soste collassate e replay, **fissa in alto mentre la tabella sotto scorre** — vedi sotto — + tabella paginata delle letture AIS grezze, con colonna **Fonte** che distingue AISStream da fix di backup ShipFinder/MyShipTracking) più **un tab per fonte esterna abilitata** (VesselFinder, MarineTraffic, ShipFinder, MyShipTracking, Equasis, Global Fishing Watch — il tab di una fonte disattivata non compare). La **destinazione è cliccabile** (vedi sotto). Bottone **📄 Report** per generare un [report stampabile/PDF](#-report-pdf-della-nave) |

**Tab Letture** — cliccare una riga della tabella (con posizione nota) sposta il marker della nave nel replay soprastante esattamente su quel punto (`seekTrackTo` in `public/js/maps.js`): salto diretto alle coordinate grezze della lettura, non un'interpolazione lungo il percorso animato — funziona anche per fix ShipFinder/MyShipTracking non inclusi nel percorso disegnato (toggle "Includi SF/MST" spento). Non tocca lo slider/la progressione dell'animazione (dati privati alla chiusura `setupTrackAnim`): premere ▶ dopo un seek riprende da dove l'animazione era rimasta. L'icona 📄 su ogni riga apre il dettaglio JSON grezzo, disaccoppiata dal click sulla riga (che esegue il seek). La mappa (`#detail-map`) sta in `position: sticky` **dentro il proprio box di scroll** (`#detail-panel-readings { max-height: calc(100vh - 240px); overflow-y: auto }`), non nello scroll di pagina: `#app` ha `overflow:auto` ma — poiché `body`/`#layout` usano `min-height:100vh` e non un'altezza fissa — il contenuto di `#app` non eccede mai il proprio box, quindi `#app` non scrolla mai davvero e la pagina scrolla a livello documento; CSS considera comunque `#app` come "ancestor di scroll" più vicino per lo sticky (basta `overflow:auto`, anche se inerte), quindi uno sticky "nudo" seguirebbe la pagina invece di restare fisso — da qui il box di scroll dedicato.
| **Traffico**       | Statistiche aggregate: card riepilogo, grafico arrivi per ora del giorno, arrivi per tipo nave; **distribuzione score rischio** (tile verde/giallo/rosso sulle navi degli ultimi 7 giorni), **principali fattori di rischio** (frequenza), **arrivi giornalieri** (ultimi 30 giorni), **navi con score più alto** (top 8 cliccabili); navi attese (per keyword preset), ultimi eventi porto |
| **Aree**           | Gestione aree a runtime: elenco con coordinate/stato/dati salvati, mappa con tutte le aree, pannello per aggiungere (coordinate GPS o cattura vista mappa), **modificare** (click sulla riga → area caricata nel pannello e inquadrata sulla mappa) ed eliminare aree (con storico correlato e annullamento entro 10s) |

Modali accessori: **Impostazioni**, organizzate in tab: **Generali** (toggle import VF/MT/sanzioni/PSC/Equasis e notifiche, toggle **livello nautico OpenSeaMap** e **marcatori OpenSeaMap** con selezione delle categorie), **Aree** (toggle start/stop stream per ogni area), **Integrazioni esterne** (collegamento del bot Telegram + toggle per categoria + webhook in uscita), **Parametri** (editor `app.config.properties`), **Backup/Ripristino** (auto-backup, esporta CSV, backup/ripristino database), **Log attività** (event log operativo live via SSE), **Log API** (pannello live delle richieste API via SSE) e **Diagnostica AIS** (uptime, msg/min, riconnessioni, ultimo errore). Bottoni di navigazione sidebar: **🏠 Monitoraggi** (home) e **🗺 Aree**. La sidebar include anche il **🔔 feed notifiche** (lista con badge non-lette, vedi [Eventi porto, statistiche e alert](#-eventi-porto-statistiche-e-alert)).

Una nave "entra" nella lista presenti appena riceve la prima lettura. La finestra è ampia (6 ore) perché le navi in sosta trasmettono di rado: una nave ormeggiata può aggiornare la posizione anche solo ogni 3 ore (standard AIS classe A). Le navi **in porto** (vedi sotto) hanno una retention ancora più larga (24 ore), così restano visibili anche dopo un riavvio del server prima della successiva trasmissione.

Il flag "visto" (★/☆) è disponibile in tutte e tre le viste: colonna nella tabella presenti, colonna nella tabella passate (★ sposta la nave in fondo alla lista), e bottone nell'header del dettaglio nave.

### 🧭 Destinazione cliccabile

Ovunque compaia una **destinazione** — la info bar del dettaglio nave **e i pannelli scraped ShipFinder / MyShipTracking** — il valore è **cliccabile** e apre un piccolo popover con la spiegazione estesa del nominativo dichiarato via AIS:

- **Codice** UN/LOCODE normalizzato (es. `ITGOA`), **Porto** (nome esteso risolto da [`locode.js`](../../src/services/locode.js)) e **Paese** (ricavato client-side dal prefisso di 2 lettere via `Intl.DisplayNames`, localizzato).
- Quando disponibili, le **Coordinate** del porto e un pulsante **🗺 Apri su OpenStreetMap** che centra la mappa sul punto esatto (marker `?mlat=&mlon=`). Le coordinate vengono da `data/locode-coords.json` (dataset UN/LOCODE, ~75% dei codici).
- Per i codici LOCODE **senza coordinate** (il restante ~25%) il pulsante ricade su una **ricerca per nome** su OpenStreetMap (`/search?query=Porto, Paese`).
- Per destinazioni in **testo libero** non-LOCODE (es. `FOR ORDERS`, `PILOT`, o un semplice nome di porto) il popover mostra il testo grezzo con una nota e **nessun pulsante** mappa.

**Risoluzione di nome/coordinate** (client, all'apertura del popover): se la destinazione coincide con quella **già mappata** della nave aperta (stesso valore del campo AIS, confronto normalizzato), si **riusano** `destination_label`/`destination_coords` già presenti — nessuna richiesta, stesso link OSM. Altrimenti si interroga `GET /api/locode/resolve?q=<dest>` (risultati in cache client-side). Così i pannelli SF/MST aprono lo **stesso** punto OSM del dettaglio quando la destinazione è la stessa. Il link OSM apre in una nuova scheda (navigazione, non una richiesta di rete): nessuna chiamata esterna e nessuna modifica alla CSP.

## ☢️ Evidenziazione tipo nave (Hazmat)

**Limite AIS**: il campo `ship_type` AIS (ITU-R M.1371) distingue solo la classe larga — `70–79` = Cargo, `80–89` = Tanker, ecc. **Non** separa i sottotipi General Cargo / Container / Ro-Ro / Heavy-Lift: tutti ricadono in `70–79`. Il sottotipo preciso (es. "Ro-Ro", "Container Ship") è disponibile solo dai dati MarineTraffic scaricati per la singola nave (campo `typeSpecific`, vedi sotto).

I sottotipi **Hazmat** (`71–74` / `81–84`, merci pericolose IMO — la Classe 1 sono esplosivi/munizioni) ricevono un badge ☢ sul tipo. Helper `isHazmat(code)` in `public/js/helpers.js`.

> La rilevanza "cargo/tanker per trasporto armi" non è più un'evidenziazione a sé: è confluita nel **tipo scafo** come fattore dello [score di rischio](#score-di-rischio-potenziale-trasporto-armi) (cargo/tanker +5, hazmat +8, militare → score 100 automatico). La vecchia funzione `isWeaponRelevant` è stata rimossa: era un sottoinsieme (solo `70–79`) già coperto dal modello di rischio.

## 🛡️ Score di rischio (potenziale trasporto armi)

A ogni nave è associato uno **score di rischio 0–100** che stima la probabilità che la nave stia trasportando armi/munizioni, ricavato **esclusivamente dai dati AIS**. È mostrato come badge colorato nelle liste (colonna **Rischio**) e nel dettaglio nave (valore + scomposizione dei fattori).

| Fascia | Colore | Significato |
|---|---|---|
| **0–30** | 🟢 verde (`risk-low`) | Navigazione regolare: pescaggio coerente, rotte commerciali standard |
| **31–70** | 🟡 giallo (`risk-med`) | Anomalie minori (es. blackout AIS breve, cambio rotta): monitoraggio di routine |
| **71–100** | 🔴 rosso (`risk-high`) | Combinazione di fattori critici → segnalazione per ispezione |

### Limite di fondo

I messaggi AIS **non descrivono il contenuto della stiva**: trasmettono solo cinematica (posizione, rotta, SOG) e dati statici/di viaggio auto-dichiarati (nome, destinazione, pescaggio). Lo score non può quindi "vedere" le armi — traduce in indicatori di rischio le **firme comportamentali** (anomalie) ricavabili dallo storico delle letture ed eventi di ciascuna nave, secondo un modello a **somma pesata** con un **moltiplicatore geopolitico** finale.

### Modello di calcolo

Implementato server-side in [`src/services/risk-score.js`](../../src/services/risk-score.js) — `computeRiskScore(ship, lang)`. Per ogni nave interroga (sola lettura) lo storico via `db.getShipPositions` (posizioni ultime 168h), `db.getShipEvents` (eventi porto), `db.getDistinctShipNames`. Se l'import VF/MT è abilitato, legge anche i dati di registro **già in cache** via `db.getScrapedData` (vedi [Arricchimento dello score](#arricchimento-dello-score-da-vfmt)) — sola lettura, nessuno scraping live durante il calcolo.

Ogni firma rilevata aggiunge punti pesati a un **subtotale anomalie**:

| Firma comportamentale | Logica di rilevamento | Peso max |
|---|---|---|
| **Blackout AIS (dark activity)** | Gap più lungo tra letture consecutive **iniziato mentre la nave era in moto** (SOG ≥ `SOG_FERMA`). Le navi in porto trasmettono di rado → contano solo i silenzi in navigazione. ≥ 6h → max; 2–6h → parziale | 25 |
| **Spoofing / cinematica anomala** | Velocità implicita tra due posizioni consecutive (distanza haversine / Δt, con Δt ≤ 1h, distanza > 500 m). > 80 kn = salto fisicamente impossibile; > 50 kn = anomalo | 20 |
| **Aumento pescaggio (carico)** | Massimo incremento positivo del `draught` dichiarato tra eventi porto consecutivi. AISStream decodifica già il pescaggio, quindi il valore è memorizzato e confrontato in **metri** (soglia `DRAUGHT_MIN_DELTA` 0.5 m, `DRAUGHT_FACTOR` 12 pt/m). Indica materiale pesante imbarcato | 20 |
| **Loitering / sosta anomala** | Posizioni ferme (SOG < `SOG_FERMA`), **non** ormeggiate/all'ancora (stato ≠ 1/5), a > 10 km dal centro **dell'area in cui cade la posizione** → possibile trasbordo ship-to-ship in mare aperto. La distanza è calcolata rispetto al centro dell'area di appartenenza (via `areaForPoint`), **non** rispetto al singolo bbox attivo: l'app è multi-area e segue navi worldwide, quindi le posizioni fuori da ogni area monitorata sono ignorate (non c'è contesto di porto per definirle "al largo"). Il **peso massimo** richiede sia abbastanza posizioni ferme al largo (`RISK_LOITERING_MIN_POSITIONS`) **sia** che coprano un intervallo di tempo reale (`RISK_LOITERING_MIN_SPAN_MIN`, default 20 min): così una raffica di letture AIS ad alta frequenza (3 posizioni in 30 s) non fa scattare il massimo, ma degrada al parziale | 15 |
| **Rendezvous nave-nave** | Rilevamento **locale** (dal nostro feed AIS, vedi [sezione dedicata](#-rilevamento-rendezvous-nave-nave)): un rendezvous confermato — due navi distinte vicine, lente e al largo per ≥ `PROXIMITY_MIN_MINUTES` — aggiunge punti a **entrambe** le navi per i rendezvous nella finestra recente (`RISK_PROXIMITY_WINDOW_DAYS`, default 7 gg). Firma di trasbordo, indipendente da GFW. Conta le navi-partner distinte; 0 disattiva il fattore | 18 |
| **Instabilità destinazione** | Numero di destinazioni dichiarate distinte (campo corrente + eventi). Più cambi = più punti. Ogni destinazione è prima **canonicalizzata** (`destinationLabel`, che risolve forme UN/LOCODE e porti noti) così varianti dello stesso porto ("ITGOA"/"IT GOA"/"GENOVA"/"GENOA") contano come **una sola**, non come cambi distinti | 10 |
| **Tipo scafo / classe carico** | Militare (35) → **score 100 automatico** (early return, nessuna analisi). Per le altre navi il vecchio modello flat Hazmat→8 / Cargo→5 è stato sostituito da un **peso per classe di carico** (`cargoTypeForShip` + `state.cargoWeights`, editabili dalle Impostazioni): la classe è derivata dal subtype granulare VesselFinder/MarineTraffic quando in cache, con fallback al codice scafo AIS. Default: crude/chemical/gas → 12, oil_products → 10, tanker_other → 8, dry_bulk → 6, general_cargo/reefer/cargo_other → 5, container/vehicles/roro/livestock → 4, non_cargo/unknown → 0. Con "escludi tanker" attivo le classi tanker contribuiscono 0. | 100 / 0–12 |
| **Rilevamento militare** | `isMilitary(ship)` in `risk-score.js`: **flag DB** `is_military = 1` **oppure** `ship_type === 35` **oppure** un **prefisso militare come PRIMA parola** del nome nave (`HMS`, `USS`, `FS`, `FGS`, `HNLMS`, `HMAS`, `HMCS`, `INS`, `BNS`, `HDMS`, `HTMS`, `TCG`, `ORP`, `ITS`, `ROKS`, `NRP`, `RFS`, `ESPS`, `SPS`) **oppure** la keyword `WARSHIP`/`NATO` come parola intera. Il match è per prima-parola/word-boundary, **non** per sottostringa: così "SPIRITS OF THE SEA" o "DOLPHINS ONE" non vengono più erroneamente classificate militari (prima davano score 100). Le navi identificate: ricevono `is_military: true` e `flagged: true` forzato nella risposta API, riga in rosso con classe `.military-row` (priorità su `.flagged-row`). Il flag manuale (`is_military` in DB) marca navi militari senza `ship_type 35` né prefisso/keyword riconoscibile (es. navi Marina Militare italiana senza prefisso "ITS"). Si imposta dal pannello detail con `🪖 Segna come nave militare`. | — |
| **Cambio nome scafo** | Stesso MMSI che trasmette più nomi distinti (flag/name hopping) | 8 |
| **Arricchimento esterno (VF/MT)** | Dati registro da VesselFinder/MarineTraffic, **solo se l'import è abilitato e già in cache** (vedi sotto): bandiera registrata sotto embargo → 12, bandiera di comodo → 5, scafo datato (≥ 35 anni) → 6, porto di armamento in zona ad alto rischio → 8 | 12 |
| **Sanzioni (OFAC SDN + UE/UK/ONU)** | Match con le liste sanzioni per IMO/nome/call sign, solo se `IMPORT_SANCTIONS` (vedi `sanctions.js`): oltre a OFAC SDN, confronta anche con la lista consolidata UE, la lista UK OFSI e la lista ONU navi designate (via OpenSanctions), liste aggiuntive gestite da `IMPORT_SANCTIONS_EXTRA`. Segnale diretto fortissimo. **Un match per IMO o call sign vale il peso pieno (60); un match per solo nome vale metà** (identificatore debole, nomi di scafo comuni collidono con entità sanzionate) | 60 (30 se solo nome) |
| **Port State Control (Paris/Tokyo MoU)** | Solo se `IMPORT_PSC` (vedi sotto): bandiera in black list MoU → 12, in grey list → 5; nave nella banned list Paris MoU (refusal of access dopo fermi multipli) → 40 (match per IMO), **20 se il match è per solo nome** | 40 (20 se solo nome) |
| **Eventi Global Fishing Watch** | Solo se `IMPORT_GFW` (vedi sotto): eventi comportamentali ricavati e classificati da GFW dal feed AIS globale, **conferme autorevoli** dei segnali che il modello solo-AIS inferisce per euristica. Incontro in mare aperto (firma di trasbordo ship-to-ship, `RISK_GFW_ENCOUNTER`) → 18, evento gap/AIS spento in navigazione (`RISK_GFW_GAP`) → 15, loitering (`RISK_GFW_LOITERING`) → 12, scalo in un porto ad alto rischio (`RISK_GFW_PORT_VISIT_HIGH_RISK`) → 15. Fattori comportamentali (passano per il moltiplicatore geopolitico). Quando lo **stesso comportamento** è rilevato sia dall'euristica locale (blackout/loitering/rendezvous) **sia** dall'evento GFW equivalente, il punteggio è limitato al **massimo tra i due** per famiglia (`max(locale, GFW)`), non alla loro somma: una singola anomalia confermata da entrambe le fonti conta una volta sola | 18 |

**Moltiplicatore di contesto geopolitico** applicato al subtotale anomalie:

- `× +0.5` se la destinazione dichiarata corrisponde a un porto/paese sotto embargo o zona di conflitto (lista `HIGH_RISK_DEST`: Siria, Iran, Corea del Nord, Libia, Yemen, Sudan, Russia/Crimea, Somalia…), **oppure** se la bandiera è di uno stato sotto embargo (`EMBARGO_MID`: NK 445, Siria 468, Iran 422, Libia 642, Russia 273). Il match sulla destinazione è per **parola intera** (word-boundary), non per sottostringa — così "IRAN" non matcha "MIRANDA" né "ADEN" matcha "BADEN" — e le destinazioni in forma **UN/LOCODE** vengono prima risolte in nome porto (`destinationLabel`), così anche "IR BND" viene riconosciuta.
- `× +0.2` se la nave batte una **bandiera di comodo** (`FOC_MID`: Panama, Liberia, Marshall, Comore, Togo, Tanzania, Cook, Sierra Leone, Moldova, Cambogia, Palau, Mongolia…).

La **bandiera** è derivata dal **MID** (Maritime Identification Digits = prime 3 cifre dell'MMSI).

Formula finale:

```
score = clamp( round( subtotaleAnomalie × moltiplicatore ), 0, 100 )
```

`computeRiskScore(ship, lang)` ritorna `{ score, band, factors, sanctionMatch, sources }`, dove `band` ∈ `low|med|high`, `factors` è l'elenco ordinato `{label, points}` delle firme che hanno contribuito (label nella lingua richiesta), `sanctionMatch` è `null` oppure il dettaglio strutturato del match sanzioni (`{ source, sourceKey, program, flag, owner, aliases, listedName, matchedOn, matchedOnLabel, url }`, usato dal pannello Sanzioni nel dettaglio nave) e `sources: { vf, mt, gfw, sanctions, psc }` indica quali fonti esterne erano presenti/consultate al momento del calcolo (ognuna `none`/`available`/`used`). Il parametro `lang` (`'it'` default, `'en'` supportato) viene inoltrato automaticamente da `api.js` in base alla lingua selezionata nel frontend.

### Pesi dei segnali editabili dall'interfaccia (Modello di rischio)

I valori della tabella sopra sono i **default** (da `app.config.properties`, chiavi `RISK_*`), ma i **pesi in punti** dei ~24 segnali sono anche **modificabili a runtime** dalle Impostazioni → sezione **⚖ Modello di rischio**, senza riavvio — stesso meccanismo dei [pesi per tipo di carico](#-tipo-di-carico-e-stato-di-carico). Solo gli admin. Le **soglie di rilevamento** (ore di blackout, kn di spoofing, km/posizioni/**durata minima** di loitering, Δ pescaggio, anni nave, giorni finestra rendezvous) e i **moltiplicatori geopolitici** restano boot-only in `app.config.properties`.

- **Override live**: l'override è salvato come singola proprietà JSON `RISK_WEIGHTS` in `local.properties`, sovrapposta ai default `RISK`; `risk-score.js` legge sempre `state.riskWeights` (che porta l'intero set `RISK` con solo i pesi-punto sovrascrivibili). Modificare un peso invalida la cache degli score così il ricalcolo è immediato.
- **Profili di rischio (preset)**: come le "classi di pesi" del carico — un preset **Default** integrato più profili salvabili dall'operatore, memorizzati come riga JSON nella tabella `meta` (chiave `risk_weight_presets`), inclusa nei backup. Endpoint: `POST /api/settings/risk-weights`, `GET|POST /api/settings/risk-presets`, `POST /api/settings/risk-presets/apply`, `DELETE /api/settings/risk-presets/:id` (tutti `requireAdmin`). Servizio in [`src/services/risk-presets.js`](../../src/services/risk-presets.js); pesi editabili elencati in `config.EDITABLE_RISK_WEIGHTS`.

### Arricchimento dello score da VF/MT

Quando l'import VesselFinder e/o MarineTraffic è abilitato, lo score usa anche i **dati di registro** scaricati da quelle fonti (`loadEnrichment` in `risk-score.js`), che il modello solo-AIS non vede:

| Campo (label VF/MT) | Segnale | Punti |
|---|---|---|
| `Bandiera` / `Flag` | Bandiera **registrata** sotto embargo (NK, Siria, Iran, Libia, Russia). Indipendente dal MID dell'MMSI → intercetta il **reflagging** | 12 |
| `Bandiera` / `Flag` | Bandiera di comodo (Panama, Liberia, Marshall, Comore, Togo, Tanzania, Cook, Sierra Leone, Moldova, Cambogia, Palau, Mongolia, Costa d'Avorio) | 5 |
| `Anno costruzione` / `Year built` | Scafo datato (≥ 35 anni) — naviglio vecchio favorito dai traffici sanzionati | 6 |
| `Porto di armamento` / `Home port` | Home port in zona ad alto rischio (lista `HIGH_RISK_DEST`) | 8 |

Regole:

- **Solo fonti abilitate**: legge solo VF se `IMPORT_VF_DATA`, solo MT se `IMPORT_MT_DATA`. Import spento → contributo nullo.
- **Solo cache, mai live**: `loadEnrichment` legge unicamente `ship_scrape_cache`. Il calcolo dello score resta sincrono e veloce per gli endpoint lista (`/ships/active`, `/ships/past`). La cache è popolata dall'[arricchimento proattivo alla prima rilevazione](#arricchimento-proattivo-alla-prima-rilevazione) o dall'apertura del dettaglio nave.
- **VF + MT unite**: per ogni campo vince la prima fonte che lo fornisce (no doppio conteggio). Ogni fattore in `factors` riporta la fonte (`fonte VesselFinder`/`fonte MarineTraffic`).
- Se la nave non è mai stata arricchita (nessuna cache), lo score ricade sul solo modello AIS.

### Screening Port State Control (Paris/Tokyo MoU)

Abilitato da `IMPORT_PSC`, implementato in [`src/services/psc.js`](../../src/services/psc.js) con lo stesso pattern **dataset** delle sanzioni (`sanctions.js`): liste pre-caricate in memoria, match locale per ogni nave, **nessuna chiamata di rete per-nave**. Due segnali complementari:

| Livello | Segnale | Fonte | Match | Punti |
|---|---|---|---|---|
| **1 — Performance bandiera** | Bandiera in **black list** MoU (registro ad alto rischio per fermi/ispezioni) → 12; in **grey list** → 5; **white list** → 0 (registro di qualità) | Liste annuali white/grey/black **Paris MoU** + **Tokyo MoU**, incluse nel repo come `data/{paris,tokyo}-mou-flags.json` | Per nome bandiera (dal campo registro VF/MT, normalizzato) | 12 / 5 |
| **2 — Navi bandite** | Nave nella **banned list** Paris MoU (refusal of access dopo **fermi multipli**) — il segnale "molti fermi" più forte | Mirror OpenSanctions della lista EMSA/Paris MoU (CSV, URL `latest`) | Per IMO, poi nome | 40 |

Regole:

- **Le liste bandiera sono ground truth regionale** e **sovrascrivono l'euristica `FOC_FLAG_NAMES` hardcoded**: una bandiera trovata nelle liste MoU usa il verdetto MoU (es. Panama = grey → 5, Liberia = white → 0), non la lista fissa. Il check bandiera-embargo resta sempre prioritario.
- **Priorità Paris su Tokyo**: in caso di verdetto diverso vince Paris MoU (regione monitorata = area Paris); Tokyo riempie solo le bandiere che Paris non elenca.
- **PDF non parsabili**: i MoU pubblicano solo PDF, quindi le liste bandiera sono trascritte a mano nei JSON e **vanno aggiornate ~1 volta l'anno** (URL fonte e data di validità sono nei file). La **banned list** invece è scaricata e aggiornata ogni 24h come OFAC.
- **Offline-safe**: all'avvio carica liste bandiera + banned list dalla cache su disco; scarica la banned list solo se non già in cache.

### Frontend

Helper in `public/js/helpers.js`: `riskClass(score)` (mappa fascia → classe CSS) e `riskBadge(risk)` (badge colorato interattivo). Lo score guida:

- **Colonna Rischio** nelle liste navi attive/passate; le righe in fascia rossa hanno la classe `.risk-row` (bordo/sfondo rosso). Le navi militari rilevate automaticamente (`is_military`) hanno la classe `.military-row` (rosso, priorità su `.flagged-row`).
- **Dettaglio nave**: score nella info-bar + scomposizione pesata dei fattori (`riskFactorsHtml`). Le label dei fattori sono restituite nella lingua corrente dal server.
- **Marker sulla mappa overview** (`renderActiveMap` in `public/js/maps.js`): colore per fascia di rischio — 🟢 verde (`low`) · 🟡 giallo (`med`) · 🔴 rosso (`high`). Le navi **segnalate** (★ `flagged`) hanno priorità e sono colorate **🟣 viola**, sia come marker sia come riga di lista (`.flagged-row`). Le navi militari auto-rilevate mantengono il rosso anche se `flagged`. Il popup del marker mostra il badge di rischio.

**Indicatore fonti** — ogni badge mostra un cerchietto nell'angolo in alto a destra che indica quali dati extra sono stati usati nel calcolo:

| Colore | Significato |
|---|---|
| Magenta | Score include dati VesselFinder |
| Giallo | Score include dati MarineTraffic |
| Arancione | Score include dati VesselFinder **+** MarineTraffic |
| Rosso (Sanzioni ⚠) | Nave presente in una lista sanzioni (OFAC / UE / UK / ONU) |
| Blu (Paris/Tokyo MoU ⚓) | Segnale dalle liste Port State Control (bandiera black/grey o nave bandita) |
| Verde acqua (Global Fishing Watch) | Score calcolato usando eventi/identità Global Fishing Watch |
| *(assente)* | Solo dati AIS free |

Il cerchietto appare solo se i dati erano già in cache al momento del calcolo (stessa garanzia del punto "Solo cache, mai live" sopra).

**Tooltip al hover** — passando il mouse sul badge appare un pannello che mostra score e fascia di rischio (colorata), l'elenco dei fattori con il relativo peso, e le fonti usate nel calcolo. Gestito via event delegation globale in `initRiskTooltip` (`public/js/main.js`); i dati sono serializzati nel campo `data-risk` del badge stesso (JSON HTML-escaped).

Stili `.risk-badge`/`.risk-low|med|high`/`.risk-src-dot`/`.src-vf|mt|both`/`.risk-tooltip`/`.rf-list`/`.risk-row`/`.flagged-row`/`.military-row` in `public/css/style.css`.

### Avvertenza sull'accuratezza

Con monitoraggio a **singola bounding box**, una nave che esce dall'area genera un lungo gap di letture che il rilevatore di blackout interpreta come "dark activity" — falso positivo intrinseco, non un reale spegnimento del transponder. Lo score è uno strumento di **triage/screening**, non una prova: le navi in fascia rossa vanno verificate con fonti esterne (MT/VF) e ispezione fisica.

## 🔎 Ricerca, filtri ed export liste

Le viste **Navi presenti** e **Navi passate** hanno una toolbar sopra la tabella per restringere l'elenco senza ricaricare dal server (filtraggio **client-side** sui dati già scaricati):

- **Ricerca testo** — sottostringa case-insensitive su nome, MMSI, IMO, destinazione e callsign.
- **Fascia di rischio** — tutte / 🟢 verde / 🟡 giallo / 🔴 rosso.
- **Solo in porto** (solo "presenti") e **Solo segnalate** (★).

Il contatore `mostrate / totali` appare quando un filtro è attivo. La mappa overview riflette gli stessi filtri. Il pulsante **⬇ CSV filtrato** esporta la vista **corrente** (filtrata e ordinata) come CSV (un file per lista, generato nel browser via `Blob`, con BOM UTF-8 per Excel): colonne MMSI, nome, tipo, destinazione, SOG, COG, in porto, score/fascia, segnalata, militare, primo/ultimo contatto, callsign, IMO, lat/lon. È complementare all'[export ZIP completo](#-api-interne) (`/api/export`), che resta l'export grezzo di tutte le letture per tipo messaggio.

### Export geospaziale (GeoJSON / KML)

Per portare i dati in **QGIS** o **Google Earth**, accanto al CSV ci sono i pulsanti **⬇ GeoJSON** e **⬇ KML**, tutti **client-side** (generati nel browser da dati già caricati, come il CSV). Le coordinate sono emesse in ordine `[lon, lat]`. Implementati in [`public/js/geoexport.js`](../../public/js/geoexport.js). Quattro sorgenti:

- **Lista navi filtrata** (toolbar Navi presenti/passate) → un **Point** per nave posizionata, con proprietà MMSI/nome/tipo/destinazione/SOG/COG/score/fascia/segnalata/militare/IMO/call sign.
- **Traccia singola nave** (dettaglio nave, sotto la mappa) → una **LineString** lungo i fix + un **Point** per fix (con timestamp), da `/api/ships/:mmsi/track`.
- **Replay finestra** (barra Replay) → una **LineString per nave** sulla finestra temporale caricata (proprietà MMSI/nome/fascia/intervallo).
- **Banchine** (pulsanti "Banchine GeoJSON/KML" nella toolbar) → un **Polygon** per banchina (categoria, n. attracchi, % hazmat), dal `polygon_json`.

Il KML usa `Placemark` con `ExtendedData` per le proprietà; il GeoJSON è una `FeatureCollection`. Export vuoto → un avviso (toast).

## 📈 Storico dello score di rischio

Lo [score di rischio](#-score-di-rischio-potenziale-trasporto-armi) è ricalcolato a ogni richiesta, ma viene anche **campionato e salvato** nel tempo (tabella `risk_history`) così il dettaglio nave può mostrarne l'**andamento** — un'escalation è di per sé un segnale.

- **Campionamento sparso**: `db.recordRiskSnapshot(mmsi, score, band)` inserisce un punto **al massimo una volta all'ora per nave**, più ogni volta che lo score cambia. Niente bloat: la tabella è inoltre limitata globalmente (rotazione a 20.000 righe).
- **Punti di campionamento**: a ogni **arrivo** della nave (lo stream calcola già lo score per la notifica `high_risk`) e all'**apertura del dettaglio** (`GET /api/ships/:mmsi`).
- **Visualizzazione**: grafico a barre colorate per fascia nel dettaglio nave (`renderRiskHistory` in `public/js/ships.js`), con variazione complessiva (▲/▼). Servono almeno due rilevazioni; finché non si accumulano, mostra un avviso. Endpoint `GET /api/ships/:mmsi/risk-history`.
- Lo storico viene incluso nel backup del database e cancellato insieme ai dati dell'area (o di tutto) dalle funzioni di cancellazione.

## 📄 Report PDF della nave

Il bottone **📄 Report** nell'header del dettaglio genera un **report stampabile** della nave: apre una finestra con un documento HTML autoconsistente (stili inline) e lancia la stampa del browser — da cui si può salvare come **PDF** (*Stampa → Salva come PDF*). Nessuna dipendenza server-side per i PDF. Il report include intestazione (nome, MMSI, data), **score di rischio con fattori**, tabella dati nave, **storico visite nelle aree monitorate** (con area, destinazione e pescaggio) e note operative, con un disclaimer sull'uso dello score come strumento di triage.

## ⚓ Rilevamento "in porto" e de-noise della traccia

Una nave ormeggiata/all'ancora non è perfettamente immobile: oscilla sull'ancora, deriva per corrente, ha rumore GPS. Questi piccoli spostamenti vanno distinti dal movimento reale.

> **Nota AIS**: la *velocità in acqua* (STW, Speed Through Water) **non è trasmessa** dai messaggi AIS — è disponibile solo la **SOG** (Speed Over Ground). La classificazione usa quindi SOG + distanza tra posizioni, non STW.

**Flag `in_port`** (`isInPort` in `src/services/ship-analysis.js`) — una nave è "in porto" se:
1. lo stato navigazionale AIS è ormeggiata (`5`) o all'ancora (`1`), **oppure**
2. *(isteresi)* le posizioni degli ultimi 30 minuti restano tutte entro `STILL_RADIUS_M` (100 m) dal loro centroide — sta ferma, solo deriva/swing, anche se la SOG istantanea ogni tanto supera la soglia, **oppure**
3. l'ultima SOG è < `SOG_FERMA` (0.5 kn).

L'isteresi evita che lo swing all'ancora faccia "lampeggiare" la nave dentro/fuori dallo stato in-porto. Le navi in porto sono marcate con badge ⚓ (lista, popup mappa, dettaglio) e beneficiano della retention di 24 ore.

**De-noise traccia** (`collapseTrack` in `public/js/maps.js`) — nella mappa del dettaglio, i punti consecutivi fermi (SOG < 0.5) entro `TRACK_MERGE_RADIUS_M` (100 m) sono collassati in un unico nodo **⚓ Sosta** (popup con numero di posizioni e intervallo orario). La polilinea passa per i centroidi → traccia pulita invece di una nuvola di marker attorno alla banchina. Le letture grezze nel DB restano intatte: il merge è solo a livello di visualizzazione.

## ⏯️ Replay storico (time-scrubber sulla mappa dell'area)

La **singola traccia** nel dettaglio nave (`setupTrackAnim`) ha anch'essa filtri temporali (**6h / 24h / 7gg / tutto**, oppure range personalizzato da/a) e **moltiplicatori di velocità** (1× / 5× / 20× / 60×); endpoint `GET /api/ships/:mmsi/track?window=6h|24h|7d|all` oppure `?from=ISO&to=ISO`. Anche qui, se ShipFinder/MyShipTracking sono attivi e la nave ha posizioni scrapate, compare il toggle **Includi SF/MST** (sotto la mappa del dettaglio, acceso di default, `?scraped=1` → `db.getShipTrack`/`getShipTrackRange` con `sources` allargate, `extraAvailable` via `db.hasShipScrapedPositions`, stato `S.trackUseScraped`): i fix SF/MST entrano nella rotta animata, con nodi colorati distinti (ambra SF / teal MST) e nota di sorgente nel popup. La mappa **Navi presenti** ha invece un **replay storico dell'intera area**: rivedere il traffico di tutte le navi su una finestra temporale scelta. Frontend in [`public/js/replay.js`](../../public/js/replay.js); endpoint `GET /api/replay`.

Il pulsante **▶ Replay** nella toolbar entra in modalità replay (nasconde i marker live, mostra la barra dei controlli). Si sceglie:

- **Area** — una delle aree dell'utente (default quella corrente);
- **Finestra** — preset rapidi **1h / 6h / 24h / tutto**, oppure un intervallo **personalizzato** (da/a) con i due selettori datetime. La finestra è ancorata al **dato più recente** dell'area (non all'orologio), così lo scrubber cade sempre su dati anche dopo una pausa, ed è limitata all'intervallo disponibile nei `readings` (a rotazione, cap 10k/tipo).

**Modello di riproduzione** — un **clock globale** scorre da inizio a fine finestra. A ogni istante T ciascuna nave è disegnata nella posizione **interpolata** tra i suoi due fix circostanti — *a meno che* quei fix non siano separati da un buco più lungo di `REPLAY_MAX_GAP_MIN` (default 30 min): in quel caso la nave è **tenuta all'ultima posizione nota** (fix a-o-prima di T) invece di essere interpolata. Così non si inventa un movimento attraverso i dati mancanti, ma la nave **resta visibile**: le navi lente o all'ancora, che trasmettono solo ogni qualche ora, prima **sparivano** per quasi tutta la timeline (bug corretto). Una nave è nascosta solo **prima del suo primo** e **dopo il suo ultimo** fix nella finestra. Una **scia che sfuma** lunga `REPLAY_TAIL_MIN` (default 20 min) mostra il percorso recente. I marker sono **colorati per fascia di rischio** (lo score è quello corrente) e **cliccabili** per aprire il dettaglio.

**Controlli** — play/pausa, **scrubber** (seek manuale) e **moltiplicatori di velocità** (1× / 5× / 20× / 60× del tempo reale). Lo stato mostra navi caricate, intervallo disponibile ed eventuale troncamento.

**Includi SF/MST** — di norma il replay usa **solo i fix AIS**. Quando ShipFinder e/o MyShipTracking sono attivi *e* ci sono loro posizioni nella finestra, accanto ai controlli compare il toggle **Includi SF/MST** (acceso di default): tiene conto anche delle posizioni scrapate quando traccia la rotta animata, utile per riempire i tratti in cui l'AIS è andato silente. Spegnendolo il replay torna al solo AIS. È un toggle **per-sessione** (`S.replayUseScraped`), non persistito; cambiarlo ricarica la finestra corrente.

**Azzera replay / intervalli di spostamenti** (track del **dettaglio nave**) — sotto la mappa del dettaglio, accanto all'export, il pulsante **🧹 Azzera replay** segna un **taglio a "ora"** nella timeline della nave: gli spostamenti successivi diventano un **nuovo intervallo**, quelli precedenti restano disponibili come intervallo separato. È **non distruttivo** — i `readings` sono condivisi e restano intatti (risk score, eventi porto e la vista di altri utenti non cambiano). I tagli sono **per-utente e persistenti** (tabella `user_track_cuts(user_id, mmsi, cut_at)`, in `BACKUP_TABLES`).

Con **almeno un taglio** compare una **dropdown "Intervallo replay"** che elenca i segmenti (N tagli → N+1 segmenti: `inizio→C1`, `C1→C2`, … `Cn→ora`), più recenti in cima, più una voce **"Tutto lo storico"**. Selezionando un intervallo il replay mostra solo quel tratto (equivale a un range personalizzato: i preset 6h/24h/7g/tutto restano usabili dentro un segmento). All'apertura della scheda si parte dal **segmento più recente**. Il pulsante **🗑 Elimina taglio** rimuove il taglio all'**inizio** dell'intervallo selezionato, fondendolo col precedente (disabilitato per il primo segmento e per "Tutto lo storico"). Endpoint: `GET /api/ships/:mmsi/track` ritorna anche `cuts` (la dropdown è costruita lato client); `POST`/`DELETE /api/ships/:mmsi/track-cut` aggiungono/rimuovono un taglio.

**Dati** — `GET /api/replay?area=KEY&window=1h|6h|24h|all` (oppure `&from=ISO&to=ISO`) restituisce le posizioni dentro il bbox dell'area nella finestra, **raggruppate per nave** (`db.getAreaReplayPositions`), più l'intervallo disponibile (`db.getAreaReplayRange`) e la fascia di rischio per nave. Con `&scraped=1` le fonti incluse diventano `('ais','sf','mst')` (solo per le integrazioni effettivamente abilitate); senza il parametro resta solo `'ais'`. La risposta porta `extraAvailable` (booleano: esistono fix SF/MST nella finestra, a prescindere dal toggle — guida la visibilità del toggle lato client, via `db.hasAreaReplayPositions`). Il totale è limitato da `REPLAY_MAX_POINTS` (default 40.000); oltre, si tengono le posizioni **più recenti** della finestra (taglio per tempo, così nessuna nave sparisce del tutto — un ordinamento per MMSI scartava intere navi ad MMSI alto) e la risposta è marcata `truncated`. Nessuna scrittura: legge solo i `readings` esistenti.

## ⚓ Banchine (caratterizzazione automatica degli attracchi)

Il sistema deduce automaticamente **dove** le navi attraccano e **di che tipo** sono, evidenziando i moli "caratterizzati" con un overlay colorato sulla mappa delle navi presenti. Tutto è correggibile a mano.

**Pipeline** (`src/services/berths.js`, per area):

1. **`detectMoorings(area)`** — un punto di attracco per visita = centroide delle letture *ferme* della nave (`sog < SOG_FERMA` o stato AIS ormeggiata/ancora `5`/`1`) nella finestra tra un arrivo e l'arrivo successivo della stessa nave (gli arrivi vengono da `port_events`). Le visite di puro transito (nessuna lettura ferma) sono scartate. Ogni punto è etichettato con la **categoria** della nave (`src/services/ship-categories.js`: cargo, tanker, passeggeri, pesca, servizio, militare, diporto, alta velocità, altro).
2. **Clustering** — DBSCAN con distanza haversine (`BERTH_CLUSTER_EPS_M`, `BERTH_MIN_PTS`). I punti dentro il poligono di una banchina **manuale** vengono assegnati prima ed esclusi dal clustering (la geometria disegnata a mano vince). La geometria di una banchina automatica è l'**inviluppo convesso** (convex hull) dei suoi punti.
3. **Caratterizzazione** — conteggio categorie per banchina: la dominante (≥ `BERTH_DOMINANT_PCT`, su almeno `BERTH_MIN_MOORINGS` attracchi) dà nome e colore alla banchina, altrimenti è **"mista"**; sotto la soglia minima resta non caratterizzata (tratteggiata). Calcola anche la quota di **merci pericolose** (☢, codici AIS 71–74/81–84).

**Persistenza delle correzioni** — le banchine automatiche vengono ricostruite ad ogni ricalcolo, ma una banchina rinominata/forzata riacquista la sua identità per prossimità del centroide (entro `eps`). Le banchine **manuali** (geometria bloccata da `manual_geom=1`) non vengono mai spostate. La caratterizzazione automatica è sempre ricalcolata, ma l'override manuale (`char_override`) ha la precedenza in lettura.

**Ciclo di calcolo** — *backfill* una tantum all'avvio (`berths.recomputeAll()` in `src/server.js`, idempotente) su tutto lo storico, poi ricalcolo periodico in background ogni `BERTH_RECOMPUTE_MIN` minuti.

**Frontend** (`public/js/berths.js`) — overlay `L.polygon` su un pane dedicato (sotto i marker nave, così non ne ruba i click) più un **marker centroide** a dimensione costante (il poligono ~80 m è invisibile allo zoom dell'intera area), toggle **Banchine** nella barra filtri (stato in `localStorage`), popup con distribuzione percentuale, e pannello di gestione (**⚓ Banchine**): rinomina, forza categoria, unisci, elimina, ricalcola; **clic su una riga** centra la mappa sulla banchina e ne apre il popup.

## 🌊 Overlay OpenSeaMap

Integrazione **OpenSeaMap** (dati gratuiti CC-BY-SA, **nessuna API key**), attivabile dalle Impostazioni (default **attivo**). Due livelli **indipendenti**, con un toggle ciascuno:

- **Livello nautico a tile** — toggle `showOpenSeaMap` (`public/js/tiles.js`, `addBaseLayers`). Overlay raster trasparente `tiles.openseamap.org/seamark/{z}/{x}/{y}.png` su **tutte e 4 le mappe** (dettaglio, attiva, navi seguite, aree) sopra le tile OSM. Mostra boe, fari, luci, segnali, separazione del traffico, fairway, ancoraggi. È un raster unico → **tutto o niente, non filtrabile per elemento** (per nascondere luci/beacon ecc. si spegne l'intero livello). `applyOpenSeaMap()` lo aggiunge/rimuove live su ogni mappa.
- **Marker vettoriali** — toggle `showOpenSeaMapMarkers` (`public/js/seamarks.js`). Su **mappa attiva**, porti/ormeggi/banchine/ancoraggi/marine ufficiali (e luci, segnali, pericoli, punti pilota) presi da **OpenStreetMap via Overpass API** (`overpass-api.de`, query diretta dal browser, CORS ok), in cache per bbox, disegnati in un pane dedicato (z360, sopra le banchine auto-calcolate z350, sotto i marker nave z400). Servono a **confrontare** gli ormeggi ufficiali con le banchine calcolate dall'app. Hover → tooltip con nome, categoria e una breve spiegazione dell'elemento.
  - **Selezione categorie**: da Impostazioni si scelgono quali categorie di marker mostrare (default tutte; ricalcolo live alla modifica). Categorie in `SEAMARK_CATEGORIES` (`seamarks.js`); l'insieme **nascosto** è persistito come `OPENSEAMAP_HIDDEN` (array JSON in `local.properties`) — si memorizza il set disabilitato, così categorie aggiunte in futuro restano visibili di default. Vale solo per i marker vettoriali (il livello a tile mostra sempre tutto).

> **Nessun database, nessuna migrazione**: i toggle vivono in `local.properties` (`SHOW_OPENSEAMAP`, `SHOW_OPENSEAMAP_MARKERS`, `OPENSEAMAP_HIDDEN`) e i dati Overpass sono recuperati live, mai salvati. La `depth-api3` di OpenSeaMap **non** è usata (richiederebbe un backend Django+PostGIS self-hosted). **Copertura**: nei porti commerciali i tag `berth`/`mooring` sono spesso assenti — per questo la query Overpass copre anche porti/bacini/ancoraggi/marine, e il livello a tile resta la fonte visiva principale.

## 🌐 Mappa delle zone coperte (copertura AISStream)

Una sottoscrizione AISStream sul **mondo intero** aggrega i messaggi di posizione in una **griglia lat/lon** (conteggio per cella) per visualizzare dove la copertura AIS è densa e dove ci sono buchi. Si apre dalla sidebar (**🌐**): una mappa **Leaflet mondiale** con le celle colorate per densità su **scala logaritmica** (blu → rosso), disegnate con il **renderer canvas** per reggere il numero di celle.

Si salva **solo** il conteggio messaggi per cella e l'ultimo avvistamento (`msg_count`, `last_seen`): **nessun nome nave, nessuna posizione** delle singole imbarcazioni.

**Hot path**: parse del messaggio → incremento di un contatore **in memoria** → flush in batch su DB ogni `HEATMAP_FLUSH_SEC`. Non c'è **mai** una scrittura per singolo messaggio.

**Visibilità**: la **mappa** (dati correnti) è visibile a **tutti** gli utenti autenticati in sola lettura (`GET /api/heatmap/cells`); l'**avvio/arresto** della raccolta, le **statistiche live** di connessione e l'**export/import** sono **solo admin**.

**Pagina pubblica**: la heatmap è accessibile **senza login** all'endpoint `GET /heatmap` (pagina Leaflet standalone). I dati vengono serviti da `GET /api/heatmap/public-cells` (limitato a 30 req/min per IP); non include nessun dato utente o nave, solo i conteggi aggregati per cella.

**Raccolta = task in background controllato dagli admin.** Premendo **Avvia**, il firehose mondiale gira in background finché un admin non preme **Ferma**, indipendentemente da chi ha la pagina aperta. Lo **stato desiderato** è persistito (chiave `heatmap_collecting` nella tabella `meta` del DB principale) e **riprende da solo al riavvio** del server. **Sicurezza**: uno sweep ogni 10 minuti **spegne** il firehose se nessun utente è stato attivo negli ultimi 10 minuti.

**Pannello admin**: stato, banda attuale, scaricato (sessione), messaggi/s, messaggi sessione, connessione (uptime + riconnessioni), celle popolate, messaggi totali; pulsanti **Avvia/Ferma**, **Aggiorna mappa**, **Cancella dati**; un banner di avviso ricorda il consumo di banda e la necessità di un account separato.

> ℹ️ **Chiave dedicata, account separato.** La feature richiede `HEATMAP_AIS_API_KEY` in `local.properties`, da un **account AISStream SEPARATO**. Il limite di connessioni di AISStream è **per-account, non per-chiave**: una chiave sullo stesso account di `AIS_API_KEY` viene **rifiutata** (la WebSocket si apre e si chiude subito con codice `1006`, senza alcun frame di errore) e priverebbe gli stream delle aree del loro slot di connessione. Senza la chiave la funzione è **inerte**. Il valore va indicato "nudo": il parser **non** rimuove i commenti `//` inline sulla riga del valore.

**Banda misurata**: ~100–300 msg/s ≈ **~200–400 MB/ora**.

**Hardening riconnessione**: backoff esponenziale (`5s × 2^tentativi`, max 5 min) sulle sessioni che si chiudono **senza aver ricevuto messaggi**; dopo **3 fallimenti consecutivi** viene mostrata una diagnosi (limite per-account / chiave non valida).

> ℹ️ **Database separato.** I dati vivono in `data/db/heatmap_data.db` (modulo `src/heatmap-db.js`), **non** nel DB principale né nelle `BACKUP_TABLES`. Sono **esportabili/importabili** per conto loro da **Impostazioni → Backup** (`/api/heatmap/export` / `import`, semantica **"sostituisci"**) e sono comunque inclusi nel **bundle completo** (formato **v3** `TPB3`: header + main DB + heatmap DB, entrambi length-prefixed, in streaming). I bundle **v1/v2** più vecchi si ripristinano lo stesso (senza la sezione heatmap).

**Griglia**: `HEATMAP_GRID_DEG` in `app.config.properties` (default **0.25°** ≈ 28 km). Più piccola = più precisa, ma il costo cresce in modo **quadratico** (render/payload/righe DB). Cambiare la griglia **invalida le celle salvate** (l'indice è `floor(coord/grid)`) → eseguire **"Cancella dati"** dopo il cambio.

#### Filtro rumore: posizione (0,0) e celle "singleton"

Analizzando un export reale sono emerse due forme distinte di rumore, entrambe **dati esterni** (AISStream/i suoi feeder), non un bug di parsing nostro (stessa estrazione `MetaData.latitude/longitude` di `ais-stream.js`/`ship-follow.js`):

- **"Null Island" (0°,0°)** — sentinel classico di "GPS senza fix" che alcuni feeder emettono al posto del vero codice ITU-R M.1371 di posizione non disponibile (91°/181°, già respinto dal range-check `lat/lon` esistente). Passava perché 0 è un valore finito e in range. **Fix**: `heatmap-stream.js` scarta esplicitamente `lat===0 && lon===0` prima di bufferizzare la cella (stesso punto del range-check). Solo ingestion **futura**: celle (0,0) già accumulate nel DB restano finché non le si cancella a mano (`DELETE FROM heatmap_cells WHERE lat_idx=0 AND lon_idx=0` sul DB heatmap, oppure "Cancella dati" che però svuota tutto).
- **Celle "singleton" isolate** (`msg_count = 1`, nessuna cella popolata nell'intorno) — firma tipica di un artefatto di posizionamento **satellitare AIS**: quando il ricevitore non riesce a risolvere bene la posizione da un rilevamento marginale, alcuni feed ripiegano sul sub-punto/ground-track del satellite (longitudine quasi costante durante un singolo passaggio orbitale, latitudine che spazia molto) invece di scartare il messaggio — diverso da un vero transito (che lascerebbe più messaggi per cella lungo un percorso diagonale). Impossibile distinguere in modo affidabile senza identità/rotta (che il DB heatmap **non salva di proposito**, vedi sopra), quindi niente euristica in ingestion: **filtro solo in lettura**, opt-out per l'utente.

**Toggle "nascondi singleton"** (🧹, **acceso di default**): stesso pattern UI dei toggle nome/scia (`createMapToggleControl`/`setToggleBtnState`, esportate da `public/js/maps.js` e riusate in `public/js/coverage.js` — icona sola, spiegazione via overlay hover `data-tip`, non testo/`title`). Pref utente `hideHeatmapSingletons` (default `true`) in `user-prefs.js`, condivisa in gruppo (`group-sync.js` `SHARED_SETTING_KEYS`), letta/scritta come le altre da `GET`/`POST /api/settings`.

- **Filtro lato server** — `heatmapDb.getCellsAgg({ level, bbox, hideSingletons })` ([`src/heatmap-db.js`](../../src/heatmap-db.js)) scarta le celle **fini** con `msg_count = 1` **prima** dell'aggregazione per LOD, non dopo: un blocco coarse che contiene anche traffico vero non perde quel traffico, solo il contributo della cella-rumore. Query param `?hideSingletons=1` su entrambe le rotte (`GET /api/heatmap/cells` autenticata, `GET /api/heatmap/public-cells` pubblica). Cache mondo (`aggCache`) tenuta per chiave `factor:hideSingletons` così le due varianti non si sovrascrivono a vicenda.
- **Pagina pubblica** (`public/heatmap.html`, `/heatmap`, nessuna sessione) — filtro **sempre attivo, non togglabile** (niente da persistere senza utente loggato).

File chiave: `src/services/heatmap-stream.js`, `src/heatmap-db.js`, `src/routes/heatmap.js`, `src/routes/heatmap-public.js`, `public/js/coverage.js`, `public/js/maps.js` (`createMapToggleControl`/`setToggleBtnState`), `public/heatmap.html`.

## 🔗 Integrazione MarineTraffic / VesselFinder

Nel dettaglio nave, due tab arricchiscono i dati AIS con dati scaricati (scraping) da fonti esterne, con cache in tabella `ship_scrape_cache` (TTL configurabile via `SCRAPE_CACHE_TTL`).

**VesselFinder** — pagina server-rendered, lo scraping HTML (`crawlVesselFinder`) estrae foto + tabella dati via `fetchHttp` (modulo `https`).

**MarineTraffic** — più complesso, due ostacoli:

1. **ID interno**: le pagine MT sono una SPA React indicizzata per `shipid` proprietario, non per MMSI/IMO/callsign. Lo `shipid` si risolve via l'endpoint `GET /{lang}/global_search/search?term=<MMSI|IMO|callsign>&types=1,3,7,9` → `results[0].id`. Lo `shipid` risolto è salvato in `ships.mt_ship_id` e usato per il link diretto. I dati nave si leggono poi da `GET /{lang}/vesselDetails/vesselInfo/shipid:<id>` (JSON pulito, include `typeSpecific` = sottotipo nave).
2. **Cloudflare**: MT blocca i client TLS di Node (`https`/`http2`) con HTTP 403 via fingerprint JA3/JA4, a prescindere dagli header. Lo **stack TLS di libcurl passa**, quindi le richieste MT sono fatte tramite **`node-libcurl`** (`fetchViaCurl` in `src/services/scrapers/http.js`).

> ℹ️ **Deploy**: non serve `curl` installato sull'host. `node-libcurl` include la propria libcurl (binari precompilati scaricati da `npm install`; build da sorgente come fallback). Nota: il fingerprint TLS può variare tra build di libcurl e Cloudflare potrebbe trattarle diversamente — da verificare in produzione.

**ShipFinder** — pagina server-rendered, scraping HTML (`crawlShipfinder` in [`src/services/scrapers/shipfinder.js`](../../src/services/scrapers/shipfinder.js)) via `fetchHttp` (no Cloudflare, niente libcurl). I campi sono indicizzati da `<label id="ais-…">`; la bandiera è il nome-file dell'`<img>` (codice ISO). A differenza di VF/MT (che gratis **non** danno coordinate), ShipFinder espone in chiaro la **posizione dell'ultimo avvistamento** (lat/lon in gradi-primi decimali, es. `44-35.056 N`, convertita in decimali da [`src/lib/coords.js`](../../src/lib/coords.js) `parseDdm`), oltre a SOG/COG/stato/destinazione/ETA. I campi statici (bandiera/tipo/dimensioni) duplicano in gran parte VF/MT e servono solo da fallback: **il valore unico è la posizione**.

**MyShipTracking** — pagina server-rendered, scraping HTML (`crawlMyshiptracking` in [`src/services/scrapers/myshiptracking.js`](../../src/services/scrapers/myshiptracking.js)) via `fetchHttp` (no Cloudflare). Stesso ruolo di ShipFinder: una **seconda fonte di posizione di backup, indipendente**. Particolari/velocità/rotta/stato AIS vengono dalle tabelle `<th>etichetta</th><td>valore</td>`; la **posizione dell'ultimo avvistamento** (lat/lon in **gradi decimali con segno**, ordine lat/lon) e il timestamp del rilevamento vengono dalla frase SEO della pagina (la tabella azzera lat/lon a `---` per le navi stale, mentre la frase porta sempre l'ultimo fix). La copertura è AIS **terrestre** (T-AIS): buona vicino a coste/porti, debole in mare aperto — adatta alle aree-porto monitorate.

L'integrazione MT/VF/SF/MST è attivabile/disattivabile via le proprietà `IMPORT_MT_DATA` / `IMPORT_VF_DATA` / `IMPORT_SF_DATA` / `IMPORT_MST_DATA` in `local.properties` (o dai toggle nelle impostazioni UI, che le persistono).

#### ShipFinder: ri-localizzazione delle navi seguite (posizione)

A differenza di VF/MT, la posizione ShipFinder serve a **ritrovare le navi seguite che il nostro stream AIS non vede più** (vedi [Navi seguite](#-navi-seguite)): una nave "persa" che non riappare sul box worldwide AIS spesso ha ancora una posizione relayed su ShipFinder.

- **Storage taggato.** Le posizioni scrapate finiscono nella tabella `readings` con `source='sf'` (colonna aggiunta via migrazione, default `'ais'`) e `message_type='ShipfinderPosition'`. Sono **escluse** dallo score di rischio (le query rischio filtrano `source='ais'`) e — *di default* — da traccia singola e replay, ma includibili in entrambi col toggle **Includi SF/MST** (vedi [Replay storico](#️-replay-storico-time-scrubber-sulla-mappa-dellarea)); e **non** toccano la riga `ships` (così `last_seen_at` resta il segnale di freschezza AIS e il box worldwide continua la ricerca in parallelo). In mappa appaiono come **marker ambra distinti, non collegati** alla polyline AIS (`renderSfPositions` in `maps.js`). Questi marker sono **clampati alla stessa finestra temporale della traccia** (`S.trackFrom`/`S.trackTo`, impostati da `loadTrack` per il preset/range/segmento scelto): un cut di replay (**🧹 Azzera replay**) o un segmento restringono lo scatter esattamente come i fix AIS — senza il clamp lo scatter ridisegnava l'intera storia scrapata a ogni poll e i tagli sembravano non avere effetto. La cache `S.sfPositions`/`S.mstPositions` permette di ri-clampare senza rifetch; il pulsante **📍 Localizza** (`focus`) bypassa il clamp per mostrare sempre il fix appena recuperato.
- **Sweep automatico.** Nel loop di refresh dei follow (ogni `FOLLOW_REFRESH_MIN`, default 5 min), `reacquireStaleViaShipfinder` scrapa le navi seguite **stale** (nessuna posizione AIS fresca) — incluse quelle **mai localizzate** (seguite da ricerca, via `getAllFollowedShips`). Throttle per-MMSI (`SF_REACQUIRE_THROTTLE_MIN`, default 30 min), tetto per passata (`SF_REACQUIRE_MAX_PER_SWEEP`, default 20), 2 s tra le richieste e negative-cache sui fallimenti → volume basso/captcha-safe.
- **Pulsante manuale.** Nel dettaglio nave, **📍 Localizza via ShipFinder** (`POST /api/ships/:mmsi/sflocate`) forza uno scrape immediato della posizione e centra il marker — vale per **qualsiasi** nave visibile, non solo le seguite.

**MyShipTracking** replica esattamente lo stesso meccanismo come **secondo backup indipendente**: storage taggato `source='mst'` (stessa esclusione da traccia/score, e dal replay salvo toggle **Includi SF/MST**), sweep `reacquireStaleViaMst` (stessi throttle/tetto `SF_REACQUIRE_*`), pulsante **📍 Localizza via MyShipTracking** (`POST /api/ships/:mmsi/mstlocate`). Quando entrambe le fonti sono attive una nave stale viene interrogata su entrambe; in mappa i marker MST sono **teal/ciano** per distinguerli dall'ambra di ShipFinder.

#### Mappa "Navi seguite": posizione di fallback SF/MST

Nella mappa delle **Navi seguite** una nave il cui stream AIS è andato silente — ma che è stata **ri-localizzata via ShipFinder o MyShipTracking** — viene mostrata sulla **posizione scrapata più recente** invece di restare ferma sull'ultima posizione AIS stantia (o sparire del tutto). Il marker resta **grigio** (come per le navi "in ricerca"), così resta visibile che non è una posizione AIS live.

- **Regola di trigger** — identica a quella dei badge "vista su…": il fix scrapato viene plottato **solo** quando l'AIS **non è fresco** (oltre `FOLLOW_FRESH_MS`, default 60 min) **e** lo scrape è **più recente** dell'ultimo fix AIS (`scrapeBadgeAt` in [`src/routes/ships.js`](../../src/routes/ships.js)). Un fix AIS fresco **vince sempre**: il marker **torna automaticamente** sulla posizione AIS appena lo stream ri-acquisisce la nave (il backend smette di emettere i campi `fallback_*`).
- **Sorgente** — se sia SF sia MST hanno un fix valido si plotta il **più recente**. Il backend (`scrapeFallbackFix`, endpoint `GET /api/ships/followed/active`) allega `fallback_lat`/`fallback_lon`/`fallback_at`/`fallback_source`; `renderFollowedMap` ([`public/js/maps.js`](../../public/js/maps.js)) li preferisce alla posizione AIS stantia. Il popup mostra l'**ora dello scrape** e la **fonte** ("📡 via ShipFinder/MyShipTracking"), senza SOG/COG (gli scrape non li portano in modo affidabile).
- **Niente impatto su traccia/rischio** — la posizione di fallback è puramente di **visualizzazione**: resta in `readings` con `source='sf'/'mst'`, non tocca la riga `ships` né il segnale di freschezza AIS, e le query di traccia/rischio continuano a filtrare `source='ais'`. (Il **replay** può opzionalmente includerla col toggle *Includi SF/MST*.)

##### Architettura: rendering mappa "Navi seguite" e sorgenti di posizione

| Aspetto | File:riga | Dettagli |
|---|---|---|
| **Vista mappa navi seguite (frontend)** | `public/js/maps.js` → `renderFollowedMap()` | Disegna i marker; chiamata da `public/js/followed.js` al render della tabella attiva. Considera "posizionate" le navi con posizione AIS **oppure** un fix di fallback SF/MST. |
| **Colore marker** | `public/js/maps.js` (`RISK_STYLE` / `GRAY_STYLE`) | Default per banda di rischio: `high` rosso #dc2626, `med` ambra #d97706, `low` verde #059669. Override **flaggata** viola #7c3aed. **Grigio** #6b7280 quando `search_mode` **o** quando si plotta un fix di fallback SF/MST. |
| **API posizioni seguite** | `src/routes/ships.js` → `GET /api/ships/followed/active` | Ritorna le navi seguite con `last_seen_at`, `is_stale`, `search_mode`, `sf_last_at`, `mst_last_at` e — quando applicabile — `fallback_lat`/`fallback_lon`/`fallback_at`/`fallback_source`. |
| **Posizione "corrente"** | `src/db.js` → `getShip(mmsi)` + upsert | La riga `ships` (`last_latitude`/`last_longitude`/`last_seen_at`) è aggiornata **solo** da letture AIS (`source='ais'`). |
| **Query posizione filtrate per fonte** | `src/db.js` (`getShipPositions`/`getRecentPositions`) | Filtrano esplicitamente `WHERE source='ais'`: SF/MST esclusi dalla posizione corrente e dal rischio. La **traccia singola** (`getShipTrack`/`getShipTrackRange`) e il **replay** (`getAreaReplayPositions`/`getAreaReplayRange`) accettano invece l'elenco `sources` e includono SF/MST quando il toggle *Includi SF/MST* è attivo. |
| **Storage SF/MST** | `src/db.js` → `insertScrapedPosition(mmsi, pos, source)` | Inserisce in `readings` con `source='sf'`/`'mst'`. Letto da `getLatestScrapedPosition(mmsi, source)`. |
| **Logica badge / fallback** | `src/routes/ships.js` → `scrapeBadgeAt()`, `scrapeFallbackFix()` | Il fix scrapato viene mostrato (badge o marker) solo se l'AIS è stantio **e** lo scrape è più recente; un fix AIS fresco lo nasconde. |
| **Soglia di freschezza** | `src/config.js` → `FOLLOW_FRESH_MS` (default 60 min) | Una nave è "stale" quando `now - last_seen_at > FOLLOW_FRESH_MS`. |
| **Auto-stop follow** | `src/config.js` → `FOLLOW_STALE_HOURS` (default 4320 h ≈ 6 mesi) | Dopo un silenzio così lungo il follow viene auto-fermato e spostato in "Seguite in passato". |
| **Ri-acquisizione stale via SF/MST** | `src/services/ship-follow.js` → `reacquireStaleViaShipfinder()` / `reacquireStaleViaMst()` | Ogni `FOLLOW_REFRESH_MS` (~5 min) scrapano le seguite stale e salvano i fix con `source='sf'/'mst'`. |

**In sintesi**: AIS è la fonte **primaria** per lo stato nave (rischio, posizione corrente) ed esclusiva per il rischio. SF e MST sono **fallback di sola visualizzazione**: appaiono come breadcrumb ambra/teal nel dettaglio, come **marker grigio sulla mappa delle navi seguite** quando l'AIS è andato silente, e — opzionalmente, col toggle *Includi SF/MST* — nella **traccia della singola nave** e nel **replay storico** dell'area; senza mai sovrascrivere la posizione AIS.

#### Pulsanti overlay mappa: etichette nome, scia recente, soglia di affollamento

Le mappe "Navi seguite" e "Navi presenti" condividono una piccola factory di pulsanti Leaflet (`public/js/maps.js` → `createMapToggleControl(map, buttons)`): un controllo in alto a destra con una icona per toggle, ogni bottone legato a un booleano `S[key]` persistito server-side. Ogni bottone è **solo icona** (🏷/〰): la spiegazione di cosa fa è un **overlay al passaggio del mouse**, non testo visibile accanto all'icona né il `title` nativo del browser — un'etichetta breve tipo "Nomi" accanto all'icona si era rivelata poco chiara. Il bottone porta `data-tip="<spiegazione>"` e riusa il **sistema di tooltip già esistente per le icone "ⓘ" di Equasis** (`initGlossaryTooltip()` in `public/js/main.js`, selettore esteso a `.map-toggle-buttons a[data-tip]`): un div fisso posizionato sotto/sopra l'elemento al `mouseover`, nessun nuovo componente.

- **Navi seguite** (`initFollowedMap`) — due pulsanti: **🏷** (`showFollowedShipNames`) e **〰** (`showFollowedTrails`, piccola scia — polilinea sottile dello stesso colore del marker, dietro di esso). `syncFollowedMapToggleButtons()` riallinea lo stato dei bottoni dopo il caricamento di `/api/settings`.
- **Navi presenti/area** (`initActiveMap`) — due pulsanti: **🏷** (`showActiveShipNames`, default **ON**) e **〰** (`showActiveTrails`, default **OFF** — un'area può avere molte più navi di un elenco seguite scelto a mano, quindi la scia parte disattivata). `syncActiveMapToggleButtons()` è l'equivalente per quest'area.

**Soglia di affollamento condivisa** (`ACTIVE_MAP_CROWD_THRESHOLD` = 20 navi plottate, in `maps.js`) governa entrambi i toggle dell'area map:

| Sotto soglia (≤20 navi) | Sopra soglia (>20 navi) |
|---|---|
| Nome: tooltip Leaflet **permanente** | Nome: tooltip **on-hover** (`permanent:false`, comportamento hover di default di Leaflet, nessun listener aggiuntivo) |
| Scia: polilinea disegnata per **tutte** le navi | Scia: **nessuna** polilinea fissa; disegnata **solo per la nave sotto il mouse** (`marker.on('mouseover'/'mouseout')`, un'unica polilinea transitoria tenuta in `activeHoverTrail`, rimossa al `mouseout` o al render successivo) |

Evita sovrapposizioni illeggibili nei porti affollati senza nascondere del tutto l'informazione: l'utente la recupera passando il mouse sulla singola nave.

Entrambe le etichette nome usano la stessa classe CSS `.ship-name-label`; i pulsanti condividono `.map-toggle-buttons`.

- **Sorgente dati scia** — `db.getRecentTrails(mmsis, limit, sinceIso, sources)` ([`src/db.js`](../../src/db.js)) è una funzione generica (rinominata da `getFollowedTrails`): una query batch con `ROW_NUMBER() OVER (PARTITION BY mmsi ...)` per l'intero gruppo di navi invece di N round-trip. `TRAIL_LIMIT`/`TRAIL_HOURS` (12 punti / 6h) e `trailSources()` (`['ais']` + `sf`/`mst` se abilitati) sono condivisi in [`src/routes/ships.js`](../../src/routes/ships.js) da entrambe le rotte:
  - `GET /api/ships/followed/active` allega sempre un campo `trail` a ogni nave seguita (elenco piccolo, nessun costo da evitare).
  - `GET /api/ships/active` calcola `trail` **solo se** la query string include `?trails=1` — il client la aggiunge quando `S.showActiveTrails` è attivo (`ships.js` → `loadActive()`), così la query batch extra non gira affatto quando il toggle (default off) resta spento.
- **Persistenza** — tutti e quattro i toggle (`showFollowedShipNames`, `showFollowedTrails`, `showActiveShipNames` default `true`; `showActiveTrails` default `false`) in `user_settings`, gestiti da [`src/services/user-prefs.js`](../../src/services/user-prefs.js) e propagati ai co-membri di gruppo come gli altri toggle di visualizzazione mappa ([`src/services/group-sync.js`](../../src/services/group-sync.js) `SHARED_SETTING_KEYS`). Nessun impatto sullo schema DB: sono righe key/value nella tabella esistente, non nuove colonne.
- **Nessun impatto su traccia/rischio** — puramente illustrativi: stesse query `readings` già usate altrove, nessuna nuova tabella.

### Arricchimento proattivo alla prima rilevazione

Oltre al caricamento on-demand nel dettaglio, l'arricchimento parte **automaticamente quando una nuova nave compare** sullo stream AIS, così lo [score di rischio](#arricchimento-dello-score-da-vfmt) può usare subito i dati di registro senza attendere l'apertura del dettaglio.

Flusso ([`src/services/enrichment.js`](../../src/services/enrichment.js)):

1. `db.insert` segnala la prima comparsa di un MMSI restituendo `{ arrivedFlagged, newShip }` (`newShip` = mmsi se l'MMSI non era mai stato visto).
2. In `ais-stream.js`, su `newShip` viene chiamato `enrichment.enrichNewShip(mmsi)`.
3. `enrichNewShip` interroga in background **solo le fonti abilitate** e salva il risultato in `ship_scrape_cache`.

Garanzie:

- **Una sola volta**: salta se esiste già cache per quella fonte, con guardia `inFlight` contro fetch concorrenti duplicati. Non riparte per navi già note (nemmeno dopo un riavvio).
- **Non bloccante**: fire-and-forget, nessun `await` nel loop di ingest AIS. Errori loggati (`[ENRICH:vf|mt]`), mai propagati.
- Se l'MMSI compare prima dei dati statici (IMO/callsign assenti), VF/MT risolvono comunque tramite MMSI.

#### Backfill all'abilitazione, ripristino e negative cache

- **Backfill al toggle**: abilitando VesselFinder o MarineTraffic dalle impostazioni (`POST /api/settings`), `enrichAllExisting(source)` arricchisce in background tutte le navi viste negli **ultimi 7 giorni** ancora prive di cache per quella fonte (una alla volta, 2 s di intervallo). Le due fonti sono indipendenti (cache per `mmsi`+`source`).
- **Il ripristino non riscrape**: applicare le impostazioni da un backup/bundle (`applyImportedSettings`) **non** lancia il backfill. I dati VF/MT vivono in `ship_scrape_cache`, che fa parte del backup del DB e viene ripristinato con esso — ri-scrapare ogni nave caricata sarebbe inutile e martellante. Il backfill resta solo sul toggle interattivo.
- **Negative cache** (`SCRAPE_NEG_CACHE_DAYS`, default 3 giorni): un lookup fallito (la fonte non conosce la nave — tipico delle navi senza IMO, cercate per MMSI → 404/redirect) non scrive nulla in `ship_scrape_cache`, quindi la nave resterebbe "senza cache" e verrebbe ri-contattata a **ogni** riabilitazione. Il fallimento viene perciò registrato in `ship_scrape_failures` (anch'essa nel backup); il backfill salta una nave il cui ultimo fallimento è più recente di `SCRAPE_NEG_CACHE_DAYS`, poi la ritenta. `0` = disabilitato (ritenta sempre). Un fetch riuscito cancella il marcatore.
- I redirect di VesselFinder verso percorsi **relativi** (es. `/vessels` per le navi sconosciute) vengono risolti contro l'URL corrente in `fetchHttp`, evitando l'errore `Invalid URL`.

### Lookup Equasis (proprietà/gestione, on-demand)

[Equasis](https://www.equasis.org/) è un database gratuito EU/US che espone i dati di **proprietà e gestione** della nave (registered owner, ISM manager, operator, DOC company) che l'AIS non trasmette e che VF/MT non offrono gratis. Lo scraper [`src/services/scrapers/equasis.js`](../../src/services/scrapers/equasis.js) (`crawlEquasis(imo)`) è volutamente **fuori** dal percorso di arricchimento proattivo: parte **solo** quando l'utente preme **Recupera informazioni Equasis** nel dettaglio.

Differenze rispetto a VF/MT:

- **Solo su richiesta**: nessun fetch automatico né alla comparsa né all'apertura del dettaglio. L'endpoint serve la cache; scrapa solo con `?fetch=1` (il pulsante).
- **Nessuna scadenza**: il risultato è salvato in `ship_scrape_cache` con source `eq` e mostrato per sempre (a differenza del TTL `SCRAPE_CACHE_TTL` di VF/MT). Dopo il primo recupero il pulsante sparisce.
- **Interroga per IMO**: Equasis è indicizzato solo per numero IMO; senza IMO il lookup fallisce con errore.
- **Login richiesto**: ogni query richiede una sessione autenticata, quindi servono `EQUASIS_USER` / `EQUASIS_PASSWORD`. Senza credenziali la feature resta nascosta/inutilizzabile (`equasisConfigured`).

Flusso (`crawlEquasis`, reverse-engineered): `POST /EquasisWeb/authen/HomePage` (`j_email`+`j_password`) → cookie di sessione → `POST /EquasisWeb/restricted/ShipInfo` (`P_IMO`) → HTML dettaglio. I cookie stanno in un jar temporaneo per la durata delle due chiamate. Come MarineTraffic, **usa `node-libcurl`** (nessuna dipendenza da `curl` di sistema). La pagina di dettaglio è divisa in sezioni commentate (`<!-- Overview -->`, `<!-- MGT DET -->`, `<!-- Classification -->`, `<!-- PI -->`, `<!-- Geo -->`, …), ognuna duplicata in markup desktop (`<table>`) e mobile (`hidden-md hidden-lg`): il parser usa sempre il desktop e ignora il duplicato. Estrae sei blocchi: `particulars` (nome/IMO dall'`<h4>` + bandiera, call sign, MMSI, tonnellaggi, tipo, anno, stato dai blocchi `<b>label</b>`), `management` (`parseManagement`, tabella *Management detail(s)* mappata per intestazione di colonna così da reggere i riordini di Equasis), `classification` (società, stato, data), `pi` (club P&I + inception), `risk` (tasso detenzioni 36 mesi, classe IACS, performance Paris/Tokyo MOU, targeting USCG dalla sezione *Overview*) e `positions` (ultime aree in cui la nave è stata vista).

**Log di audit**: ogni lookup (successo o errore) viene aggiunto in append a un file di testo `equasis.log` (root di progetto, gitignored) da [`src/services/equasis-log.js`](../../src/services/equasis-log.js): timestamp, MMSI, IMO, nome nave e i dati recuperati (o il messaggio d'errore). Il log è consultabile dalla UI col pulsante **Visualizza log Equasis** nelle impostazioni (endpoint `GET /api/equasis-log`, lettura tail-troncata a 256 KB; `DELETE /api/equasis-log` lo svuota).

### Arricchimento Global Fishing Watch

[Global Fishing Watch](https://globalfishingwatch.org/) (GFW) arricchisce ogni nave con l'**identità** (bandiera, IMO, MMSI, call sign, tipo, anno) e con gli **eventi comportamentali** che GFW ricava e classifica dal feed AIS globale: **incontri** (due navi che si incontrano in mare = firma di trasbordo ship-to-ship), **loitering** (sosta prolungata in mare aperto), **port visit** (scali ricostruiti) e **gap** (AIS spento in navigazione = "dark activity"). Poiché questi eventi sono già derivati dall'AIS e classificati da GFW, sono **conferme autorevoli** dei segnali comportamentali che l'app altrimenti inferisce per euristica dalle posizioni grezze, e alimentano direttamente lo [score di rischio](#-score-di-rischio-potenziale-trasporto-armi). Implementato in [`src/services/gfw.js`](../../src/services/gfw.js).

Il nome del porto negli **scali** (`normPortVisit`) a volte arriva da GFW come nome leggibile, a volte come un codice tipo UN/LOCODE quando l'ancoraggio non ha un nome noto: `portLabelWithCode` prova a risolverlo con la stessa anagrafica LOCODE usata per le destinazioni AIS (`src/services/locode.js`, `data/locode.json`), mostrando "Nome (CODICE)" quando il codice è riconosciuto; se non è un codice o non è in anagrafica, resta invariato. La trasformazione avviene **una volta, allo scrape** (persiste nel valore cache-ato) — le voci già in cache si aggiornano al prossimo refetch GFW (TTL 6h), non retroattivamente.

A differenza di VF/MT/Equasis/PSC, GFW è **attivo di default** (`IMPORT_GFW=true`). Come VF/MT, l'arricchimento è **proattivo**: parte in background alla prima rilevazione della nave e fa il backfill delle navi esistenti alla prima attivazione, con cache nella stessa `ship_scrape_cache` (source code `gfw`). Il **ripristino** di un backup **non** ri-scarica i dati (sono già nel DB ripristinato), esattamente come VF/MT.

- **Token API (non username/password)**: serve un token Bearer GFW configurato in `local.properties` come `GLOBAL_FISHING_WATCH_TOKEN`, generato dal [portale API GFW](https://globalfishingwatch.org/our-apis/). Senza token la feature fa silenziosamente no-op e il pannello impostazioni mostra l'avviso "token non configurato".
- **Licenza non commerciale**: i dati GFW sono gratuiti **solo per uso non commerciale** (ricerca, ONG, interesse pubblico); l'uso commerciale richiede una licenza dedicata da GFW.
- **Copertura**: GFW traccia soprattutto navi da **pesca, di supporto e reefer/carrier** — molte navi mercantili semplicemente non sono in GFW (il pannello di dettaglio mostra una nota "non trovata in GFW" per queste).

Nel dettaglio nave compare un tab **Global Fishing Watch** (quando abilitato): mostra la tabella di identità e le tabelle eventi (incontri, loitering, port visit, AIS spento), con un'icona ⓘ al hover su ogni campo/sezione che ne spiega il significato. Ogni tabella evento è ordinabile per colonna (default: data, più recenti prima) e paginata lato client (10 righe/pagina) — `gfw.js` pagina già a monte la risposta dell'API GFW (vedi `EVENT_MAX_TOTAL`/`fetchEvents`, che segue il `nextOffset` di GFW invece di fermarsi alla prima pagina), quindi anche una nave molto attiva arriva al frontend con la storia comportamentale completa.

### Dati nave aggregati (cross-provider)

Il tab **Generale** del dettaglio nave mostra anche una tabella che riconcilia i campi identità/specifiche (nome, IMO, MMSI, call sign, bandiera, tipo, anno, lunghezza, larghezza, pescaggio, GT, DWT, porto di armamento) tra **tutte** le fonti abilitate, in modo che non serva aprire ogni tab per confrontarli. Logica in `public/js/ships.js` (`buildAggregateRows`/`renderAggregateTable`), lato client, sui dati già caricati per il dettaglio:

- **Estrazione per provider**: un extractor per fonte legge le rispettive chiavi. VF è open-set (le etichette scrapate variano pagina per pagina) → matching per etichetta normalizzata (`scrapeGet`/`scrapeNormLabel`, stesso meccanismo di `SCRAPE_LABEL_GLOSSARY`). MT/SF/MST/Equasis usano chiavi fisse (`MT_FIELD_LABELS`, i `put()` di `shipfinder.js`/`myshiptracking.js`, `particulars` di Equasis) → lookup diretto. GFW usa l'oggetto `identity` già strutturato.
- **Campi volutamente esclusi**: destinazione, ETA, pescaggio corrente, stato di navigazione — dati che cambiano spesso e che le fonti scrapano in momenti diversi: confrontarli produrrebbe falsi "conflitti" dovuti solo alla staleness, non un vero disaccordo.
- **Normalizzazione per il confronto** (il valore mostrato resta sempre quello grezzo): bandiera → nome canonico via `Intl.DisplayNames` per i codici ISO alpha-2, una piccola tabella alpha-3→nome (`AGG_ISO3_TO_NAME`, stesso scope volutamente limitato di `ISO3_TO_NAME` in `gfw.js` — un codice non mappato fallisce "al sicuro": mostra una fonte in più invece di fondere per errore due bandiere diverse); numerici (`length`/`beam`/`draught`/`year`/`gt`/`dwt`) → arrotondati prima del confronto, così "202.80" e "203" coincidono.
- **Raggruppamento**: i valori con lo stesso normalizzato finiscono in un unico chip, con un pallino per ogni fonte che lo riporta; i normalizzati diversi restano chip separati sulla stessa riga, con un leggero tint di sfondo (`.agg-conflict`) a segnalare il disaccordo.
- I pallini riusano gli stessi 6 colori delle sezioni provider (`.src-dot--vf/mt/sf/mst/eq/gfw` in `style.css`) e mostrano il nome della fonte al passaggio del mouse (stesso sistema di tooltip `data-tip` di `initGlossaryTooltip`).

## 🤝 Rilevamento rendezvous nave-nave

Un **rendezvous** in mare aperto — due navi distinte ferme l'una accanto all'altra al largo — è la firma classica del **trasbordo ship-to-ship** (transshipment). A differenza degli incontri segnalati da Global Fishing Watch (che arricchisce solo le navi interrogate), questo rilevamento è **locale e gratuito**: usa il nostro stesso feed AISstream, senza API esterne. Implementato in [`src/services/proximity.js`](../../src/services/proximity.js).

**Scansione.** Un job periodico ([`proximity.init`](../../src/services/proximity.js), avviato da `src/server.js`) gira ogni `PROXIMITY_SCAN_MIN` minuti (default 10; `0` disattiva). Per ogni area considera le navi con un fix recente (`PROXIMITY_FRESH_MIN`) e ne tiene solo le coppie che soddisfano **tutte** queste condizioni — deliberatamente conservative per ridurre i falsi positivi:

- entrambe **lente**: SOG < `PROXIMITY_MAX_SOG_KN` (default 3 kn — una nave veloce sta solo transitando);
- entrambe **non** ormeggiate/all'ancora (stato di navigazione ≠ 1, 5);
- entrambe **fuori da un porto noto**: oltre `PROXIMITY_BERTH_M` metri (default 600) da ogni centroide di berth calcolato per l'area — i berth sono cluster di navi ormeggiate, cioè i porti reali, quindi è il segnale corretto per escludere i rendezvous in banchina (dove le navi sono naturalmente vicine), indipendentemente da dove cade il porto dentro il bbox. Per le aree senza berth ancora calcolati si usa come ripiego la vecchia soglia `PROXIMITY_FAR_KM` km dal centro del bbox (default 10);
- coppia entro `PROXIMITY_DIST_M` metri (default 500).

**Macchina a stati (tabella `proximity_events`, coppia canonica `mmsi_a < mmsi_b`).** Un contatto **si apre** quando una coppia entra entro `PROXIMITY_DIST_M`; **resta aperto** finché la coppia è entro `PROXIMITY_DIST_M × PROXIMITY_CLOSE_MULT` (isteresi: un singolo fix rumoroso non lo chiude di colpo); **si chiude** quando la coppia si separa o una nave lascia l'area / diventa silente. Alla prima scansione in cui la permanenza del contatto raggiunge `PROXIMITY_MIN_MINUTES` (default 10) scatta **una sola** notifica e il contatto è marcato come confermato (`alerted`).

**Notifica** (tipo `proximity`, vedi [Notifiche](#-notifiche)) — in-app + Telegram, con una **mappa statica a due pin** uniti da una linea (resa server-side, [`static-map.js`](../../src/services/static-map.js) estesa per più punti) centrata sul punto medio, più il link "apri in mappa". Controllata da `notifyProximity` (in-app) e `telegramNotifyProximity` (Telegram), indipendenti.

**Score di rischio** — un rendezvous confermato aggiunge `RISK_PROXIMITY_POINTS` (default 18) allo score di **entrambe** le navi, per i rendezvous nella finestra `RISK_PROXIMITY_WINDOW_DAYS` (default 7 giorni); il fattore conta le navi-partner distinte. `RISK_PROXIMITY_POINTS=0` disattiva il fattore lasciando attiva la scansione (e quindi lo storico). Vedi [Score di rischio](#%EF%B8%8F-score-di-rischio-potenziale-trasporto-armi).

**Dettaglio nave** — una sezione **Rendezvous in mare** elenca gli incontri confermati della nave (altra nave, data/ora, distanza minima, area); ogni riga è cliccabile e apre la scheda della nave-partner.

## 🔎 Cerca e segui una nave

Nella scheda **Navi seguite** una barra di ricerca permette di cercare una nave per **nome** o **MMSI/IMO** e aggiungerla alle seguite anche se non è mai passata dalle aree monitorate. Il flusso è in due passi:

1. **Candidati** (`GET /api/ships/search/candidates?q=`) — ricerca veloce in JSON sulla flotta **locale** (`db.searchShipsByName`: MMSI/IMO esatto, oppure nome LIKE) **+ MarineTraffic** (`searchMt` → endpoint `global_search`, [`src/services/scrapers/marinetraffic.js`](../../src/services/scrapers/marinetraffic.js)). Se il nome corrisponde a più navi, l'utente sceglie da una lista; con un MMSI a 9 cifre si va dritti al recupero. La risoluzione nome→MMSI per navi **non** locali dipende da MarineTraffic attivo (VF/GFW interrogano solo per IMO/MMSI).

2. **Recupero** (`GET /api/ships/search/recover?mmsi=…` — **SSE**) — uno stream Server-Sent Events che apre la finestra dei risultati con un **loading** e la riempie **man mano** che ogni fonte risponde: eventi `identity` (DB locale + score di rischio se nota), `source` (VF/MT/GFW, con badge trovato/assente/errore), `screening` (sanzioni OpenSanctions/OFAC, banditi PSC, performance bandiera), `position` e `timeout`. Le scansioni delle fonti girano in parallelo e ognuna emette il suo evento appena pronta.

**Recupero della posizione live.** Né VF né MT espongono coordinate: la posizione live arriva da **AISstream**. Lo stream `follow` condiviso ([`src/services/ship-follow.js`](../../src/services/ship-follow.js)) viene esteso con un **lookup transitorio**: l'MMSI cercato viene iniettato nella sottoscrizione con un **bounding box mondiale** `[[-90,-180],[90,180]]` + `FiltersShipMMSI`. Poiché AISstream applica il filtro MMSI **lato server**, il box mondiale costa solo i frame di quella nave — si recupera così la posizione di qualsiasi nave che stia trasmettendo, ovunque si trovi, senza sapere prima dov'è. Al primo fix la posizione compare su una mini-mappa e si abilita **🗺 Segui nave**. Se la nave è già stata vista localmente, l'ultima posizione nota viene mostrata subito (e il lookup la aggiorna con un frame live).

- **Cancel = stop.** La finestra resta aperta durante il recupero; chiuderla (X, **Annulla**, click fuori, Esc) **chiude la connessione SSE**, e il `req.on('close')` lato server **rimuove il lookup** e ri-sottoscrive lo stream senza quel box mondiale. Nessuna sottoscrizione worldwide resta appesa.
- **Timeout.** Senza fix entro `SEARCH_LOOKUP_TIMEOUT_SEC` (default 90 s) il lookup viene rimosso e la UI mostra "la nave non sta trasmettendo o è fuori copertura" con un pulsante **Riprova**.
- **Segui.** Cliccando 🗺 si fa `PATCH /api/ships/:mmsi/follow`: poiché ora la nave ha una posizione, la normale macchina di follow la riprende con il box stretto da 0.5°.

Lato client è tutto in [`public/js/search.js`](../../public/js/search.js) (modale dedicata `#search-modal`, `EventSource`, mini-mappa Leaflet).

### Ri-seguire una nave dalle "passate" (ri-acquisizione in background)

Quando segui una nave di cui **non** abbiamo una posizione live recente (tipicamente un **ri-follow** dalla lista "Seguite in passato": è finita lì perché silente oltre la soglia di auto-stop `FOLLOW_STALE_HOURS`, default ~6 mesi), il box di follow stretto da 0.5° non basta — la nave ha quasi certamente lasciato quella zona. Il `PATCH /api/ships/:mmsi/follow` imposta subito il follow (icona 🗺 selezionata, nave nelle "attualmente seguite") e avvia una **ri-acquisizione in background** ([`shipFollow.startReacquire`](../../src/services/ship-follow.js)): la stessa ricerca worldwide del box di ricerca, ma server-side e senza UI.

- Una nave è considerata "fresca" (nessuna ri-acquisizione) se la sua ultima posizione è più recente di `FOLLOW_FRESH_MIN` (default 60 min); altrimenti parte la ri-acquisizione.
- Al **primo fix** la ri-acquisizione termina in silenzio e il follow prosegue normalmente (box stretto attorno alla posizione fresca).
- Se entro `SEARCH_LOOKUP_TIMEOUT_SEC` (default 90 s) **non** arriva alcun segnale, il follow viene **annullato** (la nave torna tra le "passate") e l'utente riceve una **notifica in-app** `follow_lost` (+ Telegram se collegato). Il successo è silenzioso.
- Perché il follow ottimistico non venga annullato all'istante dallo sweep di auto-stop, ri-seguire **ripristina `follow_started_at`** e l'auto-stop richiede ora che *sia* la posizione *sia* l'inizio del follow siano più vecchi della soglia (finestra di grazia). Questo correggeva anche un bug per cui ri-seguire una nave "passata" la faceva rimbalzare subito indietro.

**Nessuna connessione worldwide resta appesa**: ogni lookup worldwide (ricerca o ri-acquisizione) ha un **timer di teardown garantito** entro `SEARCH_LOOKUP_TIMEOUT_SEC` che lo rimuove anche se è già arrivato un fix o se il client resta aperto; il `refresh()` periodico (5 min) riconcilia comunque la sottoscrizione dalle sole navi seguite + lookup attivi, e quando non resta nulla la WebSocket viene chiusa.

### Ri-acquisizione continua delle navi seguite uscite dalla copertura

Il box di follow stretto da 0.5° è **centrato sull'ultima posizione nota**: se una nave seguita resta in silenzio (buco di copertura AIS) e poi **ri-trasmette fuori da quel box** — perché nel frattempo si è spostata, o perché era proprio uscita dalla footprint dei ricevitori AISstream — i suoi frame non corrisponderebbero più ad alcun box e il follow resterebbe "morto" fino all'auto-stop (`FOLLOW_STALE_HOURS`, default ~6 mesi). Per evitarlo, [`buildSubscription`](../../src/services/ship-follow.js) tiene **aperta una rete worldwide anche per le navi seguite stantie**, non solo per i lookup transitori di ricerca/ri-follow:

- Una nave seguita è considerata **stantia** quando la sua ultima posizione è più vecchia di `FOLLOW_FRESH_MIN` (60 min). Per queste si **abbandona il box stretto** (inutile, punta a una posizione vecchia) e si aggiunge il **box mondiale** `[[-90,-180],[90,180]]`; il loro MMSI è già nell'allow-list `FiltersShipMMSI`, quindi vengono ri-agganciate ovunque ri-trasmettano. Le navi **fresche** mantengono il box stretto da 0.5°.
- Poiché AISstream applica il filtro MMSI **lato server**, il box mondiale costa **solo i frame di quelle navi** → overhead trascurabile, nessuna chiamata esterna (VF/MT non espongono coordinate gratis).
- Al **primo fix** la nave torna fresca e al `refresh()` successivo (5 min) rientra automaticamente nel box stretto attorno alla nuova posizione. Resta sul net worldwide e auto-recuperabile finché non supera `FOLLOW_STALE_HOURS` (default **~6 mesi**, `num('FOLLOW_STALE_HOURS', 4320)`) di silenzio totale: solo allora scatta l'auto-stop e finisce in "passate". Soglia deliberatamente lunga — abbatte solo i follow morti, non i buchi di copertura.
- Il numero di navi attualmente in ri-acquisizione worldwide è esposto come `staleCount` in `getStatus`/`getHealth` e annotato nei log `subscribe`/`heartbeat` dello stream follow.

> ⚠️ **Limite intrinseco.** Se una nave è davvero **fuori dalla copertura dei ricevitori AISstream** (mare aperto senza copertura satellitare nel piano in uso), nessun box la recupera: AISstream non riceve i suoi frame, punti dove punti. Questa ri-acquisizione risolve il caso "buco temporaneo / nave migrata fuori dal box stretto", non l'assenza totale di copertura. Recuperare la posizione da fonti terze (VesselFinder/MarineTraffic) richiederebbe le loro **API a pagamento** — gli endpoint gratuiti restituiscono timestamp/rotta/velocità/destinazione ma **mai le coordinate**.

## 🔀 Ricerca navi per aree di transito

Scoperta di navi che collegano due aree monitorate, anche mai seguite: `public/js/transits.js` (vista `#transits`, aperta dal bottone in **Navi seguite**), rotta `src/routes/transits.js`, motore `db.getAreaTransits(areaA, areaB, sinceIso)`.

**Perché sugli eventi porto e non sulle posizioni.** `readings` ha un tetto globale per tipo messaggio (`MAX_READINGS_PER_TYPE`, default 10.000) e viene potato di continuo: copre giorni, non mesi. `port_events` invece **non ha retention temporale** — è l'unico storico lungo disponibile, quindi conteggi e tragitti si ricostruiscono da lì.

**Visita** = un `arrived` più il primo `departed` successivo nella stessa area (o ancora aperta, se la nave è lì adesso).

**Sosta** (la visita era una destinazione, non un attraversamento della bbox):

- se la partenza porta l'evidenza misurata (colonne `port_events.stop_min_sog` / `stopped`, scritte da `checkAndLogDepartures` quando le posizioni della visita sono ancora in DB) vale quella: permanenza ≥ `TRANSIT_STOP_MIN_H` **e** velocità minima ≤ `TRANSIT_STOP_MAX_SOG_KN`;
- altrimenti decide la sola permanenza ≥ `TRANSIT_STOP_MIN_H`. `stopped` è **nullable**: NULL significa "non misurato" (righe precedenti a questa versione o posizioni già potate), non "non si è fermata".

**Tragitto (leg)** = due soste consecutive nelle due aree scelte, senza soste in **nessun'altra** area del catalogo nel mezzo (i `port_events` sono globali: si considerano anche le aree di altri utenti), con tempo trascorso entro il gate di `db.areaHopGate(a, b)`:

```
gateH = min( max(TRANSIT_MIN_SLACK_H, distanza_nm / TRANSIT_MIN_KN), TRANSIT_MAX_GAP_DAYS × 24 )
```

`TRANSIT_MIN_KN` (4 kn) è molto sotto la velocità di crociera reale, così un viaggio con scali intermedi passa comunque; il pavimento evita soglie di minuti fra aree vicine; il tetto impedisce di considerare "diretta" una tratta a mesi di distanza. **Lo stesso gate alimenta il filtro della notifica cambio area**, così i due criteri non possono divergere.

**Rotta.** `GET /api/transits?a=KEY&b=KEY&period=all|12m|6m|3m|30d&includeNoLeg=0|1` — 400 se le aree mancano o coincidono, 403 se l'utente non monitora entrambe. Risponde con le navi decorate come nelle altre liste (`flagged`/`seen`/`followed`/`risk`/`chargedBy` in query batch), ordinate per numero di tragitti, `truncated` oltre `TRANSIT_MAX_ROWS`. Di default sono escluse le navi con zero tragitti (`includeNoLeg=1` le include).

**Replay del tragitto** — il bottone **▶ Tragitto** apre `#modal-overlay` con una mappa Leaflet (creata una volta e ri-agganciata a ogni apertura, per non lasciare istanze morte nel registro layer di `tiles.js`) e riusa `GET /api/ships/:mmsi/track?from&to&scraped=1`. I segmenti con buco temporale oltre `REPLAY_MAX_GAP_MIN` sono disegnati **tratteggiati in grigio** ed etichettati come stimati: fuori dalle aree monitorate non esistono posizioni, quindi la rotta d'altura è una retta ipotetica.

**Visibilità.** `canSeeShip` (in `src/routes/ships.js`) accetta anche le navi con uno scalo registrato in un'area dell'utente (`db.hasShipAreaHistory`): una nave scoperta qui può trovarsi ovunque nel mondo, e senza questo il suo dettaglio risponderebbe 404.

## 📋 Eventi porto, statistiche e alert

**Eventi porto** (tabella `port_events`) — il backend rileva automaticamente:
- **Arrivo** (`arrived`): una nave compare dopo > 60 minuti di assenza (o per la prima volta).
- **Partenza** (`departed`): rilevata da `checkAndLogDepartures`, che marca come partite le navi il cui ultimo contatto è più vecchio di **60 minuti** e per cui non è già stata registrata una partenza relativa a quella sosta (dedup su `port_events.ts >= ships.last_seen_at`). La vecchia finestra fissa `-62…-60 minuti` **perdeva** le partenze avvenute durante un downtime del server più lungo di 2 minuti; ora vengono recuperate. **Nota:** al primo avvio dopo questo aggiornamento (o dopo l'import di un DB precedente) viene registrato un **burst una-tantum** di partenze per tutte le navi assenti mai marcate prima — è dato corretto recuperato, non genera notifiche.

**Statistiche** (`/api/stats`, vista Traffico) — arrivi oggi / settimana / totali, durata media di sosta (accoppiando ogni arrivo con la partenza successiva), distribuzione arrivi per ora del giorno e per tipo nave.

**Score aggregati** (`/api/stats/scores`, vista Traffico) — calcolati sulle navi viste negli ultimi 7 giorni: distribuzione per fascia di rischio (`byBand`), top 8 navi per score (`topShips`), fattori più frequenti tra tutte le navi (`byFactor`), serie storica arrivi giornalieri ultimi 30 giorni (`dailyArrivals`). Il calcolo invoca `computeRiskScore` per ogni nave della finestra, quindi il tempo di risposta scala con il numero di navi recenti.

**Navi attese** (`/api/ships/expected`) — navi con `destination` contenente la keyword del preset corrente (es. `TARANTO`), uscite dall'area nelle ultime 48 ore — utili per anticipare arrivi.

**Alert navi segnalate** (`/api/alerts`) — quando una nave con flag ★ (segnalata) rientra nell'area, l'arrivo viene accodato e mostrato come toast nel frontend al polling successivo.

**Notifiche** (tabella `notifications`, `/api/notifications`) — storico persistente mostrato in una **finestra overlay** (stesso `#modal-overlay` usato per il dettaglio lettura/banchina/restore backup, quindi già responsive su mobile) aperta dal bottone **🔔 Notifiche** nella barra laterale; il bottone porta solo il badge non-lette, il contenuto si carica ad ogni apertura (nessun refresh mentre resta aperta). Sei tipi di notifica vengono generati (tutti abilitabili/disabilitabili indipendentemente dalle Impostazioni, oltre all'interruttore generale `notificationsEnabled`):

- `revisit` — una nave **già arrivata in passato nella stessa area** vi rientra dopo un'assenza (`db.insert` ritorna `revisit`); controllata da `notifyRevisit` / `NOTIFY_REVISIT`.
- `area_change` — una nave che ha fatto **scalo** in un'area viene poi rilevata in un'**altra** area (`db.insert` ritorna `areaChange` confrontando `last_area` della nave con l'area del messaggio prima dell'upsert); la notifica memorizza l'area di partenza in `from_area` e quella di arrivo in `area`; controllata da `notifyAreaChange` / `NOTIFY_AREA_CHANGE`.

  Prima del fan-out, `ais-stream.js` scarta l'evento in tre casi, in quest'ordine (ognuno verrebbe altrimenti riportato col motivo sbagliato da quello dopo). Ogni scarto finisce nel log attività col suo motivo:

  | Motivo | Condizione | Perché |
  |---|---|---|
  | `overlap` | `areaChange.overlappingAreas` (`db.boxesOverlap`), disattivabile con `AREA_CHANGE_SKIP_OVERLAPPING=false` | Due bbox che si intersecano contengono le stesse posizioni: l'area attribuita dipende da quale sottoscrizione ha consegnato il messaggio, e una nave ormeggiata nella parte comune "cambia area" stando ferma |
  | `transito` | `!areaChange.fromWasStop` (`db.lastAreaVisitWasStop`), disattivabile con `AREA_CHANGE_REQUIRE_STOP=false` | Un'area è un rettangolo di interesse largo anche centinaia di km: annunciare "spostata da X" per una nave che X l'ha solo attraversata afferma uno scalo mai avvenuto. Richiede evidenza positiva: senza un arrivo registrato a cui puntare, l'evento viene scartato |
  | `stale` | `!areaChange.timePlausible` (gate di `db.areaHopGate`, vedi [Ricerca navi per aree di transito](#-ricerca-navi-per-aree-di-transito)), disattivabile con `AREA_CHANGE_REQUIRE_PLAUSIBLE_TIME=false` | Lo scalo di partenza è troppo vecchio per spiegare la presenza attuale: quel che la nave ha fatto nel frattempo è successo fuori dalle aree monitorate, quindi la provenienza non è nostra da dichiarare |

  I destinatari restano quelli di `db.getUsersWithBothAreas` (serve monitorare **entrambe** le aree per chiave): i due meccanismi sono complementari — uno decide *se l'evento esiste*, l'altro *a chi va*.
- `high_risk` — una nave **arriva** (nuova o dopo > 60 min di assenza, `db.insert` ritorna `arrived`) con **score di rischio in fascia rossa** (71–100); controllata da `notifyHighRisk` / `NOTIFY_HIGH_RISK`. Utile per il triage immediato dei casi critici senza aspettare la vista Traffico.
- `berth_new` — durante il ricalcolo banchine (`berths.recomputeArea`) viene rilevata una **nuova banchina automatica** (cluster senza identità ereditata); controllata da `notifyBerthNew` / `NOTIFY_BERTH_NEW`.
- `berth_characterized` — una banchina (automatica o manuale) viene **caratterizzata per la prima volta** (il `char_label` calcolato passa da `NULL` a una categoria); la categoria è memorizzata in `band`; controllata da `notifyBerthChar` / `NOTIFY_BERTH_CHAR`.
- `proximity` — rilevato un **rendezvous nave-nave** confermato (due navi vicine, lente e al largo per ≥ `PROXIMITY_MIN_MINUTES`, vedi [sezione dedicata](#-rilevamento-rendezvous-nave-nave)); generato da `proximity.scanArea`, memorizza il punto medio in `berth_lat`/`berth_lon` e i due nomi in `ship_name` (`A ↔ B`); controllata da `notifyProximity` (in-app) / `telegramNotifyProximity` (Telegram).

Per le notifiche nave `ais-stream` calcola lo score e chiama `db.addNotification` (le navi con `notif_muted` sono escluse); per le notifiche banchina è `berths.recomputeArea` a chiamarlo, memorizzando in `berth_id` la banchina di riferimento per la navigazione. Il primo ricalcolo su un'area senza banchine preesistenti **non** genera notifiche (per evitare una raffica di "nuova banchina" sul backfill iniziale). Ogni notifica nave conserva la fascia di rischio (`band`) e lo `score` calcolati al momento dell'evento, mostrati come bollino verde/giallo/rosso; le notifiche banchina mostrano un bollino dedicato. Un **clic** su una notifica nave apre la scheda della nave, su una notifica banchina porta alla mappa dell'area corrispondente con la banchina centrata. Endpoint: `GET /api/notifications` (lista + conteggio non lette), `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`, `DELETE /api/notifications/:id` (singola), `DELETE /api/notifications` (tutte) — tutti accettano `?kind=personal|group` (default `personal`) perché la stessa tabella/API serve **anche** il feed "Attività del gruppo" (vedi [Gruppi di utenti](#-gruppi-di-utenti)): sono due liste indipendenti (badge, overlay e retention delle ultime 100 separati — `actor_id`/`target_user_id` sono valorizzate solo sulle righe `group_*`).

**Filtro per tipo nave e per navi "viste"** (tab Impostazioni → **Notifiche**, [`src/services/notify-categories.js`](../../src/services/notify-categories.js)) — si applica alle quattro notifiche **legate a una nave** (`revisit`, `area_change`, `high_risk`, `proximity`), non a quelle di banchina. Due preferenze per-utente in `user-prefs.js`:

- `notifyShipTypesHidden` (array, default vuoto = tutte attive) — categorie nave da **escludere**: `cargo`, `container`, `tanker`, `passenger`, `fishing`, `highspeed`, `sailing_pleasure`, `tug_service`, `coastguard`, `military`, `other`. Categoria risolta da `categoryOf(ship)`: codice AIS grezzo per la maggior parte dei bucket; `container` vs `cargo` (AIS 70–79) usa la stessa cache VF/MT di `cargo-type.js` (nessuna chiamata di rete nel path caldo delle notifiche) — una nave appena arrivata senza ancora arricchimento VF/MT ricade su `cargo` finché non viene arricchita. `coastguard` (AIS 55) e `military` (AIS 35 / flag manuale / prefisso nome, stessa `isMilitary()` dello score) sono **categorie distinte apposta**: una motovedetta non forza score 100 come una nave militare vera. Resolver indipendente da `services/ship-categories.js` (quello delle statistiche banchine, non toccato). Per un **rendezvous** (2 navi) basta che una delle due sia di categoria attiva.
- `notifyIncludeSeen` (bool, default `true`) — a `false` sopprime le stesse quattro notifiche per le navi che l'utente ha marcato "vista" 👁 (`db.isUserSeen`, tabella `user_seen` per-utente, vedi [Dati per-utente vs globali](#dati-per-utente-vs-globali)).

Il gate combinato (`shouldNotifyShip`) è invocato **una sola volta per (utente, evento)** e vale uniformemente sia per la notifica in-app sia per Telegram/webhook — vedi [Notifiche Telegram](#-notifiche-telegram). **Diverso da `excludeTankers`** (Impostazioni → Modello di rischio, admin/globale): quello azzera il fattore "tipo carico" nello **score condiviso** da tutti; questo filtro è **personale** e agisce solo su cosa arriva a te come notifica, senza toccare lo score — i due non sono ridondanti.

**Eliminazione con annullamento** — sia la singola notifica (cestino 🗑 sulla riga) sia il pulsante **🗑 cancella tutte** (nella toolbar in cima all'overlay) eliminano con una **finestra di annullamento** (toast "↶ Annulla") prima che la cancellazione diventi effettiva. La durata del bounce è configurabile in `app.config.properties` con `NOTIF_DELETE_UNDO_SECONDS` (default 5 s; `0` = eliminazione immediata) ed è esposta al frontend via `/api/config`.

### 📲 Notifiche Telegram

Oltre al feed in sidebar, ogni utente può ricevere le proprie notifiche su **Telegram** tramite un bot. Un solo bot (token `TELEGRAM_BOT_TOKEN` in `local.properties`, creato con [@BotFather](https://t.me/BotFather)) serve tutti gli utenti; senza token la feature è inerte. Il backend riceve i messaggi in **long-polling** (`getUpdates`) — nessun URL pubblico né webhook, funziona dietro NAT accanto agli stream AIS (`src/services/telegram.js`, avviato in `server.js`).

- **Collegamento** — dalle **Impostazioni → tab Telegram** l'utente preme "Collega": il backend genera un codice monouso (`user_settings.telegramLinkCode`) e un deep link `https://t.me/<bot>?start=<codice>`. L'utente avvia il bot; il backend mappa il codice → utente e salva il `chat_id` in `user_settings.telegramChatId`. `/stop` (o il pulsante "Scollega") azzera il collegamento. Se l'utente blocca il bot, l'invio fallito con 403 scollega automaticamente.
- **Toggle per categoria** — indipendenti dalle notifiche in-sidebar (un utente può ricevere una categoria su Telegram anche con quella in-app spenta, e viceversa). Master per-utente `telegramEnabled` + sette categorie: score alto, rientro nave, cambio area, nuova banchina, caratterizzazione banchina, **disservizio AIS** (outage, evento globale verso tutti gli utenti collegati col toggle attivo) e **avvio/stop monitoraggio area** (quando l'utente aggiunge/rimuove una propria area) — più altre **sei categorie** per le [notifiche "Attività del gruppo"](#-gruppi-di-utenti) (`telegramNotifyGroupArea` ecc., solo per chi è in un gruppo). Persistiti come preferenze per-utente (`telegramNotify*`). Le quattro categorie **legate a una nave** (score alto, rientro, cambio area, rendezvous) seguono **anche** il filtro per tipo nave e il flag "vista" del tab Notifiche (vedi sopra) — sono lo stesso gate della notifica in-app, non un filtro separato; nuova banchina/caratterizzazione/outage/avvio-stop monitoraggio non sono legate a una nave e non sono filtrate.
- **Lingua** — ogni messaggio è reso nella lingua dell'utente (`it`/`en`).
- **Mappa del punto** (`telegramSendMap`, default on) — per le notifiche con coordinate (banchine e navi) il bot allega un'**immagine statica della mappa** centrata sul punto. La mappa è renderizzata server-side da `src/services/static-map.js`: cuce le tile raster di base OpenStreetMap (le stesse del client, vedi `public/js/tiles.js`) in un PNG con `pngjs`. L'**overlay nautico OpenSeaMap è disattivato** in questi screenshot (i suoi simboli intasano una mappa di notifica piccola; il render lo supporta comunque via l'opzione `seamark`, usata altrove) (puro JS, nessun build nativo né browser headless né API key), disegna il marker e lo carica con `sendPhoto` (multipart). Render fallito → fallback automatico a solo testo. Le notifiche fanno fan-out per-utente, quindi quattro accorgimenti contengono il costo: (A) **riuso del `file_id`** — il primo destinatario carica i byte, gli altri riusano il `file_id` Telegram (nessun re-render né re-upload; dedup in-burst via promise condivisa); (B) **cache delle tile** decodificate (LRU+TTL, rispetta la tile usage policy di OSM evitando refetch massivi); (C) **cache della mappa renderizzata** per coordinate arrotondate+zoom; (D) **limite di concorrenza** sui render (max 2) per contenere i picchi di CPU/RAM.
- **Posizione e dati compatti** — invece del vecchio **segnaposto nativo** (`sendVenue`/`sendLocation`, un secondo grande widget-mappa ridondante con lo screenshot), ogni notifica con coordinate include una riga **📍 Apri in mappa** — un link `https://www.google.com/maps?q=lat,lon` tappabile che apre l'app mappe del dispositivo (una sola notifica, navigazione con un tap). Le notifiche **nave** (score alto, rientro, cambio area) arricchiscono inoltre la caption — senza appesantirla — con: **bandiera** (emoji ricavata dal MID dell'MMSI), **tipo nave** (es. Cargo/Tanker, ☢ se Hazmat), **motivo del rischio** (il fattore col peso più alto dal risk score, reso nella lingua del destinatario) e **cinematica + destinazione** (SOG/COG → porto dichiarato). Ogni riga compare solo se il dato è presente. Bandiera e tipo: `src/services/vessel-format.js` (`flagEmoji`, `shipTypeLabel`).
- **Pulsanti azione (Segui / Segnala)** — le notifiche **nave** (score alto, rientro, cambio area) allegano una **inline keyboard** con due azioni one-tap: **🛰️ Segui** (aggiunge la nave alle navi seguite via `shipFollow.applyFollow` — lo **stesso** helper del bottone web, riacquisizione worldwide inclusa) e **⭐ Segnala** (flag, come la stellina della lista). `callback_data` codifica azione+MMSI (`f:<mmsi>` / `s:<mmsi>`, ben sotto il limite di 64 byte) e le etichette dei pulsanti sono **stateful** (mostrano già "✅ Seguita"/"⭐ Segnalata" se la nave lo è già per quell'utente). Il tap arriva come `callback_query` sullo **stesso long-poll** delle notifiche (`getUpdates` con `allowed_updates: ['message','callback_query']`, nessun webhook/URL pubblico): `handleCallback` risolve l'utente dal `chat_id`, applica l'azione (**solo aggiunta**, idempotente), risponde con `answerCallbackQuery` (toast di conferma) e aggiorna la tastiera con `editMessageReplyMarkup`. La logica del follow è condivisa con la route HTTP (`shipFollow.applyFollow`); il `require('./ship-follow')` è **lazy** dentro `handleCallback` per rompere il ciclo di require ship-follow ⇆ telegram. Reply markup passato anche da `sendPhoto` (campo multipart) per i messaggi con mappa.
- **API** — `GET /api/telegram` (stato + toggle), `POST /api/telegram/link` (genera codice), `POST /api/telegram/unlink`, `POST /api/telegram/settings` (toggle), `POST /api/telegram/test` (messaggio di prova).

Il token sta solo in `local.properties` (gitignored, **non** nei backup, resta per-deployment); il `chat_id` e i toggle sono in `user_settings` e quindi inclusi nei backup.

### 🔗 Webhook in uscita

Oltre a Telegram, ogni utente può inoltrare gli eventi delle **proprie aree** a un **URL arbitrario** (Slack, Discord, un SIEM o un endpoint custom). Per-utente come il collegamento Telegram: un webhook scatta solo per gli eventi visibili a quell'utente. Backend in [`src/services/webhooks.js`](../../src/services/webhooks.js), route in [`src/routes/webhooks.js`](../../src/routes/webhooks.js), UI nella tab **Integrazioni esterne** delle Impostazioni ([`public/js/webhooks.js`](../../public/js/webhooks.js)).

- **Per-webhook**: URL, **formato** (`generic` = JSON grezzo dell'evento per SIEM/custom · `slack` = `{text}` · `discord` = `{content}`), **eventi sottoscritti** (qualsiasi sottoinsieme di `high_risk`, `revisit`, `area_change`, `berth_new`, `berth_characterized`, `proximity`, `outage`, più i 13 eventi `group_*` delle [notifiche attività di gruppo](#-gruppi-di-utenti) — questi ultimi hanno **anche** un master per-categoria in Impostazioni, verificato prima di questo filtro), **abilitato** on/off, e un **secret** opzionale.
- **Firma HMAC**: se il webhook ha un secret, il POST include `X-Tracker-Signature: sha256=<HMAC-SHA256(body)>` così il receiver verifica l'autenticità.
- **Consegna**: POST fire-and-forget con timeout (8s), nessun retry; gli errori finiscono nel log attività. L'evento `outage` (disservizio AIS) è globale: viene inoltrato a tutti gli utenti che hanno un webhook iscritto.
- **Sicurezza (SSRF)**: solo `http`/`https`; max 10 webhook per utente. Gli URL verso host **interni/privati** (localhost, 127/10/192.168/169.254/172.16–31/100.64–127 CGNAT, IPv6 loopback/link-local/ULA) sono **rifiutati**. Il controllo non si limita alla stringa dell'hostname: al momento della richiesta il nome viene **risolto in DNS e l'IP effettivo validato** (`guardedLookup`), così sono bloccati anche gli IP in forma decimale/esadecimale (es. `http://2130706433`), gli IPv4-mapped IPv6 e il **DNS rebinding** (un dominio pubblico che risolve a un IP interno).
- **Archiviazione**: lista JSON in `user_settings` (chiave `webhooks`), quindi inclusa nei backup; i secret sono mascherati nelle risposte API (`hasSecret`).
- **API** (per-utente): `GET /api/webhooks` (lista + tipi evento + formati), `POST /api/webhooks` (aggiungi), `PATCH /api/webhooks/:id` (modifica/abilita), `DELETE /api/webhooks/:id`, `POST /api/webhooks/:id/test` (evento di prova). Un pulsante **Prova** invia un evento sintetico di alto rischio.

---

## 🚀 Avvio locale

```bash
# Requisiti: Node.js v22 o superiore
node --version   # deve essere v22+

git clone <repo> tracker-porti   # oppure copia la cartella
cd tracker-porti
npm install
cp local.properties.example local.properties   # poi inserisci la tua AIS_API_KEY
npm start

# App disponibile su http://localhost:3000
```

### Sviluppo

```bash
npm run dev      # avvio con --watch (riavvia ad ogni modifica in src/)
npm run lint     # ESLint (backend Node/CommonJS + frontend browser/ESM)
npm run format   # Prettier
```

## 🧭 Utilizzo

1. Aprire `http://localhost:3000`
2. La **barra laterale sinistra** contiene tutti i controlli principali; può essere collassata (solo icone) con il bottone `‹` in cima. Lo stato (espansa/collassata) è salvato in localStorage
3. (Opzionale) selezionare l'**area** dal selettore in fondo alla sidebar — cambia solo la vista, non influisce sugli stream attivi
4. Cliccare **▶ Avvia il monitoraggio** nella sidebar per avviare lo stream dell'area correntemente visualizzata — il badge diventa verde
5. Tab **Navi presenti**: navi rilevate nella finestra attiva (6h / 24h in porto), aggiornamento ogni 5 minuti. Le navi ad alto rischio (score 71–100) hanno riga rossa, le navi segnalate ★ riga viola, le navi militari auto-rilevate riga rossa con ★ automatica, quelle in sosta il badge ⚓ In porto. Colonna **Rischio** con lo score 0–100 colorato. Toolbar in alto per **cercare/filtrare** la lista ed **esportarla in CSV** ([dettagli](#-ricerca-filtri-ed-export-liste))
6. Cliccare una riga nave → vista **Dettaglio**: info-bar + dati VesselFinder/MarineTraffic (se abilitati) + **andamento score di rischio** + note + storico visite nelle aree monitorate (tab Generale); mappa track (soste collassate, replay) + letture paginate nel tab **Letture**. Bottone **📄 Report** per il [report PDF](#-report-pdf-della-nave)
7. Cliccare una riga lettura nel dettaglio → modal con dati grezzi AIS
8. **← Indietro** per tornare alla lista precedente
9. Tab **Navi passate**: navi non più nel criterio "presenti"; cliccare ★ per segnalarle / ✓ per marcarle viste
10. Tab **Traffico**: statistiche, grafici arrivi per ora/tipo; distribuzione score rischio (verde/giallo/rosso), fattori più frequenti, arrivi per giorno (30gg), top 8 navi per score (cliccabili); navi attese, ultimi eventi porto
11. **⚙ Impostazioni** — 4 tab:
    - **Generali**: abilita/disabilita import VesselFinder, MarineTraffic, Equasis, screening sanzioni (OFAC + UE/UK/ONU), Port State Control, notifiche
    - **Aree**: toggle start/stop stream per ogni area (stato 🟢/⚪)
    - **Developer options**: notifica di test
    - **Backup/Ripristino**: auto-backup locale + esportazione manuale + ripristino selettivo (vedi [Backup e ripristino](#backup-e-ripristino-del-database))
11b. **🗺 Aree**: gestione aree a runtime — elenco con coordinate, stato e dati salvati; mappa di tutte le aree; aggiunta di una nuova area per **coordinate GPS** o con **🎯 Cattura vista corrente** (inquadrando l'area sulla mappa); modifica di un'area esistente (click sulla riga → nome/parola chiave/coordinate nel pannello, **💾 Salva modifiche**); eliminazione di un'area e del relativo storico, con **toast di annullamento (10s)**. Il bottone **🏠 Monitoraggi** torna alla home.
12. **📡 Diagnostica AIS** (tab in Impostazioni): stato connessione (uptime, msg/min, riconnessioni, errori) per l'area correntemente visualizzata
13. **🗑 Cancella dati** → elimina le letture, le navi e gli eventi porto dell'**area correntemente visualizzata** (con conferma che mostra il nome dell'area)
14. Cliccare **■ Ferma** per interrompere lo stream (i dati rimangono in DB)
15. Il bottone 🌙/☀️ in basso a destra commuta tema scuro/chiaro (salvato in localStorage)

Il database `ais_data.db` persiste tra i riavvii dell'app.

### Backup e ripristino del database

Dal modal **⚙ Impostazioni**, tab **Backup/Ripristino**:

#### Auto-backup locale (nuovo)

Il server crea automaticamente un backup "bundle" completo (database + aree + impostazioni) a intervalli regolari (default **ogni 2 ore**, configurabile con `BACKUP_INTERVAL_MIN` in `app.config.properties`) nella cartella `data/backups/`. Vengono conservati gli **ultimi 5 backup**; i più vecchi vengono cancellati automaticamente. Il primo backup parte 30 secondi dopo l'avvio del server.

- **💾 Salva ora** → crea immediatamente un backup manuale (stesso formato dei backup automatici).
- **Lista backup** → mostra i backup salvati con data, dimensione e tipo (Auto/Manuale). Per ciascuno:
  - **⬇** → scarica il file bundle localmente (download nel browser).
  - **↩ Ripristina** → apre un dialogo per scegliere cosa ripristinare:
    - **Database** (letture AIS, navi, eventi porto)
    - **Aree di monitoraggio**
    - **Impostazioni**
    - Qualsiasi combinazione delle tre. Il ripristino è irreversibile (con conferma).

I backup automatici si trovano in `data/backups/tracker-porti-autobackup-<timestamp>.tpbk`; i manuali in `tracker-porti-manualbackup-<timestamp>.tpbk`. Il `.tpbk` è un contenitore binario in streaming — intestazione + aree/impostazioni (JSON) + database SQLite grezzo — che evita di tenere l'intero DB in memoria durante salvataggio e ripristino (i vecchi backup `.json`, con il DB in base64, restano comunque ripristinabili: il formato viene rilevato automaticamente).

> ℹ️ **Database copertura nel bundle.** Dal **formato v3** (`TPB3`) il bundle incorpora anche il **database separato della Mappa delle zone coperte** (`data/db/heatmap_data.db`, vedi [sezione dedicata](#-mappa-delle-zone-coperte-copertura-aisstream)) oltre al DB principale. Nella stessa tab è disponibile un **Esporta/Importa dati copertura** dedicato per gestire solo quel DB (semantica "sostituisci"). I bundle **v1/v2** più vecchi si ripristinano lo stesso, senza la sezione copertura. L'**auto-ripristino dopo un deploy** (vedi sotto) reidrata anch'esso il DB heatmap.

#### Auto-ripristino dopo un deploy

Il database `ais_data.db` è gitignored: un deploy che ricrea la cartella applicativa lo **cancella**. All'avvio, se il file del database **non esiste** (è appena stato ricreato vuoto) e in `data/backups/` c'è almeno un auto-backup, il server **ripristina automaticamente l'ultimo backup** — solo il database (le aree in `bounding-boxes.json` e le impostazioni in `local.properties` sono file che sopravvivono al deploy, quindi non vengono toccati). Vedi log `[RESTORE] DB assente dopo il deploy → ripristinato l'ultimo backup …`.

- Scatta **solo** quando il file `.db` era assente all'avvio: un DB esistente ma vuoto (es. dopo **🗑 Cancella dati** + riavvio) **non** viene ripristinato, così non si "resuscitano" dati cancellati di proposito.
- Disattivabile con `AUTO_RESTORE_ON_DEPLOY=false` in `app.config.properties`.
- **Importante**: perché funzioni, la cartella `data/backups/` deve **sopravvivere al deploy** (es. su un volume persistente / fuori dalla dir sostituita dal deploy). Vedi [Deploy su server Linux](#-deploy-su-server-linux-vps).

> ℹ️ **Posizione dei database.** I database SQLite (`ais_data.db` + `heatmap_data.db`) vivono ora sotto `data/db/`. Le versioni precedenti li tenevano nella root del progetto: al **primo avvio** della nuova versione vengono **spostati automaticamente** lì, inclusi i sidecar `-wal`/`-shm`. I bundle salvano il **contenuto** dei database, non i loro percorsi, quindi l'export/import tra versioni con il vecchio layout (root) e il nuovo (`data/db/`) funziona indipendentemente.

#### Backup manuale (singolo componente)

- **Backup database** → scarica l'intero DB come singolo file `.db` (`tracker-porti-backup-<timestamp>.db`). È uno snapshot consistente (`VACUUM INTO`), sicuro anche con lo stream AIS attivo e senza file sidecar WAL/`-shm`.
- **Ripristina database** → carica un file `.db` di backup: **tutti** i dati attuali vengono sostituiti (operazione irreversibile, con conferma). Il file viene validato (header SQLite) e le tabelle copiate colonna-per-colonna sull'intersezione delle colonne, quindi un backup con schema più vecchio si ripristina comunque. Non serve riavviare l'app. Dopo il ripristino, le righe con `area` non valorizzata vengono automaticamente assegnate all'area corretta in base alle coordinate (bounding box più specifica che contiene il punto).

> ℹ️ **Nessun lockout dopo un ripristino.** Un ripristino del database sostituisce anche le tabelle `users` e `sessions` con quelle del backup. Per questo, dopo ogni ripristino (upload `.db`, import bundle o restore selettivo con la parte "database") il server **garantisce la presenza dell'admin** (lo ri-crea se il backup non lo contiene) e **ri-emette la sessione** dell'operatore che ha lanciato il ripristino, che resta quindi autenticato. Importando un backup di un'altra istanza vale la nota sulla password admin qui sopra.

---

## 🔐 Autenticazione (multi-utente)

L'intera app è protetta da una **login a sessione**: nessuna rotta è raggiungibile senza essere autenticati. La sessione viaggia in un **cookie firmato `httpOnly`**; le password sono salvate con hash **scrypt** (nulla è recuperabile in chiaro). Non c'è più alcun bypass da `localhost`: anche in locale serve fare login.

### Registrazione e approvazione

Dalla pagina di login un visitatore può **registrarsi** con nome, cognome, email e password. I nuovi account nascono in stato **"in attesa"** (pending) e **non possono accedere** finché un amministratore non li approva. (La conferma via email è prevista ma al momento inerte: non è ancora configurato alcun SMTP.)

### Ruoli

Esistono due ruoli: **utente** (normale) e **amministratore**. Ci si registra sempre come utente normale; un amministratore può promuovere o retrocedere gli account. Oltre alle funzioni normali, un amministratore può: **vedere i log** (il log API e il log attività sono globali/condivisi e visibili solo agli admin), **approvare** le registrazioni, **abilitare/disabilitare** gli account, **cambiare ruolo**, **reimpostare le password**, **eliminare** gli utenti e **impersonare** un utente (vista in **sola lettura** delle sue aree/monitoraggi/navi seguite, con banner e uscita con un click). Tutto dalla **pagina di amministrazione** `/admin`, raggiungibile dal link **Admin** nel widget account in alto a destra. Nella tabella utenti ogni riga espone **un solo pulsante inline** (l'azione attesa da quella riga: Approva se in attesa, Riabilita se disabilitato) e un menu **···** con tutto il resto, raggruppato per intento (stato → ruolo → utilità → distruttive); il menu è appeso al `<body>` con `position:fixed`, perché `.tablewrap` ha `overflow-x:auto` e ritaglierebbe un dropdown posizionato dentro la cella. C'è anche il terzo ruolo **tester** (limiti su numero/dimensione aree e navi seguite), assegnabile **solo all'approvazione** con "Approva come tester"; la voce di menu **Promuovi a utente** lo riporta a utente normale (`POST /api/admin/users/:id/role` con `role: 'user'`) e la transizione inversa non è consentita su un account già approvato.

### Amministratore predefinito

Un amministratore **è sempre presente**: all'avvio viene **creato se mancante**. Credenziali di default: username `admin`, password `v*ZG!S@GE2^yK^`, configurabili in `local.properties` (file gitignored, mai committato):

```properties
ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@local
ADMIN_PASSWORD=una_password_robusta
COOKIE_SECURE=false      # → true quando servi su HTTPS
SESSION_TTL_DAYS=30
```

Il login accetta indifferentemente **lo username oppure l'email**. Cambia la password di default al primo avvio in qualsiasi deployment non locale.

> ⚠️ **Comportamento della password admin.** Il seed è **idempotente**: se l'account admin **esiste già**, all'avvio **non** viene toccato. `ADMIN_PASSWORD` vale quindi **solo alla prima creazione** dell'account. Una password cambiata dall'interfaccia (o via reset) **persiste** e non viene più sovrascritta ai riavvii successivi. *(In precedenza il seed reimpostava la password al valore di `ADMIN_PASSWORD`/default a ogni boot, annullando i cambi fatti dall'UI e, senza `ADMIN_PASSWORD` esplicita, lasciando l'account sulla password pubblica di default.)* Conseguenza pratica: dopo aver **importato un backup di un'altra istanza**, l'admin login diventa quello **contenuto nel backup**; per cambiarlo, entra (la tua sessione resta valida, vedi Backup/ripristino) e imposta una nuova password dall'UI — ora resta.

### Rate limiting sull'autenticazione

Gli endpoint pubblici di autenticazione sono protetti da un **rate limiter** (per IP) contro brute-force e credential stuffing: **login** e **richiesta di reset** max **10 tentativi ogni 15 minuti**, **registrazione** max **10 all'ora**. Superata la soglia l'endpoint risponde `429` con un messaggio di attesa finché la finestra non si libera.

La **registrazione non rivela** se un'email o uno username sono già registrati: un valore duplicato riceve **la stessa risposta generica** (`pending`) di una registrazione nuova, senza creare né toccare alcun account (l'evento è comunque annotato nel log operativo per l'admin). Impedisce l'**enumerazione degli account**. Login e richiesta di reset erano già generici.

### Header di sicurezza e protezione CSRF

Ogni risposta HTTP porta un set di **header di sicurezza** ([`src/middleware/security.js`](../../src/middleware/security.js), montato per primo così coprono anche la pagina di login, gli asset statici e il service worker):

- **`Content-Security-Policy`** — `default-src 'self'` con allowlist esplicita delle sole origini realmente usate: tile raster OSM/OpenSeaMap, Google Fonts, e l'API **Overpass** interrogata lato client da `seamarks.js`. **Leaflet è self-hosted** (`public/vendor/leaflet/`), quindi `script-src`/`style-src` non ammettono alcuna origine esterna (solo `'self'`). Blocca `frame-ancestors` (clickjacking), `object-src` (plugin/embed), `base-uri` (hijack del `<base>`) e qualsiasi script/connect verso origini non in lista. *(`'unsafe-inline'` è ancora necessario su `script-src`/`style-src` perché `index.html` e la pagina di login contengono blocchi inline; rimuoverlo dipende dalla de-inlinizzazione degli script — hardening successivo.)*
- **`X-Frame-Options: DENY`** — no framing (difesa clickjacking ridondante alla CSP).
- **`X-Content-Type-Options: nosniff`**, **`Referrer-Policy: no-referrer`**, **`Permissions-Policy: camera=(), microphone=()`**.
- **`Strict-Transport-Security`** (1 anno, `includeSubDomains`) — emesso **solo sulle richieste HTTPS**, così non "pinna" mai un deploy in chiaro.

Le **mutazioni** (`POST`/`PATCH`/`PUT`/`DELETE` su `/api`) passano da una **guardia CSRF** (`csrfGuard`): una richiesta cross-site da browser porta sempre un header `Origin` (e di solito `Referer`) con host diverso dal nostro → viene **rifiutata con `403`**. È difesa in profondità in aggiunta al cookie `SameSite=Lax` e al body parser solo-JSON. Le richieste senza `Origin` né `Referer` passano (un browser non può omettere `Origin` su una mutazione cross-origin: sono XHR same-origin o client non-browser, già coperti da `SameSite`).

### Dati per-utente vs globali

Ogni utente ha **i propri** dati:

- le **aree** (bounding box di monitoraggio);
- le **impostazioni** (preferenze notifiche, opzioni di visualizzazione mappa OpenSeaMap, lingua, area di default);
- le **navi segnalate** ★, le **navi seguite** e le **navi segnate come viste** 👁;
- le navi **prese in carico** 🧑‍✈️ (solo in un gruppo — vedi sotto);
- il proprio **feed di notifiche**.

La visibilità delle navi è **geografica**: un utente vede i dati AIS la cui posizione cade dentro una delle bounding box delle sue aree.

Sono invece **condivise/globali** (gestite dagli amministratori, **non** per-utente):

- la **API key AISstream** e le altre API key/token;
- le **fonti di arricchimento** (VesselFinder, MarineTraffic, sanzioni OFAC/UE/UK/ONU, Port State Control, Global Fishing Watch, Equasis);
- la **configurazione dello score di rischio** (pesi del carico, esclusione petroliere, controlli spoofing/dark-activity).

C'è **un solo set di connessioni AISstream** a livello di sistema (una WebSocket per ogni bounding box distinta delle aree, più uno stream "follow" condiviso — che ospita anche i [lookup transitori della ricerca nave](#-cerca-e-segui-una-nave) con box mondiale + filtro MMSI) e lo **score di rischio è un unico valore condiviso** per nave.

### 👥 Gruppi di utenti

Un amministratore può raggruppare gli utenti in **gruppi** (dalla pagina `/admin`). Ogni utente appartiene **al massimo a un gruppo**; un gruppo deve avere **almeno 2 membri**. I membri di un gruppo **condividono** — come **unione** — cinque insiemi di risorse e un sottoinsieme di impostazioni:

- le **aree** di monitoraggio;
- le **navi seguite** (attive);
- le **navi segnalate** ★;
- le **navi silenziate** 🔕;
- le **navi segnate come viste** 👁 (utile per dividersi il lavoro di cernita: chi ha già controllato una nave la segna vista per tutto il gruppo);
- le **preferenze di notifica** (in-app e Telegram per-categoria + filtro per tipo nave + invio mappa) e di **visualizzazione mappa** (OpenSeaMap) + l'**area di default**.

Restano **personali** (mai sincronizzati): la **connessione Telegram** del singolo (chat collegata e codice di link), la **lingua** dell'interfaccia, e — ovviamente — credenziali e sessione. Le impostazioni **globali gestite dall'amministratore** (fonti di arricchimento, pesi di rischio, ecc.) restano globali e valgono per tutti, come prima: **non** fanno parte del gruppo.

**Come funziona la sincronizzazione (write-through):**

- **Alla creazione / all'ingresso** di un membro, aree/follow/segnalazioni/mute diventano l'**unione** di quelle di tutti i membri e vengono applicate a ciascuno. Le impostazioni iniziali del gruppo sono quelle di un **utente "modello"** scelto dall'amministratore alla creazione; un nuovo membro che entra in seguito **adotta** le impostazioni correnti del gruppo.
- **Durante l'uso**, ogni modifica di un membro si propaga agli altri: sia le **aggiunte** sia le **rimozioni** (aree/navi), e ogni cambio di una preferenza condivisa. Gli altri membri la vedono **al successivo accesso/aggiornamento**. Il **feed di notifiche** converge naturalmente (stesse aree ⇒ stessi eventi), ma lo **stato letto/non-letto resta personale**.
- **Disassociando** un membro, questo **mantiene** tutto ciò che ha accumulato (aree, navi, ultime impostazioni) e semplicemente **smette di sincronizzare**.

**Vincolo dei 2 membri:** una rimozione che porterebbe il gruppo a 1 è **bloccata** — per smontare un gruppo di 2 si usa **"Sciogli gruppo"** (tutti tornano singoli mantenendo i dati). Unica eccezione: **eliminare** un utente è un'azione distruttiva esplicita, quindi se l'eliminazione lascia il gruppo a un solo membro il gruppo viene **sciolto automaticamente**.

**Log delle azioni di gruppo** (tabella `group_activity_log`, popolata da [`src/services/group-sync.js`](../../src/services/group-sync.js)): il mirror write-through di per sé è silenzioso, quindi ogni azione mirrorata — aggiunta/rimozione area, follow/unfollow, segnalazione/rimozione segnalazione, mute/unmute, vista/non-vista, cambio di un'impostazione condivisa (incluso l'area di default) — viene anche registrata con **chi** l'ha fatta, **quando**, e i dati per costruire una frase leggibile (nome nave/area **risolti al momento della scrittura**, così la riga resta comprensibile anche se la nave/area viene poi rinominata o rimossa). Retention configurabile (`GROUP_ACTIVITY_LOG_RETENTION_DAYS` in `app.config.properties`, default 90 giorni — pulizia periodica sul pattern delle altre tabelle storiche); inclusa in `BACKUP_TABLES` e nel `pruneOrphans()` (righe di un gruppo sciolto). Ogni utente in un gruppo vede questo log — in ordine cronologico inverso, paginato ("Carica altro") — nella sezione **Attività di gruppo** della sidebar (sotto Monitoraggi/Navi seguite, visibile solo a chi è in un gruppo), che mostra anche nome del gruppo e lista membri in un tab separato. API: `GET /api/group` (dati gruppo + membri) e `GET /api/group/activity?limit=&offset=` (feed paginato) — entrambe risolvono il gruppo dell'utente loggato, nessun parametro di gruppo in ingresso.

**Presa in carico nave** (triage di gruppo, tabella `user_ship_charges`: `user_id, mmsi, assigned_by_id, created_at`): a differenza dei cinque insiemi sopra, **non** è mirror-shared — più membri possono avere la stessa nave "in carico" contemporaneamente, e ogni riga appartiene a chi l'ha effettivamente presa (o a chi gliel'ha assegnata), non è un'unione propagata a tutto il gruppo. Ogni membro può **prendere in carico se stesso** una nave o **assegnarla** a un co-membro; chiunque nel gruppo può togliere la presa in carico di chiunque (stesso modello aperto di flag/follow/mute/vista — [`src/services/group-sync.js`](../../src/services/group-sync.js) `logCharge`, sola voce di log, la scrittura vera e propria vive in `routes/ships.js` che verifica che il destinatario sia un co-membro). Visibile: nell'intestazione del dettaglio nave (tag di chi l'ha presa + bottone "prendi in carico" 🧑‍✈️ + menu "assegna a un membro"), e nelle liste (Monitoraggi/Navi seguite, presenti e passate) come sfondo/icona dedicati (`.charged-row`, teal) + tag utenti sulla riga. Filtrabile sia dal campo di ricerca libero (nomi utente) sia da un menu a tendina dedicato (tutte / assegnate a me / non assegnate / un membro specifico). Ogni cambio genera comunque una voce nel log attività di gruppo (`charge_on`/`charge_off`/`charge_assign`), stesso meccanismo del paragrafo precedente. API: `PATCH /api/ships/:mmsi/charge {on, targetUserId?}` (`targetUserId` assente = se stesso; se presente dev'essere un co-membro, altrimenti 403). Tabella inclusa in `BACKUP_TABLES` e nella cascade `deleteUser`; nessun impatto sul restore di backup più vecchi (tabella nuova, il loop di restore la salta se assente nel backup — vedi [Vincoli importanti](../../.claude/CLAUDE.md)).

**Notifiche "Attività del gruppo"** — le azioni sopra (i cinque insiemi mirror-shared + la presa in carico) possono opzionalmente **notificare i co-membri**, oltre a restare silenziosamente nel log. Ogni utente controlla **cosa riceve**, ma non può controllare quali proprie azioni notificano gli altri (le regole valgono per tutto il gruppo, in quanto preferenze condivise — vedi sopra). Sei categorie (una per insieme: aree, navi seguite, segnalazione, silenziamento, vista, presa in carico), ciascuna con **tre gate indipendenti**, tutti default ON:

- **In-app** (`notifyGroupArea`/`notifyGroupFollow`/`notifyGroupFlag`/`notifyGroupMute`/`notifyGroupSeen`/`notifyGroupCharge`) — governa il feed **Notifiche attività di gruppo**, un secondo bottone in sidebar (accanto a **🔔 Notifiche**, visibile solo a chi è in un gruppo) che apre lo **stesso overlay condiviso** con un proprio badge/contenuto indipendente (`?kind=group` sulle stesse API di cui sopra).
- **Telegram** (`telegramNotifyGroupArea` ecc., stesso meccanismo delle altre categorie Telegram — vedi [Notifiche Telegram](#-notifiche-telegram)).
- **Webhook** (`webhookNotifyGroupArea` ecc.) — un master per categoria controllato **prima** del filtro `events` di ciascun webhook (`webhooks.dispatch`); i 14 tipi `group_area_add/remove/edit`, `group_follow_on/off`, `group_flag_on/off`, `group_mute_on/off`, `group_seen_on/off`, `group_charge_on/off/assign` sono selezionabili come qualsiasi altro evento webhook. È l'**unico** gate di questo tipo nell'app: le 7 categorie webhook preesistenti non hanno un master per-categoria, solo la sottoscrizione per-webhook.

Il fan-out (`groupSync.notifyGroupActivity`, chiamato da ogni `sync*`, da `logCharge` e da `notifyAreaEdit`) itera i co-membri (mai l'autore) — con un'unica eccezione, la **modifica di un'area** (`group_area_edit`), il cui elenco destinatari è passato esplicitamente ed è composto da **tutti gli altri proprietari di quell'area**, anche fuori dal gruppo (il catalogo aree è globale: la modifica sposta l'area anche per loro). Per questo il feed "Notifiche attività di gruppo" compare in sidebar anche a un utente **senza gruppo** che abbia almeno una notifica di questo feed (`hasGroupNotifications` in `/api/auth/me`), e `getNotifications` risolve lato server il nome dell'autore (`actor_name`, LEFT JOIN su `users`), che il client non può dedurre dal proprio roster di gruppo e, per chi ha il gate in-app attivo, scrive una riga `notifications` con `type` prefissato `group_` (es. `group_flag_on`), `actor_id` = chi ha compiuto l'azione e — per la presa in carico — `target_user_id` = l'altro utente coinvolto. Il testo del messaggio (`"<Autore> ha …"`) riusa **le stesse chiavi i18n** della vista "Attività di gruppo" (`groupActivity.msg.*`), quindi le due presentazioni (log e notifica) restano sempre in sintonia. Tutte e diciotto le preferenze sono in `SHARED_SETTING_KEYS` (mirrorate nel gruppo, come le altre preferenze di notifica).

### Password dimenticata

Poiché l'email non è ancora collegata, il reset password è **avviato dall'amministratore**: nell'elenco utenti della pagina `/admin` c'è l'azione **"Reimposta password"** che genera un **link monouso** (valido **24h**) da consegnare all'utente. La pagina di login mostra comunque un link **"Password dimenticata?"** e un link di registrazione.

### Migrazione dalla versione single-user

Aggiornando da una versione precedente (single-user): quando un **vecchio database** (pre-multi-utente) viene ripristinato/importato, tutte le sue aree, navi segnalate, navi seguite, navi viste e notifiche esistenti vengono **migrate automaticamente all'account amministratore predefinito**. Anche il flag "vista" — global su `ships.seen` fino alla versione che ha introdotto il filtro per tipo nave nelle notifiche — segue lo stesso trattamento: `migrateMultiUser` (`src/db.js`) lo ri-assegna a `user_seen` dell'admin e azzera la colonna legacy, così i backup vecchi restano importabili senza perdere le navi già marcate.

> ⚠️ Il cookie di sessione di per sé **non cifra il traffico**. Per l'esposizione diretta su internet metti **TLS** davanti (reverse proxy con HTTPS, Caddy, Cloudflare Tunnel…) e imposta `COOKIE_SECURE=true`, così il cookie viaggia solo su HTTPS.

---

## 📱 App installabile (PWA)

L'app è una **Progressive Web App**: si installa sulla home screen (Android/iOS) o come app desktop (Chrome/Edge) e si apre **standalone** (senza barra del browser). Niente store, nessun build step — sono file statici serviti da `public/`.

- **Manifest** ([`public/manifest.webmanifest`](../../public/manifest.webmanifest)) — nome, icone, `display: standalone`, colore tema/sfondo `#0a0d13`.
- **Icone** ([`public/icons/`](../../public/icons/)) — derivate dal logo brand [`public/icons/source.png`](../../public/icons/source.png) (tile blu, àncora bianca su mappa): [`scripts/gen-icons.js`](../../scripts/gen-icons.js) rileva il riquadro blu, lo ritaglia a tutto campo (niente angoli bianchi) e lo ridimensiona con `sips` (macOS) in 192/512, 512 *maskable*, `apple-touch-icon` 180, favicon 32. Per rigenerare dopo aver sostituito `source.png`: `node scripts/gen-icons.js` (richiede macOS; i PNG sono committati, la produzione non lo esegue).
- **Service worker** ([`public/sw.js`](../../public/sw.js)) — registrato da `index.html`. Strategia pensata per un tracker **live**: `/api/*` e le **tile** esterne (OSM/OpenSeaMap) **non** vengono mai intercettate né messe in cache (nessun dato autenticato o live finisce nella cache del browser); lo **shell** (HTML/CSS/JS, locali, icone) è *stale-while-revalidate* e **Leaflet self-hosted** (`/vendor/leaflet/*`) è **precache-ato**, così la mappa funziona anche **offline** (prima, con Leaflet da CDN non intercettato, offline `L` era `undefined` e ogni render con mappa falliva); i moduli ES `/js/` e `/locales/` sono *network-first* (niente mix di versioni post-deploy); le navigazioni sono *network-first* con fallback alla shell in cache o a [`offline.html`](../../public/offline.html). Bump di `CACHE` in `sw.js` per invalidare tutto.
- **Accesso senza sessione** — `manifest.webmanifest`, `/sw.js`, `/icons/*`, `/offline.html` e `/vendor/*` (Leaflet) sono serviti **prima del gate di autenticazione** ([`src/app.js`](../../src/app.js)): il browser li carica anche sulla pagina di login (e sulla heatmap pubblica) e registra il SW a scope `/`. L'app e i dati (`/index.html`, `/api/*`) restano protetti.

Per installarla: aprire il sito → menu del browser → "Installa app" / "Aggiungi a Home".

---

## 🐧 Deploy su server Linux (VPS)

### Requisiti server

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

node --version   # v22+
npm --version

# I crawler MarineTraffic/Equasis usano node-libcurl (libcurl integrata via npm).
# Nessun `curl` di sistema richiesto. Su distro minimali per la build da sorgente
# di fallback servono build-essential: sudo apt-get install -y build-essential
```

### Deploy manuale

```bash
# Sul server
mkdir -p /opt/tracker-porti
# Copia i file (da locale via scp o rsync)
scp -r /Users/marco/projects/tracker-porti/{package.json,package-lock.json,src,public} user@server:/opt/tracker-porti/

# Crea local.properties sul server (NON copiare quello locale se contiene chiavi diverse)
# Deve contenere almeno AIS_API_KEY — vedi sezione "Configurazione"

ssh user@server
cd /opt/tracker-porti
npm install --omit=dev
```

> **Persistenza tra deploy**: `ais_data.db` è gitignored e viene ricreato vuoto ad ogni deploy che sostituisce la cartella. Se conservi la cartella `data/backups/` tra un deploy e l'altro (non sovrascriverla — es. tienila su un volume persistente o escludila dall'`rsync --delete`), all'avvio l'app **ripristina automaticamente l'ultimo auto-backup** (vedi [Auto-ripristino dopo un deploy](#auto-ripristino-dopo-un-deploy)). In alternativa, conserva direttamente `ais_data.db`.

### Avvio con PM2 (processo persistente)

PM2 mantiene il processo attivo, lo riavvia dopo crash e lo fa partire al boot.

```bash
npm install -g pm2

# Avvia
pm2 start src/server.js --name tracker-porti

# Salva la configurazione per il boot automatico
pm2 save
pm2 startup   # segui le istruzioni che stampa

# Comandi utili
pm2 status              # stato processi
pm2 logs tracker-porti       # log in tempo reale
pm2 restart tracker-porti    # riavvio
pm2 stop tracker-porti       # stop
```

### Porta e firewall

Di default l'app gira sulla porta 3000. Per renderla accessibile:

```bash
# Apri la porta nel firewall
sudo ufw allow 3000

# Oppure usa una porta custom
PORT=8080 pm2 start src/server.js --name tracker-porti
```

> ⚠️ Aprire la porta espone l'app a chiunque raggiunga il server. L'app è comunque protetta da login (vedi [Autenticazione](#-autenticazione-multi-utente)): **cambia la password dell'amministratore predefinito** (`ADMIN_PASSWORD`) prima e metti **TLS davanti** — con HTTPS il cookie di sessione riceve il flag `Secure` **automaticamente** (imposta `COOKIE_SECURE=true` solo se il proxy non inoltra `X-Forwarded-Proto`).

### Nginx come reverse proxy (opzionale, consigliato)

Per esporre l'app su porta 80/443 con un dominio:

```bash
sudo apt install nginx

# /etc/nginx/sites-available/tracker-porti
server {
    listen 80;
    server_name tuo-dominio.it;   # o IP del server

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        # Necessari: X-Forwarded-Proto abilita il cookie Secure automatico su
        # HTTPS; X-Forwarded-For dà a rate limiting e audit l'IP reale del client.
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tracker-porti /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Variabile d'ambiente per la porta

```bash
# In pm2
pm2 start src/server.js --name tracker-porti --env production -- --port 3000

# Oppure con env nel file ecosystem
```

O crea `/opt/tracker-porti/ecosystem.config.js`:

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

## 📂 File principali

| File                          | Descrizione                                                       |
| ------------------------------| -------------------------------------------------------------------|
| `src/server.js` / `src/app.js`| Entry point + factory dell'app Express                            |
| `src/config.js`               | Config (local.properties/env), preset bbox, costanti, stato runtime; aggiunta/rimozione aree a runtime (`addArea`/`removeArea`, persistite in `bounding-boxes.json`); esporta `areaForPoint(lat, lon)` per risolvere una coordinata al preset più specifico |
| `src/db.js`                   | Wrapper SQLite: schema `readings`/`ships`/`port_events`/`api_log`/`ship_scrape_cache`/`ship_scrape_failures`/`notifications`/`risk_history`/`moorings`/`berths`, insert/upsert, query, predicato attive |
| `src/services/ais-stream.js`  | Client WebSocket AISStream multi-area (`Map<areaKey, state>`) + riconnessione + eventi porto + notifiche di rientro e cambio area |
| `src/services/berths.js`      | Rilevamento attracchi + clustering DBSCAN + caratterizzazione banchine (convex hull, point-in-polygon, backfill/ricalcolo) + notifiche di nuova banchina e caratterizzazione |
| `src/services/ship-categories.js` | Mappa codice tipo nave AIS → categoria larga (cargo/tanker/passeggeri/…) + flag hazmat, usata per caratterizzare le banchine |
| `src/services/scrapers/`      | Scraping VesselFinder (https), MarineTraffic (node-libcurl) ed Equasis (node-libcurl, login, on-demand) |
| `src/services/risk-score.js`  | Score di rischio trasporto armi (0–100) da firme comportamentali AIS + dati registro VF/MT in cache |
| `src/services/enrichment.js`  | Arricchimento proattivo VF/MT (una volta) alla prima rilevazione di una nave |
| `src/services/sanctions.js`   | Liste sanzioni OFAC SDN + UE/UK/ONU (OpenSanctions): download CSV, indice in memoria, match nave per IMO/nome/call sign |
| `src/services/psc.js`         | Port State Control (Paris/Tokyo MoU): performance bandiera (JSON bundled) + banned list (CSV OpenSanctions), match per nome bandiera / IMO |
| `src/routes/`                 | Router Express per dominio (ships, readings, events, notifications, logs, settings, app-config, stream, areas, berths, export) |
| `public/index.html`           | SPA: sidebar collassabile, tab nav, 4 view + modali (impostazioni/diagnostica/log) |
| `public/js/`                  | Moduli ES: state machine SPA, polling, mappe Leaflet, de-noise track, grafici, export |
| `public/css/style.css`        | Design system con token CSS; tema scuro (default) e chiaro (selezionabile) |
| `public/manifest.webmanifest` / `public/sw.js` / `public/icons/` / `public/offline.html` | [PWA](#-app-installabile-pwa): manifest, service worker (shell cache, `/api` mai in cache), icone, pagina offline |
| `scripts/gen-icons.js`        | Rigenera le icone PWA dal logo `public/icons/source.png` (auto-crop del tile + resize via `sips`, macOS) |
| `local.properties`            | Configurazione + API key (gitignored, non committare)             |
| `ais_data.db`                 | Database SQLite (creato al primo avvio, gitignored)               |

## 🗄️ Schema DB

**`readings`** — ogni messaggio AIS ricevuto (max 10.000 per tipo, rotazione automatica); include la colonna `area TEXT NOT NULL DEFAULT ''` che identifica l'area di monitoraggio del record.

**`ships`** — una riga per MMSI, aggiornata ad ogni lettura:

| Colonna | Tipo | Descrizione |
|---|---|---|
| `mmsi` | INTEGER PK | Identificativo nave |
| `ship_name` | TEXT | Nome nave |
| `first_seen_at` / `last_seen_at` | TEXT | Timestamp primo/ultimo contatto |
| `last_latitude` / `last_longitude` | REAL | Ultima posizione |
| `last_sog` / `last_cog` | REAL | Ultima velocità (kn) / rotta (°) |
| `last_navigational_status` | TEXT | Ultimo stato navigazionale AIS |
| `ship_type` | INTEGER | Codice tipo nave/carico (ITU-R M.1371) |
| `destination` | TEXT | Destinazione dichiarata |
| `max_draught` | REAL | Pescaggio massimo (decimi di metro) |
| `call_sign` | TEXT | Nominativo radio |
| `imo_number` | INTEGER | Numero IMO |
| `dim_bow` / `dim_stern` / `dim_port` / `dim_starboard` | INTEGER | Dimensioni nave (m) |
| `eta` | TEXT | ETA dichiarata |
| `flagged` | INTEGER | Flag "segnalata" (★, 0/1) |
| `seen` | INTEGER | Flag "vista" (✓, 0/1) |
| `notes` | TEXT | Note libere sulla nave |
| `mt_ship_id` | INTEGER | `shipid` interno MarineTraffic (risolto al primo scraping MT) |
| `last_area` | TEXT NOT NULL DEFAULT '' | Chiave dell'ultima area in cui la nave è stata rilevata |

Tabella ausiliaria **`ship_scrape_cache`** — cache dei dati scaricati da VesselFinder / MarineTraffic / Equasis per `(mmsi, source)`, con `scraped_at`. Source: `vf`/`mt` con TTL `SCRAPE_CACHE_TTL`; `eq` (Equasis) senza scadenza (salvato una volta).

Tabella ausiliaria **`ship_scrape_failures`** — negative cache dei lookup VF/MT falliti per `(mmsi, source)`, con `failed_at` e `reason`. Il backfill salta una nave finché il fallimento è più recente di `SCRAPE_NEG_CACHE_DAYS`; un fetch riuscito cancella la riga. Evita di ri-contattare a ogni riabilitazione le navi che le fonti non conoscono.

**`port_events`** — eventi arrivo/partenza rilevati automaticamente: `mmsi`, `ship_name`, `event_type` (`arrived`/`departed`), `ts`, `ship_type`, `destination`, `draught`, `area TEXT NOT NULL DEFAULT ''` (area in cui è avvenuto l'evento), più l'evidenza di sosta scritta sulla riga `departed`: `stop_min_sog REAL` (velocità minima osservata durante la visita) e `stopped INTEGER` (1 = scalo vero, 0 = attraversamento). Entrambe **nullable**: NULL = non misurato (righe più vecchie di questa versione, o posizioni già potate al momento della partenza), non "non si è fermata" — chi legge ricade sulla sola permanenza.

**`api_log`** — log delle richieste HTTP (max 1.000, rotazione automatica): `ts`, `method`, `path`, `status`, `duration_ms`, `request_body`, `response_body`.

**`notifications`** — due feed indipendenti mostrati in un overlay (vedi [Notifiche](#-eventi-porto-statistiche-e-alert)), distinti da `type` e filtrati con `?kind=personal|group` (rotazione a 100 righe **per feed**, non condivisa): `type` (`revisit`, `area_change`, `high_risk`, `berth_new`, `berth_characterized`, `proximity` per il feed personale; `group_area_add/remove`, `group_follow_on/off`, `group_flag_on/off`, `group_mute_on/off`, `group_seen_on/off`, `group_charge_on/off/assign` per il feed "Attività del gruppo"), `mmsi`, `ship_name` (per le banchine: il nome della banchina, se ha un nome), `area` (area di arrivo), `from_area` (area di partenza, solo per `area_change`), `band` (`low`/`med`/`high` per le notifiche nave; la categoria di banchina per `berth_characterized`) e `score` di rischio calcolati al momento dell'evento, `berth_id`/`berth_lat`/`berth_lon` (banchina di riferimento, solo per le notifiche banchina), `actor_id`/`target_user_id` (solo per le righe `group_*`: chi ha compiuto l'azione / l'altro utente coinvolto nella presa in carico), `ts`, `read` (0/1).

**`risk_history`** — snapshot dello score di rischio nel tempo per il grafico di andamento (vedi [Storico dello score](#-storico-dello-score-di-rischio)): `mmsi`, `ts`, `score`, `band`. Campionata sparsa (max 1/ora per nave) e limitata globalmente (rotazione a 20.000 righe).

**`moorings`** — un punto di attracco per visita (vedi [Banchine](#-banchine-caratterizzazione-automatica-degli-attracchi)): `area`, `mmsi`, `ship_type`, `category` (categoria larga), `lat`, `lon`, `ts`, `berth_id` (banchina assegnata, `NULL` se non clusterizzato). Ricostruita dal servizio banchine ad ogni ricalcolo.

**`berths`** — banchine rilevate/disegnate: `area`, `name`, `polygon_json` (`[[lat,lon],…]`), `centroid_lat`/`centroid_lon`, `manual_geom` (1 = geometria bloccata a mano), `char_label` (categoria dominante calcolata o `mixed` o `NULL`), `char_override` (categoria forzata a mano, ha la precedenza), `mooring_count`, `dist_json` (distribuzione `[{category,n,pct}]`), `hazmat_pct`, `updated_at`. Entrambe incluse nei backup (`BACKUP_TABLES`).

**`proximity_events`** — contatti di [rendezvous nave-nave](#-rilevamento-rendezvous-nave-nave): un record per incontro tra una coppia canonica (`mmsi_a < mmsi_b`), con `name_a`/`name_b`, `area`, `started_at`, `last_seen_at`, `ended_at` (`NULL` = contatto ancora aperto), `min_dist_m` (distanza minima raggiunta), `lat_a`/`lon_a`/`lat_b`/`lon_b` (ultime posizioni), `alerted` (1 = soglia di permanenza raggiunta, notifica già inviata). Alimenta lo score di rischio (entrambe le navi) e la sezione "Rendezvous in mare" del dettaglio. Retention: cap a 5.000 contatti chiusi. Inclusa nei backup (`BACKUP_TABLES`).

## 🔌 API interne

| Metodo | Path | Descrizione |
|---|---|---|
| POST | `/api/stream/start` | Avvia connessione WebSocket a AISStream per l'area specificata — body `{area}` obbligatorio |
| POST | `/api/stream/stop` | Chiude la connessione per l'area specificata — body `{area}` obbligatorio |
| GET | `/api/stream/status` | `{streams: {areaKey: {active, totalReceived}}, dbCount}` — stato di tutti gli stream attivi |
| GET | `/api/stream/health` | Statistiche connessione (uptime, msg/min, errori) per l'area specificata (`?area=`) |
| GET | `/api/ships/active` | Navi "presenti" nell'area (`?area=`), finestra 6h / 24h in porto, + campi `direction`, `in_port`, `risk`, `is_military`, `flagged` (forzato a `true` se militare) |
| GET | `/api/ships/past` | Navi "passate" nell'area (`?area=`), complemento di active, ordinate per flag/data, + campi `risk`, `is_military`, `flagged` |
| GET | `/api/ships/:mmsi` | Dati statici di una nave (+ campi `direction`, `in_port`, `risk`, `is_military`, `flagged`) |
| GET | `/api/ships/:mmsi/readings` | Letture di una nave (`?limit=50&offset=0`), include `source` (`ais`/`sf`/`mst`) |
| GET | `/api/ships/:mmsi/track` | Punti posizione per il tracciato mappa (`?limit=500`) |
| GET | `/api/replay` | Posizioni storiche di tutte le navi in un'area per il replay (`?area=KEY&window=1h\|6h\|24h\|all` o `&from=ISO&to=ISO`), raggruppate per nave + intervallo disponibile. Con `&scraped=1` include anche le posizioni SF/MST (integrazioni abilitate); risposta con `extraAvailable` |
| GET | `/api/transits` | Navi che hanno fatto scalo in **due** aree monitorate dall'utente e tragitti fra le due (`?a=KEY&b=KEY&period=all\|12m\|6m\|3m\|30d&includeNoLeg=0\|1`). 400 aree mancanti/uguali, 403 se non le monitora entrambe; risposta con `gate` (soglie usate) e `truncated` |
| GET | `/api/ships/search/candidates` | Cerca navi per nome/MMSI/IMO (`?q=`) su flotta locale + MarineTraffic → `{candidates, mt}` |
| GET | `/api/ships/search/recover` | **SSE**: recupera identità (VF/MT/GFW) + screening + posizione live via lookup AISstream (`?mmsi=` o `?mtShipId=`). Chiudere lo stream annulla il lookup |
| GET | `/api/ships/:mmsi/vfdata` | Dati scaricati da VesselFinder (con cache) |
| GET | `/api/ships/:mmsi/mtdata` | Dati scaricati da MarineTraffic (con cache); risolve e salva `mt_ship_id` |
| GET | `/api/ships/:mmsi/equasis` | Dati Equasis (proprietà/gestione) dalla cache; scrapa solo con `?fetch=1` (pulsante dettaglio). Mai automatico, nessuna scadenza |
| GET / DELETE | `/api/equasis-log` | Legge (tail 256 KB) / svuota il log di audit testuale dei lookup Equasis (`equasis.log`) |
| GET | `/api/ships/:mmsi/events` | Eventi porto (arrivi/partenze) di una nave, con `area_name` (join su `areas.key`, nome globale dell'area monitorata in cui l'evento è avvenuto) |
| GET | `/api/ships/:mmsi/risk-history` | Serie storica degli snapshot di score di rischio della nave (`{history:[{ts,score,band}]}`) |
| GET | `/api/ships/expected` | Navi attese nell'area (`?area=`): destinazione = keyword preset, uscite < 48h |
| PATCH | `/api/ships/:mmsi/flag` | Imposta flag segnalata `{flagged: 0\|1}` |
| PATCH | `/api/ships/:mmsi/seen` | Imposta flag vista `{seen: 0\|1}`, per-utente (`user_seen`), mirror di gruppo |
| PATCH | `/api/ships/:mmsi/charge` | Presa in carico di gruppo `{on: 0\|1, targetUserId?}`, per-utente (`user_ship_charges`), NON mirrorata — `targetUserId` assente = se stesso, altrimenti dev'essere un co-membro (403 altrimenti) |
| PATCH | `/api/ships/:mmsi/notes` | Imposta note libere `{notes: "…"}` |
| PATCH | `/api/ships/:mmsi/military` | Imposta flag militare manuale `{is_military: 0\|1}` → forza score 100 e riga rossa |
| GET | `/api/readings` | Letture globali (`?type=&limit=50&offset=0`) |
| GET | `/api/readings/:id` | Dettaglio singolo record con raw JSON |
| DELETE | `/api/readings` | Cancella letture, navi ed eventi porto dell'area specificata (`?area=`, default: area corrente) |
| GET | `/api/events` | Eventi porto dell'area (`?area=&limit=100&offset=0`) |
| GET | `/api/stats` | Statistiche aggregate dell'area (`?area=`) — arrivi, sosta media, per ora/tipo |
| GET | `/api/stats/scores` | Score di rischio aggregati dell'area (`?area=`) sulle navi degli ultimi 7 giorni: `byBand` (count per fascia), `topShips` (top 8 per score), `byFactor` (fattori più frequenti), `dailyArrivals` (arrivi per giorno ultimi 30gg) |
| GET | `/api/alerts` | Coda alert di navi segnalate rientrate in area (svuotata alla lettura) |
| GET | `/api/notifications` | Feed notifiche (ultime 100) + conteggio non lette: `{notifications, unread}` — `?kind=personal\|group` (default `personal`) sceglie il feed |
| POST | `/api/notifications/:id/read` | Segna una notifica come letta → `{ok, unread}` (`?kind=` per il conteggio restituito) |
| DELETE | `/api/notifications/:id` | Elimina una notifica → `{ok, unread}` (`?kind=`) |
| DELETE | `/api/notifications` | Elimina **tutte** le notifiche del feed `?kind=` → `{ok, unread:0}` |
| POST | `/api/notifications/read-all` | Segna come lette tutte le notifiche del feed `?kind=` → `{ok, unread:0}` |
| GET | `/api/export` | Download ZIP con CSV per tipo messaggio |
| GET | `/api/backup` | Download intero database come file `.db` (snapshot `VACUUM INTO`) |
| POST | `/api/restore` | Ripristina l'intero DB da un file `.db` caricato (body `application/octet-stream`) |
| GET | `/api/backups` | Lista dei backup locali salvati in `data/backups/` — `{backups:[{filename,size,mtime}]}` |
| POST | `/api/backups/save` | Crea e salva un bundle manuale in `data/backups/` — `{ok, filename, mtime, size}` |
| GET | `/api/backups/:filename/download` | Download di un backup locale specifico |
| POST | `/api/backups/:filename/restore` | Ripristino selettivo da backup locale — body `{parts:['db','areas','settings']}` |
| GET | `/api/app-config` | Parametri di `app.config.properties` raggruppati, con descrizioni estratte dai commenti del file; `{groups, applies:'restart'}` |
| POST | `/api/app-config` | Scrive i parametri modificati `{values:{CHIAVE:valore}}` (solo chiavi già presenti nel file); `{ok, changed, restart}` |
| GET | `/api/settings` | Preset bbox corrente, lista preset, stato import VF/MT |
| POST | `/api/settings` | Cambia preset, toggle import, toggle notifiche e overlay OpenSeaMap `{preset?, importVfData?, importMtData?, notificationsEnabled?, notifyRevisit?, notifyAreaChange?, notifyHighRisk?, notifyBerthNew?, notifyBerthChar?, notifyProximity?, notifyShipTypesHidden?, notifyIncludeSeen?, showOpenSeaMap?, showOpenSeaMapMarkers?, openSeaMapHidden?}` |
| GET | `/api/areas` | Elenco aree con bbox, stato stream, flag `current` e conteggi dati (`counts`); `{areas, preset, minAreas}` |
| POST | `/api/areas` | Aggiunge un'area `{name, sw:[lat,lon], ne:[lat,lon], keyword?, autostart?}` → salva in `bounding-boxes.json` e avvia lo stream (salvo `autostart:false`) |
| PATCH | `/api/areas/:key` | Modifica un'area già esistente `{name?, keyword?, sw?, ne?}` → la **chiave non cambia** (lo storico resta agganciato), riscrive `bounding-boxes.json` + catalogo DB e, se il box è cambiato e lo stream è attivo, rispedisce la subscription. Se l'area è condivisa, ogni altro proprietario riceve una notifica di gruppo `group_area_edit` |
| DELETE | `/api/areas/:key` | Elimina un'area e tutto il suo storico (letture/navi/eventi); rifiuta se è l'unica rimasta. Se era l'area attiva, ne seleziona un'altra |
| GET | `/api/berths` | Banchine dell'area (`?area=`, default: area corrente) con geometria, etichetta effettiva, distribuzione e conteggi; `{berths, minMoorings, dominantPct}` |
| POST | `/api/berths/recompute` | Ricalcola attracchi e banchine: con `?area=` solo quella, altrimenti tutte le aree |
| POST | `/api/berths` | Crea una banchina manuale disegnando un poligono `{area, polygon:[[lat,lon],…], name?, override?}` |
| PATCH | `/api/berths/:id` | Modifica una banchina `{name?, override?, polygon?}` (il poligono blocca la geometria come manuale) |
| POST | `/api/berths/merge` | Unisce più banchine in una sola manuale `{ids:[…], name?}` |
| DELETE | `/api/berths/:id` | Elimina una banchina (i suoi attracchi vengono liberati) |
| GET | `/api/logs` | Log richieste HTTP (`?limit=200&offset=0`) |
| GET | `/api/logs/stream` | SSE: stream live dei log API |
| GET | `/api/logs/:id` | Dettaglio singolo log con request/response body |
| DELETE | `/api/logs` | Cancella tutti i log |

## 📝 Note

- **Area vuota**: un porto può non avere navi AIS nelle ore notturne o nei periodi di bassa attività. L'app funziona correttamente — la lista "presenti" è semplicemente vuota. I dati restano nella tab "passate" e nel DB.
- **Riconnessione automatica**: se il WebSocket di un'area si chiude inaspettatamente mentre il suo stream è attivo, il backend tenta la riconnessione dopo 5 secondi (per area indipendentemente).
- **Rilevamento disservizio AIS**: quando uno stream attivo non riceve messaggi nave per `AIS_OUTAGE_SILENCE_MIN` minuti (default 10), il backend interroga un **monitor di uptime indipendente** ([AISStream-Uptime](https://github.com/buttermilkgreen/AISStream-Uptime)) che mantiene una propria connessione a `stream.aisstream.io`. Modalità **ibrida**: viene contattata per prima un'eventuale istanza **self-hosted** (`AIS_UPTIME_SELFHOST_URL`) e, solo se irraggiungibile, l'istanza **pubblica** di ripiego (`AIS_UPTIME_URL`, default `https://aisuptime.buttermilkgreen.fyi`) — che indica anche se il disservizio è globale. Solo se il monitor che risponde riporta il servizio non attivo (stato ≠ *Up*) viene mostrato un **banner di disservizio** non invasivo nelle pagine di monitoraggio. Così un'area genuinamente silenziosa non genera mai un falso allarme. Si disabilita con `AIS_OUTAGE_CHECK=false`. Vedi la sezione **Crediti / Fonti terze** in fondo.
  Il meccanismo silenzio + cross-check esterno sopra descritto ha un punto cieco: se lo stream non riesce proprio a **tenere aperta una connessione** (si chiude ripetutamente pochi secondi dopo la connect, es. `503`/`socket hang up`/`1006`), `connectedAt` si resetta a ogni tentativo e il silenzio non si accumula mai abbastanza da far scattare il cross-check. Per questo, in aggiunta al meccanismo sopra, tutti e tre gli stream (**monitoraggio aree**, **navi seguite**, **mappa zone coperte**) tengono traccia diretta della propria salute di connessione: se restano bloccati senza mai riagganciarsi per `AIS_OUTAGE_SILENCE_MIN` minuti, oppure **si riconnettono ripetutamente** (3+ volte nella stessa finestra, "flapping") — anche se ogni tentativo dura solo pochi secondi — il banner compare comunque, indicando quale stream (`monitoring`/`follow`/`heatmap`) è in difficoltà. Nessun cross-check esterno necessario in questo caso: la disconnessione del nostro stesso socket non è ambigua, a differenza del silenzio di un'area che potrebbe semplicemente essere poco trafficata. Vedi `getConnTrouble()` in `ais-stream.js`/`ship-follow.js`/`heatmap-stream.js` e `stuckStreams()` in `ais-uptime.js`.
- **Riavvio e dati**: il DB (`ais_data.db`, WAL) persiste tra i riavvii. Dopo un riavvio le navi che trasmettono di rado (ormeggiate) possono non comparire subito in "presenti" finché non ritrasmettono — vedi finestre 6h/24h.
- **`node-libcurl`**: lo scraping MarineTraffic/Equasis usa `node-libcurl` per il bypass Cloudflare (libcurl integrata, nessun `curl` di sistema). Se il binario nativo non si installa, l'import MT/Equasis fallisce ma il resto dell'app funziona.
- **Node.js versione**: il modulo `node:sqlite` è built-in da Node 22.5+. Non funziona su versioni precedenti.

## 🙏 Crediti / Fonti terze

Il rilevamento dei disservizi AIS si appoggia al progetto **[AISStream-Uptime](https://github.com/buttermilkgreen/AISStream-Uptime)** di [buttermilkgreen](https://github.com/buttermilkgreen) (licenza **MIT**) — un monitor di uptime per `stream.aisstream.io`. Non ne è stato incorporato alcun codice sorgente: l'app consuma soltanto la **API REST** (`GET /api/v1/status`) tramite un client scritto per questo progetto ([`src/services/ais-uptime.js`](../../src/services/ais-uptime.js)). Essendo MIT, il monitor può essere **ospitato in proprio**: indica l'URL della tua istanza in `AIS_UPTIME_SELFHOST_URL` (interrogata per prima) e l'[istanza pubblica](https://aisuptime.buttermilkgreen.fyi) resta solo come ripiego. Configurabile/disabilitabile via `AIS_UPTIME_SELFHOST_URL` / `AIS_UPTIME_URL` / `AIS_OUTAGE_CHECK`.

Altre fonti dati di terze parti usate dall'app, ciascuna con i propri termini: [AISStream.io](https://aisstream.io) (flusso AIS), [VesselFinder](https://www.vesselfinder.com) / [MarineTraffic](https://www.marinetraffic.com) (arricchimento nave), [Equasis](https://www.equasis.org) (proprietà/gestione), [Global Fishing Watch](https://globalfishingwatch.org) (eventi comportamentali, **gratuito solo per uso non commerciale**), [OpenSeaMap](https://www.openseamap.org) / [OpenStreetMap](https://www.openstreetmap.org) (livello nautico) e le liste sanzioni/PSC (OFAC, UE, UK OFSI, ONU, Paris/Tokyo MoU).
