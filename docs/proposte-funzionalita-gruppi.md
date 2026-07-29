# Proposte: feature aggiuntive per i gruppi utenti

> Documento di proposta, non ancora implementato. Contesto: [../.claude/CLAUDE.md](../.claude/CLAUDE.md) §"Gruppi utenti" — modello attuale è mirror write-through (`src/services/group-sync.js`): le tabelle per-utente restano source of truth, ogni scrittura di un membro si propaga ai co-membri (aree, follows, flags, mutes, viste, settings notifiche/mappa/area-default).

## 1. Audit log azioni di gruppo

Oggi il mirror è silenzioso: se un membro segna una nave "vista" (`user_seen`), tutto il gruppo la vede vista ma nessuno sa **chi** l'ha fatto né **quando**. Stesso vale per flag/follow/mute.

- **Cosa**: tabella `group_activity_log` (group_id, user_id, action, target_type, target_id, timestamp) popolata negli stessi punti dove oggi scatta il mirror in `group-sync.js`.
- **Perché**: permette di dividersi il lavoro di cernita sapendo chi ha già controllato cosa, invece di fidarsi ciecamente dello stato condiviso.
- **Trade-off**: nuova tabella da aggiungere a `BACKUP_TABLES`; crescita nel tempo → serve retention/pulizia come le altre tabelle storiche.
- **Priorità**: alta — gap più concreto nel modello attuale.

## 2. Ruoli in gruppo (leader / membro)

Oggi la membership è piatta: chiunque nel gruppo può modificare aree condivise, settings, ecc.

- **Cosa**: colonna `role` in `group_members` (`leader`|`member`). Leader può gestire aree/settings condivisi e membership; membro solo flag/follow/mute/vista.
- **Perché**: evita modifiche accidentali a configurazione condivisa da parte di un membro qualunque.
- **Trade-off**: serve definire cosa succede se l'unico leader lascia il gruppo (promozione automatica? blocco come per il minimo 2 membri già esistente).

## 3. Note condivise per nave/area

Nessuno spazio oggi per annotazioni testuali libere, tipo "controllata, ok" o "sospetta, verificare AIS".

- **Cosa**: tabella `group_notes` (group_id, target_type, target_id, author_id, testo, timestamp), mirrorata come le altre entità di gruppo.
- **Perché**: comunicazione asincrona tra membri senza uscire dall'app.
- **Trade-off**: superficie UI nuova (textarea + lista note in dettaglio nave/area).

## 4. Assegnazione nave → membro — ✅ implementato (variante)

Oggi la divisione del lavoro è solo binaria (vista/non vista).

- **Cosa**: campo `assigned_to` per nave nel contesto di un gruppo, visibile in tabella/dettaglio.
- **Perché**: triage esplicito ("questa la controlla Mario") invece di solo vista/non vista.
- **Trade-off**: si sovrappone parzialmente a #1 (audit log) e #3 (note) — valutare se serve come feature separata o è coperta da quelle.

**Implementato con una variante rispetto alla proposta**: non un singolo `assigned_to`, ma una tabella `user_ship_charges` (many-to-many) — più membri possono "prendere in carico" la stessa nave insieme, ciascuno può prendersi in carico da solo o essere assegnato da un co-membro, e chiunque nel gruppo può togliere la presa in carico di chiunque (stesso modello aperto di flag/follow/mute/vista). Non è un mirror write-through come le altre risorse di gruppo: ogni riga appartiene a chi l'ha presa, non è un'unione propagata a tutti. Copre il gap di #1 riusando lo stesso `group_activity_log` (azioni `charge_on`/`charge_off`/`charge_assign`) invece di introdurre una feature a parte — nessuna sovrapposizione irrisolta con #1. Dettagli: [`docs/technical/README.it.md` §Gruppi di utenti](technical/README.it.md#-gruppi-di-utenti).

## 5. Webhook condiviso di gruppo

`services/webhooks.js` oggi è per-utente, max 10 per utente, formati generic/slack/discord + HMAC + guardia SSRF.

- **Cosa**: webhook a livello di gruppo (stessa tabella o nuova `group_webhooks`), evita che ogni membro configuri manualmente lo stesso canale Slack/Discord.
- **Perché**: riduce duplicazione di configurazione per notifiche di squadra.
- **Trade-off**: da capire se i 4 eventi legati a nave (rientro/cambio area/score alto/rendezvous) devono passare dal filtro tipo-nave/vista già per-utente (`notify-categories.js`) o da un filtro separato per il gruppo.

## Raccomandazione

Partire da **#1 (audit log)**: gap più concreto nel modello attuale, non richiede nuova UI complessa, e le altre proposte (#3, #4) possono appoggiarsi alla stessa tabella/pattern.
