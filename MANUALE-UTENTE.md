# Manuale Utente — Tracker Porti

<p align="center">
  <img src="public/icons/icon-512.png" alt="Tracker Porti" width="128">
</p>

## Cos'è questo software

**Tracker Porti** monitora in tempo reale il traffico navale AIS in un'area geografica definita. Raccoglie i dati trasmessi dalle navi, li analizza, calcola un punteggio di rischio per ogni imbarcazione e li presenta in forma visiva e tabellare.

Non richiede conoscenze tecniche per essere utilizzato.

---

## Avvio rapido

1. Apri il browser e naviga all'indirizzo del server (es. `http://localhost:3000`)
2. **Accedi** con le tue credenziali (se non hai un account, registrati e attendi l'approvazione di un amministratore — vedi [Account e accesso](#account-e-accesso))
3. Nella barra laterale sinistra, seleziona l'**area geografica** da monitorare nel menu a tendina "Area:"
4. Premi il pulsante **▶ Avvia il monitoraggio** per iniziare a ricevere dati
5. Le navi appariranno automaticamente nella tabella e sulla mappa

---

## Account e accesso

L'applicazione è protetta da un **accesso con login**: per usarla devi prima autenticarti. Ogni utente ha i propri dati, separati da quelli degli altri.

### Registrarsi

Dalla pagina di accesso, segui il link di **registrazione** e inserisci **nome, cognome, email e password**. Il nuovo account viene creato in stato **"in attesa"**: **non puoi ancora accedere** finché un **amministratore non lo approva**. Una volta approvato, potrai effettuare il login normalmente.

> La conferma via email è prevista ma al momento non attiva: l'approvazione è sempre manuale, da parte di un amministratore.

### Accedere

Nella pagina di login inserisci la password e, come identificativo, **lo username oppure l'email** (vanno bene entrambi). La sessione resta valida per diversi giorni: di norma non devi reinserire le credenziali a ogni visita.

### Disconnettersi

Usa il **widget account in alto a destra** e scegli **Esci** (logout) per terminare la sessione.

### Password dimenticata

Nella pagina di login c'è il link **"Password dimenticata?"**. Al momento, però, l'email non è collegata: per reimpostare la password **rivolgiti a un amministratore**, che genererà per te un **link monouso** (valido 24 ore) da usare per impostarne una nuova.

### I tuoi dati

Ogni utente ha **i propri**:

- **aree** di monitoraggio;
- **impostazioni** (preferenze notifiche, opzioni mappa, lingua, area di default);
- **navi segnalate** ★ e **navi seguite**;
- **notifiche**.

Vedi i dati AIS delle navi che si trovano **dentro le tue aree**. La API key AISstream, le fonti di arricchimento (VesselFinder, MarineTraffic, sanzioni, ecc.) e la configurazione dello score di rischio sono invece **condivise** e gestite dagli amministratori.

Se fai parte di un **gruppo di utenti** (vedi sotto), alcune di queste cose sono **condivise con gli altri membri del gruppo**.

### Gruppi di utenti

Un amministratore può inserirti in un **gruppo** insieme ad altri utenti. Quando fai parte di un gruppo, **condividi con gli altri membri** (come **unione** di ciò che ognuno aveva):

- le **aree** di monitoraggio;
- le **navi seguite**, le **navi segnalate** ★ e le **navi silenziate** 🔕;
- le **preferenze di notifica** (app e Telegram) e di **visualizzazione mappa**, oltre all'**area di default**.

In pratica: se aggiungi un'area, segui una nave o abiliti una notifica, **gli altri membri se la ritrovano** al loro prossimo accesso — e viceversa. Restano invece **tuoi personali**: il **collegamento Telegram** (la tua chat) e la **lingua** dell'interfaccia. Le impostazioni gestite dagli amministratori (sorgenti dati, pesi di rischio) restano globali per tutti.

Se l'amministratore ti **toglie dal gruppo**, **mantieni** tutto quello che nel frattempo era stato condiviso (aree, navi, impostazioni): semplicemente smetti di sincronizzarti con gli altri.

### Per gli amministratori

Gli amministratori vedono in alto a destra il link **Admin**, che apre la **pagina di amministrazione** (`/admin`). Da qui un amministratore può:

- **approvare** le nuove registrazioni in attesa;
- **abilitare o disabilitare** un account;
- **cambiare il ruolo** di un utente (utente normale ↔ amministratore);
- **reimpostare la password** di un utente (genera un link monouso da consegnargli);
- **eliminare** un utente;
- **creare e gestire i gruppi di utenti** — un gruppo ha un **nome**, una **descrizione** e **almeno 2 membri**; alla creazione si sceglie l'**utente modello** da cui prendere le impostazioni iniziali. Si possono **aggiungere/rimuovere** membri o **sciogliere** il gruppo (una rimozione che lascerebbe 1 solo membro è bloccata: si scioglie il gruppo);
- **impersonare** un utente — visualizzarne aree, monitoraggi e navi seguite in **sola lettura**, con un banner in evidenza e l'uscita con un click;
- consultare i **log** (log API e log attività), che sono condivisi e visibili solo agli amministratori.

---

## Interfaccia principale

### Barra laterale (sinistra)

| Elemento | Funzione |
|---|---|
| **🏠 Monitoraggi** | Torna alla home (le schede Navi presenti / passate / Traffico), dove monitori le aree |
| **▶ Avvia il monitoraggio** | Avvia la ricezione dei dati AIS in tempo reale per l'area correntemente visualizzata |
| **■ Ferma** | Interrompe la ricezione per l'area corrente (i dati già raccolti rimangono) |
| **🗑 Cancella dati** | Elimina le letture dell'area correntemente visualizzata — **irreversibile** |
| **🗺 Aree** | Apre la schermata di gestione aree: elenco, mappa, aggiunta e rimozione di aree (vedi [Gestione aree](#gestione-aree)) |
| **🌐 Mappa zone coperte** | Apre la mappa mondiale che mostra dove la copertura AIS è buona e dove ci sono buchi (vedi [Mappa delle zone coperte](#mappa-delle-zone-coperte)) |
| **⚙ Impostazioni** | Apre le impostazioni dell'applicazione. Include i tab tecnici **Log API** (📋) e **Diagnostica AIS** (📡) |
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
| Destinazione | Porto di destinazione dichiarato. Se il valore è un codice UN/LOCODE (es. `ITTAR`, `IT TAR`) viene tradotto automaticamente nel nome del porto (es. "Taranto"); i valori già leggibili (es. "NAPOLI") sono mostrati invariati |
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
- **Clicca su una banchina** (poligono o pallino) per vedere nome, caratterizzazione, numero di attracchi, distribuzione percentuale per categoria, **distribuzione per tipo di carico** (classe merceologica delle navi che vi attraccano) ed eventuale quota di merci pericolose (☢).

**Correggere a mano** (pulsante **⚓ Banchine**): apre il pannello di gestione, dove puoi:

- **Rinominare** una banchina (es. "Molo San Cataldo").
- **Forzare la categoria** con il menu a tendina (override manuale, ha la precedenza sulla caratterizzazione automatica). Riportalo su *(automatica)* per tornare al calcolo automatico.
- **Unire** due o più banchine in una sola (selezionale con le caselle e premi *Unisci*). La banchina risultante ha geometria "bloccata" (disegnata a mano) e non viene più spostata dal ricalcolo.
- **Eliminare** una banchina: i suoi attracchi vengono liberati e potranno essere riaggregati al ricalcolo successivo.
- **Ricalcolare** subito attracchi e banchine dell'area corrente (il sistema lo fa comunque in automatico periodicamente).
- **Clicca su una riga** della lista per centrare la mappa su quella banchina e aprirne il dettaglio (attiva l'overlay se era spento).

> Le banchine modificate a mano (geometria, nome, categoria forzata) sopravvivono ai ricalcoli automatici: le correzioni non vengono mai sovrascritte. Le banchine automatiche vengono invece ricostruite ad ogni ricalcolo, mantenendo però nome e categoria forzata se le avevi impostate.

**Overlay OpenSeaMap.** Nelle impostazioni (→ Generali, attivo di default) ci sono **due interruttori indipendenti**: il **Livello nautico (tile)** disegna sopra le mappe i simboli nautici OpenSeaMap (boe, fari, luci, segnali, fairway, ancoraggi) — è un'immagine unica, quindi o la mostri tutta o la nascondi tutta (i simboli che sembrano piccole torri con una goccia magenta sono **luci/beacon**, non pale eoliche); i **Marcatori (selezionabili)** disegnano sulla mappa delle navi presenti dei marcatori ⚓ con gli **ormeggi/banchine/porti ufficiali** mappati su OpenStreetMap, da confrontare con le banchine che l'app calcola da sola. Solo i marcatori sono filtrabili per categoria, e la mappa si aggiorna subito quando cambi le caselle. Passa il mouse su un marcatore per leggere cos'è. I dati provengono da OpenSeaMap/OpenStreetMap (gratuiti, nessuna chiave API) e nei porti commerciali possono essere incompleti.

> All'avvio l'app esegue un'analisi iniziale (*backfill*) di tutto lo storico già raccolto, così le banchine sono visibili da subito.

**Replay storico (rivedere il traffico passato).** In alto nella barra strumenti c'è il pulsante **▶ Replay**: premilo per rivedere come si è mosso il traffico dell'area in un intervallo di tempo passato. Entrando in modalità replay i marker "live" vengono nascosti e compare una barra di controllo:

- **Area** — scegli quale delle tue aree rivedere (di default quella corrente).
- **Finestra** — pulsanti rapidi **1h / 6h / 24h / tutto**, oppure imposta un intervallo **personalizzato** con i due selettori data/ora. L'intervallo si aggancia automaticamente al **dato più recente** disponibile (così trovi sempre qualcosa da rivedere) e non può andare oltre i dati realmente registrati.
- **▶ / ⏸** play/pausa, la **barra di scorrimento** (per saltare a un istante preciso) e i pulsanti di **velocità** (1× / 5× / 20× / 60× del tempo reale).

Ogni nave si muove interpolata tra le sue posizioni reali, lascia una **scia che sfuma** dietro di sé, ed è colorata per fascia di rischio; cliccala per aprire il suo dettaglio. Se una nave ha un **buco di segnale** lungo (AIS spento o uscita dall'area) viene **nascosta** in quel tratto, invece di "teletrasportarsi" in linea retta. In basso vedi l'ora corrente del replay e quante navi sono visibili. Premi **✕ Esci** per tornare alla vista live.

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

## Navi seguite

La sezione **🗺 Navi seguite** (barra laterale) raccoglie le navi che segui ovunque vadano, anche fuori dalle aree monitorate, tramite uno stream AIS dedicato. Una nave seguita che esce dalla copertura AIS **non viene persa**: resta agganciata a una rete di ri-acquisizione mondiale e torna tracciata automaticamente appena ri-trasmette, ovunque ricompaia. Due sotto-schede: **Seguite** (attualmente tracciate) e **Seguite in passato** (storico; una nave ci finisce automaticamente solo dopo un silenzio totale molto lungo — default ~6 mesi — oppure quando smetti di seguirla).

### Cerca e segui una nave

In cima alla sezione c'è una **barra di ricerca**: digita il **nome** o l'**MMSI** di una nave e premi **🔍 Cerca**.

1. Si apre una finestra dei risultati che resta aperta mentre raccogliamo i dati. Se il nome corrisponde a più navi, scegli quella giusta dalla lista.
2. La scheda si riempie **man mano**: identità e dati da VesselFinder / MarineTraffic / Global Fishing Watch (con un'icona che indica dove è stata trovata), eventuali avvisi di **sanzioni** o **PSC**, e — appena disponibile — la **posizione live** su una mini-mappa.
3. La posizione viene recuperata in tempo reale da AISstream: può richiedere qualche secondo (fino a ~90 s). Se la nave non sta trasmettendo o è fuori copertura compare un avviso con **↻ Riprova**.
4. Quando la posizione è stata trovata si abilita **🗺 Segui nave**: cliccalo per aggiungerla alle navi seguite.

Chiudere la finestra (**Annulla**, la **✕**, clic fuori o **Esc**) interrompe la ricerca e il recupero della posizione, senza seguire nulla.

### Ri-seguire una nave dalle "Seguite in passato"

Quando ri-segui una nave che era tra le **Seguite in passato** (apri il suo dettaglio e premi **🗺 Segui nave**), l'app la rimette **subito** tra le navi attualmente seguite e avvia in automatico, in background, la stessa ricerca della posizione via AISstream. Non devi fare altro:

- se la nave viene trovata (sta trasmettendo), resta tra le seguite e la posizione si aggiorna;
- se entro ~90 secondi **non** trasmette, la nave **torna tra le "Seguite in passato"** e ricevi una **notifica** che avvisa che non è stata trovata.

---

## Mappa delle zone coperte

Si apre dalla voce **🌐 Mappa zone coperte** nella barra laterale. Mostra una **mappa del mondo** dove ogni cella della griglia è colorata in base a **quanti messaggi AIS si ricevono** in quella zona: una scala di colore che va dal **blu** (pochi messaggi) al **rosso** (molti). Serve a capire a colpo d'occhio dove la copertura AIS è buona e dove invece ci sono dei "buchi".

**Tutti gli utenti** possono aprire la mappa e vedere i dati correnti: per loro è in **sola lettura**.

La mappa è disponibile anche **senza fare login** all'indirizzo `/heatmap` (es. `http://localhost:3000/heatmap`): mostra gli stessi dati di copertura, senza nessun'altra funzionalità dell'app.

Solo gli **amministratori** possono inoltre:

- **avviare** e **fermare** la raccolta dei dati;
- vedere le **statistiche di connessione in tempo reale** (banda usata, messaggi al secondo, numero di celle popolate, ecc.);
- **cancellare** i dati raccolti.

I pulsanti disponibili per l'amministratore nella pagina sono: **Avvia/Ferma raccolta**, **Aggiorna mappa** e **Cancella dati**.

**Come funziona la raccolta:** una volta avviata da un amministratore, gira **in background** sul server — anche se nessuno ha la pagina aperta — finché un amministratore non la ferma. Riprende da sola dopo un riavvio del server. Per sicurezza si **spegne automaticamente** se nessun utente è attivo per **10 minuti**.

> **Attenzione:** mentre la raccolta è attiva l'app **scarica dati in continuazione da tutto il mondo** (circa **200–400 MB l'ora**). La funzione richiede una **chiave AISStream di un account separato** (diverso da quello usato per il monitoraggio normale), impostata dall'amministratore in `local.properties` come `HEATMAP_AIS_API_KEY`. Senza quella chiave la funzione resta spenta.

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
| Tipo carico | Classe merceologica (portacontainer, petroliera greggio, chimichiera, gasiera, rinfusiera, ecc.) derivata dal sottotipo VesselFinder/MarineTraffic, con ripiego sul codice AIS. Tra parentesi la fonte |
| Stato carico | Stima carica / parziale / in zavorra dal pescaggio dichiarato confrontato con il minimo/massimo osservato per quella nave (indicato come "stimato") |
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

Quando **attivi** VesselFinder o MarineTraffic, l'app recupera in background i dati per tutte le navi viste negli ultimi giorni che non li hanno ancora (una alla volta, per non sovraccaricare i servizi). Le navi che la fonte **non conosce** (tipico di chi non ha numero IMO) non vengono ri-contattate ad ogni riattivazione: vengono ritentate al massimo ogni `SCRAPE_NEG_CACHE_DAYS` giorni (default 3, modificabile in **Parametri**). Il **ripristino** di un backup **non** rilancia questi recuperi: i dati VF/MT sono già salvati nel database ripristinato.

### Dati ShipFinder e ri-localizzazione delle navi seguite

Se abiliti **Import ShipFinder** nelle impostazioni, nel dettaglio compare il pannello **Dati ShipFinder**. Oltre ai dati statici (bandiera, tipo, dimensioni — in gran parte uguali a VesselFinder/MarineTraffic, qui come ripiego), ShipFinder offre una cosa che le altre fonti gratuite **non** danno: la **posizione dell'ultimo avvistamento** della nave.

Questa posizione serve a **ritrovare le navi seguite che l'AIS non vede più**:

- **Automatico.** Per ogni nave nelle tue **Navi seguite** che non trasmette da un po' (anche quelle che non hai mai localizzato, seguite tramite ricerca), l'app interroga periodicamente ShipFinder in background. Se trova una posizione, compare sulla mini-mappa del dettaglio come **marker arancione distinto** ("Ultima posizione nota (ShipFinder)"), separato dalla traccia AIS e **senza alterare** la traccia, lo score di rischio o il replay. La ricerca worldwide via AIS continua comunque in parallelo. Le richieste sono limitate (max una ogni 30 min per nave) per non sovraccaricare il servizio.
- **Badge dedicato.** Quando esiste una posizione ShipFinder, accanto al nome della nave (nell'elenco **Navi seguite** e nel dettaglio) compare un badge arancione **📍 vista su ShipFinder · &lt;data&gt;**, distinto dal badge giallo **🔍 in ricerca** (che riflette lo stato AIS). I due possono coesistere: la nave è ancora muta sull'AIS (*in ricerca*), ma ShipFinder ne ha l'ultima posizione nota. Il badge "in ricerca" si spegne **solo** con un segnale AIS reale (o dopo l'auto-stop ~6 mesi): un ritrovamento ShipFinder **non** lo spegne.
- **Manuale — il pulsante.** Nel pannello **Dati ShipFinder** c'è il bottone **📍 Localizza via ShipFinder**: premilo per recuperare **subito** la posizione corrente della nave e vederla sulla mappa. Funziona per qualsiasi nave, non solo per quelle seguite.

Nella barra azioni del dettaglio c'è anche **⧉ ShipFinder**, che apre semplicemente la scheda della nave sul sito ShipFinder.

> Il pannello e i pulsanti **compaiono solo se Import ShipFinder è attivo** (Impostazioni → Import ShipFinder). Di default è spento.

### Dati MyShipTracking (seconda fonte di backup)

**Import MyShipTracking** funziona esattamente come ShipFinder e fa da **seconda fonte di backup, indipendente**, per ri-localizzare le navi seguite perse. Se attivo, nel dettaglio compare il pannello **Dati MyShipTracking** con i dati statici e la **posizione dell'ultimo avvistamento**, con gli stessi comportamenti: ri-localizzazione automatica in background delle navi seguite stale, badge **📍 vista su MyShipTracking · <data>**, pulsante **📍 Localizza via MyShipTracking** e **⧉ MyShipTracking** per aprire la scheda della nave. Sulla mini-mappa i suoi marker dell'ultima posizione nota sono **teal/ciano**, per distinguerli dall'ambra di ShipFinder.

Quando ShipFinder e MyShipTracking sono entrambi attivi, una nave seguita persa viene interrogata su entrambi: quella che ha una posizione fornisce il marker. MyShipTracking usa AIS terrestre: forte vicino a coste e porti, più debole in mare aperto.

**Sulla mappa delle Navi seguite**, una nave seguita che l'AIS non vede più viene ora mostrata sulla sua **posizione ShipFinder/MyShipTracking più recente** (la più nuova fra le due) invece di restare ferma sull'ultima posizione AIS stantia o sparire dalla mappa. Il marker resta **grigio**, come una nave "in ricerca", per chiarire che non è una posizione AIS live; il suo popup mostra l'ora di quel rilevamento e la fonte da cui arriva. Appena la nave torna a trasmettere via AIS, il marker **torna automaticamente** sulla posizione AIS live.

> Il pannello e i pulsanti **compaiono solo se Import MyShipTracking è attivo** (Impostazioni → Import MyShipTracking). Di default è spento.

### Proprietà / gestione (Equasis)

Se il lookup Equasis è abilitato nelle impostazioni, nel dettaglio compare il pannello **Proprietà / gestione (Equasis)** con il pulsante **Recupera informazioni Equasis**. A differenza di VesselFinder/MarineTraffic **non parte mai in automatico**: la ricerca avviene solo quando premi il pulsante, e interroga Equasis per **numero IMO** (se la nave non ha IMO il lookup non è possibile). Restituisce: dati nave (bandiera, call sign, MMSI, tonnellaggi, tipo, anno, stato), **proprietà e gestione** (proprietario registrato, gestore ISM, operatore, manager commerciale), **classificazione** (società, stato, data), **copertura P&I**, indicatori di **performance/rischio** (tasso detenzioni a 36 mesi, classe IACS, performance Paris/Tokyo MOU, targeting USCG) e le **posizioni recenti** (aree in cui la nave è stata vista). Il risultato viene **memorizzato una sola volta** e mostrato senza limite di tempo (nessuna scadenza); il pulsante sparisce dopo il primo recupero. Richiede un account Equasis gratuito configurato in `local.properties`. Ogni recupero viene anche registrato in un log consultabile dalle impostazioni (vedi **Visualizza log Equasis**).

### Global Fishing Watch

Se l'arricchimento Global Fishing Watch è abilitato (lo è **di default**), nel dettaglio compare il pannello **Global Fishing Watch**, sopra la mappa accanto ai pannelli VesselFinder/MarineTraffic/Equasis. Mostra l'**identità** della nave (bandiera, IMO, MMSI, call sign, tipo, anno) e le tabelle degli **eventi comportamentali** che GFW ricava e classifica dal flusso AIS globale:

- **Incontri** — due navi che si incontrano in mare aperto (firma tipica di un trasbordo nave-a-nave).
- **Loitering** — sosta prolungata in mare aperto.
- **Port visit** — scali in porto ricostruiti.
- **AIS spento (gap)** — transponder spento mentre la nave era in navigazione ("dark activity").

Ogni campo/sezione ha un'icona ⓘ al passaggio del mouse che ne spiega il significato. Come VesselFinder/MarineTraffic, l'arricchimento è **proattivo**: parte in background alla prima rilevazione della nave (nessun pulsante da premere). Questi eventi, essendo già derivati dall'AIS e classificati da GFW, sono **conferme autorevoli** dei segnali comportamentali e **alimentano lo score di rischio**.

GFW traccia soprattutto navi da **pesca, di supporto e reefer/carrier**: molte navi mercantili non sono presenti, e in tal caso il pannello mostra la nota "non trovata in GFW". La feature richiede un **token API** GFW configurato in `local.properties` (`GLOBAL_FISHING_WATCH_TOKEN`); senza token resta disattivata e le impostazioni mostrano l'avviso "token non configurato". I dati GFW sono gratuiti **solo per uso non commerciale** (ricerca, ONG, interesse pubblico); l'uso commerciale richiede una licenza dedicata.

### Sanzioni

Quando una nave corrisponde a una lista sanzioni (screening attivo, vedi impostazioni), nel dettaglio compare in cima — prima dei pannelli VesselFinder/MarineTraffic/GFW e con bordo rosso — il pannello **Sanzioni**. Spiega in breve **cosa sono le sanzioni** e mostra i dati del match:

- **Lista** — il regime che ha prodotto il match: OFAC SDN (Tesoro USA), lista consolidata UE, UK OFSI o Consiglio di Sicurezza ONU (ris. 1718).
- **Programma** — il programma sanzionatorio specifico (es. EU-MARE, GB-RUS, UN-SC1718), quando disponibile.
- **Corrispondenza per** — il campo su cui è avvenuto il match: **IMO** o **call sign** (alta affidabilità) oppure **nome** (più debole, possibile omonimia).
- **Nome in lista**, **bandiera**, **proprietario** e **alias** dell'entità designata, quando presenti nella fonte.

Un riquadro spiega il regime corrispondente (OFAC / UE / UK / ONU) e un **avviso** ricorda di verificare sempre sulla fonte ufficiale: in particolare un match **solo per nome** può essere un falso positivo (omonimia). Quando l'identificativo dell'entità è disponibile, il pulsante **Apri scheda ufficiale** apre la pagina pubblica della nave (OpenSanctions per UE/UK/ONU, OFAC Sanctions Search per OFAC). Il pannello compare **solo** per le navi effettivamente in lista; per tutte le altre non viene mostrato.

### Rendezvous in mare

Se questa nave ha avuto un **rendezvous** confermato con un'altra nave (le due sono rimaste vicine, lente e al largo abbastanza a lungo — la firma classica di un trasbordo nave-nave), nel dettaglio compare la sezione **Rendezvous in mare**: l'elenco degli incontri (altra nave, data/ora, distanza minima raggiunta, area). Ogni riga è **cliccabile** e apre la scheda della nave coinvolta.

Un rendezvous confermato fa anche scattare una **notifica** (vedi [Notifiche](#notifiche)) e **aggiunge punti al rischio di entrambe le navi**. Il rilevamento è automatico e usa solo i dati AIS dell'app (non richiede fonti esterne).

### Mappa posizione

Mappa con la traccia della nave e controlli di riproduzione animata.

- **Finestra temporale** — preset rapidi **6h / 24h / 7gg / tutto** per filtrare la traccia sull'ultimo periodo. Oppure imposta un **intervallo personalizzato** con i due selettori data/ora (Da → A) e premi **Applica**. All'apertura del dettaglio i selettori sono pre-compilati con l'intero periodo disponibile in archivio.
- **▶ / ⏸** — riproduce o mette in pausa l'animazione della traccia (la nave si muove lungo il percorso lasciando una scia).
- **Scrubber** — trascinalo per saltare a un qualsiasi punto della traccia.
- **Moltiplicatori di velocità** — **1× / 5× / 20× / 60×** rispetto alla durata di riproduzione standard. Di default 20×. Cambiabili durante la riproduzione senza interruzioni.

### Letture AIS

Tabella paginata con tutte le posizioni ricevute in ordine cronologico. Clicca su una riga per vedere il dettaglio della lettura. I **dati grezzi** completi in formato JSON sono mostrati solo per i messaggi statici della nave (nome, dimensioni, destinazione…); per i semplici messaggi di posizione i campi utili sono già tutti nella griglia di dettaglio e la sezione JSON appare vuota (`{}`), per non gonfiare il database.

**Navigazione pagine:** usa i pulsanti ← Prec e Succ → sotto la tabella.

### Note operative

Area di testo libero. Scrivi qualsiasi annotazione sulla nave e premi **Salva note**. Le note vengono salvate nel database e sono persistenti.

### Storico visite in porto

Registro di tutti gli eventi di arrivo (↙) e partenza (↗) rilevati per questa nave, con destinazione, pescaggio e durata della sosta. I codici UN/LOCODE nella colonna Destinazione sono risolti automaticamente nel nome del porto (es. `ITNAP` → "Napoli").

---

## Impostazioni

Apri con il pulsante **⚙ Impostazioni** nella barra laterale.

| Opzione | Funzione |
|---|---|
| **Monitoraggio aree** | Pannello nella parte superiore delle impostazioni: mostra tutte le aree configurate con un toggle per avviare o fermare lo stream di ciascuna. 🟢 = stream attivo, ⚪ = stream spento. Permette di monitorare più aree contemporaneamente. |
| **VesselFinder** (toggle) | Recupera dati aggiuntivi da VesselFinder nel dettaglio nave. Dati in cache per 6 ore. |
| **MarineTraffic** (toggle) | Recupera dati aggiuntivi da MarineTraffic nel dettaglio nave. Dati in cache per 6 ore. |
| **Import ShipFinder** (toggle) | Recupera dati da ShipFinder e la **posizione dell'ultimo avvistamento**, usata per ri-localizzare le navi seguite che l'AIS non vede più (in automatico, in background) e tramite il pulsante **📍 Localizza via ShipFinder** nel dettaglio. Le posizioni appaiono come marker arancioni distinti, senza alterare traccia AIS/score/replay. Dati statici in cache per 6 ore. Spento di default. |
| **Import MyShipTracking** (toggle) | Come Import ShipFinder, come **seconda fonte di backup indipendente** per la posizione dell'ultimo avvistamento (AIS terrestre: forte vicino a coste/porti). Ri-localizzazione in background + pulsante **📍 Localizza via MyShipTracking**; le posizioni appaiono come marker teal/ciano distinti. Dati statici in cache per 6 ore. Spento di default. |
| **Screening sanzioni** (toggle) | Confronta ogni nave con la lista sanzioni OFAC SDN (US Treasury), scaricata localmente. Il match avviene per numero IMO, nome o call sign. Un match è un segnale di rischio molto forte (contributo elevato allo score). La lista viene scaricata all'attivazione e aggiornata ogni 24 ore; il pulsante **Aggiorna lista** forza un download immediato. Sotto al toggle viene mostrato il numero di navi sanzionate in lista e la data dell'ultimo aggiornamento. |
| **Liste sanzioni aggiuntive (UE / UK / ONU)** (toggle) | Oltre alla lista OFAC, confronta ogni nave anche con la lista consolidata UE, la lista UK OFSI e la lista ONU delle navi designate. Sottovoce indentata sotto la riga **Screening sanzioni**, attiva solo quando lo screening sanzioni è acceso. Un match in una qualsiasi lista contribuisce allo score come un match OFAC. Le liste vengono scaricate e aggiornate ogni 24 ore (via OpenSanctions). Default attivo. |
| **Screening Port State Control (Paris/Tokyo MoU)** (toggle) | Confronta ogni nave con due liste ufficiali dei Memorandum d'Intesa: (1) la **performance bandiera** white/grey/black di Paris MoU e Tokyo MoU — una bandiera in black list è un registro ad alto rischio per fermi/ispezioni (contributo medio-alto allo score), una in white list non penalizza; (2) la **lista delle navi bandite** dal Paris MoU (refusal of access dopo fermi multipli) — segnale forte, match per IMO/nome. Le liste bandiera sono incluse nell'applicazione e vanno aggiornate manualmente ~1 volta l'anno; la lista navi bandite è scaricata all'attivazione e aggiornata ogni 24 ore. Il pulsante **Aggiorna liste** forza il download. Sotto al toggle sono mostrati i conteggi bandiere (black/grey/white) e navi bandite con la data dell'ultimo aggiornamento. |
| **Lookup Equasis (proprietà)** (toggle) | Abilita il pulsante **Recupera informazioni Equasis** nel dettaglio nave per recuperare proprietario registrato, gestore ISM e operatore (per numero IMO). **Mai automatico**: parte solo su richiesta, una nave alla volta. I dati vengono memorizzati una sola volta (nessuna scadenza). Richiede credenziali Equasis (`EQUASIS_USER` / `EQUASIS_PASSWORD` in `local.properties`); senza credenziali il pulsante resta inutilizzabile. Il pulsante **Visualizza log Equasis** (sotto la descrizione) apre il registro testuale di tutti i lookup effettuati, con data, nave e dati recuperati; dalla stessa finestra è possibile **Cancellare il log**. |
| **Global Fishing Watch** (toggle) | Arricchisce ogni nave con identità ed eventi comportamentali (incontri in mare, loitering, scali in porto, AIS spento) ricavati da GFW dal flusso AIS globale, mostrati in un pannello dedicato nel dettaglio; gli eventi contribuiscono allo score di rischio. **Proattivo** come VesselFinder/MarineTraffic e **attivo di default**. Copre soprattutto navi da pesca, di supporto e reefer/carrier (molte mercantili non sono presenti). Richiede un **token API** GFW (`GLOBAL_FISHING_WATCH_TOKEN` in `local.properties`); senza token la riga mostra l'avviso "token non configurato". Dati gratuiti solo per uso non commerciale. |
| **Notifiche** (toggle) | Interruttore generale: abilita o disabilita tutte le notifiche nella barra laterale. Se spento, i toggle sottostanti sono disattivati. |
| **Notifica rientro nave** (toggle) | Avvisa quando una nave rientra in un'area dove era già stata in passato. |
| **Notifica cambio area** (toggle) | Avvisa quando una nave vista in un'area viene poi rilevata in un'**altra** area. |
| **Notifica score alto** (toggle) | Avvisa quando una nave arriva con score di rischio in fascia rossa (71–100). |
| **Notifica nuova banchina** (toggle) | Avvisa quando viene rilevata una nuova banchina in un'area. |
| **Notifica caratterizzazione banchina** (toggle) | Avvisa quando una banchina viene caratterizzata per la prima volta (categoria di navi prevalente). |
| **Escludi tanker** (toggle) | Non assegnare il punteggio di rischio di tipo nave alle navi su scafo tanker. Utile quando si monitora il trasporto di armi, che i tanker non possono effettuare. |
| **Controlla salto di posizione** (toggle) | Includi nel punteggio di rischio la voce "Salto di posizione impossibile". Disattiva nelle aree con copertura AIS scarsa, dove i report di posizione radi producono salti apparenti che non sono spoofing reale. Default attivo. |
| **Controlla blackout AIS** (toggle) | Includi nel punteggio di rischio la voce "Blackout AIS". Disattiva nelle aree poco coperte, dove i buchi di ricezione sembrano spegnimenti deliberati del transponder. Default attivo. |
| **Livello nautico OpenSeaMap (tile)** (toggle) | Mostra sulle mappe il livello nautico OpenSeaMap a tile (boe, fari, luci, segnali, separazione del traffico, fairway, ancoraggi). È un'immagine unica: mostra **tutto o niente**, non si possono nascondere singoli simboli. Spegnilo se non vuoi vedere questi simboli (es. le luci/beacon che sembrano piccole torri con una goccia magenta). Dati gratuiti, **nessuna chiave API**. Default attivo. |
| **Marcatori OpenSeaMap (selezionabili)** (toggle) | Disegna sulla mappa delle navi presenti dei marcatori ⚓ con gli ormeggi/banchine/porti ufficiali presi da OpenStreetMap, da confrontare con le banchine calcolate automaticamente dall'app. A differenza del livello a tile, **sono filtrabili per categoria** (riga sotto). Passa il mouse su un marcatore per leggere cos'è. Default attivo. |
| **Elementi OpenSeaMap da mostrare** (caselle) | Scegli quali categorie di marcatori disegnare sulla mappa (porti, ormeggi, ancoraggi, marine, aree regolamentate, fari, segnali/boe, pericoli, punti pilota). La mappa si aggiorna subito quando spunti/togli una categoria. Vale per i marcatori vettoriali; il livello nautico a tile mostra sempre tutto. Default: tutte attive. |
| **Pesi rischio per tipo di carico** (griglia) | Punti di rischio assegnati per ciascuna classe merceologica (portacontainer, petroliera greggio, chimichiera, gasiera, rinfusiera, ecc.). La classe è derivata dal sottotipo VesselFinder/MarineTraffic con ripiego sul codice AIS. Sostituisce il vecchio punteggio fisso Cargo/Hazmat. Modifica i valori e premi **💾 Salva pesi** (effetto immediato, senza riavvio); **Ripristina default** ricarica i valori predefiniti nella griglia (da salvare per applicarli). I pesi sono inclusi nell'export delle impostazioni e del bundle. |
| **⬇ Esporta CSV** | Scarica tutte le letture come file CSV (importabile in Excel) |
| **⬇ Scarica backup** | Scarica il file del database (.db) come backup |
| **⬆ Ripristina** | Carica un file .db precedentemente salvato per ripristinare i dati |
| **Lingua** | Cambia la lingua dell'interfaccia (Italiano / English) |

> **Attenzione:** Il ripristino del database sostituisce **tutti** i dati attuali. L'operazione è irreversibile. Scarica un backup prima di procedere. Dopo il ripristino, i dati vengono automaticamente assegnati all'area corretta in base alle coordinate geografiche.

> **Mappa delle zone coperte:** i dati della [Mappa delle zone coperte](#mappa-delle-zone-coperte) sono tenuti in un **database separato**. Possono essere **esportati e importati per conto loro** dalle impostazioni di backup, e sono comunque inclusi anche nel **backup completo**.

> **Auto-ripristino dopo un deploy:** il database viene cancellato quando si aggiorna l'applicazione (deploy). Se all'avvio il database **non esiste** e sono presenti degli **auto-backup** salvati (cartella `data/backups/`), l'app ripristina automaticamente l'ultimo backup (solo il database). Questo richiede che la cartella dei backup sopravviva al deploy. Non scatta se il database esiste ma è stato semplicemente svuotato con "Cancella dati". Disattivabile con `AUTO_RESTORE_ON_DEPLOY=false` in `app.config.properties`.

Le impostazioni sono organizzate in **tab**: **Generali** (la tabella qui sopra), **Aree**, **Integrazioni esterne** (notifiche Telegram + webhook in uscita, vedi sotto), **Parametri** e **Backup / Ripristino**.

### Tab Integrazioni esterne

In questo tab colleghi i canali esterni a cui inviare le notifiche: **Telegram** (in alto) e i **webhook in uscita** (in fondo).

Permette di ricevere le notifiche del tuo utente su **Telegram**, tramite un bot. Funziona solo se l'amministratore ha configurato il token del bot sul server (`TELEGRAM_BOT_TOKEN`); altrimenti il tab mostra "Bot Telegram non configurato".

**Collegare il tuo account:**

1. Premi **Collega**. Compare un link (e un codice).
2. Apri il link su Telegram (o invia al bot il messaggio `/start <codice>`) e avvia il bot.
3. Il bot risponde "Account collegato" e il tab si aggiorna da solo: ora ricevi le notifiche su Telegram.

Per smettere: premi **Scollega** (o invia `/stop` al bot). Con **Invia prova** verifichi che il collegamento funzioni.

**Quali notifiche ricevere** — l'interruttore generale **Notifiche Telegram** accende/spegne tutto; sotto, un toggle per ciascuna categoria:

| Toggle | Avvisa quando… |
|---|---|
| **Score alto** | una nave arriva con score di rischio in fascia rossa (71–100). |
| **Rientro nave** | una nave rientra in un'area già visitata. |
| **Cambio area** | una nave passa da un'area monitorata a un'altra. |
| **Nuova banchina** | viene rilevata una nuova banchina in un'area. |
| **Caratterizzazione banchina** | una banchina viene caratterizzata per la prima volta. |
| **Disservizio AIS** | il feed AIS risulta non disponibile (inizio) e quando rientra (fine). |
| **Avvio/stop monitoraggio area** | avvii o fermi il monitoraggio di una tua area. |
| **Mappa del punto** | non è una categoria di evento: quando attivo, alle notifiche che hanno una posizione (banchine e navi) viene allegata un'**immagine della mappa** del punto (stesse mappe del sito: OpenStreetMap + livello nautico OpenSeaMap) più un **segnaposto toccabile** che apri nell'app mappe del telefono. Disattivalo per ricevere quelle notifiche come solo testo. |

I toggle Telegram sono **indipendenti** da quelli delle notifiche nella barra laterale: puoi ricevere una categoria solo su Telegram, o solo in-app, o entrambi. I messaggi arrivano nella **lingua** impostata per il tuo utente.

**Pulsanti Segui / Segnala** — le notifiche che riguardano una nave (**Score alto**, **Rientro nave**, **Cambio area**) mostrano due pulsanti sotto il messaggio:

- **🛰️ Segui** — aggiunge la nave alle tue **Navi seguite** (se non c'è già), esattamente come il follow nel sito; se la nave non sta trasmettendo da un po' parte la ricerca della sua posizione in background.
- **⭐ Segnala** — contrassegna la nave, come premere la **stellina** nella lista.

Dopo il tap arriva una breve conferma e il pulsante si aggiorna (es. **✅ Seguita**, **⭐ Segnalata**). Le azioni sono "solo aggiunta": ripremere un pulsante già attivo non fa nulla. Per togliere il follow o la segnalazione usa la lista navi nel sito.

**🔗 Webhook in uscita** — sotto i toggle Telegram puoi inoltrare gli eventi delle tue aree anche a un **indirizzo web** (un *webhook*), per portarli in **Slack**, **Discord**, un sistema di sicurezza (SIEM) o un tuo servizio. Per aggiungerne uno:

1. Incolla l'**URL** del webhook (quello che ti dà Slack/Discord, o il tuo endpoint).
2. Scegli il **formato**: *Generic* (JSON grezzo dell'evento, per SIEM/integrazioni custom), *Slack* o *Discord* (messaggio di testo pronto per quei servizi).
3. Spunta **quali eventi** inviare (alto rischio, rendezvous, cambio area, rientro, banchine, disservizio AIS).
4. (Facoltativo) imposta un **secret**: se presente, ogni invio include una firma `X-Tracker-Signature` con cui il destinatario verifica che arrivi davvero da qui.
5. **Aggiungi webhook**. Usa **Prova** per inviare un evento di test, l'interruttore per attivarlo/disattivarlo, **Elimina** per rimuoverlo.

I webhook sono **personali** (valgono solo per le tue aree) e indipendenti da Telegram. Per sicurezza non sono ammessi indirizzi interni/privati (localhost, reti locali). Massimo 10 per utente.

### Tab Parametri

Permette di modificare dall'interfaccia **tutti i parametri di funzionamento** dell'app (quelli del file `app.config.properties`): soglie di stato nave, finestre temporali, retention del database, intervallo di backup, auto-ripristino, parametri delle banchine e pesi dello **score di rischio**.

- I parametri sono raggruppati per categoria; **ogni campo ha una descrizione** che spiega cosa configura (presa direttamente dai commenti del file).
- Modifica i valori e premi **💾 Salva parametri**. I campi modificati e non ancora salvati sono evidenziati, con il conteggio accanto al pulsante.
- **⚠️ Importante:** questi parametri vengono letti dal server **una sola volta all'avvio**. Dopo il salvataggio è quindi **necessario riavviare il server** perché le modifiche abbiano effetto — **ricaricare il browser non basta**. L'interfaccia lo ricorda con un avviso e dopo ogni salvataggio. Per riavviare: ferma e riavvia con `npm start`, oppure `pm2 restart` se usi PM2.
- I **segreti** (chiave API, password) **non** sono modificabili da qui per sicurezza: restano nel file `local.properties`. I toggle di import e notifiche sono nel tab **Generali**.

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
| `AIS_API_KEY` | La chiave di accesso ad AISStream.io (obbligatoria) — usata dagli stream delle **aree di monitoraggio** |
| `FOLLOW_AIS_API_KEY` | Chiave AISStream.io per lo stream delle **navi seguite**. Meglio da un **account separato** (vedi nota sotto). Vuota = riusa `AIS_API_KEY` |
| `HEATMAP_AIS_API_KEY` | Chiave API di un account AISStream **separato** (diverso da `AIS_API_KEY`), usata **solo** per la [Mappa delle zone coperte](#mappa-delle-zone-coperte). Vuota = funzione disattivata. Va scritta "nuda", **senza commenti sulla stessa riga** |
| `BBOX_PRESET` | Area mostrata all'avvio (la chiave di un'area, es. `bari`) |
| `IMPORT_VF_DATA` | `true`/`false` — abilita l'import dati VesselFinder |
| `IMPORT_MT_DATA` | `true`/`false` — abilita l'import dati MarineTraffic |
| `IMPORT_SF_DATA` | `true`/`false` — abilita l'import dati ShipFinder + posizione per ri-localizzare le navi seguite perse |
| `IMPORT_MST_DATA` | `true`/`false` — abilita l'import MyShipTracking: seconda fonte di posizione di backup, stesso ruolo di ShipFinder |
| `IMPORT_SANCTIONS` | `true`/`false` — abilita lo screening contro la lista sanzioni OFAC SDN |
| `IMPORT_SANCTIONS_EXTRA` | `true`/`false` — abilita le liste sanzioni aggiuntive UE / UK OFSI / ONU oltre a OFAC (attivo solo con `IMPORT_SANCTIONS`); default `true` |
| `IMPORT_PSC` | `true`/`false` — abilita lo screening Port State Control (performance bandiera Paris/Tokyo MoU + navi bandite Paris MoU) |
| `IMPORT_EQUASIS` | `true`/`false` — abilita il lookup Equasis on-demand (proprietà/gestione) nel dettaglio nave |
| `EQUASIS_USER` | Email dell'account Equasis (registrazione gratuita su https://www.equasis.org/) — richiesta dal lookup Equasis |
| `EQUASIS_PASSWORD` | Password dell'account Equasis — richiesta dal lookup Equasis |
| `IMPORT_GFW` | `true`/`false` — abilita l'arricchimento Global Fishing Watch (identità + eventi comportamentali); **default `true`** |
| `GLOBAL_FISHING_WATCH_TOKEN` | Token API (Bearer) di Global Fishing Watch, generato dal portale API GFW (https://globalfishingwatch.org/our-apis/) — richiesto dall'arricchimento GFW. Dati gratuiti solo per uso non commerciale |
| `ADMIN_USERNAME` | Username dell'amministratore predefinito (sempre ricreato all'avvio se manca). Default `admin` |
| `ADMIN_EMAIL` | Email dell'amministratore predefinito. Default `admin@local` |
| `ADMIN_PASSWORD` | Password dell'amministratore predefinito. Se vuota usa il valore di default incluso nell'app — **cambiala** su un server raggiungibile da altri |
| `COOKIE_SECURE` | `true`/`false` — invia il cookie di sessione solo su HTTPS; impostare a `true` dietro TLS |
| `SESSION_TTL_DAYS` | Durata in giorni della sessione di login. Default `30` |

> `BBOX_PRESET`, `IMPORT_VF_DATA` e `IMPORT_MT_DATA` si cambiano anche dall'interfaccia (selettore area / Impostazioni) e vengono riscritti nel file automaticamente.

> 💡 **Consigliato: tre chiavi da tre account AISStream separati.** AISStream limita le connessioni **per account, non per chiave**. L'app apre tre tipi di stream indipendenti — **monitoraggio aree** (`AIS_API_KEY`), **navi seguite** (`FOLLOW_AIS_API_KEY`) e **mappa di copertura** (`HEATMAP_AIS_API_KEY`). Se due di questi usano chiavi dello **stesso account** competono per lo stesso slot di connessione e uno viene continuamente rifiutato. Per far funzionare bene tutte e tre le funzioni, dai a ciascuna una chiave di un **account AISStream dedicato**. (`FOLLOW_AIS_API_KEY` vuota = il follow riusa la chiave del monitoraggio; `HEATMAP_AIS_API_KEY` vuota = mappa di copertura disattivata.)

### `app.config.properties` — parametri di funzionamento

Contiene le soglie e i parametri dell'app (finestre temporali, raggi, retention, pesi dello score di rischio). Formato `CHIAVE=valore`. Ogni parametro è documentato da un commento nel file stesso. **Puoi modificare questi valori anche dall'interfaccia** in **⚙ Impostazioni → [Parametri](#tab-parametri)** (più comodo); in entrambi i casi serve **riavviare il server** per applicarli. Esempi:

| Chiave | Significato | Default |
|---|---|---|
| `SOG_FERMA_KN` | Velocità (nodi) sotto cui una nave è "ferma" | `0.5` |
| `ACTIVE_WINDOW_HOURS` | Ore entro cui una nave in movimento resta tra le "presenti" | `6` |
| `PORT_WINDOW_HOURS` | Ore di permanenza tra le "presenti" per una nave in porto | `24` |
| `POLL_INTERVAL_MS` | Intervallo di aggiornamento dell'interfaccia (millisecondi) | `300000` |
| `AIS_OUTAGE_CHECK` | Attiva il rilevamento dei disservizi AIS (`false` per disattivarlo) | `true` |
| `AIS_OUTAGE_SILENCE_MIN` | Minuti senza segnali AIS prima di interrogare il monitor di uptime | `10` |
| `AIS_UPTIME_SELFHOST_URL` | URL di una tua istanza self-hosted del monitor (interrogata per prima; vuota = nessuna) | _(vuoto)_ |
| `AIS_UPTIME_URL` | URL del monitor di uptime AISStream pubblico, usato come ripiego | `https://aisuptime.buttermilkgreen.fyi` |
| `MAX_READINGS_PER_TYPE` | Numero massimo di letture conservate per tipo di messaggio | `10000` |
| `BERTH_CLUSTER_EPS_M` | Raggio di clustering attracchi → banchine (metri) | `80` |
| `BERTH_MIN_PTS` | Attracchi minimi vicini per formare una banchina | `3` |
| `BERTH_MIN_MOORINGS` | Attracchi minimi prima di caratterizzare/colorare una banchina | `10` |
| `BERTH_DOMINANT_PCT` | Percentuale che una categoria deve superare per dare il nome alla banchina | `60` |
| `BERTH_RECOMPUTE_MIN` | Minuti tra un ricalcolo automatico delle banchine e il successivo | `30` |
| `HEATMAP_GRID_DEG` | Dimensione delle celle della [Mappa delle zone coperte](#mappa-delle-zone-coperte), in gradi (~28 km). Più piccola = mappa più precisa ma più pesante. Dopo averla cambiata premi **Cancella dati** nella mappa | `0.25` |
| `HEATMAP_FLUSH_SEC` | Ogni quanti secondi i conteggi raccolti vengono scritti su disco | `10` |
| `HEATMAP_STATS_SEC` | Ogni quanti secondi si aggiornano le statistiche di connessione in tempo reale | `2` |
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
- Punto rosso (con alone): nave presente in una lista sanzioni (OFAC / UE / UK / ONU)
- Etichetta blu (Paris/Tokyo MoU ⚓): segnale dalle liste Port State Control (bandiera black/grey o nave bandita)
- Punto verde acqua (Global Fishing Watch): punteggio calcolato con dati Global Fishing Watch

Passa il cursore sul badge per vedere i dettagli dei fattori e le fonti.

**Peso per tipo di carico:** uno dei fattori del punteggio dipende dalla classe merceologica della nave (vedi [Tipo carico](#barra-informazioni)). Ogni classe ha un peso configurabile da **⚙ Impostazioni → "Pesi rischio per tipo di carico"** (es. petroliere/chimichiere/gasiere pesano più delle portacontainer). Le modifiche hanno effetto immediato, senza riavvio. Con **"Escludi tanker"** attivo le classi su scafo tanker non assegnano punti.

**Pesi dei segnali (Modello di rischio):** quanti punti vale **ogni** segnale di rischio (blackout AIS, spoofing, sosta, aumento pescaggio, sanzioni, PSC, eventi GFW, rendezvous, ecc.) è regolabile da **⚙ Impostazioni → sezione "⚖ Modello di rischio"** (solo amministratori). Trovi una griglia con un campo per segnale: cambia i valori e premi **💾 Salva pesi** — effetto immediato, senza riavvio. **Ripristina default** riporta i valori di fabbrica. Puoi anche salvare configurazioni complete come **profili di rischio** (menu *Profilo di rischio* → *Salva come…*) e richiamarle con *Applica* — utile per passare al volo tra impostazioni diverse (es. un profilo più aggressivo, o uno tarato per aree con copertura AIS scarsa). Mettere un peso a **0** disattiva quel segnale. *(Le soglie di rilevamento e i moltiplicatori restano nel file di configurazione, vedi [`app.config.properties`](#appconfigproperties--parametri-di-funzionamento).)*

**Navi militari:** sono automaticamente classificate a rischio massimo.

---

## Diagnostica AIS

Apri da **⚙ Impostazioni → tab 📡 Diagnostica AIS**. Mostra lo stato della connessione al flusso dati:

- **Connessione** — Connesso / Disconnesso
- **Uptime sessione** — Da quanto tempo il flusso è attivo
- **Frame WS ricevuti** — Quanti pacchetti sono stati ricevuti
- **Messaggi nave** — Quante posizioni di navi sono state elaborate
- **Velocità messaggi** — Messaggi al minuto
- **Riconnessioni** — Quante volte la connessione è stata ripristinata
- **Ultimo errore** — L'eventuale ultimo errore registrato

Il pannello si aggiorna automaticamente ogni 5 secondi.

### Banner di disservizio AIS

Se per alcuni minuti (`AIS_OUTAGE_SILENCE_MIN`, predefinito 10) un monitoraggio attivo non riceve **nessun segnale AIS**, l'app verifica lo stato del servizio interrogando un **monitor di uptime indipendente** ([AISStream-Uptime](https://github.com/buttermilkgreen/AISStream-Uptime), istanza pubblica `https://aisuptime.buttermilkgreen.fyi`). Solo se anche quel monitor conferma che il servizio AISStream **non è attivo**, in cima alle pagine di monitoraggio compare un avviso giallo, evidente ma non invasivo:

> ⚠️ Possibile disservizio AISStream: nessun segnale in arrivo e il monitor pubblico riporta «…». I dati potrebbero non aggiornarsi.

Puoi chiudere l'avviso con la **✕**; ricomparirà se viene rilevato un nuovo disservizio. Quando i segnali tornano a essere ricevuti, l'avviso scompare da solo. Se l'area è semplicemente silenziosa ma il servizio è regolarmente attivo, **non** viene mostrato alcun avviso (nessun falso allarme). La funzione si disattiva del tutto con `AIS_OUTAGE_CHECK=false`. Vedi anche [Crediti](#crediti).

Il progetto AISStream-Uptime è open source (licenza MIT) e puoi **ospitarlo tu stesso**: indica l'URL della tua istanza in `AIS_UPTIME_SELFHOST_URL` e l'app la interrogherà per prima, ricorrendo al monitor pubblico solo se la tua è irraggiungibile (utile anche a capire se il disservizio è globale). Con un'istanza self-hosted sana il servizio pubblico non viene mai contattato.

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

Vengono create notifiche automatiche nei seguenti casi (ciascuno abilitabile/disabilitabile in modo indipendente dalle [Impostazioni](#impostazioni)):

Eventi nave:
- **Rientro nave** — una nave **già vista in passato in un'area torna a essere rilevata nella stessa area** (un nuovo arrivo dopo un'assenza). Il primo avvistamento in assoluto di una nave non genera notifica.
- **Cambio area** — una nave vista in un'area viene poi rilevata in un'**altra** area monitorata (lo spostamento da un'area all'altra).
- **Score alto** — una nave arriva con score di rischio in fascia rossa (71–100).

Eventi banchina (vedi [Banchine](#banchine-caratterizzazione-automatica-degli-attracchi)):
- **Nuova banchina** — durante il ricalcolo automatico viene rilevata una nuova banchina in un'area.
- **Caratterizzazione banchina** — una banchina viene caratterizzata per la prima volta (raggiunge la categoria di navi prevalente). Il primo calcolo iniziale (*backfill*) su un'area senza banchine non genera notifiche.

Altri eventi:
- **Rendezvous in mare** — due navi distinte sostano vicine, lente e al largo abbastanza a lungo (possibile trasbordo nave-nave, vedi [Rendezvous in mare](#rendezvous-in-mare)). La notifica include una mappa con i **due** punti uniti da una linea. Attivabile a parte sia in-app sia su Telegram.

**Lettura di una notifica**

| Elemento | Significato |
|---|---|
| Bollino 🟢 / 🟡 / 🔴 | Notifiche nave: colore in base allo score di rischio calcolato (verde basso, giallo medio, rosso alto — vedi [Punteggio di rischio](#punteggio-di-rischio)). Le notifiche banchina hanno un bollino dedicato. |
| Testo | Nome della nave e area (rientro/score alto), area di partenza e di arrivo (cambio area), oppure nome/categoria della banchina e area (eventi banchina) |
| Pulsante ✓ | Segna la notifica come letta |
| Pulsante 🗑 | Elimina la notifica (visibile al passaggio del cursore) |

**Clicca sulla notifica** (fuori dai pulsanti ✓ e 🗑): per una notifica nave apre la scheda della nave; per una notifica banchina passa alla mappa dell'area corrispondente (cambiando area se necessario) e centra la banchina aprendone il dettaglio.

**Eliminare una notifica**

Premi il pulsante 🗑 sulla notifica. Appare un avviso con un pulsante **↶ Annulla** per 5 secondi; allo scadere del tempo la notifica viene rimossa definitivamente.

**Silenziare le notifiche per una singola nave**

Nel dettaglio nave (apri cliccando su una riga della tabella o su una notifica) compare un pulsante:

- **🔔** — le notifiche per questa nave sono attive; cliccalo per silenziare
- **🔕** — le notifiche per questa nave sono silenziare; cliccalo per riabilitarle

Quando una nave è silenziata, non genera notifiche di rientro né di cambio area, indipendentemente dalle impostazioni globali.

Le notifiche **da leggere** sono mostrate in **grassetto** e contano nel badge rosso del pulsante 🔔. Le notifiche lette rimangono comunque visibili nella lista (non in grassetto). Viene conservato lo storico delle **ultime 100 notifiche**; le più vecchie vengono eliminate automaticamente. La cancellazione dei dati di un'area rimuove anche le sue notifiche.

---

## Installare l'app (PWA)

Tracker Porti è una **app installabile** (PWA): puoi aggiungerla alla schermata home del telefono o installarla come app sul desktop, e si apre **a tutto schermo**, senza la barra del browser.

- **Su telefono** — apri il sito nel browser → menu → **"Aggiungi a Home"** (iPhone/Safari) o **"Installa app"** (Android/Chrome). Comparirà un'icona con l'àncora come una normale app.
- **Su desktop** — in Chrome/Edge appare un'icona di installazione nella barra degli indirizzi, oppure menu → **"Installa Tracker Porti"**.

L'app installata **funziona anche offline** per quanto riguarda l'apertura: se manca la connessione mostra una schermata **"Sei offline"** con un pulsante *Riprova*, perché i dati AIS sono in tempo reale e richiedono la rete. Appena torni online ricarica e riprende normalmente. L'accesso resta protetto: serve sempre il login.

---

## Domande frequenti

**La tabella è vuota — cosa faccio?**
Verifica che il monitoraggio per quest'area sia avviato (badge ATTIVO in alto) e che l'area selezionata contenga traffico navale. Puoi controllare quali aree sono in monitoraggio dal pannello "Monitoraggio aree" nelle Impostazioni. Usa la Diagnostica AIS per controllare la connessione.

**Come faccio a non perdere le navi già controllate?**
Usa il pulsante **✓ Vista** su ogni riga: la nave diventa trasparente e la puoi distinguere subito da quelle non ancora esaminate.

**Posso esportare i dati?**
Sì, in più modi, tutti scaricati direttamente dal browser:
- **CSV** — il pulsante **⬇ CSV filtrato** nella toolbar Navi presenti/passate esporta la vista corrente (filtrata e ordinata); in **⚙ Impostazioni → Esporta CSV** c'è invece l'export grezzo di tutte le letture.
- **GeoJSON / KML** (per **QGIS** o **Google Earth**) — accanto al CSV trovi **⬇ GeoJSON** e **⬇ KML**. Quattro sorgenti: la **lista navi** filtrata (punti), la **traccia** di una nave (dal dettaglio, sotto la mappa), il **replay** di un'area (una linea per nave, dalla barra Replay) e le **banchine** come poligoni (pulsanti "Banchine GeoJSON/KML"). Se non c'è nulla da esportare compare un avviso.

**Ho cambiato area e le navi sono scomparse — è normale?**
Sì. Ogni area ha il proprio set di dati indipendente e il proprio stream indipendente. Cambiare l'area nel menu a tendina è solo un cambio di vista: mostra i dati dell'area selezionata ma non avvia né ferma nessuno stream. Le navi della precedente area rimangono nel database; se torni a quell'area le rivedrai. Per ricevere dati su più aree contemporaneamente usa il pannello "Monitoraggio aree" nelle Impostazioni.

**Posso monitorare più aree contemporaneamente?**
Sì. Apri **⚙ Impostazioni** → sezione **Monitoraggio aree** e attiva il toggle di ciascuna area che vuoi monitorare. Ogni area raccoglie dati in modo completamente indipendente. Puoi poi passare da un'area all'altra con il menu a tendina per visualizzarne i dati.

**Le navi militari sono sempre rosse?**
Sì. Le navi identificate come militari vengono contrassegnate automaticamente con punteggio massimo e riga rossa.

---

## Crediti

Il rilevamento dei disservizi AIS (il [banner di disservizio](#banner-di-disservizio-ais)) si appoggia al progetto **[AISStream-Uptime](https://github.com/buttermilkgreen/AISStream-Uptime)** di buttermilkgreen, un monitor di uptime per il servizio AISStream. L'app non ne incorpora il codice: consulta soltanto la API pubblica della sua istanza ospitata (`https://aisuptime.buttermilkgreen.fyi`) per capire se l'eventuale silenzio dei dati dipende da un guasto del servizio o semplicemente da un'area poco trafficata.
