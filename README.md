# 🚢 Tracker Porti

```
          /\
         /  \
     ___/    \___
    |  TRACKER   |
    |  PORTI     |
     \__________/
    ~~~~~~~~~~~~~~
```

App per tracciare navi via [AISStream.io](https://aisstream.io). L'area di monitoraggio è selezionabile a runtime tra più preset (Bari, Taranto, Nord Adriatico, Puglia — vedi [Bounding box](#bounding-box)) e configurabile con bounding box arbitrarie, quindi utilizzabile per qualsiasi porto. Le aree si **aggiungono e rimuovono a runtime** dalla schermata **🗺 Aree** (senza riavviare l'app). È possibile monitorare **più aree contemporaneamente**: ogni area ha il proprio stream AIS indipendente.

## 🏗️ Architettura

```
Browser ←──polling 5min──→ Express (Node.js) ←──WebSocket──→ AISStream.io
                                 │         └──curl subprocess──→ MarineTraffic (Cloudflare)
                                 │         └──https───────────→ VesselFinder
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
│   │   ├── equasis-log.js     # Log di audit append-only dei lookup Equasis (equasis.log)
│   │   └── scrapers/
│   │       ├── http.js        # Helper HTTP/curl + parsing HTML
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
│       ├── notifications.js   # Feed notifiche in sidebar (badge, lista, segna come letta)
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
│   └── tokyo-mou-flags.json  # Liste Tokyo MoU
├── local.properties          # Config + API key (gitignored)
├── local.properties.example  # Template di configurazione
└── ais_data.db               # Database SQLite (creato al primo avvio, gitignored)
```

## ⚙️ Configurazione (`local.properties`)

La configurazione sta nel file `local.properties` nella root (formato `CHIAVE=valore`, righe con `//` o `#` ignorate). **Il file è in `.gitignore`** perché contiene la API key — non committarlo. Parti da `local.properties.example` (`cp local.properties.example local.properties`). Le chiavi possono anche essere passate come variabili d'ambiente.

| Chiave | Descrizione | Default |
|---|---|---|
| `AIS_API_KEY` | API key di [AISStream.io](https://aisstream.io) (obbligatoria) | — |
| `BBOX_PRESET` | Preset area iniziale (`bari` \| `taranto` \| `nord_adriatico` \| `puglia`) | `bari` |
| `IMPORT_VF_DATA` | Abilita scraping VesselFinder (`true`/`false`) | `false` |
| `IMPORT_MT_DATA` | Abilita scraping MarineTraffic (`true`/`false`) | `false` |
| `IMPORT_SANCTIONS` | Abilita screening lista sanzioni OFAC SDN (`true`/`false`) | `false` |
| `IMPORT_SANCTIONS_EXTRA` | Abilita liste sanzioni aggiuntive UE/UK OFSI/ONU oltre a OFAC (`true`/`false`) | `true` |
| `IMPORT_PSC` | Abilita screening Port State Control Paris/Tokyo MoU: performance bandiera + navi bandite (`true`/`false`) | `false` |
| `IMPORT_EQUASIS` | Abilita il lookup Equasis on-demand (proprietà/gestione) nel dettaglio nave (`true`/`false`) | `false` |
| `EQUASIS_USER` | Email account Equasis (registrazione gratuita su [equasis.org](https://www.equasis.org/)) — richiesta dal lookup Equasis | *(vuota)* |
| `EQUASIS_PASSWORD` | Password account Equasis — richiesta dal lookup Equasis | *(vuota)* |
| `AUTH_USER` | Username per l'autenticazione HTTP Basic (vedi [Autenticazione](#-autenticazione)) | `admin` |
| `AUTH_PASSWORD` | Password per l'autenticazione HTTP Basic. **Vuota = auth disattivata** | *(vuota)* |

`BBOX_PRESET`, `IMPORT_VF_DATA` e `IMPORT_MT_DATA` sono modificabili anche dalla UI (cambio area / modal Impostazioni) e vengono ri-persistiti nel file. `PORT` (variabile d'ambiente) imposta la porta HTTP (default 3000). `AUTH_USER`/`AUTH_PASSWORD` si leggono solo all'avvio (non modificabili dalla UI).

Esempio `local.properties`:

```properties
AIS_API_KEY=la_tua_api_key
BBOX_PRESET=taranto
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

Preset inclusi di default: `bari`, `taranto`, `nord_adriatico`, `puglia`.

Ci sono **due modi** per gestire le aree:

1. **Schermata 🗺 Aree (a runtime, senza riavvio)** — il bottone **🗺 Aree** nella sidebar apre una pagina con l'elenco delle aree (con coordinate, stato e quantità di dati salvati), una mappa che le visualizza tutte, e un pannello per aggiungerne di nuove:
   - **per coordinate GPS** in gradi decimali (campi SW lat/lon e NE lat/lon), oppure
   - **da mappa**: inquadra (zoom/pan) l'area da monitorare e premi **🎯 Cattura vista corrente** per riempire automaticamente le coordinate dal riquadro visibile.
   - Assegna un **nome** (obbligatorio) e una **parola chiave** facoltativa. La nuova area viene salvata in `bounding-boxes.json` e il suo stream parte subito.
   - **Eliminazione**: il cestino 🗑 rimuove l'area **e tutto lo storico dei monitoraggi correlati** (letture, navi, eventi porto). La cancellazione è **ritardata di 10 secondi** con un toast **↶ Annulla**: diventa effettiva allo scadere del timer o quando si lascia la pagina; premendo Annulla non viene eliminato nulla. Deve restare **almeno un'area** (l'ultima non è eliminabile).
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

Max 10.000 record per tipo di messaggio. Rotazione automatica (cancella i più vecchi) ogni 500 inserimenti per tipo. Le notifiche (tabella `notifications`) conservano gli ultimi 100 record, con rotazione automatica a ogni inserimento.

## 🎛️ Parametri configurabili

| Parametro                       | File                              | Dove                                  | Default        |
| ---------------------------------| ----------------------------------| --------------------------------------| ---------------|
| Intervallo polling UI           | `public/js/store.js`              | `POLL_INTERVAL = 300000`              | 300000 ms (5m) |
| Finestra "navi presenti"        | `src/db.js`                       | `ACTIVE_WINDOW = '-6 hours'`          | 6 ore          |
| Finestra retention "in porto"   | `src/db.js`                       | `PORT_WINDOW = '-24 hours'`           | 24 ore         |
| Soglia velocità "ferma"         | `src/config.js` (+ `src/db.js`)   | `SOG_FERMA = 0.5`                     | 0.5 kn         |
| Raggio "stessa sosta" (in porto)| `src/config.js`                   | `STILL_RADIUS_M = 100`                | 100 m          |
| Raggio merge traccia (de-noise) | `public/js/store.js`              | `TRACK_MERGE_RADIUS_M = 100`          | 100 m          |
| Ritardo riconnessione WebSocket | `src/services/ais-stream.js`      | `setTimeout(startStream, 5000)`       | 5000 ms        |
| Max record per tipo messaggio   | `src/db.js`                       | `pruneStmt.run(..., 10000)`           | 10.000         |
| Max punti track mappa           | `src/routes/ships.js` (`/track`)  | `Math.min(..., 2000)` e default `500` | 500 punti      |
| TTL cache scraping VF/MT        | `src/config.js`                   | `SCRAPE_CACHE_TTL`                    | 6 ore          |
| Bounce annullamento eliminazione notifiche | `app.config.properties` | `NOTIF_DELETE_UNDO_SECONDS`           | 5 s            |
| Raggio clustering banchine      | `app.config.properties`           | `BERTH_CLUSTER_EPS_M`                 | 80 m           |
| Attracchi minimi per banchina   | `app.config.properties`           | `BERTH_MIN_PTS`                       | 3              |
| Attracchi minimi caratterizzazione | `app.config.properties`        | `BERTH_MIN_MOORINGS`                  | 10             |
| Soglia % categoria dominante    | `app.config.properties`           | `BERTH_DOMINANT_PCT`                  | 60 %           |
| Intervallo ricalcolo banchine   | `app.config.properties`           | `BERTH_RECOMPUTE_MIN`                 | 30 min         |
| Auto-ripristino DB dopo deploy  | `app.config.properties`           | `AUTO_RESTORE_ON_DEPLOY`              | `true`         |
| Intervallo auto-backup su disco | `app.config.properties`           | `BACKUP_INTERVAL_MIN`                 | 120 min (2h)   |

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
| **Dettaglio nave** | Info statiche nave (tipo, IMO, callsign, dimensioni, destinazione…) + dati VesselFinder/MarineTraffic (se abilitati, sopra alla mappa) + **andamento dello [score di rischio nel tempo](#-storico-dello-score-di-rischio)** + mappa track (con soste collassate) + letture paginate + note + storico visite porto. Bottone **📄 Report** per generare un [report stampabile/PDF](#-report-pdf-della-nave) |
| **Traffico**       | Statistiche aggregate: card riepilogo, grafico arrivi per ora del giorno, arrivi per tipo nave; **distribuzione score rischio** (tile verde/giallo/rosso sulle navi degli ultimi 7 giorni), **principali fattori di rischio** (frequenza), **arrivi giornalieri** (ultimi 30 giorni), **navi con score più alto** (top 8 cliccabili); navi attese (per keyword preset), ultimi eventi porto |
| **Aree**           | Gestione aree a runtime: elenco con coordinate/stato/dati salvati, mappa con tutte le aree, pannello per aggiungere (coordinate GPS o cattura vista mappa) ed eliminare aree (con storico correlato e annullamento entro 10s) |

Modali accessori: **Impostazioni** (4 tab: Generali con toggle import VF/MT/sanzioni/PSC/Equasis e notifiche; **Aree** con toggle start/stop stream per ogni area; Developer options; **Backup/Ripristino** con auto-backup, esporta CSV, backup/ripristino database), **Diagnostica AIS Stream** (uptime, msg/min, riconnessioni, ultimo errore), **Log** (pannello live delle richieste API via SSE). Bottoni di navigazione sidebar: **🏠 Monitoraggi** (home) e **🗺 Aree**. La sidebar include anche il **🔔 feed notifiche** (lista con badge non-lette, vedi [Eventi porto, statistiche e alert](#-eventi-porto-statistiche-e-alert)).

Una nave "entra" nella lista presenti appena riceve la prima lettura. La finestra è ampia (6 ore) perché le navi in sosta trasmettono di rado: una nave ormeggiata può aggiornare la posizione anche solo ogni 3 ore (standard AIS classe A). Le navi **in porto** (vedi sotto) hanno una retention ancora più larga (24 ore), così restano visibili anche dopo un riavvio del server prima della successiva trasmissione.

Il flag "visto" (★/☆) è disponibile in tutte e tre le viste: colonna nella tabella presenti, colonna nella tabella passate (★ sposta la nave in fondo alla lista), e bottone nell'header del dettaglio nave.

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

Implementato server-side in [`src/services/risk-score.js`](src/services/risk-score.js) — `computeRiskScore(ship, lang)`. Per ogni nave interroga (sola lettura) lo storico via `db.getShipPositions` (posizioni ultime 168h), `db.getShipEvents` (eventi porto), `db.getDistinctShipNames`. Se l'import VF/MT è abilitato, legge anche i dati di registro **già in cache** via `db.getScrapedData` (vedi [Arricchimento dello score](#arricchimento-dello-score-da-vfmt)) — sola lettura, nessuno scraping live durante il calcolo.

Ogni firma rilevata aggiunge punti pesati a un **subtotale anomalie**:

| Firma comportamentale | Logica di rilevamento | Peso max |
|---|---|---|
| **Blackout AIS (dark activity)** | Gap più lungo tra letture consecutive **iniziato mentre la nave era in moto** (SOG ≥ `SOG_FERMA`). Le navi in porto trasmettono di rado → contano solo i silenzi in navigazione. ≥ 6h → max; 2–6h → parziale | 25 |
| **Spoofing / cinematica anomala** | Velocità implicita tra due posizioni consecutive (distanza haversine / Δt, con Δt ≤ 1h, distanza > 500 m). > 80 kn = salto fisicamente impossibile; > 50 kn = anomalo | 20 |
| **Aumento pescaggio (carico)** | Massimo incremento positivo del `draught` dichiarato tra eventi porto consecutivi (unità AIS = decimi di metro). Indica materiale pesante imbarcato. ≥ 0.5 m attiva il punteggio | 20 |
| **Loitering / sosta anomala** | Posizioni ferme (SOG < `SOG_FERMA`), **non** ormeggiate/all'ancora (stato ≠ 1/5), a > 10 km dal centro del bbox monitorato → possibile trasbordo ship-to-ship in mare aperto | 15 |
| **Instabilità destinazione** | Numero di destinazioni dichiarate distinte (campo corrente + eventi). Più cambi = più punti | 10 |
| **Tipo scafo** | Militare (35) → **score 100 automatico** (early return, nessuna analisi); Cargo/Tanker Hazmat (71–74, 81–84) → 8; Cargo/Tanker (70–89) → 5 | 100 / 8 / 5 |
| **Rilevamento militare** | `isMilitary(ship)` in `risk-score.js`: **flag DB** `is_military = 1` **oppure** `ship_type === 35` **oppure** il nome nave contiene token militari (prefissi: `HMS`, `USS`, `FS`, `FGS`, `HNLMS`, `HMAS`, `HMCS`, `INS`, `BNS`, `HDMS`, `HTMS`, `TCG`, `ORP`, `ITS`, `ROKS`, `NRP`, `RFS`, `ESPS`, `SPS`; keyword: `WARSHIP`, `NATO`). Le navi identificate: ricevono `is_military: true` e `flagged: true` forzato nella risposta API, riga evidenziata in rosso con classe `.military-row` (ha priorità su `.flagged-row`). Il flag manuale (`is_military` in DB) permette di marcare navi militari che non hanno `ship_type 35` né prefisso/keyword riconoscibile (es. navi Marina Militare italiana trasmesse senza prefisso "ITS"). Si imposta dal pannello detail con il bottone `🪖 Segna come nave militare`. | — |
| **Cambio nome scafo** | Stesso MMSI che trasmette più nomi distinti (flag/name hopping) | 8 |
| **Arricchimento esterno (VF/MT)** | Dati registro da VesselFinder/MarineTraffic, **solo se l'import è abilitato e già in cache** (vedi sotto): bandiera registrata sotto embargo → 12, bandiera di comodo → 5, scafo datato (≥ 35 anni) → 6, porto di armamento in zona ad alto rischio → 8 | 12 |
| **Sanzioni (OFAC SDN + UE/UK/ONU)** | Match con le liste sanzioni per IMO/nome/call sign, solo se `IMPORT_SANCTIONS` (vedi `sanctions.js`): oltre a OFAC SDN, confronta anche con la lista consolidata UE, la lista UK OFSI e la lista ONU navi designate (via OpenSanctions), liste aggiuntive gestite da `IMPORT_SANCTIONS_EXTRA`. Segnale diretto fortissimo | 60 |
| **Port State Control (Paris/Tokyo MoU)** | Solo se `IMPORT_PSC` (vedi sotto): bandiera in black list MoU → 12, in grey list → 5; nave nella banned list Paris MoU (refusal of access dopo fermi multipli) → 40 | 40 |

**Moltiplicatore di contesto geopolitico** applicato al subtotale anomalie:

- `× +0.5` se la destinazione dichiarata contiene un porto/paese sotto embargo o zona di conflitto (lista `HIGH_RISK_DEST`: Siria, Iran, Corea del Nord, Libia, Yemen, Sudan, Russia/Crimea, Somalia…), **oppure** se la bandiera è di uno stato sotto embargo (`EMBARGO_MID`: NK 445, Siria 468, Iran 422, Libia 642, Russia 273).
- `× +0.2` se la nave batte una **bandiera di comodo** (`FOC_MID`: Panama, Liberia, Marshall, Comore, Togo, Tanzania, Cook, Sierra Leone, Moldova, Cambogia, Palau, Mongolia…).

La **bandiera** è derivata dal **MID** (Maritime Identification Digits = prime 3 cifre dell'MMSI).

Formula finale:

```
score = clamp( round( subtotaleAnomalie × moltiplicatore ), 0, 100 )
```

`computeRiskScore(ship, lang)` ritorna `{ score, band, factors, sources }`, dove `band` ∈ `low|med|high`, `factors` è l'elenco ordinato `{label, points}` delle firme che hanno contribuito (label nella lingua richiesta), e `sources: { vf, mt, sanctions, psc }` indica quali fonti esterne erano presenti/consultate al momento del calcolo (ognuna `none`/`available`/`used`). Il parametro `lang` (`'it'` default, `'en'` supportato) viene inoltrato automaticamente da `api.js` in base alla lingua selezionata nel frontend.

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

Abilitato da `IMPORT_PSC`, implementato in [`src/services/psc.js`](src/services/psc.js) con lo stesso pattern **dataset** delle sanzioni (`sanctions.js`): liste pre-caricate in memoria, match locale per ogni nave, **nessuna chiamata di rete per-nave**. Due segnali complementari:

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

## 📈 Storico dello score di rischio

Lo [score di rischio](#-score-di-rischio-potenziale-trasporto-armi) è ricalcolato a ogni richiesta, ma viene anche **campionato e salvato** nel tempo (tabella `risk_history`) così il dettaglio nave può mostrarne l'**andamento** — un'escalation è di per sé un segnale.

- **Campionamento sparso**: `db.recordRiskSnapshot(mmsi, score, band)` inserisce un punto **al massimo una volta all'ora per nave**, più ogni volta che lo score cambia. Niente bloat: la tabella è inoltre limitata globalmente (rotazione a 20.000 righe).
- **Punti di campionamento**: a ogni **arrivo** della nave (lo stream calcola già lo score per la notifica `high_risk`) e all'**apertura del dettaglio** (`GET /api/ships/:mmsi`).
- **Visualizzazione**: grafico a barre colorate per fascia nel dettaglio nave (`renderRiskHistory` in `public/js/ships.js`), con variazione complessiva (▲/▼). Servono almeno due rilevazioni; finché non si accumulano, mostra un avviso. Endpoint `GET /api/ships/:mmsi/risk-history`.
- Lo storico viene incluso nel backup del database e cancellato insieme ai dati dell'area (o di tutto) dalle funzioni di cancellazione.

## 📄 Report PDF della nave

Il bottone **📄 Report** nell'header del dettaglio genera un **report stampabile** della nave: apre una finestra con un documento HTML autoconsistente (stili inline) e lancia la stampa del browser — da cui si può salvare come **PDF** (*Stampa → Salva come PDF*). Nessuna dipendenza server-side per i PDF. Il report include intestazione (nome, MMSI, data), **score di rischio con fattori**, tabella dati nave, **storico visite in porto** e note operative, con un disclaimer sull'uso dello score come strumento di triage.

## ⚓ Rilevamento "in porto" e de-noise della traccia

Una nave ormeggiata/all'ancora non è perfettamente immobile: oscilla sull'ancora, deriva per corrente, ha rumore GPS. Questi piccoli spostamenti vanno distinti dal movimento reale.

> **Nota AIS**: la *velocità in acqua* (STW, Speed Through Water) **non è trasmessa** dai messaggi AIS — è disponibile solo la **SOG** (Speed Over Ground). La classificazione usa quindi SOG + distanza tra posizioni, non STW.

**Flag `in_port`** (`isInPort` in `src/services/ship-analysis.js`) — una nave è "in porto" se:
1. lo stato navigazionale AIS è ormeggiata (`5`) o all'ancora (`1`), **oppure**
2. *(isteresi)* le posizioni degli ultimi 30 minuti restano tutte entro `STILL_RADIUS_M` (100 m) dal loro centroide — sta ferma, solo deriva/swing, anche se la SOG istantanea ogni tanto supera la soglia, **oppure**
3. l'ultima SOG è < `SOG_FERMA` (0.5 kn).

L'isteresi evita che lo swing all'ancora faccia "lampeggiare" la nave dentro/fuori dallo stato in-porto. Le navi in porto sono marcate con badge ⚓ (lista, popup mappa, dettaglio) e beneficiano della retention di 24 ore.

**De-noise traccia** (`collapseTrack` in `public/js/maps.js`) — nella mappa del dettaglio, i punti consecutivi fermi (SOG < 0.5) entro `TRACK_MERGE_RADIUS_M` (100 m) sono collassati in un unico nodo **⚓ Sosta** (popup con numero di posizioni e intervallo orario). La polilinea passa per i centroidi → traccia pulita invece di una nuvola di marker attorno alla banchina. Le letture grezze nel DB restano intatte: il merge è solo a livello di visualizzazione.

## ⚓ Banchine (caratterizzazione automatica degli attracchi)

Il sistema deduce automaticamente **dove** le navi attraccano e **di che tipo** sono, evidenziando i moli "caratterizzati" con un overlay colorato sulla mappa delle navi presenti. Tutto è correggibile a mano.

**Pipeline** (`src/services/berths.js`, per area):

1. **`detectMoorings(area)`** — un punto di attracco per visita = centroide delle letture *ferme* della nave (`sog < SOG_FERMA` o stato AIS ormeggiata/ancora `5`/`1`) nella finestra tra un arrivo e l'arrivo successivo della stessa nave (gli arrivi vengono da `port_events`). Le visite di puro transito (nessuna lettura ferma) sono scartate. Ogni punto è etichettato con la **categoria** della nave (`src/services/ship-categories.js`: cargo, tanker, passeggeri, pesca, servizio, militare, diporto, alta velocità, altro).
2. **Clustering** — DBSCAN con distanza haversine (`BERTH_CLUSTER_EPS_M`, `BERTH_MIN_PTS`). I punti dentro il poligono di una banchina **manuale** vengono assegnati prima ed esclusi dal clustering (la geometria disegnata a mano vince). La geometria di una banchina automatica è l'**inviluppo convesso** (convex hull) dei suoi punti.
3. **Caratterizzazione** — conteggio categorie per banchina: la dominante (≥ `BERTH_DOMINANT_PCT`, su almeno `BERTH_MIN_MOORINGS` attracchi) dà nome e colore alla banchina, altrimenti è **"mista"**; sotto la soglia minima resta non caratterizzata (tratteggiata). Calcola anche la quota di **merci pericolose** (☢, codici AIS 71–74/81–84).

**Persistenza delle correzioni** — le banchine automatiche vengono ricostruite ad ogni ricalcolo, ma una banchina rinominata/forzata riacquista la sua identità per prossimità del centroide (entro `eps`). Le banchine **manuali** (geometria bloccata da `manual_geom=1`) non vengono mai spostate. La caratterizzazione automatica è sempre ricalcolata, ma l'override manuale (`char_override`) ha la precedenza in lettura.

**Ciclo di calcolo** — *backfill* una tantum all'avvio (`berths.recomputeAll()` in `src/server.js`, idempotente) su tutto lo storico, poi ricalcolo periodico in background ogni `BERTH_RECOMPUTE_MIN` minuti.

**Frontend** (`public/js/berths.js`) — overlay `L.polygon` su un pane dedicato (sotto i marker nave, così non ne ruba i click) più un **marker centroide** a dimensione costante (il poligono ~80 m è invisibile allo zoom dell'intera area), toggle **Banchine** nella barra filtri (stato in `localStorage`), popup con distribuzione percentuale, e pannello di gestione (**⚓ Banchine**): rinomina, forza categoria, unisci, elimina, ricalcola; **clic su una riga** centra la mappa sulla banchina e ne apre il popup.

## 🔗 Integrazione MarineTraffic / VesselFinder

Nel dettaglio nave, due pannelli arricchiscono i dati AIS con dati scaricati (scraping) da fonti esterne, con cache in tabella `ship_scrape_cache` (TTL configurabile via `SCRAPE_CACHE_TTL`).

**VesselFinder** — pagina server-rendered, lo scraping HTML (`crawlVesselFinder`) estrae foto + tabella dati via `fetchHttp` (modulo `https`).

**MarineTraffic** — più complesso, due ostacoli:

1. **ID interno**: le pagine MT sono una SPA React indicizzata per `shipid` proprietario, non per MMSI/IMO/callsign. Lo `shipid` si risolve via l'endpoint `GET /{lang}/global_search/search?term=<MMSI|IMO|callsign>&types=1,3,7,9` → `results[0].id`. Lo `shipid` risolto è salvato in `ships.mt_ship_id` e usato per il link diretto. I dati nave si leggono poi da `GET /{lang}/vesselDetails/vesselInfo/shipid:<id>` (JSON pulito, include `typeSpecific` = sottotipo nave).
2. **Cloudflare**: MT blocca i client TLS di Node (`https`/`http2`) con HTTP 403 via fingerprint JA3/JA4, a prescindere dagli header. **`curl` passa** (stack TLS diverso), quindi le richieste MT sono fatte tramite subprocess `curl` (`fetchViaCurl` in `src/services/scrapers/http.js`).

> ⚠️ **Dipendenza di deploy**: il crawler MarineTraffic richiede che **`curl` sia installato** sull'host. Su Linux/macOS è quasi sempre presente. Nota: il fingerprint TLS di `curl` può variare tra build (es. curl-OpenSSL su Linux vs curl-SecureTransport su macOS) e Cloudflare potrebbe trattarli diversamente — da verificare in produzione.

L'integrazione MT/VF è attivabile/disattivabile via le proprietà `IMPORT_MT_DATA` / `IMPORT_VF_DATA` in `local.properties` (o dai toggle nelle impostazioni UI, che le persistono).

### Arricchimento proattivo alla prima rilevazione

Oltre al caricamento on-demand nel dettaglio, l'arricchimento parte **automaticamente quando una nuova nave compare** sullo stream AIS, così lo [score di rischio](#arricchimento-dello-score-da-vfmt) può usare subito i dati di registro senza attendere l'apertura del dettaglio.

Flusso ([`src/services/enrichment.js`](src/services/enrichment.js)):

1. `db.insert` segnala la prima comparsa di un MMSI restituendo `{ arrivedFlagged, newShip }` (`newShip` = mmsi se l'MMSI non era mai stato visto).
2. In `ais-stream.js`, su `newShip` viene chiamato `enrichment.enrichNewShip(mmsi)`.
3. `enrichNewShip` interroga in background **solo le fonti abilitate** e salva il risultato in `ship_scrape_cache`.

Garanzie:

- **Una sola volta**: salta se esiste già cache per quella fonte, con guardia `inFlight` contro fetch concorrenti duplicati. Non riparte per navi già note (nemmeno dopo un riavvio).
- **Non bloccante**: fire-and-forget, nessun `await` nel loop di ingest AIS. Errori loggati (`[ENRICH:vf|mt]`), mai propagati.
- Se l'MMSI compare prima dei dati statici (IMO/callsign assenti), VF/MT risolvono comunque tramite MMSI.

### Lookup Equasis (proprietà/gestione, on-demand)

[Equasis](https://www.equasis.org/) è un database gratuito EU/US che espone i dati di **proprietà e gestione** della nave (registered owner, ISM manager, operator, DOC company) che l'AIS non trasmette e che VF/MT non offrono gratis. Lo scraper [`src/services/scrapers/equasis.js`](src/services/scrapers/equasis.js) (`crawlEquasis(imo)`) è volutamente **fuori** dal percorso di arricchimento proattivo: parte **solo** quando l'utente preme **Recupera informazioni Equasis** nel dettaglio.

Differenze rispetto a VF/MT:

- **Solo su richiesta**: nessun fetch automatico né alla comparsa né all'apertura del dettaglio. L'endpoint serve la cache; scrapa solo con `?fetch=1` (il pulsante).
- **Nessuna scadenza**: il risultato è salvato in `ship_scrape_cache` con source `eq` e mostrato per sempre (a differenza del TTL `SCRAPE_CACHE_TTL` di VF/MT). Dopo il primo recupero il pulsante sparisce.
- **Interroga per IMO**: Equasis è indicizzato solo per numero IMO; senza IMO il lookup fallisce con errore.
- **Login richiesto**: ogni query richiede una sessione autenticata, quindi servono `EQUASIS_USER` / `EQUASIS_PASSWORD`. Senza credenziali la feature resta nascosta/inutilizzabile (`equasisConfigured`).

Flusso (`crawlEquasis`, reverse-engineered): `POST /EquasisWeb/authen/HomePage` (`j_email`+`j_password`) → cookie di sessione → `POST /EquasisWeb/restricted/ShipInfo` (`P_IMO`) → HTML dettaglio. I cookie stanno in un jar temporaneo per la durata delle due chiamate. Come MarineTraffic, **usa `curl`** in subprocess (stessa dipendenza di deploy). La pagina di dettaglio è divisa in sezioni commentate (`<!-- Overview -->`, `<!-- MGT DET -->`, `<!-- Classification -->`, `<!-- PI -->`, `<!-- Geo -->`, …), ognuna duplicata in markup desktop (`<table>`) e mobile (`hidden-md hidden-lg`): il parser usa sempre il desktop e ignora il duplicato. Estrae sei blocchi: `particulars` (nome/IMO dall'`<h4>` + bandiera, call sign, MMSI, tonnellaggi, tipo, anno, stato dai blocchi `<b>label</b>`), `management` (`parseManagement`, tabella *Management detail(s)* mappata per intestazione di colonna così da reggere i riordini di Equasis), `classification` (società, stato, data), `pi` (club P&I + inception), `risk` (tasso detenzioni 36 mesi, classe IACS, performance Paris/Tokyo MOU, targeting USCG dalla sezione *Overview*) e `positions` (ultime aree in cui la nave è stata vista).

**Log di audit**: ogni lookup (successo o errore) viene aggiunto in append a un file di testo `equasis.log` (root di progetto, gitignored) da [`src/services/equasis-log.js`](src/services/equasis-log.js): timestamp, MMSI, IMO, nome nave e i dati recuperati (o il messaggio d'errore). Il log è consultabile dalla UI col pulsante **Visualizza log Equasis** nelle impostazioni (endpoint `GET /api/equasis-log`, lettura tail-troncata a 256 KB; `DELETE /api/equasis-log` lo svuota).

## 📋 Eventi porto, statistiche e alert

**Eventi porto** (tabella `port_events`) — il backend rileva automaticamente:
- **Arrivo** (`arrived`): una nave compare dopo > 60 minuti di assenza (o per la prima volta).
- **Partenza** (`departed`): rilevata da `checkAndLogDepartures`, che marca come partite le navi il cui ultimo contatto cade nella finestra `-62…-60 minuti` senza una partenza già registrata di recente.

**Statistiche** (`/api/stats`, vista Traffico) — arrivi oggi / settimana / totali, durata media di sosta (accoppiando ogni arrivo con la partenza successiva), distribuzione arrivi per ora del giorno e per tipo nave.

**Score aggregati** (`/api/stats/scores`, vista Traffico) — calcolati sulle navi viste negli ultimi 7 giorni: distribuzione per fascia di rischio (`byBand`), top 8 navi per score (`topShips`), fattori più frequenti tra tutte le navi (`byFactor`), serie storica arrivi giornalieri ultimi 30 giorni (`dailyArrivals`). Il calcolo invoca `computeRiskScore` per ogni nave della finestra, quindi il tempo di risposta scala con il numero di navi recenti.

**Navi attese** (`/api/ships/expected`) — navi con `destination` contenente la keyword del preset corrente (es. `TARANTO`), uscite dall'area nelle ultime 48 ore — utili per anticipare arrivi.

**Alert navi segnalate** (`/api/alerts`) — quando una nave con flag ★ (segnalata) rientra nell'area, l'arrivo viene accodato e mostrato come toast nel frontend al polling successivo.

**Notifiche** (tabella `notifications`, `/api/notifications`) — storico persistente mostrato nella barra laterale. Cinque tipi di notifica vengono generati (tutti abilitabili/disabilitabili indipendentemente dalle Impostazioni, oltre all'interruttore generale `notificationsEnabled`):

- `revisit` — una nave **già arrivata in passato nella stessa area** vi rientra dopo un'assenza (`db.insert` ritorna `revisit`); controllata da `notifyRevisit` / `NOTIFY_REVISIT`.
- `area_change` — una nave vista in un'area viene poi rilevata in un'**altra** area (`db.insert` ritorna `areaChange` confrontando `last_area` della nave con l'area del messaggio prima dell'upsert); la notifica memorizza l'area di partenza in `from_area` e quella di arrivo in `area`; controllata da `notifyAreaChange` / `NOTIFY_AREA_CHANGE`.
- `high_risk` — una nave **arriva** (nuova o dopo > 60 min di assenza, `db.insert` ritorna `arrived`) con **score di rischio in fascia rossa** (71–100); controllata da `notifyHighRisk` / `NOTIFY_HIGH_RISK`. Utile per il triage immediato dei casi critici senza aspettare la vista Traffico.
- `berth_new` — durante il ricalcolo banchine (`berths.recomputeArea`) viene rilevata una **nuova banchina automatica** (cluster senza identità ereditata); controllata da `notifyBerthNew` / `NOTIFY_BERTH_NEW`.
- `berth_characterized` — una banchina (automatica o manuale) viene **caratterizzata per la prima volta** (il `char_label` calcolato passa da `NULL` a una categoria); la categoria è memorizzata in `band`; controllata da `notifyBerthChar` / `NOTIFY_BERTH_CHAR`.

Per le notifiche nave `ais-stream` calcola lo score e chiama `db.addNotification` (le navi con `notif_muted` sono escluse); per le notifiche banchina è `berths.recomputeArea` a chiamarlo, memorizzando in `berth_id` la banchina di riferimento per la navigazione. Il primo ricalcolo su un'area senza banchine preesistenti **non** genera notifiche (per evitare una raffica di "nuova banchina" sul backfill iniziale). Ogni notifica nave conserva la fascia di rischio (`band`) e lo `score` calcolati al momento dell'evento, mostrati come bollino verde/giallo/rosso; le notifiche banchina mostrano un bollino dedicato. Un **clic** su una notifica nave apre la scheda della nave, su una notifica banchina porta alla mappa dell'area corrispondente con la banchina centrata. Endpoint: `GET /api/notifications` (lista + conteggio non lette), `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`, `DELETE /api/notifications/:id` (singola), `DELETE /api/notifications` (tutte). Conservate le ultime 100 (rotazione automatica a ogni inserimento).

**Eliminazione con annullamento** — sia la singola notifica (cestino 🗑 sulla riga) sia il pulsante **🗑 cancella tutte** (accanto al badge non-lette nella sidebar) eliminano con una **finestra di annullamento** (toast "↶ Annulla") prima che la cancellazione diventi effettiva. La durata del bounce è configurabile in `app.config.properties` con `NOTIF_DELETE_UNDO_SECONDS` (default 5 s; `0` = eliminazione immediata) ed è esposta al frontend via `/api/config`.

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
6. Cliccare una riga nave → vista **Dettaglio**: info-bar + dati VesselFinder/MarineTraffic (se abilitati) + **andamento score di rischio** + mappa track (soste collassate) + letture paginate + note + storico visite porto. Bottone **📄 Report** per il [report PDF](#-report-pdf-della-nave)
7. Cliccare una riga lettura nel dettaglio → modal con dati grezzi AIS
8. **← Indietro** per tornare alla lista precedente
9. Tab **Navi passate**: navi non più nel criterio "presenti"; cliccare ★ per segnalarle / ✓ per marcarle viste
10. Tab **Traffico**: statistiche, grafici arrivi per ora/tipo; distribuzione score rischio (verde/giallo/rosso), fattori più frequenti, arrivi per giorno (30gg), top 8 navi per score (cliccabili); navi attese, ultimi eventi porto
11. **⚙ Impostazioni** — 4 tab:
    - **Generali**: abilita/disabilita import VesselFinder, MarineTraffic, Equasis, screening sanzioni (OFAC + UE/UK/ONU), Port State Control, notifiche
    - **Aree**: toggle start/stop stream per ogni area (stato 🟢/⚪)
    - **Developer options**: notifica di test
    - **Backup/Ripristino**: auto-backup locale + esportazione manuale + ripristino selettivo (vedi [Backup e ripristino](#backup-e-ripristino-del-database))
11b. **🗺 Aree**: gestione aree a runtime — elenco con coordinate, stato e dati salvati; mappa di tutte le aree; aggiunta di una nuova area per **coordinate GPS** o con **🎯 Cattura vista corrente** (inquadrando l'area sulla mappa); eliminazione di un'area e del relativo storico, con **toast di annullamento (10s)**. Il bottone **🏠 Monitoraggi** torna alla home.
12. **📡 Diagnostica AIS**: stato connessione (uptime, msg/min, riconnessioni, errori) per l'area correntemente visualizzata
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

I backup automatici si trovano in `data/backups/tracker-porti-autobackup-<timestamp>.json`; i manuali in `tracker-porti-manualbackup-<timestamp>.json`.

#### Auto-ripristino dopo un deploy

Il database `ais_data.db` è gitignored: un deploy che ricrea la cartella applicativa lo **cancella**. All'avvio, se il file del database **non esiste** (è appena stato ricreato vuoto) e in `data/backups/` c'è almeno un auto-backup, il server **ripristina automaticamente l'ultimo backup** — solo il database (le aree in `bounding-boxes.json` e le impostazioni in `local.properties` sono file che sopravvivono al deploy, quindi non vengono toccati). Vedi log `[RESTORE] DB assente dopo il deploy → ripristinato l'ultimo backup …`.

- Scatta **solo** quando il file `.db` era assente all'avvio: un DB esistente ma vuoto (es. dopo **🗑 Cancella dati** + riavvio) **non** viene ripristinato, così non si "resuscitano" dati cancellati di proposito.
- Disattivabile con `AUTO_RESTORE_ON_DEPLOY=false` in `app.config.properties`.
- **Importante**: perché funzioni, la cartella `data/backups/` deve **sopravvivere al deploy** (es. su un volume persistente / fuori dalla dir sostituita dal deploy). Vedi [Deploy su server Linux](#-deploy-su-server-linux-vps).

#### Backup manuale (singolo componente)

- **Backup database** → scarica l'intero DB come singolo file `.db` (`tracker-porti-backup-<timestamp>.db`). È uno snapshot consistente (`VACUUM INTO`), sicuro anche con lo stream AIS attivo e senza file sidecar WAL/`-shm`.
- **Ripristina database** → carica un file `.db` di backup: **tutti** i dati attuali vengono sostituiti (operazione irreversibile, con conferma). Il file viene validato (header SQLite) e le tabelle copiate colonna-per-colonna sull'intersezione delle colonne, quindi un backup con schema più vecchio si ripristina comunque. Non serve riavviare l'app. Dopo il ripristino, le righe con `area` non valorizzata vengono automaticamente assegnate all'area corretta in base alle coordinate (bounding box più specifica che contiene il punto).

---

## 🔐 Autenticazione

L'app **non ha autenticazione di default**: in locale (`localhost`) non serve. Appena la esponi su una rete o su internet (vedi [Deploy](#-deploy-su-server-linux-vps)) **tutte** le rotte — incluse quelle distruttive (`POST /api/restore`, `DELETE /api/areas/:key`, `DELETE /api/readings`) — sono raggiungibili da chiunque. Per evitarlo l'app integra un gate **HTTP Basic Auth** a livello applicativo (`src/middleware/auth.js`), senza bisogno di configurare un reverse proxy.

**Attivazione** — imposta una password in `local.properties` (file gitignored, mai committato — stesso schema di `AIS_API_KEY`):

```properties
AUTH_USER=admin
AUTH_PASSWORD=una_password_robusta
```

- `AUTH_PASSWORD` **vuota o assente → auth disattivata** (comportamento di default, sviluppo locale invariato).
- Con la password impostata, il browser mostra il **dialog di login nativo** e rimanda le credenziali automaticamente su ogni richiesta: API, file statici e stream SSE. Nessuna modifica al frontend, nessuna login page.
- Il middleware è montato **prima** di static e API in `app.js`, quindi protegge l'intera app. Confronto credenziali a **tempo costante** (`crypto.timingSafeEqual`).
- Le chiavi si leggono **solo all'avvio**: dopo aver cambiato `AUTH_PASSWORD` riavvia il server.

> ⚠️ **Basic auth non cifra**: le credenziali viaggiano in base64 (≈ testo in chiaro) a ogni richiesta. Su rete fidata, VPN o **tunnel SSH** (`ssh -L 3000:localhost:3000 utente@server`) è adeguato. Per l'esposizione diretta su internet metti comunque **TLS** davanti (reverse proxy con HTTPS, Caddy, Cloudflare Tunnel…). Anche senza TLS, però, blocca scanner e accessi anonimi agli endpoint distruttivi: molto meglio di nessuna protezione.

---

## 🐧 Deploy su server Linux (VPS)

### Requisiti server

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

node --version   # v22+
npm --version

# curl è richiesto dal crawler MarineTraffic (vedi sezione integrazione MT/VF)
curl --version   # se assente: sudo apt-get install -y curl
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

> ⚠️ Aprire la porta espone l'app a chiunque raggiunga il server. **Imposta `AUTH_PASSWORD`** prima (vedi [Autenticazione](#-autenticazione)), idealmente con TLS davanti.

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
| `src/db.js`                   | Wrapper SQLite: schema `readings`/`ships`/`port_events`/`api_log`/`ship_scrape_cache`/`notifications`/`risk_history`/`moorings`/`berths`, insert/upsert, query, predicato attive |
| `src/services/ais-stream.js`  | Client WebSocket AISStream multi-area (`Map<areaKey, state>`) + riconnessione + eventi porto + notifiche di rientro e cambio area |
| `src/services/berths.js`      | Rilevamento attracchi + clustering DBSCAN + caratterizzazione banchine (convex hull, point-in-polygon, backfill/ricalcolo) + notifiche di nuova banchina e caratterizzazione |
| `src/services/ship-categories.js` | Mappa codice tipo nave AIS → categoria larga (cargo/tanker/passeggeri/…) + flag hazmat, usata per caratterizzare le banchine |
| `src/services/scrapers/`      | Scraping VesselFinder (https), MarineTraffic (curl) ed Equasis (curl, login, on-demand) |
| `src/services/risk-score.js`  | Score di rischio trasporto armi (0–100) da firme comportamentali AIS + dati registro VF/MT in cache |
| `src/services/enrichment.js`  | Arricchimento proattivo VF/MT (una volta) alla prima rilevazione di una nave |
| `src/services/sanctions.js`   | Liste sanzioni OFAC SDN + UE/UK/ONU (OpenSanctions): download CSV, indice in memoria, match nave per IMO/nome/call sign |
| `src/services/psc.js`         | Port State Control (Paris/Tokyo MoU): performance bandiera (JSON bundled) + banned list (CSV OpenSanctions), match per nome bandiera / IMO |
| `src/routes/`                 | Router Express per dominio (ships, readings, events, notifications, logs, settings, app-config, stream, areas, berths, export) |
| `public/index.html`           | SPA: sidebar collassabile, tab nav, 4 view + modali (impostazioni/diagnostica/log) |
| `public/js/`                  | Moduli ES: state machine SPA, polling, mappe Leaflet, de-noise track, grafici, export |
| `public/css/style.css`        | Design system con token CSS; tema scuro (default) e chiaro (selezionabile) |
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

**`port_events`** — eventi arrivo/partenza rilevati automaticamente: `mmsi`, `ship_name`, `event_type` (`arrived`/`departed`), `ts`, `ship_type`, `destination`, `draught`, `area TEXT NOT NULL DEFAULT ''` (area in cui è avvenuto l'evento).

**`api_log`** — log delle richieste HTTP (max 20.000, rotazione automatica): `ts`, `method`, `path`, `status`, `duration_ms`, `request_body`, `response_body`.

**`notifications`** — feed notifiche mostrato in sidebar (max 100, rotazione automatica): `type` (`revisit`, `area_change`, `high_risk`, `berth_new` o `berth_characterized`), `mmsi`, `ship_name` (per le banchine: il nome della banchina, se ha un nome), `area` (area di arrivo), `from_area` (area di partenza, solo per `area_change`), `band` (`low`/`med`/`high` per le notifiche nave; la categoria di banchina per `berth_characterized`) e `score` di rischio calcolati al momento dell'evento, `berth_id` (banchina di riferimento, solo per le notifiche banchina), `ts`, `read` (0/1).

**`risk_history`** — snapshot dello score di rischio nel tempo per il grafico di andamento (vedi [Storico dello score](#-storico-dello-score-di-rischio)): `mmsi`, `ts`, `score`, `band`. Campionata sparsa (max 1/ora per nave) e limitata globalmente (rotazione a 20.000 righe).

**`moorings`** — un punto di attracco per visita (vedi [Banchine](#-banchine-caratterizzazione-automatica-degli-attracchi)): `area`, `mmsi`, `ship_type`, `category` (categoria larga), `lat`, `lon`, `ts`, `berth_id` (banchina assegnata, `NULL` se non clusterizzato). Ricostruita dal servizio banchine ad ogni ricalcolo.

**`berths`** — banchine rilevate/disegnate: `area`, `name`, `polygon_json` (`[[lat,lon],…]`), `centroid_lat`/`centroid_lon`, `manual_geom` (1 = geometria bloccata a mano), `char_label` (categoria dominante calcolata o `mixed` o `NULL`), `char_override` (categoria forzata a mano, ha la precedenza), `mooring_count`, `dist_json` (distribuzione `[{category,n,pct}]`), `hazmat_pct`, `updated_at`. Entrambe incluse nei backup (`BACKUP_TABLES`).

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
| GET | `/api/ships/:mmsi/readings` | Letture di una nave (`?limit=50&offset=0`) |
| GET | `/api/ships/:mmsi/track` | Punti posizione per il tracciato mappa (`?limit=500`) |
| GET | `/api/ships/:mmsi/vfdata` | Dati scaricati da VesselFinder (con cache) |
| GET | `/api/ships/:mmsi/mtdata` | Dati scaricati da MarineTraffic (con cache); risolve e salva `mt_ship_id` |
| GET | `/api/ships/:mmsi/equasis` | Dati Equasis (proprietà/gestione) dalla cache; scrapa solo con `?fetch=1` (pulsante dettaglio). Mai automatico, nessuna scadenza |
| GET / DELETE | `/api/equasis-log` | Legge (tail 256 KB) / svuota il log di audit testuale dei lookup Equasis (`equasis.log`) |
| GET | `/api/ships/:mmsi/events` | Eventi porto (arrivi/partenze) di una nave |
| GET | `/api/ships/:mmsi/risk-history` | Serie storica degli snapshot di score di rischio della nave (`{history:[{ts,score,band}]}`) |
| GET | `/api/ships/expected` | Navi attese nell'area (`?area=`): destinazione = keyword preset, uscite < 48h |
| PATCH | `/api/ships/:mmsi/flag` | Imposta flag segnalata `{flagged: 0\|1}` |
| PATCH | `/api/ships/:mmsi/seen` | Imposta flag vista `{seen: 0\|1}` |
| PATCH | `/api/ships/:mmsi/notes` | Imposta note libere `{notes: "…"}` |
| PATCH | `/api/ships/:mmsi/military` | Imposta flag militare manuale `{is_military: 0\|1}` → forza score 100 e riga rossa |
| GET | `/api/readings` | Letture globali (`?type=&limit=50&offset=0`) |
| GET | `/api/readings/:id` | Dettaglio singolo record con raw JSON |
| DELETE | `/api/readings` | Cancella letture, navi ed eventi porto dell'area specificata (`?area=`, default: area corrente) |
| GET | `/api/events` | Eventi porto dell'area (`?area=&limit=100&offset=0`) |
| GET | `/api/stats` | Statistiche aggregate dell'area (`?area=`) — arrivi, sosta media, per ora/tipo |
| GET | `/api/stats/scores` | Score di rischio aggregati dell'area (`?area=`) sulle navi degli ultimi 7 giorni: `byBand` (count per fascia), `topShips` (top 8 per score), `byFactor` (fattori più frequenti), `dailyArrivals` (arrivi per giorno ultimi 30gg) |
| GET | `/api/alerts` | Coda alert di navi segnalate rientrate in area (svuotata alla lettura) |
| GET | `/api/notifications` | Feed notifiche (ultime 100) + conteggio non lette: `{notifications, unread}` |
| POST | `/api/notifications/:id/read` | Segna una notifica come letta → `{ok, unread}` |
| DELETE | `/api/notifications/:id` | Elimina una notifica → `{ok, unread}` |
| DELETE | `/api/notifications` | Elimina **tutte** le notifiche → `{ok, unread:0}` |
| POST | `/api/notifications/read-all` | Segna tutte le notifiche come lette → `{ok, unread:0}` |
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
| POST | `/api/settings` | Cambia preset, toggle import e toggle notifiche `{preset?, importVfData?, importMtData?, notificationsEnabled?, notifyRevisit?, notifyAreaChange?, notifyHighRisk?, notifyBerthNew?, notifyBerthChar?}` |
| GET | `/api/areas` | Elenco aree con bbox, stato stream, flag `current` e conteggi dati (`counts`); `{areas, preset, minAreas}` |
| POST | `/api/areas` | Aggiunge un'area `{name, sw:[lat,lon], ne:[lat,lon], keyword?, autostart?}` → salva in `bounding-boxes.json` e avvia lo stream (salvo `autostart:false`) |
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
- **Riavvio e dati**: il DB (`ais_data.db`, WAL) persiste tra i riavvii. Dopo un riavvio le navi che trasmettono di rado (ormeggiate) possono non comparire subito in "presenti" finché non ritrasmettono — vedi finestre 6h/24h.
- **`curl` richiesto**: lo scraping MarineTraffic usa un subprocess `curl` (bypass Cloudflare). Assente `curl`, l'import MT fallisce ma il resto dell'app funziona.
- **Node.js versione**: il modulo `node:sqlite` è built-in da Node 22.5+. Non funziona su versioni precedenti.
