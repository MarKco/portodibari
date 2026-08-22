# Piano: fallback silenzioso per-area (sostituisce la modalità fallback globale)

Documento di lavoro — **non ancora implementato**. Obiettivo: sostituire l'attuale
modalità fallback globale (toggle admin esplicito, attivata da un outage rilevato
sull'intero servizio AISStream) con un meccanismo **per-area, automatico e
silenzioso**: ogni area monitorata riposiziona da sola le proprie navi via
scraping (ShipFinder/MyShipTracking) quando non riceve abbastanza segnali AIS,
indipendentemente da un outage globale — utile sia per disservizi transitori sia
per aree con copertura AISStream scarsa/assente in modo strutturale.

Decisioni prese in conversazione (non riaprire senza motivo):
- Soglia di silenzio: **un solo valore globale**, non configurabile per-area.
- Nessun cross-check con l'uptime monitor pubblico per il fallback per-area: si
  basa solo sul silenzio locale di quell'area (copre anche il caso "quest'area
  non ha mai avuto copertura AISStream").
- Le notifiche di outage esistenti (Telegram "Disservizio AIS"/"rientrato")
  restano **invariate**, riferite all'intero servizio AISStream, a tutti gli
  utenti collegati come oggi. Il fallback per-area è **silenzioso**: nessuna
  notifica quando scatta o rientra.
- Budget anti-ban: **un solo tetto globale condiviso** (oggi 90/h SF+MST),
  usato da tutto lo scraping di fallback, comprese le navi seguite.
- Per-area: un **solo interruttore booleano** ("modalità fallback abilitata per
  quest'area", default ON) nella schermata Aree — non più la scelta
  "solo seguite / completo" (non aveva senso per-area: le navi seguite non
  appartengono a una singola area, restano sempre tracciate a prescindere).
- Icona/badge "posizione da scraping" sulle navi d'area: riusa lo stile già
  esistente per le navi seguite, nessuna nuova colonna DB per questo.

## Modello concettuale

Niente più macchina a stati persistita (niente `fallback_mode_active`/
`fallback_mode_since` globali). Per ogni area si tengono due soli fatti:

- `areas.fallback_enabled` (bool, default 1) — impostato dall'admin.
- `areas.last_ais_message_at` (timestamp) — aggiornato ad ogni messaggio AIS
  reale attribuito a quell'area.

"L'area X è silenziosa ora" si **calcola al volo**, non si salva:
```
fallback_enabled = 1
AND (last_ais_message_at IS NULL OR last_ais_message_at < now - AREA_SILENT_THRESHOLD_MIN)
```
Nessuna isteresi di uscita: appena arriva un messaggio AIS reale per quell'area,
`last_ais_message_at` si aggiorna e l'area smette immediatamente di essere
"silenziosa" al giro successivo. Non c'è stato da "dimenticare" in un restore:
risolve anche il bug della "durata sessione" ereditata da un vecchio backup
visto in questa stessa conversazione — semplicemente non esiste più uno stato
del genere da ereditare.

## Decisione architetturale da confermare prima di implementare

**Le navi seguite passano a essere gestite SOLO da `fallback-mode.js`, mai più
da `ship-follow.js`.**

Motivo: il requisito "un solo tetto globale condiviso" impone che TUTTO lo
scraping SF/MST (aree + seguite) passi da un unico limitatore. Oggi invece
convivono due percorsi:
- `ship-follow.js` `refresh()` (`src/services/ship-follow.js:379-417`) fa
  scraping delle navi seguite quando `!fallbackMode.isActive()` — throttle
  leggero per-mmsi, stagger fisso 2s, **nessun budget/circuit breaker propri**
  (lo dice il commento nel codice: si appoggia a fallback-mode.js quando attivo).
- `fallback-mode.js` fa scraping (aree + seguite) quando `isActive()` è vero,
  con budget/circuit breaker condivisi.

Con la modalità globale sparisce anche il concetto di "isActive()" che oggi
arbitra quale dei due percorsi è attivo. Se lascio `ship-follow.js` a scrapare
le seguite in autonomia E rendo il sweep di `fallback-mode.js` sempre attivo
per le seguite, otterrei scraping duplicato sulle stesse navi da due moduli
indipendenti — il tetto "90/h condiviso" diventerebbe di fatto "90/h + quello
di ship-follow", violando il requisito.

**Fix proposto**: eliminare del tutto lo scraping SF/MST da `ship-follow.js`
(`refresh()`, `reacquireStaleViaShipfinder`, `reacquireStaleViaMst` e relativo
stato: `sfSweeping`/`mstSweeping`, `lastSfScrape`, ecc.). Il sweep di
`fallback-mode.js` diventa **sempre attivo** (non più gated da nessun flag
globale) e copre le navi seguite **incondizionatamente**, esattamente come fa
oggi solo "durante" la modalità fallback — semplicemente adesso è sempre così,
non più un caso speciale. `ship-follow.js` mantiene la sua parte non-scraping
(WS dedicata, subscription per nave, world-box quando stale — quella è AIS
gratuito, non scraping, resta invariata).

Se preferisci un'altra soluzione (es. dare a `ship-follow.js` un proprio slot
di budget separato, sacrificando il tetto unico) dimmelo prima di procedere.

## Altra cosa aperta: sospensione VF/MT durante il fallback

Oggi `enrichment.js` sospende VF/MT **globalmente** quando `fallbackMode.isActive()`
(motivazione: non danno coordinate comunque, e MT è la fonte più a rischio ban).
Con un flag per-area invece che globale, la sospensione VF/MT deve diventare:

- **(A) globale ma basata su "almeno un'area è silenziosa ora"** — semplice,
  stesso comportamento grossolano di oggi;
- **(B) per-nave, basata sull'area della nave specifica** — più preciso (VF/MT
  restano attivi per le navi in aree sane anche se un'altra area è silenziosa)
  ma richiede di passare il contesto-area a ogni chiamata di enrichment, oggi
  non lo fa.

Non ho ancora una preferenza netta — (A) è una riga di codice, (B) è corretto
ma tocca più file. Serve una tua decisione prima di toccare `enrichment.js`.

## Modifiche per file

### Schema (`src/db.js`)
- `areas`: aggiungere `fallback_enabled INTEGER NOT NULL DEFAULT 1` e
  `last_ais_message_at TEXT` nel loop `ALTER TABLE ... ADD COLUMN` (pattern
  esistente, riga ~483). Restano in `BACKUP_TABLES` (già lo è `areas`) — lo
  stato per-area viaggia nel backup automaticamente, gratis.
- Nuove funzioni: `setAreaFallbackEnabled(key, enabled)`,
  `touchAreaLastAisMessage(key, ts)` (throttlata — vedi sotto), una query che
  restituisce le aree correntemente silenziose (per il pannello diagnostica) e
  aggiornare `getStaleAreaShips` per fare tutto in una query con JOIN su
  `areas` invece di richiedere l'elenco delle aree "silenziose" calcolato prima
  in JS:
  ```sql
  SELECT s.mmsi, s.ship_name, s.last_seen_at, s.last_latitude AS lat, s.last_longitude AS lon
  FROM ships s
  JOIN areas a ON a.key = s.last_area
  WHERE a.fallback_enabled = 1
    AND (a.last_ais_message_at IS NULL OR a.last_ais_message_at < ?)
    AND (s.last_seen_at IS NULL OR s.last_seen_at < ?)
    AND s.mmsi NOT IN (SELECT DISTINCT mmsi FROM user_follows WHERE followed = 1)
  ```
  (due cutoff distinti: uno per "l'area è silenziosa", uno per "la nave
  specifica ha bisogno di un fix" — oggi collassati nello stesso `freshMs`,
  valutare se tenerli distinti o no).

### Rilevamento silenzio per-area (`src/services/ais-stream.js`)
- Nel punto dove arriva un messaggio reale e si calcola `areaKey`
  (`src/services/ais-stream.js` intorno alla riga 236-244, dove oggi si chiama
  `berths.markAreaDirty(areaKey)` su arrivo), aggiungere l'aggiornamento di
  `last_ais_message_at` per quell'area.
- **Da throttlare**: un'area trafficata riceve messaggi in continuo — un
  `UPDATE areas SET last_ais_message_at = ?` per OGNI messaggio raddoppierebbe
  il carico di scrittura DB. Tenere un debounce in memoria (es. aggiorna il DB
  al massimo una volta al minuto per area, tipo il pattern già usato altrove
  nel progetto per throttle simili) invece di scrivere ad ogni messaggio.

### `src/services/fallback-mode.js` (riscrittura sostanziale)
- Rimuovere: `enter()`, `exit()`, `isActive()` (versione meta-based),
  `META_ACTIVE`/`META_SINCE`, `db.setMeta('fallback_mode_active'/'fallback_mode_since', ...)`.
- `candidatePool()`: navi seguite sempre incluse (incondizionato, spostando qui
  la logica oggi in `ship-follow.js` — vedi decisione sopra) + navi d'area
  dalla nuova query JOIN.
- `sweep()`: rimuovere il gate `if (!isActive()) return;` in testa — gira
  sempre, è un no-op naturale quando non ci sono candidati.
- `getStatus()`: ritorna lo stato per-area (elenco aree con
  `fallbackEnabled`/`isSilent`/`silentSince` calcolato da `last_ais_message_at`)
  invece di un singolo blocco globale `active`/`since`/`scope`.
- `getEstimate()`: niente più confronto "solo seguite vs completo" (non è più
  una scelta binaria globale) — mostrare candidate attuali e stima
  richieste/ora dato lo stato reale corrente di ciascuna area.
- Circuit breaker e budget (`FALLBACK_MAX_REQ_PER_HOUR`, `failureLog`,
  `circuit`, `requestTimestamps`) restano **invariati** — sono già globali e
  condivisi, esattamente come richiesto.

### `src/services/ais-uptime.js`
- Rimuovere le chiamate a `fallbackMode.enter()`/`fallbackMode.exit()` da
  `handleFallbackTransition()` — il rilevatore di outage globale diventa
  **puro notificatore**, non controlla più lo scraping.
- Rimuovere il check `if (!fallbackMode.isActive())` introdotto nel turno
  precedente di questa stessa conversazione per sopprimere la notifica
  duplicata — non ha più senso senza il flag globale `isActive()`. Le
  notifiche tornano a comportarsi come prima di quella modifica (va bene,
  visto che qui la fonte del problema — lo stato globale ereditato da un
  restore — sparisce alla radice).

### `src/services/ship-follow.js`
- Rimuovere `refresh()`'s ramo di scraping, `reacquireStaleViaShipfinder`,
  `reacquireStaleViaMst`, e lo stato associato (`sfSweeping`, `mstSweeping`,
  `lastSfScrape`, cap/costanti dedicate tipo `SF_REACQUIRE_MAX_PER_SWEEP`).
  Confermare cosa resta: la WS dedicata, la subscription per-nave, la logica
  world-box quando stale (quella non è scraping, resta).

### `src/services/enrichment.js`
- Gate VF/MT da aggiornare secondo la decisione (A) o (B) sopra — in sospeso.

### `src/config.js`
- Rimuovere: `FALLBACK_SCOPE_AREAS`/`state.fallbackScopeAreas`/
  `setFallbackScopeAreas` (local.properties), `AIS_FALLBACK_HOURS`,
  `AIS_FALLBACK_EXIT_GRACE_MIN` (non servono più: niente più soglia "quanto
  deve durare un outage globale prima di attivare il fallback", niente più
  isteresi di uscita).
- Aggiungere: `AREA_SILENT_THRESHOLD_MIN` in `app.config.properties` (boot-only
  come le altre soglie, es. default 15-30 min — valore da confermare).

### `src/routes/settings.js`
- Rimuovere `POST /settings/fallback-scope` (non esiste più uno scope
  globale).
- Rimuovere `fallbackScopeAreas` da `exportSettings()`/`applyImportedSettings()`
  — è la modifica fatta nel turno precedente di questa conversazione, va
  **ripristinata al contrario**: il concetto sparisce, sostituito da
  `areas.fallback_enabled` che viaggia già nel backup DB da solo.
- `GET /settings/fallback-mode/estimate`: adattare a `getEstimate()` riscritta
  (vedi sopra) o spostarlo/rinominarlo se il pannello si sposta.

### `src/routes/areas.js`
- `POST /areas` (riga 110) e `PATCH /areas/:key` (riga 152): accettare
  `fallbackEnabled` nel body, passarlo a `addArea()`/`updateArea()` in
  `config.js` (o direttamente a `db.setAreaFallbackEnabled`).
- `GET /areas` (riga 39): includere `fallback_enabled`/stato silenzioso
  corrente nella risposta.

### Frontend — schermata "Aree" (`public/js/areas.js`)
- `renderAreasList()` (riga 99): aggiungere colonna/toggle per
  `fallback_enabled` per riga.
- `submitForm()` (riga 205) + form di add/edit: aggiungere il campo
  `fallbackEnabled` (default checked).

### Frontend — pannello Diagnostica AIS (`public/js/health.js`)
- `fallbackModeBlock()`: da blocco singolo globale a lista per-area (nome
  area, silenziosa sì/no, da quando). Rimuovere i pulsanti
  "Solo navi seguite"/"Monitoraggio completo" (`btn-fallback-scope-follow`/
  `btn-fallback-scope-areas`) e il relativo handler `setFallbackScope`.
  Grafici volume/circuit breaker/log **restano aggregati**, non per-area
  (decisione presa: non spaccare quelli).

### Frontend — badge "posizione da scraping" sulle navi d'area
- Backend: in `src/routes/ships.js`, wire `scrapeFallbackFix`/`sfBadgeAt`/
  `mstBadgeAt` (oggi usati solo da `GET /ships/followed/active`, righe
  101-133 e 216-224) anche dentro `GET /ships/active` (riga 169) — stesso
  calcolo, stessi campi (`sf_last_at`, `mst_last_at`, `fallback_lat/lon/source`)
  nella risposta.
- Frontend: in `public/js/ships.js`, `renderActiveTable()` (riga 578-608)
  riusa lo stesso frammento di `public/js/followed.js:87` (badge
  `follow-sf-badge`/`ais-lost-badge` con `data-tip`) invece di reinventarlo.
- Nessuna nuova colonna su `ships` per questo — il calcolo resta live dai
  `readings`, esattamente come già fa la vista navi seguite.

### i18n (`public/locales/it.js` / `en.js`)
- Nuove stringhe: toggle per-area, tooltip badge (probabile riuso di
  `follow.sfSeenTip`/`follow.mstSeenTip` già esistenti).
- Rimuovere le stringhe dei due pulsanti scope globali se non più referenziate
  altrove.

### Documentazione (regola primaria del progetto — da NON saltare)
- `docs/technical/README.it.md` + `README.en.md`: riscrivere la sezione
  "Modalità fallback" con la nuova architettura per-area.
- `docs/manuale_admin/` (manuale_admin.md + .en.md, poi rigenerare
  `index.html`/`.en.html` e i due PDF): la sezione fallback + il nuovo
  controllo nella schermata Aree. Aggiungere/aggiornare screenshot se cambia
  una schermata (pannello Diagnostica AIS, form Aree).
- `docs/manuale/` (utente): verificare se menziona il fallback (probabilmente
  minimamente, essendo feature admin) — allineare se serve.
- `README.md` root: solo se cambia qualcosa di rilevante per il quick start
  (probabilmente no).
- `.claude/CLAUDE.md`: riscrivere per intero la voce "Modalità fallback" nella
  sezione "Conoscenza del progetto" — l'attuale descrive un'architettura che
  sparisce quasi per intero.

## Rischi / cose da testare con attenzione

1. **Throttle di `last_ais_message_at`**: verificare che non aggiunga scritture
   DB percepibili su un'area trafficata (era esattamente il tipo di problema
   di CPU/blocco event-loop già risolto in questa conversazione per le
   banchine — non ripetere l'errore).
2. **Rimozione scraping da `ship-follow.js`**: verificare che nessuna nave
   seguita resti scoperta durante la transizione (nessun buco tra "smetto di
   scrapare da ship-follow" e "fallback-mode.js la prende in carico
   incondizionatamente").
3. **Budget condiviso**: con `sweep()` sempre attivo (non più gated), il
   numero di candidate "di base" (seguite, sempre incluse) cambia poco, ma va
   verificato che il giro a 90/h con MOLTE aree silenziose contemporaneamente
   (es. un vero outage AISStream globale → tutte le aree diventano silenziose
   insieme) non faccia regredire i tempi di rotazione delle navi seguite
   rispetto a oggi.
4. **Backup/restore**: testare che un restore di un vecchio backup (pre-questa
   feature, senza le nuove colonne `areas`) non rompa nulla — le colonne nuove
   con `DEFAULT 1`/`NULL` devono comportarsi bene su un backup che non le ha
   mai avute (restoreFrom è già intersezione-colonne, ma verificare comunque).
5. **Migrazione dello stato esistente**: `fallback_mode_active`/
   `fallback_mode_since` in `meta` restano righe orfane dopo la rimozione —
   valutare se vanno ripulite esplicitamente o semplicemente ignorate (restano
   innocue, mai più lette).

## Domande ancora aperte (rispondimi prima che implementi)

1. Confermi la decisione architetturale su `ship-follow.js` (sezione sopra) —
   scraping delle seguite si sposta interamente su `fallback-mode.js`?
2. Sospensione VF/MT durante il fallback: opzione (A) globale-grossolana o
   (B) per-nave/per-area?
3. Valore di `AREA_SILENT_THRESHOLD_MIN` — quanti minuti di silenzio per
   un'area prima di considerarla "silenziosa"? (oggi l'outage globale usa
   `AIS_OUTAGE_SILENCE_MIN=10` min per la disambiguazione outage/silenzio, ma
   quello resta invariato — qui serve un valore pensato per l'attivazione
   fallback, probabilmente più alto per evitare falsi positivi su aree con
   traffico naturalmente saltuario)
