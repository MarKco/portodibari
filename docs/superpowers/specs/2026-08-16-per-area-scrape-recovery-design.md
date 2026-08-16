# Recupero dati via scraping per-area + scoperta porti — design

Data: 2026-08-16
Stato: approvato in chat, in attesa di piano di implementazione

## Contesto e motivazione

La "modalità fallback" attuale (`src/services/fallback-mode.js`, introdotta in f7eac56/aec40dd) è un
interruttore **globale**: entra dopo `AIS_FALLBACK_HOURS` (6h) di disservizio *dell'intero* stream di
monitoraggio, esce dopo `AIS_FALLBACK_EXIT_GRACE_MIN` (20min) di servizio stabile. Due problemi reali:

1. **Non copre le aree naturalmente povere di traffico AIS** (es. un porto piccolo come Bari): l'area
   può avere pochissimi dati anche con AISStream perfettamente sano altrove, ma la modalità fallback
   non scatta mai per lei specificamente — serve un down *globale* di 6h.
2. **In produzione (16/08/2026) si osservano flap ogni 10-20 min** del banner disservizio (silenzio
   locale che supera `AIS_OUTAGE_SILENCE_MIN`=10min ripetutamente) con picchi di CPU correlati — causa
   non isolata con certezza da codice statico (vedi sezione Rischi). Il redesign non promette di
   risolverlo da solo; va verificato in produzione dopo il deploy.

Decisione: sostituire il concetto di "modalità" on/off globale con un meccanismo **continuo, silenzioso,
per-area**: ogni area valuta in autonomia se i dati AIS che riceve sono sufficienti; se non lo sono
(che sia per un disservizio globale o per povertà di traffico locale), le sue navi entrano nello sweep
di scraping di supporto. Se *tutte* le aree diventano insufficienti insieme, è un disservizio globale
— ma è un comportamento **emergente**, non un flag dedicato.

Nello stesso lavoro si integra la **scoperta automatica dei porti** dentro una bounding box (utile sia
per capire dove concentrare lo scraping di supporto, sia per scoprire *nuove* navi mai viste tramite le
pagine arrivi/partenze di MyShipTracking).

## Cosa NON cambia

- `ship-follow.js`: lo scraping SF/MST per le navi **seguite** stale resta come oggi, per-nave,
  incondizionato — non ha bisogno del concetto di area.
- Budget/priorità/rotazione/circuit-breaker anti-ban (`FALLBACK_MAX_REQ_PER_HOUR`, coda oldest-first,
  rotazione sorgente, jitter, UA pool, circuit breaker per sorgente): restano **esattamente come sono**,
  a protezione di un meccanismo ora continuo invece che raro. Widening dello scope redistribuisce lo
  stesso budget su più navi, non lo aumenta — proprietà già esistente, ora più rilevante perché più
  aree possono essere insufficienti insieme.
- Sospensione VF/MT durante lo scraping di supporto: invariata (non danno coordinate gratis).
- `AIS_FALLBACK_HOURS` / `AIS_FALLBACK_EXIT_GRACE_MIN`: restano, ma **solo** per il banner disservizio
  AIS globale (`outage.js`), disaccoppiati dallo scraping.

## 1. Rilevamento "dati insufficienti" per-area

**Nuovo stato**, non esiste oggi: `src/services/ais-stream.js` traccia un solo `lastFrameAt` globale
(aggiornato da *qualunque* messaggio di *qualunque* area — vedi `getSilenceInfo()`). Serve un
`lastFrameAt` **per area**, aggiunto al `Map` interno `areas` (oggi tiene solo `{active, totalReceived}`),
stampato nello stesso punto in cui `totalReceived++` avviene oggi (dentro il message handler, dopo
`areaForActive(lat, lon)`).

Nuova funzione esportata, es. `getAreaSilenceInfo(areaKey)`, analoga a `getSilenceInfo()` ma per singola
area. Nuova soglia dedicata in config, **indipendente** da `AIS_OUTAGE_SILENCE_MIN` (quest'ultimo resta
per il banner globale):

- `AREA_SCRAPE_SILENCE_MIN` (default 10, minuti) — silenzio locale per l'area oltre cui è "insufficiente".
- `AREA_SCRAPE_EXIT_GRACE_MIN` (default 5, minuti) — isteresi minima per evitare flap se un'area riceve
  messaggi sporadici proprio a cavallo della soglia.

Nessuna verifica su monitor esterno (a differenza del banner globale): non serve dichiarare "AISStream è
giù nel mondo", basta "quest'area sta zitta da troppo".

## 2. Scraping di supporto — da modalità a sweep continuo

`fallback-mode.js` perde il concetto `isActive()`/`enter()`/`exit()` come gate d'esecuzione. Lo sweep
(`sweep()`, ogni 3 min, invariato) gira **sempre**; la sua candidate pool cambia:

- Navi seguite stale: **invariato**, sempre incluse (nessuna dipendenza da area).
- Navi di area stale: incluse **solo se** (a) l'area ha lo scope "completo" abilitato (opt-in **per
  area**, persistito per area — non più un flag globale legato a un "ingresso in modalità") **e** (b)
  quell'area è attualmente insufficiente (`getAreaSilenceInfo` oltre soglia).

`meta` keys `fallback_mode_active`/`fallback_mode_since` (globali) vengono ritirate. Lo scope per-area
va persistito — nuova colonna o tabella (es. `areas.scrape_scope_full` via `ALTER TABLE`, boolean,
default 0), non più `state.fallbackScopeAreas` globale.

## 3. Banner disservizio AIS — invariato nel meccanismo, cambia il testo

`ais-uptime.js` resta come oggi (silenzio globale + cross-check monitor esterno + `AIS_FALLBACK_HOURS`/
`EXIT_GRACE_MIN`), **decoupled** dallo sweep di scraping. Il testo del banner/CTA (`outage.js`,
`health.fallback*` i18n) smette di riferirsi a un singolo flag "modalità fallback attiva" e riporta invece
quante aree sono correntemente in recupero dati (query leggera, calcolata al volo da
`getAreaSilenceInfo` per ogni area attiva + suo scope, non persistita).

## 4. Scoperta porti (nuova tabella `area_ports`)

Cascata di conferma, in ordine di priorità/costo:

1. **Area già monitorata con banchine** (`services/berths.js`) → ogni cluster è già ground-truth,
   **auto-confermato**, nessuna fonte esterna interrogata.
2. Altrimenti, cascata **GFW → World Port Index (NGA) → UN/LOCODE → VesselFinder**:
   - **GFW**: dataset "anchorages" pubblico di Global Fishing Watch — riusa `GFW_TOKEN`/client esistente
     (`src/services/gfw.js`). ⚠️ *Da verificare in fase di implementazione*: se è un endpoint API o un
     download statico; l'API vessel-events attuale è per-nave, non per-bbox.
   - **World Port Index**: dataset pubblico NGA (Pub 150), non integrato oggi. Bundle statico
     `data/wpi.json` generato una tantum da uno script `scripts/build-wpi.js` (pattern identico a
     `build-locode.js`/PSC), refresh raro (~1/anno). ⚠️ *Da verificare*: URL/formato di download attuale.
   - **UN/LOCODE**: `scripts/build-locode.js` va esteso per **non scartare** `entry.Function` (oggi
     buttato via) — filtro bbox + function=porto marittimo. Richiede reinstallare temporaneamente il
     pacchetto dev `un-locode` per rigenerare, come da commento esistente nello script.
   - **VesselFinder**: pagina `/ports` (verificata rispondere, 39KB) — stesso pattern di scraping di
     ShipFinder/MyShipTracking (`scrapers/http.js`), da esplorare la struttura esatta in implementazione.
   - **Clustering**: candidati di fonti diverse raggruppati per prossimità geografica (~3-5km). Ogni
     cluster conta le fonti distinte che l'hanno trovato. **≥2 fonti = confermato**, altrimenti stato
     `review` (in attesa di conferma/rifiuto admin).
3. Risoluzione `mst_pid` (per la scoperta arrivi, sezione 5): **solo sui porti confermati**, pigra, non
   su ogni candidato scartato.

**Trigger**: automatico alla creazione di una nuova area. **Backfill al deploy**: per le aree già attive
senza porti scoperti, una coda in background (non in parallelo — un'area alla volta, con pausa tra una e
l'altra) al boot del processo dopo questo deploy. **Refresh manuale**: bottone admin "Cerca porti ora"
per area, riusabile in futuro.

**Persistenza**: nuova tabella `area_ports` (in `BACKUP_TABLES`):

```sql
CREATE TABLE IF NOT EXISTS area_ports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area_key TEXT NOT NULL,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  sources TEXT NOT NULL,          -- JSON array, es. ["berths","gfw","wpi"]
  status TEXT NOT NULL DEFAULT 'review',  -- 'confirmed' | 'review' | 'rejected'
  mst_pid TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 5. Scoperta nuove navi (arrivi/partenze porto)

Solo per aree **insufficienti** con almeno un porto **confermato** e `mst_pid` risolto. Polling della
pagina `myshiptracking.com/ports-arrivals-departures/?pid=<id>` **ogni 15-30 minuti per porto** (non ad
ogni sweep — la scoperta non ha bisogno della freschezza a 3 minuti del refresh posizione), dentro lo
stesso budget orario condiviso.

Nave mai vista (mmsi nuovo) → riga `ships` creata subito, posizione iniziale = **centroide del porto**
(marcata come approssimata), entra nel tracking/liste/notifiche come una nave qualunque. Il giro di
scraping successivo (stesso meccanismo di sezione 2) corregge la posizione col fix vero dalla pagina
dettaglio nave.

## 6. UI

- **Rimossa**: voce sidebar "🔀 Modalità fallback" e tutto il wiring aggiunto nella sessione precedente
  (`main.js`, `outage.js`, `dom.js`, `index.html` — bottone + listener + toggle reattivo).
- **Nuovo tab Impostazioni, admin-only**: "Recupero dati via scraping" (separato da "Diagnostica AIS").
  Contenuto:
  - Stato per-area: quali aree sono correntemente in recupero, da quanto, scope (solo seguite / completo).
  - **Grafico globale aggregato** per sorgente (SF/MST, tutte le aree sommate) — andamento generale.
  - **Grafici per singola area** per sorgente (quelli già costruiti, ok/falliti impilati, per capire il
    dettaglio di una singola area).
  - Circuit breaker per sorgente: resta **globale**, non per area (è SF/MST a rischiare il ban, non la
    singola area) — invariato da oggi.
  - Contatore problemi sessione per sorgente: invariato da oggi.
- **Schermata Aree**: elenco porti scoperti per area, espandibile, con conferma/rifiuto admin dei
  candidati in stato `review`, + bottone "Cerca porti ora". **Il toggle di scope** ("solo seguite" /
  "completo", oggi due bottoni globali in Diagnostica AIS) si sposta qui, per singola area — sostituisce
  i due bottoni globali con un controllo per-riga area, coerente col fatto che lo scope non è più un
  flag globale legato a un "ingresso in modalità".

## Config nuova

| Chiave | Default | Ruolo |
|---|---|---|
| `AREA_SCRAPE_SILENCE_MIN` | 10 | Soglia silenzio locale per-area → area insufficiente |
| `AREA_SCRAPE_EXIT_GRACE_MIN` | 5 | Isteresi minima per evitare flap |
| (porto discovery: nessuna nuova soglia numerica, solo la cascata a 4 fonti) | | |

`AIS_FALLBACK_HOURS`/`AIS_FALLBACK_EXIT_GRACE_MIN`/`FALLBACK_MAX_REQ_PER_HOUR`/
`FALLBACK_CIRCUIT_*` restano invariate nel valore e nel ruolo (banner globale / budget anti-ban).

## Migrazioni DB

- Nuova tabella `area_ports` (CREATE TABLE IF NOT EXISTS, in BACKUP_TABLES).
- Nuova colonna `areas.scrape_scope_full` (ALTER TABLE try/catch, default 0) — sostituisce
  `state.fallbackScopeAreas` globale.
- Rimozione (o semplice non-uso) delle meta keys `fallback_mode_active`/`fallback_mode_since` — un
  restore di un backup pre-feature le ignora semplicemente (nessun problema, stesso pattern già
  documentato per l'introduzione della feature originale).
- Nuovi bundle statici committati: `data/wpi.json` (World Port Index), aggiornamento di
  `data/locode.json`/nuovo `data/locode-function.json` (o campo aggiuntivo) con la classificazione
  Function di UN/LOCODE.

## Verifica compatibilità backup/restore

Come da vincolo di progetto (deploy = backup + restore, `restoreFrom` copia solo l'intersezione delle
colonne e salta tabelle assenti): prima di considerare l'implementazione conclusa, va verificato
concretamente che un backup esportato dallo schema **attuale** (pre-redesign, con `fallback_mode_active`/
`fallback_mode_since` in `meta`, senza `area_ports` né `areas.scrape_scope_full`) si importi senza
errori nella versione **modificata** — `area_ports` assente nel backup viene semplicemente saltata
(tabella nuova, non nell'intersezione), `areas.scrape_scope_full` assente diventa il default (0) via lo
stesso pattern `ALTER TABLE` già in uso, le meta keys `fallback_mode_*` del backup vecchio vengono
ignorate (non lette da nessun codice nuovo). Se il test rivela un problema, va sistemato con una
migrazione o il fix necessario prima di chiudere l'implementazione — non è opzionale.

## Rischi e mitigazioni

- **Volume di scraping**: passare da "raro/emergenza" a "continuo per area opt-in" aumenta il *tempo
  totale* in cui lo sweep gira, non il tetto massimo orario (budget condiviso invariato). Se più aree
  sono insufficienti insieme, si ridistribuisce lo stesso budget, non si moltiplica — proprietà già
  esistente e verificata, ora più rilevante.
- **Backfill di massa al deploy**: la scoperta porti per aree esistenti gira **in coda, un'area alla
  volta**, non in parallelo, per non generare un picco di chiamate esterne al primo avvio dopo il deploy.
- **Picchi di CPU osservati in produzione (16/08/2026, ~ogni 10-20 min)**: non isolati con certezza da
  codice statico durante l'investigazione di debug in questa stessa conversazione — vedi conversazione
  per l'analisi (escluso: crash-loop applicativo, notifiche outage senza rendering mappa). Ipotesi aperte:
  area con traffico naturalmente intermittente + monitor esterno incoerente, oppure sweep
  `ship-follow.js` preesistente, oppure riavvii lato host. **Il redesign elimina la causa più plausibile
  per il flapping del banner** (area silenziosa che supera una soglia pensata per un disservizio globale),
  ma non garantisce di risolvere il picco di CPU — da verificare col prossimo deploy, come da richiesta
  esplicita dell'utente.
- **Fonti esterne da verificare in implementazione** (non bloccanti per il design, ma rischio di stima):
  formato/accesso dataset GFW anchorages; URL/formato download World Port Index; struttura esatta pagina
  `/ports` di VesselFinder.
- **Rework di codice già scritto in questa sessione**: la sidebar+grafici per "modalità fallback"
  costruiti in un turno precedente vanno in gran parte rifatti (non solo estesi) per la vista multi-area.

## Consumatori futuri di `area_ports` (non in questa iterazione)

Suggeriti dall'utente durante il brainstorming, esplicitamente rimandati: suggerimento nome banchina da
porto più vicino, gate "in porto" per rendezvous su aree nuove senza storico banchine, testo notifiche
con nome porto invece di nome area, overlay porti su mappa/heatmap.
