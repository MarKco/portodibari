'use strict';

// Cargo-type classification: *what a ship is built to carry*.
//
// Three-tier source, best first:
//   1. VesselFinder "Ship Type" / MarineTraffic "Tipo" — a granular subtype
//      string ("Crude Oil Tanker", "Container Ship", "Bulk Carrier"…). Mapped to
//      a merchandise CLASS below.
//   2. AIS ship_type code — coarse fallback: 70–79 → generic cargo, 80–89 →
//      generic tanker. Cannot tell commodity, only hull family.
//   3. nothing usable → 'unknown'.
//
// The CLASS set is fixed and shared with the frontend (which owns colours +
// translated labels) and with the risk score (configurable per-class weights in
// state.cargoWeights). `cargo_other` / `tanker_other` are the AIS-only generic
// buckets; the rest are reachable only from a granular VF/MT subtype.
//
// Separately, loadStateOf() estimates the *current* load condition (laden /
// ballast) from declared draught — the closest AIS proxy to "what's on board
// now". It is data-driven (current draught vs the min/max ever observed for that
// MMSI) and needs no external source.

const CARGO_CLASSES = [
  'container',
  'dry_bulk',
  'crude_oil',
  'oil_products',
  'chemical',
  'gas',
  'vehicles',
  'roro',
  'reefer',
  'general_cargo',
  'livestock',
  'cargo_other', // AIS 70–79, no granular subtype
  'tanker_other', // AIS 80–89, no granular subtype
  'non_cargo', // tug / supply / pleasure / passenger / fishing …
  'unknown',
];

// Classes that are tanker hulls — suppressed when the "exclude tankers" toggle
// is on (mirrors the AIS 80–89 check the risk score used before).
const TANKER_CLASSES = new Set(['crude_oil', 'oil_products', 'chemical', 'gas', 'tanker_other']);

// Default per-class risk weights. Replace the old flat HAZMAT(8)/CARGO(5):
// dangerous liquids (crude/chemical/gas) score highest, dry cargo lower, and
// non-cargo hulls contribute nothing. Overridable at runtime via Settings.
const DEFAULT_CARGO_WEIGHTS = {
  crude_oil: 12,
  chemical: 12,
  gas: 12,
  oil_products: 10,
  tanker_other: 8,
  dry_bulk: 6,
  reefer: 5,
  general_cargo: 5,
  cargo_other: 5,
  container: 4,
  vehicles: 4,
  roro: 4,
  livestock: 4,
  non_cargo: 0,
  unknown: 0,
};

// ── Built-in weight presets ("classi di pesi") ───────────────────────────────
// Named cargo-weight sets the operator can apply with one click from Settings.
// `default` mirrors DEFAULT_CARGO_WEIGHTS (the all-round shipping-risk weighting).
// `arms_transport` retunes the score for monitoring weapons movements: ro-ro,
// vehicle carriers and break-bulk / container / generic cargo hulls score high
// (tanks, vehicles and crated materiel ride these), while tankers, reefers,
// livestock carriers and non-cargo hulls — which cannot plausibly carry arms —
// score zero so they drop out of the ranking.
const ARMS_TRANSPORT_WEIGHTS = {
  roro: 15,
  general_cargo: 15, // crated materiel — the most recurrent hull in real arms-shipment cases
  vehicles: 14,
  container: 13, // containerised arms / ammunition / components — common in illicit trafficking
  cargo_other: 12, // generic AIS cargo hull (unknown subtype): keep high, could be any of the above
  dry_bulk: 6, // arms concealed under bulk cargo (e.g. weapons under sacks)
  reefer: 0,
  livestock: 0,
  crude_oil: 0,
  oil_products: 0,
  chemical: 0,
  gas: 0,
  tanker_other: 0,
  non_cargo: 0,
  unknown: 0,
};

// Ordered list of built-in presets. `name` is the Italian default label; the
// frontend may translate by id (settings.cargoPresets.builtin.<id>). Built-ins
// cannot be edited or deleted — only applied (or used as the base for a
// "save as" of the live weights). User-defined presets live in the DB `meta`
// table (see services/cargo-presets.js) so they survive a backup/restore.
const BUILTIN_CARGO_PRESETS = [
  { id: 'default', name: 'Standard', builtin: true, weights: { ...DEFAULT_CARGO_WEIGHTS } },
  { id: 'arms_transport', name: 'Trasporto armi', builtin: true, weights: { ...ARMS_TRANSPORT_WEIGHTS } },
];

/** True for a cargo class that rides on a tanker hull. */
function isTankerClass(cls) {
  return TANKER_CLASSES.has(cls);
}

// Map a granular VF/MT subtype string to a merchandise class. Ordered specific →
// generic: "Chemical/Oil Products Tanker" must hit `chemical` before `oil`,
// "Crude Oil Tanker" before the generic oil rule, etc. Returns null when the
// string is present but unrecognised (caller falls back to the AIS code).
function classFromSubtype(subtype) {
  if (!subtype) return null;
  const s = String(subtype).toLowerCase();
  if (/lng|lpg|\bgas\b/.test(s)) return 'gas';
  if (/chemical/.test(s)) return 'chemical';
  if (/crude/.test(s)) return 'crude_oil';
  if (/oil|bitumen|asphalt|bunker|product.*tanker|tanker.*product/.test(s)) return 'oil_products';
  if (/container/.test(s)) return 'container';
  if (/vehicle|car carrier/.test(s)) return 'vehicles';
  if (/ro-?ro/.test(s)) return 'roro';
  if (/livestock/.test(s)) return 'livestock';
  if (/reefer|refriger/.test(s)) return 'reefer';
  if (/bulk|ore carrier|cement|aggregat|self discharg/.test(s)) return 'dry_bulk';
  // Any remaining tanker hull → generic liquid bulk.
  if (/tanker/.test(s)) return 'oil_products';
  if (/general cargo|dry storage|deck cargo|cargo ship|cargo\/|\bcargo\b/.test(s)) return 'general_cargo';
  // Non-cargo hulls (no commodity).
  if (
    /tug|tender|pilot|supply|offshore|dredg|research|survey|drill|yacht|sailing|pleasure|passenger|cruise|ferry|fishing|trawler|naval|military|patrol|sar|salvage|crane|barge|pontoon|work ?boat|service|buoy|cable|diving|icebreaker|hopper/.test(
      s
    )
  ) {
    return 'non_cargo';
  }
  return null;
}

/** Coarse class from an AIS ship-type code. Only cargo (70–79) and tanker
 * (80–89) hulls map to a cargo class; everything else is non-cargo/unknown. */
function classFromAis(code) {
  const c = Number(code);
  if (!Number.isFinite(c) || c === 0) return null;
  if (c >= 80 && c <= 89) return 'tanker_other';
  if (c >= 70 && c <= 79) return 'cargo_other';
  return 'non_cargo';
}

// Pull the granular subtype string from cached VF/MT data (flat label→value
// maps as stored in ship_scrape_cache). VF wins over MT. '-' is VF's empty marker.
function subtypeFrom(vf, mt) {
  const clean = (v) => (v && String(v).trim() && String(v).trim() !== '-' ? String(v).trim() : null);
  const v = vf && clean(vf['Ship Type']);
  if (v) return { subtype: v, source: 'VesselFinder' };
  const m = mt && clean(mt['Tipo'] ?? mt['Type'] ?? mt['Ship type']);
  if (m) return { subtype: m, source: 'MarineTraffic' };
  return null;
}

/**
 * Classify one ship's cargo type. `vf`/`mt` are the parsed (label→value) cached
 * scrape objects, or null/undefined when unavailable.
 * Returns { class, subtype, source } where:
 *   - class  : one of CARGO_CLASSES
 *   - subtype: the granular VF/MT label for display, or null
 *   - source : 'VesselFinder' | 'MarineTraffic' | 'AIS' | 'none'
 */
function cargoTypeOf(ship, vf, mt) {
  const st = subtypeFrom(vf, mt);
  if (st) {
    const cls = classFromSubtype(st.subtype) || classFromAis(ship && ship.ship_type) || 'unknown';
    return { class: cls, subtype: st.subtype, source: st.source };
  }
  const cls = classFromAis(ship && ship.ship_type);
  return { class: cls || 'unknown', subtype: null, source: cls ? 'AIS' : 'none' };
}

/**
 * Estimate current load condition from declared draught.
 * `current` is the ship's latest draught (m); `observed` an array of historical
 * draught values (m). Laden/ballast is relative to the vessel's own observed
 * range, so it needs no design-draught reference. Returns { state, ratio } with
 * state in 'laden' | 'partial' | 'ballast' | 'unknown'.
 */
function loadStateOf(current, observed) {
  const vals = (observed || []).map(Number).filter((d) => Number.isFinite(d) && d > 0);
  const cur = Number(current);
  if (!Number.isFinite(cur) || cur <= 0 || vals.length < 2) return { state: 'unknown', ratio: null };
  const min = Math.min(...vals, cur);
  const max = Math.max(...vals, cur);
  if (max - min < 0.5) return { state: 'unknown', ratio: null }; // too little variation to tell
  const ratio = Math.max(0, Math.min(1, (cur - min) / (max - min)));
  const state = ratio >= 0.66 ? 'laden' : ratio <= 0.33 ? 'ballast' : 'partial';
  return { state, ratio };
}

// Convenience resolver for routes/services: reads the cached VF/MT scrape rows
// (honouring the user's import toggles, like the risk score does) and classifies.
// db/config are lazy-required to avoid a load-time cycle — config imports this
// module for DEFAULT_CARGO_WEIGHTS, so this module must not require config at top.
function cargoTypeForShip(ship) {
  const db = require('../db');
  const { state } = require('../config');
  let vf = null;
  let mt = null;
  if (state.importVfData) {
    const r = db.getScrapedData(ship.mmsi, 'vf');
    if (r) {
      try {
        vf = JSON.parse(r.data_json);
      } catch {
        /* corrupt cache row */
      }
    }
  }
  if (state.importMtData) {
    const r = db.getScrapedData(ship.mmsi, 'mt');
    if (r) {
      try {
        mt = JSON.parse(r.data_json);
      } catch {
        /* corrupt cache row */
      }
    }
  }
  return cargoTypeOf(ship, vf, mt);
}

module.exports = {
  CARGO_CLASSES,
  DEFAULT_CARGO_WEIGHTS,
  ARMS_TRANSPORT_WEIGHTS,
  BUILTIN_CARGO_PRESETS,
  isTankerClass,
  classFromSubtype,
  classFromAis,
  cargoTypeOf,
  cargoTypeForShip,
  loadStateOf,
};
