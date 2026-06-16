# Manuale Utente — Tracker Porti

## Cos'è questo software

**Tracker Porti** monitora in tempo reale il traffico navale AIS in un'area geografica definita. Raccoglie i dati trasmessi dalle navi, li analizza, calcola un punteggio di rischio per ogni imbarcazione e li presenta in forma visiva e tabellare.

Non richiede conoscenze tecniche per essere utilizzato.

---

## Avvio rapido

1. Apri il browser e naviga all'indirizzo del server (es. `http://localhost:3000`)
2. Nella barra laterale sinistra, seleziona l'**area geografica** da monitorare nel menu a tendina "Area:"
3. Premi il pulsante **▶ Avvia il monitoraggio** per iniziare a ricevere dati
4. Le navi appariranno automaticamente nella tabella e sulla mappa

---

## Interfaccia principale

### Barra laterale (sinistra)

| Elemento | Funzione |
|---|---|
| **🏠 Monitoraggi** | Torna alla home (le schede Navi presenti / passate / Traffico), dove monitori le aree |
| **▶ Avvia il monitoraggio** | Avvia la ricezione dei dati AIS in tempo reale per l'area correntemente visualizzata |
| **■ Ferma** | Interrompe la ricezione per l'area corrente (i dati già raccolti rimangono) |
| **🗑 Cancella dati** | Elimina le letture dell'area correntemente visualizzata — **irreversibile** |
| **📋 Log API** | Apre il pannello tecnico dei log (per diagnosi) |
| **📡 Diagnostica AIS** | Mostra lo stato della connessione al flusso AIS per l'area corrente |
| **🗺 Aree** | Apre la schermata di gestione aree: elenco, mappa, aggiunta e rimozione di aree (vedi [Gestione aree](#gestione-aree)) |
| **⚙ Impostazioni** | Apre le impostazioni dell'applicazione |
| **🔔 Notifiche** | Mostra/nasconde la lista delle notifiche nella barra laterale. Un badge rosso indica il numero di notifiche da leggere (vedi [Notifiche](#notifiche)) |
| **Area:** | Seleziona la zona geografica da visualizzare. Non avvia né ferma lo stream — ogni area ha il proprio stream indipendente. Le opzioni mostrano 🟢 se lo stream è attivo o ⚪ se è spento. |
| **N letture** | Contatore in basso: quante posizioni sono state ricevute in sessione |

### Barra di stato (in alto)

Il badge **ATTIVO** (con punto pulsante verde) indica che lo stream dell'area correntemente visualizzata è in funzione. **INATTIVO** indica che la ricezione per quell'area è ferma.

---

## Le tre schede principali

### 1. Navi presenti

Mostra le navi rilevate nell'area nelle ultime ore, con mappa e tabella in tempo reale.

**Mappa:** le navi sono visualizzate come indicatori sulla mappa interattiva. Puoi trascinare il bordo inferiore della mappa per ridimensionarla.

**Tabella — colonne:**

| Colonna | Significato |
|---|---|
| Icone azione | Pulsanti per segnalare, marcare come vista, aprire su VesselFinder |
| Ultimo contatto | Data e ora dell'ultima posizione ricevuta |
| Nome nave | Nome dell'imbarcazione |
| MMSI | Codice identificativo univoco della nave |
| Tipo nave | Categoria (cargo, tanker, passeggeri, ecc.) |
| Destinazione | Porto di destinazione dichiarato |
| SOG | Velocità sul fondo in nodi |
| Direzione | ↙ In entrata / ↗ In uscita / ⚓ Ferma |
| Score rischio | Punteggio 0–100 (verde/giallo/rosso) |

**Ordinamento:** clicca sull'intestazione di qualsiasi colonna (tranne le icone azione) per ordinare la tabella in base a quel campo. Un secondo clic inverte l'ordine (▲ ascendente / ▼ discendente). L'ordinamento persiste durante gli aggiornamenti automatici.

**Pulsanti per riga:**

- **☆ / ★ Segnala** — Evidenzia la nave in viola come "segnalata da esaminare". Clicca di nuovo per rimuovere la segnalazione.
- **✓ Vista** — Segna la nave come già esaminata (riga diventa trasparente). Utile per non perdere di vista le novità.
- **⧉ VesselFinder** — Apre la scheda della nave sul sito VesselFinder (nuova scheda del browser).

**Colori delle righe:**

| Colore | Significato |
|---|---|
| Rosso 🪖 | Nave militare (segnalata automaticamente) |
| Rosso | Punteggio di rischio alto (71–100) |
| Viola | Nave segnalata manualmente dall'utente |
| Trasparente/sfumata | Nave marcata come "vista" |
| Badge ⚓ In porto | La nave è attualmente ormeggiata in porto |

**Clicca su una riga** per aprire il dettaglio completo della nave.

#### Banchine (caratterizzazione automatica degli attracchi)

Sulla mappa delle navi presenti puoi attivare un **overlay delle banchine**: il sistema impara da solo dove le navi attraccano e di che tipo sono, evidenziando i moli "caratterizzati".

**Come funziona:**

1. **Rilevamento attracchi** — ad ogni visita di una nave (sosta in porto) il sistema registra **un punto di attracco**, calcolato come centroide delle posizioni della nave mentre è ferma/ormeggiata nell'area.
2. **Raggruppamento in banchine** — i punti di attracco vicini tra loro vengono raggruppati automaticamente in **banchine** (cluster). Il contorno disegnato sulla mappa è l'inviluppo (convex hull) dei punti del gruppo.
3. **Caratterizzazione** — per ogni banchina vengono contate le categorie di nave (cargo, cisterna, passeggeri, pesca, servizio/rimorchio, militare, diporto, alta velocità, altro). Quando una categoria supera il **60%** degli attracchi (su almeno **10** attracchi), la banchina viene **colorata** con quella categoria; sotto soglia è etichettata **"mista"** (grigia). Le banchine con meno di 10 attracchi restano tratteggiate e non caratterizzate.

**Usare l'overlay:**

- Spunta la casella **Banchine** nella barra dei filtri sopra la mappa per mostrare/nascondere l'overlay (la scelta viene ricordata).
- Ogni banchina ha un poligono colorato e un **pallino centrale** sempre visibile (il poligono di una banchina è largo poche decine di metri e a livello di zoom dell'intera area risulterebbe minuscolo: il pallino la rende individuabile).
- **Clicca su una banchina** (poligono o pallino) per vedere nome, caratterizzazione, numero di attracchi, distribuzione percentuale per categoria ed eventuale quota di merci pericolose (☢).

**Correggere a mano** (pulsante **⚓ Banchine**): apre il pannello di gestione, dove puoi:

- **Rinominare** una banchina (es. "Molo San Cataldo").
- **Forzare la categoria** con il menu a tendina (override manuale, ha la precedenza sulla caratterizzazione automatica). Riportalo su *(automatica)* per tornare al calcolo automatico.
- **Unire** due o più banchine in una sola (selezionale con le caselle e premi *Unisci*). La banchina risultante ha geometria "bloccata" (disegnata a mano) e non viene più spostata dal ricalcolo.
- **Eliminare** una banchina: i suoi attracchi vengono liberati e potranno essere riaggregati al ricalcolo successivo.
- **Ricalcolare** subito attracchi e banchine dell'area corrente (il sistema lo fa comunque in automatico periodicamente).
- **Clicca su una riga** della lista per centrare la mappa su quella banchina e aprirne il dettaglio (attiva l'overlay se era spento).

> Le banchine modificate a mano (geometria, nome, categoria forzata) sopravvivono ai ricalcoli automatici: le correzioni non vengono mai sovrascritte. Le banchine automatiche vengono invece ricostruite ad ogni ricalcolo, mantenendo però nome e categoria forzata se le avevi impostate.

> All'avvio l'app esegue un'analisi iniziale (*backfill*) di tutto lo storico già raccolto, così le banchine sono visibili da subito.

---

### 2. Navi passate

Mostra le navi che hanno visitato l'area in precedenza. La struttura della tabella è simile alla scheda "Navi presenti", con l'aggiunta delle colonne:

- **Primo contatto** — Quando la nave è stata vista per la prima volta
- **Durata sosta** — Per quanto tempo è rimasta nell'area

**Ordinamento:** clicca sull'intestazione di qualsiasi colonna (tranne le icone azione) per ordinare la tabella in base a quel campo. Un secondo clic inverte l'ordine (▲ ascendente / ▼ discendente). L'ordinamento persiste durante gli aggiornamenti automatici.

---

### 3. Traffico

Pannello statistico con grafici e indicatori aggregati.

**Schede statistiche in alto:**
- Arrivi oggi
- Arrivi negli ultimi 7 giorni
- Arrivi totali
- Durata media della sosta

**Grafici:**

| Grafico | Cosa mostra |
|---|---|
| Arrivi per ora del giorno | Barre orarie (00:00–23:00). Passa il cursore su una barra per il dettaglio. |
| Arrivi per tipo nave | Quante navi per categoria (cargo, tanker, ecc.) |
| Distribuzione score rischio | Ripartizione tra navi a rischio basso, medio, alto |
| Principali fattori di rischio | Quali fattori contribuiscono maggiormente agli score |
| Arrivi giornalieri (ultimi 30 gg) | Andamento del traffico nel mese |
| Navi con score più alto | Le imbarcazioni con rischio maggiore |

**Pannelli inferiori:**
- **Navi attese** — Navi dirette verso l'area (per parola chiave nella destinazione)
- **Ultimi eventi porto** — Cronologia di arrivi e partenze recenti

---

## Dettaglio nave

Cliccando su qualsiasi riga della tabella si apre la scheda completa della nave.

### Intestazione
- **← Indietro** — Torna alla lista
- **★ Segnala** — Attiva/disattiva la segnalazione
- **✓ Vista** — Segna come esaminata
- **🪖 Segna come nave militare** — Classifica la nave come militare (riga diventerà rossa)
- **🔔 / 🔕 Notifiche** — Silenzia o riabilita le notifiche automatiche per questa nave (vedi [Notifiche](#notifiche))
- **⧉ VesselFinder / MarineTraffic** — Apri la scheda esterna (se disponibile)

### Barra informazioni

Griglia con tutti i dati disponibili della nave:

| Campo | Significato |
|---|---|
| Score rischio | Badge colorato 0–100 |
| Tipo nave | Categoria; "☢ Hazmat" se trasporta merci pericolose |
| Nominativo | Indicativo radio (call sign) |
| IMO | Numero IMO di registrazione |
| Destinazione | Porto dichiarato |
| ETA | Orario stimato di arrivo |
| Pescaggio max | Profondità dello scafo in acqua (metri) |
| Lunghezza / Larghezza | Dimensioni fisiche |
| SOG / Rotta | Velocità e direzione corrente |
| Stato navigazione | Ormeggiata, in navigazione, ecc. |
| Direzione | In entrata, in uscita, ferma |
| Posizione | Ultima latitudine e longitudine |
| Durata sosta | Tempo trascorso dall'arrivo |
| Primo/Ultimo contatto | Timestamp del primo e dell'ultimo dato ricevuto |

### Fattori di rischio

Lista dei fattori che hanno contribuito al punteggio, con i punti assegnati da ciascuno. Se la nave non presenta anomalie compare "Nessuna anomalia rilevata".

### Dati VesselFinder / MarineTraffic

Se abilitati nelle impostazioni, vengono mostrate informazioni aggiuntive recuperate da questi servizi (bandiera, stazza lorda, anno di costruzione, ecc.), con indicazione se i dati sono in cache.

### Proprietà / gestione (Equasis)

Se il lookup Equasis è abilitato nelle impostazioni, nel dettaglio compare il pannello **Proprietà / gestione (Equasis)** con il pulsante **Recupera informazioni Equasis**. A differenza di VesselFinder/MarineTraffic **non parte mai in automatico**: la ricerca avviene solo quando premi il pulsante, e interroga Equasis per **numero IMO** (se la nave non ha IMO il lookup non è possibile). Restituisce proprietario registrato, gestore ISM, operatore e altri dati nave. Il risultato viene **memorizzato una sola volta** e mostrato senza limite di tempo (nessuna scadenza); il pulsante sparisce dopo il primo recupero. Richiede un account Equasis gratuito configurato in `local.properties`. Ogni recupero viene anche registrato in un log consultabile dalle impostazioni (vedi **Visualizza log Equasis**).

### Mappa posizione

Mappa con la traccia dell'ultima posizione nota della nave.

### Letture AIS

Tabella paginata con tutte le posizioni ricevute in ordine cronologico. Clicca su una riga per vedere i dati grezzi completi in formato JSON.

**Navigazione pagine:** usa i pulsanti ← Prec e Succ → sotto la tabella.

### Note operative

Area di testo libero. Scrivi qualsiasi annotazione sulla nave e premi **Salva note**. Le note vengono salvate nel database e sono persistenti.

### Storico visite in porto

Registro di tutti gli eventi di arrivo (↙) e partenza (↗) rilevati per questa nave, con destinazione, pescaggio e durata della sosta.

---

## Impostazioni

Apri con il pulsante **⚙ Impostazioni** nella barra laterale.

| Opzione | Funzione |
|---|---|
| **Monitoraggio aree** | Pannello nella parte superiore delle impostazioni: mostra tutte le aree configurate con un toggle per avviare o fermare lo stream di ciascuna. 🟢 = stream attivo, ⚪ = stream spento. Permette di monitorare più aree contemporaneamente. |
| **VesselFinder** (toggle) | Recupera dati aggiuntivi da VesselFinder nel dettaglio nave. Dati in cache per 6 ore. |
| **MarineTraffic** (toggle) | Recupera dati aggiuntivi da MarineTraffic nel dettaglio nave. Dati in cache per 6 ore. |
| **Screening sanzioni OFAC** (toggle) | Confronta ogni nave con la lista sanzioni OFAC SDN (US Treasury), scaricata localmente. Il match avviene per numero IMO, nome o call sign. Un match è un segnale di rischio molto forte (contributo elevato allo score). La lista viene scaricata all'attivazione e aggiornata ogni 24 ore; il pulsante **Aggiorna lista** forza un download immediato. Sotto al toggle viene mostrato il numero di navi sanzionate in lista e la data dell'ultimo aggiornamento. |
| **Screening Port State Control (Paris/Tokyo MoU)** (toggle) | Confronta ogni nave con due liste ufficiali dei Memorandum d'Intesa: (1) la **performance bandiera** white/grey/black di Paris MoU e Tokyo MoU — una bandiera in black list è un registro ad alto rischio per fermi/ispezioni (contributo medio-alto allo score), una in white list non penalizza; (2) la **lista delle navi bandite** dal Paris MoU (refusal of access dopo fermi multipli) — segnale forte, match per IMO/nome. Le liste bandiera sono incluse nell'applicazione e vanno aggiornate manualmente ~1 volta l'anno; la lista navi bandite è scaricata all'attivazione e aggiornata ogni 24 ore. Il pulsante **Aggiorna liste** forza il download. Sotto al toggle sono mostrati i conteggi bandiere (black/grey/white) e navi bandite con la data dell'ultimo aggiornamento. |
| **Lookup Equasis (proprietà)** (toggle) | Abilita il pulsante **Recupera informazioni Equasis** nel dettaglio nave per recuperare proprietario registrato, gestore ISM e operatore (per numero IMO). **Mai automatico**: parte solo su richiesta, una nave alla volta. I dati vengono memorizzati una sola volta (nessuna scadenza). Richiede credenziali Equasis (`EQUASIS_USER` / `EQUASIS_PASSWORD` in `local.properties`); senza credenziali il pulsante resta inutilizzabile. Il pulsante **Visualizza log Equasis** (sotto la descrizione) apre il registro testuale di tutti i lookup effettuati, con data, nave e dati recuperati; dalla stessa finestra è possibile **Cancellare il log**. |
| **Notifiche** (toggle) | Interruttore generale: abilita o disabilita tutte le notifiche nella barra laterale. Se spento, i toggle sottostanti sono disattivati. |
| **Notifica rientro nave** (toggle) | Avvisa quando una nave rientra in un'area dove era già stata in passato. |
| **Notifica cambio area** (toggle) | Avvisa quando una nave vista in un'area viene poi rilevata in un'**altra** area. |
| **⬇ Esporta CSV** | Scarica tutte le letture come file CSV (importabile in Excel) |
| **⬇ Scarica backup** | Scarica il file del database (.db) come backup |
| **⬆ Ripristina** | Carica un file .db precedentemente salvato per ripristinare i dati |
| **Lingua** | Cambia la lingua dell'interfaccia (Italiano / English) |

> **Attenzione:** Il ripristino del database sostituisce **tutti** i dati attuali. L'operazione è irreversibile. Scarica un backup prima di procedere. Dopo il ripristino, i dati vengono automaticamente assegnati all'area corretta in base alle coordinate geografiche.

---

## Gestione aree

Apri con il pulsante **🗺 Aree** nella barra laterale. Da qui puoi aggiungere e rimuovere le aree monitorate **senza riavviare l'applicazione**.

La schermata contiene:

- un **pannello "Aggiungi area"** (in alto a sinistra);
- una **mappa** che mostra tutte le aree configurate come rettangoli (verde = stream attivo, viola = area attualmente in vista, blu = altre);
- una **tabella** con tutte le aree: nome, coordinate dell'angolo Sud-Ovest e Nord-Est, parola chiave, stato dello stream, quantità di dati salvati e pulsante di eliminazione.

### Aggiungere un'area

1. Scrivi un **nome** (obbligatorio) e, se vuoi, una **parola chiave** (usata dalla sezione "Navi attese" per filtrare le navi con destinazione corrispondente).
2. Indica i confini dell'area in **uno** di questi due modi:
   - **Coordinate GPS** — inserisci a mano latitudine e longitudine in **gradi decimali** dei due angoli: SW (Sud-Ovest) e NE (Nord-Est). Esempio: SW `40.95, 16.60` — NE `41.30, 17.10`. Mentre digiti, sulla mappa compare un rettangolo tratteggiato di anteprima.
   - **Da mappa** — sposta e ingrandisci/rimpicciolisci (zoom) la mappa finché inquadri esattamente l'area da monitorare, poi premi **🎯 Cattura vista corrente**: le quattro coordinate si compilano da sole con i confini del riquadro visibile.
3. Premi **＋ Aggiungi area**. La nuova area viene salvata e il suo stream AIS parte immediatamente.

> I gradi decimali sono il formato GPS più semplice: ad esempio `41.125, 16.866`. La latitudine va da -90 a 90 (positiva a Nord), la longitudine da -180 a 180 (positiva a Est). Gli angoli possono essere inseriti in qualsiasi ordine: vengono riordinati automaticamente.

### Rimuovere un'area

Premi il pulsante 🗑 sulla riga dell'area. **Insieme all'area viene eliminato tutto lo storico dei monitoraggi correlati** (letture, navi ed eventi porto di quell'area).

Per sicurezza la cancellazione **non è immediata**: compare in basso un avviso con un conto alla rovescia e un pulsante **↶ Annulla** per **10 secondi**.

- Se premi **↶ Annulla**, non viene eliminato nulla.
- La cancellazione diventa definitiva allo scadere dei 10 secondi, **oppure** quando lasci la pagina Aree (o chiudi/ricarichi il browser).

Deve restare **almeno un'area**: il pulsante di eliminazione è disabilitato quando ne rimane una sola.

---

## Modifica dei file di configurazione

Alcune impostazioni avanzate non sono nell'interfaccia ma in file di testo nella cartella del progetto. Aprili con un qualsiasi editor di testo (Blocco note, TextEdit, VS Code…), modifica i valori e **riavvia l'applicazione** per applicarli. Le righe che iniziano con `#` sono commenti e vengono ignorate.

### `local.properties` — chiavi e segreti

Contiene la API key e le preferenze iniziali. Formato `CHIAVE=valore`, una per riga. **Non va condiviso** (contiene la API key). Se non esiste, copialo da `local.properties.example`.

| Chiave | Significato |
|---|---|
| `AIS_API_KEY` | La chiave di accesso ad AISStream.io (obbligatoria) |
| `BBOX_PRESET` | Area mostrata all'avvio (la chiave di un'area, es. `bari`) |
| `IMPORT_VF_DATA` | `true`/`false` — abilita l'import dati VesselFinder |
| `IMPORT_MT_DATA` | `true`/`false` — abilita l'import dati MarineTraffic |
| `IMPORT_SANCTIONS` | `true`/`false` — abilita lo screening contro la lista sanzioni OFAC SDN |
| `IMPORT_PSC` | `true`/`false` — abilita lo screening Port State Control (performance bandiera Paris/Tokyo MoU + navi bandite Paris MoU) |
| `IMPORT_EQUASIS` | `true`/`false` — abilita il lookup Equasis on-demand (proprietà/gestione) nel dettaglio nave |
| `EQUASIS_USER` | Email dell'account Equasis (registrazione gratuita su https://www.equasis.org/) — richiesta dal lookup Equasis |
| `EQUASIS_PASSWORD` | Password dell'account Equasis — richiesta dal lookup Equasis |

> `BBOX_PRESET`, `IMPORT_VF_DATA` e `IMPORT_MT_DATA` si cambiano anche dall'interfaccia (selettore area / Impostazioni) e vengono riscritti nel file automaticamente.

### `app.config.properties` — parametri di funzionamento

Contiene le soglie e i parametri dell'app (finestre temporali, raggi, retention, pesi dello score di rischio). Formato `CHIAVE=valore`. Ogni parametro è documentato da un commento nel file stesso. Esempi:

| Chiave | Significato | Default |
|---|---|---|
| `SOG_FERMA_KN` | Velocità (nodi) sotto cui una nave è "ferma" | `0.5` |
| `ACTIVE_WINDOW_HOURS` | Ore entro cui una nave in movimento resta tra le "presenti" | `6` |
| `PORT_WINDOW_HOURS` | Ore di permanenza tra le "presenti" per una nave in porto | `24` |
| `POLL_INTERVAL_MS` | Intervallo di aggiornamento dell'interfaccia (millisecondi) | `300000` |
| `MAX_READINGS_PER_TYPE` | Numero massimo di letture conservate per tipo di messaggio | `10000` |
| `BERTH_CLUSTER_EPS_M` | Raggio di clustering attracchi → banchine (metri) | `80` |
| `BERTH_MIN_PTS` | Attracchi minimi vicini per formare una banchina | `3` |
| `BERTH_MIN_MOORINGS` | Attracchi minimi prima di caratterizzare/colorare una banchina | `10` |
| `BERTH_DOMINANT_PCT` | Percentuale che una categoria deve superare per dare il nome alla banchina | `60` |
| `BERTH_RECOMPUTE_MIN` | Minuti tra un ricalcolo automatico delle banchine e il successivo | `30` |
| `RISK_*` | Pesi e soglie del punteggio di rischio (vedi commenti nel file) | vari |

### `bounding-boxes.json` — definizione delle aree

Elenca le aree di monitoraggio. **Il modo consigliato per gestirle è la schermata [🗺 Aree](#gestione-aree)** (che riscrive questo file da sola). Puoi però modificarlo a mano per il provisioning iniziale; in tal caso **riavvia** l'app dopo le modifiche.

Ogni area ha questa forma:

```json
"bari": { "name": "Porto di Bari", "keyword": "BARI", "sw": [40.95, 16.60], "ne": [41.30, 17.10] }
```

| Campo | Significato |
|---|---|
| chiave (`bari`) | Identificatore interno dell'area (usato anche da `BBOX_PRESET`) |
| `name` | Nome mostrato nell'interfaccia |
| `keyword` | (Facoltativa, può essere `null`) filtra le "Navi attese" per destinazione |
| `sw` | Angolo Sud-Ovest `[lat, lon]` in gradi decimali |
| `ne` | Angolo Nord-Est `[lat, lon]` in gradi decimali |

> Modifiche fatte a mano a questo file mentre l'app è in esecuzione vengono applicate solo dopo un riavvio. Se usi la schermata Aree, la formattazione del file viene normalizzata (resta valido, ma cambia l'indentazione).

---

## Punteggio di rischio

Ogni nave riceve un punteggio da 0 a 100 calcolato automaticamente in base a diversi fattori. Il punteggio è indicativo e non sostituisce una valutazione esperta.

| Colore | Fascia | Significato |
|---|---|---|
| Verde | 0–30 | Rischio basso |
| Giallo | 31–70 | Rischio medio — monitorare |
| Rosso | 71–100 | Rischio alto — esaminare |

**Indicatori fonte sul badge:**
- Punto magenta: punteggio calcolato con dati VesselFinder
- Punto oro: punteggio calcolato con dati MarineTraffic
- Punto arancione: entrambe le fonti usate
- Punto rosso (con alone): nave presente nella lista sanzioni OFAC SDN
- Etichetta blu (Paris/Tokyo MoU ⚓): segnale dalle liste Port State Control (bandiera black/grey o nave bandita)

Passa il cursore sul badge per vedere i dettagli dei fattori e le fonti.

**Navi militari:** sono automaticamente classificate a rischio massimo.

---

## Diagnostica AIS

Apri con **📡 Diagnostica AIS** nella barra laterale. Mostra lo stato della connessione al flusso dati:

- **Connessione** — Connesso / Disconnesso
- **Uptime sessione** — Da quanto tempo il flusso è attivo
- **Frame WS ricevuti** — Quanti pacchetti sono stati ricevuti
- **Messaggi nave** — Quante posizioni di navi sono state elaborate
- **Velocità messaggi** — Messaggi al minuto
- **Riconnessioni** — Quante volte la connessione è stata ripristinata
- **Ultimo errore** — L'eventuale ultimo errore registrato

Il pannello si aggiorna automaticamente ogni 5 secondi.

---

## Cambio tema

Il pulsante **🌙 / ☀️** in basso a destra alterna tra tema scuro (predefinito) e tema chiaro.

---

## Notifiche automatiche

Se una nave precedentemente segnalata (★) entra nell'area monitorata, compare un avviso in sovrimpressione:

> ⚠️ Nave segnalata in area!
> **[Nome nave]** — [Tipo]

L'avviso si chiude automaticamente dopo 10 secondi.

---

## Notifiche

Oltre agli avvisi temporanei, l'applicazione tiene uno **storico delle notifiche** nella barra laterale. La lista è visibile per impostazione predefinita (vuota al primo avvio) e si apre/chiude con il pulsante **🔔 Notifiche**. Lo stato aperto/chiuso viene ricordato tra le sessioni.

**Quando viene generata una notifica**

Vengono create notifiche automatiche in due casi (entrambi abilitabili/disabilitabili dalle [Impostazioni](#impostazioni)):

- **Rientro nave** — una nave **già vista in passato in un'area torna a essere rilevata nella stessa area** (un nuovo arrivo dopo un'assenza). Il primo avvistamento in assoluto di una nave non genera notifica.
- **Cambio area** — una nave vista in un'area viene poi rilevata in un'**altra** area monitorata (lo spostamento da un'area all'altra).

**Lettura di una notifica**

| Elemento | Significato |
|---|---|
| Bollino 🟢 / 🟡 / 🔴 | Colore in base allo score di rischio calcolato per quella nave (verde basso, giallo medio, rosso alto — vedi [Punteggio di rischio](#punteggio-di-rischio)) |
| Testo | Nome della nave e area in cui è rientrata, oppure area di partenza e di arrivo per un cambio area |
| Pulsante ✓ | Segna la notifica come letta |
| Pulsante 🗑 | Elimina la notifica (visibile al passaggio del cursore) |

**Clicca sulla notifica** (fuori dai pulsanti ✓ e 🗑) per aprire direttamente la scheda della nave.

**Eliminare una notifica**

Premi il pulsante 🗑 sulla notifica. Appare un avviso con un pulsante **↶ Annulla** per 5 secondi; allo scadere del tempo la notifica viene rimossa definitivamente.

**Silenziare le notifiche per una singola nave**

Nel dettaglio nave (apri cliccando su una riga della tabella o su una notifica) compare un pulsante:

- **🔔** — le notifiche per questa nave sono attive; cliccalo per silenziare
- **🔕** — le notifiche per questa nave sono silenziare; cliccalo per riabilitarle

Quando una nave è silenziata, non genera notifiche di rientro né di cambio area, indipendentemente dalle impostazioni globali.

Le notifiche **da leggere** sono mostrate in **grassetto** e contano nel badge rosso del pulsante 🔔. Le notifiche lette rimangono comunque visibili nella lista (non in grassetto). Viene conservato lo storico delle **ultime 100 notifiche**; le più vecchie vengono eliminate automaticamente. La cancellazione dei dati di un'area rimuove anche le sue notifiche.

---

## Domande frequenti

**La tabella è vuota — cosa faccio?**
Verifica che il monitoraggio per quest'area sia avviato (badge ATTIVO in alto) e che l'area selezionata contenga traffico navale. Puoi controllare quali aree sono in monitoraggio dal pannello "Monitoraggio aree" nelle Impostazioni. Usa la Diagnostica AIS per controllare la connessione.

**Come faccio a non perdere le navi già controllate?**
Usa il pulsante **✓ Vista** su ogni riga: la nave diventa trasparente e la puoi distinguere subito da quelle non ancora esaminate.

**Posso esportare i dati?**
Sì. Vai in **⚙ Impostazioni** → **Esporta CSV**. Il file si scarica direttamente dal browser.

**Ho cambiato area e le navi sono scomparse — è normale?**
Sì. Ogni area ha il proprio set di dati indipendente e il proprio stream indipendente. Cambiare l'area nel menu a tendina è solo un cambio di vista: mostra i dati dell'area selezionata ma non avvia né ferma nessuno stream. Le navi della precedente area rimangono nel database; se torni a quell'area le rivedrai. Per ricevere dati su più aree contemporaneamente usa il pannello "Monitoraggio aree" nelle Impostazioni.

**Posso monitorare più aree contemporaneamente?**
Sì. Apri **⚙ Impostazioni** → sezione **Monitoraggio aree** e attiva il toggle di ciascuna area che vuoi monitorare. Ogni area raccoglie dati in modo completamente indipendente. Puoi poi passare da un'area all'altra con il menu a tendina per visualizzarne i dati.

**Le navi militari sono sempre rosse?**
Sì. Le navi identificate come militari vengono contrassegnate automaticamente con punteggio massimo e riga rossa.
