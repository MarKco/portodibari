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
      d.toLocaleDateString(DATE_LOCALE, { day: '2-digit', month: '2-digit' })
    );
  } catch {
    return iso;
  }
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

export function shipTypeBadge(code) {
  const label = shipTypeLabel(code);
  if (isHazmat(code)) return `<span class="hazmat-badge">☢ ${label}</span>`;
  return label;
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
