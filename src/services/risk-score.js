'use strict';

// ── Risk score for potential arms trafficking (0–100) ────────────────────────
// AIS messages never describe cargo, only kinematics + self-declared static
// data. So the score is built from *behavioural signatures* (anomalies) derived
// from a ship's reading/event history, then a geopolitical-context multiplier is
// applied — exactly the weighted-sum model described in the project brief.
//
//   0–30   verde   navigazione regolare
//   31–70  giallo  anomalie minori, monitoraggio di routine
//   71–100 rosso   combinazione di fattori critici → segnalazione
//
// Each detected signature contributes weighted points; the geopolitical context
// (embargo / flag-of-convenience) multiplies the anomaly subtotal. Final value
// is clamped to [0, 100].

const db = require('../db');
const { state, SOG_FERMA, RISK: R } = require('../config');
const { haversineM } = require('./ship-analysis');
const { cargoTypeForShip, isTankerClass, loadStateOf } = require('./cargo-type');
const sanctions = require('./sanctions');
const psc = require('./psc');

// Human labels for the cargo classes (keys defined in cargo-type.js). The
// frontend owns its own copy for the ship card / settings; this set is only for
// the risk-factor description line.
const CARGO_CLASS_LABELS = {
  en: {
    container: 'Container ship', dry_bulk: 'Dry bulk carrier', crude_oil: 'Crude oil tanker',
    oil_products: 'Oil products tanker', chemical: 'Chemical tanker', gas: 'Gas carrier (LNG/LPG)',
    vehicles: 'Vehicles carrier', roro: 'Ro-Ro cargo', reefer: 'Reefer (refrigerated)',
    general_cargo: 'General cargo', livestock: 'Livestock carrier', cargo_other: 'Cargo (generic)',
    tanker_other: 'Tanker (generic)', non_cargo: 'Non-cargo vessel', unknown: 'Unknown cargo type',
  },
  it: {
    container: 'Portacontainer', dry_bulk: 'Rinfusiera (carico secco)', crude_oil: 'Petroliera (greggio)',
    oil_products: 'Petroliera (prodotti raffinati)', chemical: 'Chimichiera', gas: 'Gasiera (LNG/LPG)',
    vehicles: 'Trasporto veicoli', roro: 'Ro-Ro merci', reefer: 'Frigorifera (reefer)',
    general_cargo: 'Carico generale', livestock: 'Trasporto bestiame', cargo_other: 'Cargo (generico)',
    tanker_other: 'Tanker (generico)', non_cargo: 'Nave non da carico', unknown: 'Tipo carico sconosciuto',
  },
};

// Self-declared destinations / known ports tied to arms embargoes or conflict
// zones. Matched case-insensitively as substrings of the AIS destination field.
const HIGH_RISK_DEST = [
  'SYRIA', 'TARTUS', 'LATAKIA', 'BANIYAS',
  'IRAN', 'BANDAR', 'BUSHEHR', 'CHABAHAR',
  'NORTH KOREA', 'DPRK', 'NAMPO', 'WONSAN',
  'LIBYA', 'TRIPOLI', 'BENGHAZI', 'MISRATA', 'TOBRUK',
  'YEMEN', 'HODEIDAH', 'HUDAYDAH', 'ADEN',
  'SUDAN', 'PORT SUDAN',
  'RUSSIA', 'NOVOROSSIYSK', 'SEVASTOPOL', 'KERCH', 'CRIMEA',
  'SOMALIA', 'MOGADISHU',
];

// MID = first 3 MMSI digits → flag state. Embargo / conflict flags weigh heavier
// than ordinary flags of convenience (lax registries favoured by smugglers).
const EMBARGO_MID = new Set([445, 468, 422, 642, 273]); // NK, Syria, Iran, Libya, Russia
const FOC_MID = new Set([
  351, 352, 353, 354, 355, 356, 357, 370, 371, 372, 373, // Panama
  636, 637, // Liberia
  538, // Marshall Islands
  616, // Comoros
  671, // Togo
  677, // Tanzania
  518, // Cook Islands
  667, // Sierra Leone
  214, // Moldova
  514, 515, // Cambodia
  511, // Palau
  423, // Mongolia
  619, // Ivory Coast
]);

// Registered-flag country names as they appear in VesselFinder/MarineTraffic
// enrichment ("Bandiera"/"Flag" field). The MID heuristic only sees the MMSI's
// declared flag; the scraped registry flag can differ (reflagging) or simply be
// the ground truth, so it is matched independently by country name.
const EMBARGO_FLAG_NAMES = ['NORTH KOREA', 'DPRK', 'SYRIA', 'IRAN', 'LIBYA', 'RUSSIA'];
const FOC_FLAG_NAMES = [
  'PANAMA', 'LIBERIA', 'MARSHALL', 'COMOROS', 'TOGO', 'TANZANIA', 'COOK ISLANDS',
  'SIERRA LEONE', 'MOLDOVA', 'CAMBODIA', 'PALAU', 'MONGOLIA', 'IVORY COAST', "COTE D'IVOIRE",
];

// Human label for which key matched a sanctions entry, per language.
const MATCHED_ON = {
  it: { imo: 'IMO', callSign: 'call sign', name: 'nome' },
  en: { imo: 'IMO', callSign: 'call sign', name: 'name' },
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function getLabels(lang) {
  if (lang === 'en') return {
    military: 'Military vessel (automatic maximum score)',
    darkMax:  (h)           => `Prolonged AIS blackout (~${h}h underway)`,
    darkPartial: (h)        => `AIS blackout (~${h}h underway)`,
    spoofImpossible: (kn)   => `Impossible position jump (~${kn} kn)`,
    spoofAnom: (kn)         => `Anomalous kinematics (~${kn} kn)`,
    loiterMax: 'Anomalous stop in open sea (possible transshipment)',
    loiterPartial: 'Anomalous slowdown off course',
    draughtLoad: (d)        => `Draft increase +${d}m (cargo loaded)`,
    destChange: (n)         => `Declared destination changed (${n} different)`,
    hazmat: 'Cargo/Tanker hazardous goods (Hazmat)',
    cargo:  'Cargo/Tanker (relevant for arms transport)',
    cargoClass: (c) => `Cargo type: ${c.subtype || CARGO_CLASS_LABELS.en[c.class] || c.class}${c.source && c.source !== 'AIS' ? ` (source ${c.source})` : ''}`,
    nameHop: (n)            => `Hull name change (${n} names on same MMSI)`,
    embargoFlag: (f, s)     => `Flag registered under embargo: ${f} (source ${s})`,
    focFlag: (f, s)         => `Flag of convenience: ${f} (source ${s})`,
    oldVessel: (y, age, s)  => `Aged vessel (${y}, ~${age} years — source ${s})`,
    sanctioned: (src, prog, on) => `Listed in ${src} sanctions list${prog ? ` (${prog})` : ''} — matched by ${on}`,
    pscBlackFlag: (f, m)    => `Flag on ${m} black list (high-risk registry): ${f}`,
    pscGreyFlag: (f, m)     => `Flag on ${m} grey list (medium-risk registry): ${f}`,
    pscBanned: (r, on)      => `Vessel on Paris MoU banned list${r ? ` — ${r}` : ''} (matched by ${on})`,
    gfwEncounter: (n)       => `At-sea encounter detected by Global Fishing Watch (${n} event${n > 1 ? 's' : ''}) — possible transshipment`,
    gfwGap: (n)             => `AIS-off ("dark") event detected by Global Fishing Watch (${n})`,
    gfwLoiter: (n)          => `Loitering in open sea detected by Global Fishing Watch (${n})`,
    gfwPortHigh: (p)        => `Global Fishing Watch port call in a high-risk area: ${p}`,
    proximity: (n)          => `At-sea rendezvous with ${n === 1 ? 'another vessel' : `${n} vessels`} (close, slow, offshore — possible ship-to-ship transfer)`,
    highRiskPort: (p, s)    => `Home port in high-risk zone: ${p} (source ${s})`,
    highRiskCtx: (ctx, m)   => `High-risk context: ${ctx} (×${m})`,
    ctxDest: 'destination under embargo/conflict zone',
    ctxEmbargoFlag: 'state flag under embargo',
    ctxFoc: 'flag of convenience',
  };
  return {
    military: 'Nave militare (score massimo automatico)',
    darkMax:  (h)           => `Blackout AIS prolungato (~${h}h in navigazione)`,
    darkPartial: (h)        => `Blackout AIS (~${h}h in navigazione)`,
    spoofImpossible: (kn)   => `Salto di posizione impossibile (~${kn} kn)`,
    spoofAnom: (kn)         => `Cinematica anomala (~${kn} kn)`,
    loiterMax: 'Sosta anomala in mare aperto (possibile trasbordo)',
    loiterPartial: 'Rallentamento anomalo fuori rotta',
    draughtLoad: (d)        => `Aumento pescaggio +${d}m (carico imbarcato)`,
    destChange: (n)         => `Destinazione dichiarata variata (${n} diverse)`,
    hazmat: 'Cargo/Tanker merci pericolose (Hazmat)',
    cargo:  'Cargo/Tanker (rilevante per trasporto armi)',
    cargoClass: (c) => `Tipo carico: ${c.subtype || CARGO_CLASS_LABELS.it[c.class] || c.class}${c.source && c.source !== 'AIS' ? ` (fonte ${c.source})` : ''}`,
    nameHop: (n)            => `Cambio nome scafo (${n} nomi sullo stesso MMSI)`,
    embargoFlag: (f, s)     => `Bandiera registrata sotto embargo: ${f} (fonte ${s})`,
    focFlag: (f, s)         => `Bandiera di comodo: ${f} (fonte ${s})`,
    oldVessel: (y, age, s)  => `Naviglio datato (${y}, ~${age} anni — fonte ${s})`,
    sanctioned: (src, prog, on) => `Nave in lista sanzioni ${src}${prog ? ` (${prog})` : ''} — match per ${on}`,
    pscBlackFlag: (f, m)    => `Bandiera in black list ${m} (registro ad alto rischio): ${f}`,
    pscGreyFlag: (f, m)     => `Bandiera in grey list ${m} (registro a rischio medio): ${f}`,
    pscBanned: (r, on)      => `Nave nella banned list Paris MoU${r ? ` — ${r}` : ''} (match per ${on})`,
    gfwEncounter: (n)       => `Incontro in mare rilevato da Global Fishing Watch (${n} event${n > 1 ? 'i' : 'o'}) — possibile trasbordo`,
    gfwGap: (n)             => `Evento AIS spento ("dark") rilevato da Global Fishing Watch (${n})`,
    gfwLoiter: (n)          => `Sosta in mare aperto rilevata da Global Fishing Watch (${n})`,
    gfwPortHigh: (p)        => `Scalo Global Fishing Watch in zona ad alto rischio: ${p}`,
    proximity: (n)          => `Rendezvous in mare con ${n === 1 ? "un'altra nave" : `${n} navi`} (vicine, lente, al largo — possibile trasbordo nave-nave)`,
    highRiskPort: (p, s)    => `Porto di armamento in zona ad alto rischio: ${p} (fonte ${s})`,
    highRiskCtx: (ctx, m)   => `Contesto ad alto rischio: ${ctx} (×${m})`,
    ctxDest: 'destinazione sotto embargo/zona di conflitto',
    ctxEmbargoFlag: 'bandiera di stato sotto embargo',
    ctxFoc: 'bandiera di comodo',
  };
}

// Find the first value whose key contains any of the given (lowercase) needles.
function pick(data, needles) {
  if (!data) return null;
  for (const [k, v] of Object.entries(data)) {
    const kl = k.toLowerCase();
    if (needles.some((n) => kl.includes(n)) && v != null && v !== '') return String(v);
  }
  return null;
}

// Pull cached VesselFinder/MarineTraffic enrichment (only the sources the user
// enabled) and merge it into a single field map. Never triggers live scraping:
// it reads whatever the detail-view requests already cached, so it stays fast
// and synchronous for the list endpoints.
//
// Returns vfStatus/mtStatus as one of:
//   'none'      – source disabled or no cached data (not yet fetched via detail view)
//   'available' – cached data found; whether it contributes to score is determined later
function loadEnrichment(mmsi) {
  let vfStatus = 'none', mtStatus = 'none', gfwStatus = 'none';
  const sources = [];
  if (state.importVfData) {
    const row = db.getScrapedData(mmsi, 'vf');
    if (row) { vfStatus = 'available'; sources.push(['VesselFinder', row]); }
  }
  if (state.importMtData) {
    const row = db.getScrapedData(mmsi, 'mt');
    if (row) { mtStatus = 'available'; sources.push(['MarineTraffic', row]); }
  }

  // GFW uses a structured shape ({ identity, events }) rather than the flat
  // label→value map VF/MT produce, so it's parsed separately and its identity
  // fields are merged as a *fallback* (VF/MT win when both are present).
  let gfwData = null;
  if (state.importGfw) {
    const row = db.getScrapedData(mmsi, 'gfw');
    if (row) {
      try {
        const parsed = JSON.parse(row.data_json);
        if (parsed && parsed.found) { gfwData = parsed; gfwStatus = 'available'; }
      } catch {
        /* corrupt cache row — ignore */
      }
    }
  }

  const fields = {}; // field → { value, src }; first source to provide it wins
  for (const [src, row] of sources) {
    let data;
    try {
      data = JSON.parse(row.data_json);
    } catch {
      continue;
    }
    const set = (key, value) => {
      if (value && !fields[key]) fields[key] = { value, src };
    };
    set('flag', pick(data, ['bandiera', 'flag']));
    set('year', pick(data, ['anno costruzione', 'year of build', 'built', 'anno']));
    set('homePort', pick(data, ['porto di armamento', 'home port', 'homeport']));
  }
  // GFW identity fills only what VF/MT left empty (no home-port field in GFW).
  if (gfwData && gfwData.identity) {
    const set = (key, value) => {
      if (value && !fields[key]) fields[key] = { value: String(value), src: 'Global Fishing Watch' };
    };
    set('flag', gfwData.identity.flag);
    set('year', gfwData.identity.year);
  }
  return { fields, vfStatus, mtStatus, gfwStatus, gfwData };
}

function bandOf(score) {
  if (score <= 30) return 'low';
  if (score <= 70) return 'med';
  return 'high';
}

/**
 * Compute the arms-trafficking risk score for one ship.
 * Returns { score, band, factors } where `factors` lists the contributing
 * signatures for the detail view. Pure given its inputs (queries are read-only).
 */
function computeRiskScore(ship, lang) {
  const L = getLabels(lang);
  const mmsi = ship.mmsi;
  const positions = db.getShipPositions(mmsi);
  const events = db.getShipEvents(mmsi);
  const names = db.getDistinctShipNames(mmsi);

  const factors = [];
  let anomaly = 0;
  const add = (points, label) => {
    if (points <= 0) return;
    anomaly += points;
    factors.push({ label, points: Math.round(points) });
  };

  // Military ships → fixed maximum score regardless of behavioural signals.
  if (isMilitary(ship)) {
    return {
      score: 100,
      band: 'high',
      factors: [{ label: L.military, points: 100 }],
      sources: { vf: 'none', mt: 'none', gfw: 'none', sanctions: 'none', psc: 'none' },
    };
  }

  // 1. Dark activity — longest AIS blackout while underway. In-port ships
  //    legitimately transmit rarely, so only gaps that *begin* while moving
  //    (sog ≥ threshold) count as a deliberate transponder shutdown. Skipped
  //    entirely when the user disabled it (coverage gaps in poorly-served areas
  //    masquerade as deliberate dark activity).
  if (state.checkDarkActivity) {
    let maxGapH = 0;
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const movingBefore = prev.sog != null && prev.sog >= SOG_FERMA;
      if (!movingBefore) continue;
      const dtH = (new Date(positions[i].received_at) - new Date(prev.received_at)) / 3.6e6;
      if (dtH > maxGapH) maxGapH = dtH;
    }
    if (maxGapH >= R.DARK_MAX_H) {
      add(R.DARK_MAX, L.darkMax(maxGapH.toFixed(0)));
    } else if (maxGapH >= R.DARK_MIN_H) {
      const t = (maxGapH - R.DARK_MIN_H) / (R.DARK_MAX_H - R.DARK_MIN_H);
      add(R.DARK_PARTIAL_MIN + t * (R.DARK_MAX - R.DARK_PARTIAL_MIN), L.darkPartial(maxGapH.toFixed(1)));
    }
  }

  // 2. Spoofing — physically impossible jump between consecutive positions.
  //    Skipped when disabled: sparse position reports in low-coverage areas
  //    produce large apparent jumps that are not real spoofing.
  if (state.checkSpoofing) {
    let maxImplied = 0;
    for (let i = 1; i < positions.length; i++) {
      const a = positions[i - 1];
      const b = positions[i];
      const dtH = (new Date(b.received_at) - new Date(a.received_at)) / 3.6e6;
      if (dtH <= 0 || dtH > 1) continue; // ignore long gaps (handled as blackout)
      const dM = haversineM(a.lat, a.lon, b.lat, b.lon);
      if (dM < 500) continue; // GPS jitter
      const kn = dM / 1852 / dtH;
      if (kn > maxImplied) maxImplied = kn;
    }
    if (maxImplied > R.SPOOF_IMPOSSIBLE) add(R.SPOOF_MAX, L.spoofImpossible(maxImplied.toFixed(0)));
    else if (maxImplied > R.SPOOF_ANOMALOUS) add(R.SPOOF_ANOM_PTS, L.spoofAnom(maxImplied.toFixed(0)));
  }

  // 3. Loitering — stationary in open water (far from the monitored port centre)
  //    while NOT moored/anchored: classic ship-to-ship transfer signature.
  if (state.centerLat != null) {
    const open = positions.filter((p) => {
      const slow = p.sog != null && p.sog < SOG_FERMA;
      const notMoored = p.ns !== '1' && p.ns !== '5';
      const farKm = haversineM(p.lat, p.lon, state.centerLat, state.centerLon) / 1000;
      return slow && notMoored && farKm > R.LOITER_FAR_KM;
    }).length;
    if (open >= R.LOITER_MIN_POS) add(R.LOITER_MAX, L.loiterMax);
    else if (open >= 1) add(R.LOITER_PARTIAL, L.loiterPartial);
  }

  // 4. Draught load — significant increase in declared draught across a stop
  //    (heavier cargo taken on). Draught is stored in metres.
  let maxLoad = 0;
  for (let i = 1; i < events.length; i++) {
    // events are newest-first; compare each with the older neighbour
    const newer = events[i - 1];
    const older = events[i];
    if (newer.draught != null && older.draught != null) {
      const deltaM = newer.draught - older.draught;
      if (deltaM > maxLoad) maxLoad = deltaM;
    }
  }
  if (maxLoad >= R.DRAUGHT_MIN_DELTA) add(clamp(maxLoad * R.DRAUGHT_FACTOR, 0, R.DRAUGHT_MAX), L.draughtLoad(maxLoad.toFixed(1)));

  // 5. Destination instability — frequent changes of declared destination.
  const dests = new Set(
    [ship.destination, ...events.map((e) => e.destination)]
      .map((d) => (d || '').trim().toUpperCase())
      .filter(Boolean)
  );
  if (dests.size >= 2) add(clamp((dests.size - 1) * R.DEST_PER_CHANGE, 0, R.DEST_MAX), L.destChange(dests.size));

  // 6. Cargo type — per-class weight (replaces the old flat hazmat/cargo points).
  //    The class is derived from the granular VesselFinder/MarineTraffic subtype
  //    when imported & cached, falling back to the AIS hull code. Each class has
  //    its own weight (state.cargoWeights, editable from Settings). With "exclude
  //    tankers" on, tanker-hull classes contribute nothing — useful when
  //    monitoring arms transport, which tankers cannot carry.
  const cargo = cargoTypeForShip(ship);
  if (!(state.excludeTankers && isTankerClass(cargo.class))) {
    const w = state.cargoWeights[cargo.class] || 0;
    if (w > 0) add(w, L.cargoClass(cargo));
  }

  // 7. Flag/name hopping — one MMSI broadcasting multiple hull names.
  if (names.length >= 2) add(R.NAME_HOP, L.nameHop(names.length));

  // 8. External enrichment (VesselFinder / MarineTraffic) — only used when the
  //    user enabled the corresponding import and the data is already cached.
  //    Tracks which sources actually contributed points ('used') vs were merely
  //    consulted but had no relevant data ('available').
  const { fields: enr, vfStatus, mtStatus, gfwStatus, gfwData } = loadEnrichment(mmsi);
  let vfContributed = false, mtContributed = false, gfwContributed = false, pscContributed = false;
  const addEnr = (points, label, src) => {
    add(points, label);
    if (points > 0) {
      if (src === 'VesselFinder') vfContributed = true;
      if (src === 'MarineTraffic') mtContributed = true;
      if (src === 'Global Fishing Watch') gfwContributed = true;
    }
  };
  if (enr.flag) {
    const flagUpper = enr.flag.value.toUpperCase();
    // Official Paris/Tokyo MoU flag performance, when enabled & loaded. It is
    // ground truth for registry risk, so it overrides the hardcoded FOC list
    // (e.g. Panama is only grey, Liberia is white in the current Paris list).
    const pscFlag = state.importPsc && psc.flagsLoaded() ? psc.matchFlag(enr.flag.value) : null;
    if (EMBARGO_FLAG_NAMES.some((n) => flagUpper.includes(n))) {
      addEnr(R.EMBARGO_FLAG, L.embargoFlag(enr.flag.value, enr.flag.src), enr.flag.src);
    } else if (pscFlag) {
      const mous = pscFlag.mous.join(' + ');
      if (pscFlag.perf === 'black') {
        addEnr(R.PSC_BLACK_FLAG, L.pscBlackFlag(enr.flag.value, mous), enr.flag.src);
        pscContributed = true;
      } else if (pscFlag.perf === 'grey') {
        addEnr(R.PSC_GREY_FLAG, L.pscGreyFlag(enr.flag.value, mous), enr.flag.src);
        pscContributed = true;
      }
      // white → quality registry: no penalty (and suppresses the FOC heuristic)
    } else if (FOC_FLAG_NAMES.some((n) => flagUpper.includes(n))) {
      addEnr(R.FOC_FLAG, L.focFlag(enr.flag.value, enr.flag.src), enr.flag.src);
    }
  }
  if (enr.year) {
    const y = parseInt(String(enr.year.value).match(/\d{4}/)?.[0], 10);
    const age = Number.isFinite(y) ? new Date().getUTCFullYear() - y : 0;
    if (age >= R.OLD_MIN_AGE) addEnr(R.OLD_VESSEL, L.oldVessel(y, age, enr.year.src), enr.year.src);
  }
  if (enr.homePort) {
    const hpUpper = enr.homePort.value.toUpperCase();
    if (HIGH_RISK_DEST.some((k) => hpUpper.includes(k))) {
      addEnr(R.HIGH_RISK_PORT, L.highRiskPort(enr.homePort.value, enr.homePort.src), enr.homePort.src);
    }
  }

  // 9. Sanctions screening (OFAC SDN) — local match by IMO/name/call sign. A hit
  //    is a very strong direct signal, so it adds a heavy weighted factor that
  //    still passes through the geopolitical multiplier below.
  //    'none' = disabled or dataset not loaded; 'available' = checked, no match;
  //    'used' = matched and contributed points.
  let sanctionStatus = 'none';
  let sanctionMatch = null;
  if (state.importSanctions && sanctions.getStatus().loaded) {
    const hit = sanctions.matchShip(ship);
    if (hit) {
      const onLabel = MATCHED_ON[lang === 'en' ? 'en' : 'it'][hit.matchedOn] || hit.matchedOn;
      add(R.SANCTION_MATCH, L.sanctioned(hit.entry.source, hit.entry.program, onLabel));
      sanctionStatus = 'used';
      // Structured detail for the dedicated sanctions panel in the ship detail view.
      sanctionMatch = {
        source: hit.entry.source,
        sourceKey: hit.entry.sourceKey || null,
        program: hit.entry.program || null,
        flag: hit.entry.flag || null,
        owner: hit.entry.owner || null,
        aliases: hit.entry.aliases || [],
        listedName: hit.entry.name || null,
        matchedOn: hit.matchedOn,
        matchedOnLabel: onLabel,
        url: sanctions.entityUrl(hit.entry),
      };
    } else {
      sanctionStatus = 'available';
    }
  }

  // 10. Port State Control (Paris / Tokyo MoU). Flag-performance points were
  //     already added in block 8 (it needs the enriched flag). Here we add the
  //     banned-ship match: a vessel refused access after repeated detentions —
  //     the strongest "many detentions" signal — matched locally by IMO/name.
  //     'none' = disabled or no data; 'available' = checked, no contribution;
  //     'used' = flag and/or banned match contributed points.
  let pscStatus = 'none';
  if (state.importPsc && psc.anyLoaded()) {
    pscStatus = pscContributed ? 'used' : 'available';
    if (psc.bannedLoaded()) {
      const ban = psc.matchBanned(ship);
      if (ban) {
        const onLabel = MATCHED_ON[lang === 'en' ? 'en' : 'it'][ban.matchedOn] || ban.matchedOn;
        add(R.PSC_BANNED, L.pscBanned(ban.entry.reason, onLabel));
        pscStatus = 'used';
      }
    }
  }

  // 11. Global Fishing Watch behavioural events. These are AIS-derived signals
  //     already classified by GFW from the global feed, so they are authoritative
  //     confirmations of the behavioural heuristics computed above (blocks 1–3)
  //     and contribute to the anomaly subtotal (pass through the multiplier).
  //     Identity-based GFW contributions (flag/year, block 8) already set
  //     gfwContributed; here we add the event factors.
  if (gfwData && gfwData.events) {
    const ev = gfwData.events;
    if (ev.encounters?.length) addEnr(R.GFW_ENCOUNTER, L.gfwEncounter(ev.encounters.length), 'Global Fishing Watch');
    if (ev.gaps?.length) addEnr(R.GFW_GAP, L.gfwGap(ev.gaps.length), 'Global Fishing Watch');
    if (ev.loitering?.length) addEnr(R.GFW_LOITERING, L.gfwLoiter(ev.loitering.length), 'Global Fishing Watch');
    const highRiskCall = (ev.portVisits || []).find((pv) => {
      const hay = `${pv.port || ''} ${pv.country || ''}`.toUpperCase();
      return HIGH_RISK_DEST.some((k) => hay.includes(k));
    });
    if (highRiskCall) {
      addEnr(R.GFW_PORT_HIGH, L.gfwPortHigh(highRiskCall.port || highRiskCall.country), 'Global Fishing Watch');
    }
  }

  // 12. Ship-to-ship rendezvous (local detection). A confirmed close, slow,
  //     offshore encounter with another tracked vessel within the trailing
  //     window — the transshipment signature, computed from our own AIS feed
  //     (no external source). Counts distinct partner ships. Behaves like the
  //     other behavioural heuristics (passes through the multiplier). Weight 0
  //     disables it. See services/proximity.js for the detection itself.
  if (R.PROXIMITY > 0) {
    const sinceIso = new Date(Date.now() - R.PROXIMITY_WINDOW_DAYS * 86400000).toISOString();
    const partners = new Set(db.getProximityForShip(mmsi, sinceIso).map((r) => r.other));
    if (partners.size) add(R.PROXIMITY, L.proximity(partners.size));
  }

  // ── Geopolitical context multiplier ────────────────────────────────────────
  const destUpper = (ship.destination || '').toUpperCase();
  const highRiskDest = HIGH_RISK_DEST.some((k) => destUpper.includes(k));
  const mid = Math.floor(mmsi / 1e6);
  const embargoFlag = EMBARGO_MID.has(mid);
  const focFlag = FOC_MID.has(mid);

  let mult = 1;
  if (highRiskDest || embargoFlag) mult += R.MULT_HIGH_RISK;
  if (focFlag) mult += R.MULT_FOC;

  const score = clamp(Math.round(anomaly * mult), 0, 100);

  if (mult > 1) {
    const ctx = [];
    if (highRiskDest) ctx.push(L.ctxDest);
    if (embargoFlag) ctx.push(L.ctxEmbargoFlag);
    if (focFlag) ctx.push(L.ctxFoc);
    factors.push({ label: L.highRiskCtx(ctx.join(', '), mult.toFixed(1)), points: Math.round(score - anomaly) });
  }

  // Resolve final source status:
  //   'none'      – no cached data (disabled or detail view never opened)
  //   'available' – data in cache but no relevant fields triggered score
  //   'used'      – data in cache AND contributed points to the score
  const resolvedVf = vfStatus === 'none' ? 'none' : vfContributed ? 'used' : 'available';
  const resolvedMt = mtStatus === 'none' ? 'none' : mtContributed ? 'used' : 'available';
  const resolvedGfw = gfwStatus === 'none' ? 'none' : gfwContributed ? 'used' : 'available';

  // Cargo type + estimated load condition for the detail view (the cargo class
  // also fed the score above). Load state compares the latest declared draught
  // against the min/max ever observed for this MMSI — a laden/ballast estimate.
  const draughts = events.map((e) => e.draught).filter((d) => d != null);
  const loadState = loadStateOf(ship.max_draught, draughts);

  factors.sort((a, b) => b.points - a.points);
  return {
    score,
    band: bandOf(score),
    factors,
    sanctionMatch,
    cargo: { class: cargo.class, subtype: cargo.subtype, source: cargo.source, loadState: loadState.state, loadRatio: loadState.ratio },
    sources: { vf: resolvedVf, mt: resolvedMt, gfw: resolvedGfw, sanctions: sanctionStatus, psc: pscStatus },
  };
}

// Name prefixes / keywords that identify military or NATO vessels in AIS data.
// Prefixes include a trailing space to avoid false positives (e.g. "ITSM..." vs "ITS Lupo").
const MILITARY_NAME_TOKENS = [
  'WARSHIP', 'NATO',
  'HMS ', 'USS ', 'FS ', 'FGS ', 'HNLMS ', 'HMAS ', 'HMCS ',
  'INS ', 'BNS ', 'HDMS ', 'HTMS ', 'TCG ', 'ORP ', 'ITS ',
  'ROKS ', 'NRP ', 'RFS ', 'ESPS ', 'SPS ',
];

function isMilitary(ship) {
  if (ship.is_military === 1) return true;
  if (ship.ship_type === 35) return true;
  const name = (ship.ship_name || '').toUpperCase();
  return MILITARY_NAME_TOKENS.some((tok) => name.includes(tok));
}

// ── Memoisation ──────────────────────────────────────────────────────────────
// computeRiskScore is heavy (several DB reads + geometry per ship). The list /
// stats endpoints score hundreds of ships per request on a synchronous SQLite
// connection, which stalls the event loop. Cache the result per (mmsi, lang)
// with a TTL, invalidated whenever a ship gets new data (a fresh AIS reading,
// a manual military toggle, or new scraped enrichment) or a global input
// changes (settings toggles, sanctions/PSC refresh). The ingestion path and the
// single-ship detail view keep calling the uncached computeRiskScore so they
// always see the freshest inputs.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50000; // hard cap so a flood of distinct MMSIs can't grow it unbounded
const _cache = new Map(); // `${mmsi}:${lang}` -> { at, val }

function computeRiskScoreCached(ship, lang) {
  const key = `${ship.mmsi}:${lang}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.val;
  const val = computeRiskScore(ship, lang);
  if (_cache.size >= CACHE_MAX) _cache.clear();
  _cache.set(key, { at: Date.now(), val });
  return val;
}

/** Drop cached scores for one MMSI (all languages). */
function invalidateRiskCache(mmsi) {
  if (mmsi == null) return;
  for (const key of _cache.keys()) {
    if (key.startsWith(`${mmsi}:`)) _cache.delete(key);
  }
}

/** Drop the whole cache (use when a global scoring input changes). */
function clearRiskCache() {
  _cache.clear();
}

module.exports = {
  computeRiskScore,
  computeRiskScoreCached,
  invalidateRiskCache,
  clearRiskCache,
  bandOf,
  isMilitary,
};
