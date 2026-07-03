// Pure formatting, labelling and escaping helpers. No app state, no DOM.

import { t, DATE_LOCALE } from './i18n.js';

export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return (
      d.toLocaleTimeString(DATE_LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
      ' ' +
      d.toLocaleDateString(DATE_LOCALE, { day: '2-digit', month: '2-digit', year: '2-digit' })
    );
  } catch {
    return iso;
  }
}

// Coarse "time since" label that auto-upgrades its unit: minutes < 1h, hours
// < 1 day, days < 1 week, then weeks. Used for the "AIS signal lost X ago"
// badge on followed ships. Returns localized, pluralized text (it/en).
export function formatAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return t('ago.now');
  const min = Math.floor(ms / 60000);
  if (min < 60) return t(min === 1 ? 'ago.min1' : 'ago.minN', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t(h === 1 ? 'ago.hour1' : 'ago.hourN', { n: h });
  const d = Math.floor(h / 24);
  if (d < 7) return t(d === 1 ? 'ago.day1' : 'ago.dayN', { n: d });
  const w = Math.floor(d / 7);
  return t(w === 1 ? 'ago.week1' : 'ago.weekN', { n: w });
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function fmtUptime(sec) {
  if (!sec) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', `${s}s`].filter(Boolean).join(' ');
}

export function shortType(t_) {
  const map = {
    PositionReport: 'PosReport',
    ShipStaticData: 'StaticData',
    ExtendedClassBPositionReport: 'Ext.ClassB',
    StandardClassBPositionReport: 'Std.ClassB',
  };
  return map[t_] || t_;
}

const NAV_STATUS_KEYS = {
  0: 'ns.0', 1: 'ns.1', 2: 'ns.2', 3: 'ns.3',
  4: 'ns.4', 5: 'ns.5', 6: 'ns.6', 7: 'ns.7',
  8: 'ns.8', 15: 'ns.15',
};
export function navStatus(s) {
  if (s == null) return '—';
  const key = NAV_STATUS_KEYS[s];
  if (key) return t(key);
  return t('ns.unknown', { n: s });
}

const DIR_KEYS = {
  entrata: ['dir-in',    'dir.in'],
  uscita:  ['dir-out',   'dir.out'],
  ferma:   ['dir-still', 'dir.still'],
};
export function directionBadge(dir) {
  if (!dir) return '<span class="dir-badge dir-unknown">—</span>';
  const [cls, key] = DIR_KEYS[dir] || ['dir-unknown', null];
  return `<span class="dir-badge ${cls}">${key ? t(key) : escHtml(dir)}</span>`;
}

const SHIP_TYPE_KEYS = {
  0: 'type.nd',
  20: 'type.wig', 21: 'type.wig', 22: 'type.wig', 23: 'type.wig', 24: 'type.wig',
  25: 'type.wig', 26: 'type.wig', 27: 'type.wig', 28: 'type.wig', 29: 'type.wig',
  30: 'type.fishing', 31: 'type.towing', 32: 'type.towing',
  33: 'type.dredging', 34: 'type.diving', 35: 'type.military',
  36: 'type.sailing', 37: 'type.pleasure', 38: 'type.reserved', 39: 'type.reserved',
  50: 'type.pilot', 51: 'type.sar', 52: 'type.tug', 53: 'type.port',
  54: 'type.antipollution', 55: 'type.coastguard', 58: 'type.medical', 59: 'type.special',
  70: 'type.cargo',
  71: 'type.cargoA', 72: 'type.cargoB', 73: 'type.cargoC', 74: 'type.cargoD',
  75: 'type.cargo', 76: 'type.cargo', 77: 'type.cargo', 78: 'type.cargo', 79: 'type.cargo',
  80: 'type.tanker',
  81: 'type.tankerA', 82: 'type.tankerB', 83: 'type.tankerC', 84: 'type.tankerD',
  85: 'type.tanker', 86: 'type.tanker', 87: 'type.tanker', 88: 'type.tanker', 89: 'type.tanker',
};
export function shipTypeLabel(code) {
  if (code == null) return '—';
  if (SHIP_TYPE_KEYS[code]) return t(SHIP_TYPE_KEYS[code]);
  if (code >= 40 && code <= 49) return t('type.highSpeed');
  if (code >= 60 && code <= 69) return t('type.passenger');
  if (code >= 90 && code <= 99) return t('type.other');
  return t('type.unknown', { code });
}

export function isHazmat(code) {
  return (code >= 71 && code <= 74) || (code >= 81 && code <= 84);
}

// Hover-explainer "ⓘ" icon. Shares markup + the global tooltip handler with the
// Equasis icons (main.js: initGlossaryTooltip). Empty `def` → no icon.
export function infoIcon(term, def) {
  if (!def) return '';
  return ` <span class="eq-info" data-term="${escHtml(term)}" data-tip="${escHtml(def)}" aria-label="${escHtml(term)}: ${escHtml(def)}" role="img">ⓘ</span>`;
}

// Plain-language explanation for an AIS ship-type code (e.g. what "Hazmat A"
// means). Derived from the type's i18n key + ".help"; returns '' when no help
// string is defined for that type, so the icon only appears where it adds value.
export function shipTypeHelpText(code) {
  if (code == null) return '';
  let baseKey = SHIP_TYPE_KEYS[code];
  if (!baseKey) {
    if (code >= 40 && code <= 49) baseKey = 'type.highSpeed';
    else if (code >= 60 && code <= 69) baseKey = 'type.passenger';
    else if (code >= 90 && code <= 99) baseKey = 'type.other';
  }
  if (!baseKey) return '';
  const helpKey = baseKey + '.help';
  const txt = t(helpKey);
  return txt === helpKey ? '' : txt;
}

export function shipTypeBadge(code) {
  const label = shipTypeLabel(code);
  const help = infoIcon(label, shipTypeHelpText(code));
  if (isHazmat(code)) return `<span class="hazmat-badge">☢ ${label}</span>${help}`;
  return `${label}${help}`;
}

// ── Cargo type (merchandise class) ─────────────────────────────────────────────
// Translated label for a cargo class key (from cargo-type.js on the server).
export function cargoClassLabel(cls) {
  return cls ? t('cargo.' + cls) : '—';
}

// Plain-language explanation of a cargo class (what the merchandise category
// actually is). Returns '' when no help string is defined for that class.
export function cargoClassHelpText(cls) {
  if (!cls) return '';
  const key = 'cargo.help.' + cls;
  const txt = t(key);
  return txt === key ? '' : txt;
}

// Detail-view cell for a ship's cargo type: the granular VF/MT subtype when
// available, else the translated class, plus the source (when not the coarse AIS
// fallback). `cargo` is the { class, subtype, source } object from the risk result.
export function cargoTypeHtml(cargo) {
  if (!cargo || !cargo.class || cargo.class === 'unknown') return '—';
  const main = cargo.subtype ? escHtml(cargo.subtype) : cargoClassLabel(cargo.class);
  const src = cargo.source && cargo.source !== 'AIS' && cargo.source !== 'none'
    ? ` <span class="cargo-src">(${t('cargo.src', { src: cargo.source })})</span>`
    : '';
  const help = infoIcon(cargoClassLabel(cargo.class), cargoClassHelpText(cargo.class));
  return `${main}${src}${help}`;
}

// Load condition badge (laden / ballast / …), estimated from draught.
export function loadStateHtml(stateKey) {
  if (!stateKey || stateKey === 'unknown') return '—';
  return `<span class="load-badge load-${stateKey}">${t('load.' + stateKey)}</span> <span class="cargo-src">(${t('load.estimated')})</span>`;
}

// ── Risk score ───────────────────────────────────────────────────────────────
export function riskClass(score) {
  if (score == null) return 'risk-na';
  if (score <= 30) return 'risk-low';
  if (score <= 70) return 'risk-med';
  return 'risk-high';
}

function riskSrcDot(sources) {
  if (!sources) return '';
  const { vf, mt, gfw, sanctions } = sources;
  // Sanctions screening shown as its own dot (strongest signal) before VF/MT.
  let out = '';
  if (sanctions && sanctions !== 'none') {
    const used = sanctions === 'used';
    out += `<span class="risk-src-dot src-sanction${!used ? ' src-dim' : ''}" title="${used ? t('risk.src.sanction') : t('risk.src.sanctionDim')}"></span>`;
  }
  const vfOn = vf && vf !== 'none';
  const mtOn = mt && mt !== 'none';
  const vfUsed = vf === 'used', mtUsed = mt === 'used';
  if (vfOn && mtOn)
    out += `<span class="risk-src-dot src-both${(!vfUsed && !mtUsed) ? ' src-dim' : ''}" title="${(!vfUsed && !mtUsed) ? t('risk.src.bothDim') : t('risk.src.both')}"></span>`;
  else if (vfOn)
    out += `<span class="risk-src-dot src-vf${!vfUsed ? ' src-dim' : ''}" title="${!vfUsed ? t('risk.src.vfDim') : t('risk.src.vf')}"></span>`;
  else if (mtOn)
    out += `<span class="risk-src-dot src-mt${!mtUsed ? ' src-dim' : ''}" title="${!mtUsed ? t('risk.src.mtDim') : t('risk.src.mt')}"></span>`;
  const gfwOn = gfw && gfw !== 'none';
  if (gfwOn) {
    const gfwUsed = gfw === 'used';
    out += `<span class="risk-src-dot src-gfw${!gfwUsed ? ' src-dim' : ''}" title="${!gfwUsed ? t('risk.src.gfwDim') : t('risk.src.gfw')}"></span>`;
  }
  return out;
}

export function riskBadge(risk) {
  if (!risk || risk.score == null) return '<span class="risk-badge risk-na">—</span>';
  const data = escHtml(JSON.stringify({ score: risk.score, band: risk.band, factors: risk.factors || [], sources: risk.sources || {} }));
  return `<span class="risk-badge ${riskClass(risk.score)}" data-risk="${data}">${riskSrcDot(risk.sources)}${risk.score}</span>`;
}

const HTTP_STATUS = {
  200: 'OK', 201: 'Created', 204: 'No data',
  301: 'Moved', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict',
  410: 'Gone', 422: 'Unprocessable', 429: 'Too Many Requests',
  500: 'Server Error', 502: 'Bad Gateway', 503: 'Unavailable', 504: 'Timeout',
};
export function statusLabel(s) {
  if (s == null) return '—';
  const label = HTTP_STATUS[s];
  return label ? `${s} ${label}` : String(s);
}

export function formatJson(str) {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

const API_KEY_RE = /[0-9a-f]{40}/gi;
export function maskSecrets(str) {
  return str.replace(API_KEY_RE, '***masked***');
}

/** Great-circle distance in metres between two lat/lon points. */
export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
