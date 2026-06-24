// Compact, server-side vessel formatting for notifications (Telegram captions).
// Two helpers: a flag emoji derived from the MMSI's MID, and a short localized
// ship-type label. Both are deliberately dependency-free and string-only so the
// Telegram sender can drop them into a caption without extra DB reads.

// ── Flag from MID ────────────────────────────────────────────────────────────
// The first 3 digits of a 9-digit MMSI are the Maritime Identification Digits
// (MID) = the declared flag state (ITU table). This is the same signal the risk
// score uses (EMBARGO_MID/FOC_MID) — here mapped to an ISO-3166 alpha-2 so we
// can render the regional-indicator flag emoji. Covers the European/Med basin,
// the major flag states and all flags of convenience; unknown MIDs render no
// flag (caption simply omits it).
const MID_ISO = {
  201: 'AL', 202: 'AD', 203: 'AT', 204: 'PT', 205: 'BE', 206: 'BY', 207: 'BG',
  208: 'VA', 209: 'CY', 210: 'CY', 211: 'DE', 212: 'CY', 213: 'GE', 214: 'MD',
  215: 'MT', 216: 'AM', 218: 'DE', 219: 'DK', 220: 'DK', 224: 'ES', 225: 'ES',
  226: 'FR', 227: 'FR', 228: 'FR', 230: 'FI', 231: 'FO', 232: 'GB', 233: 'GB',
  234: 'GB', 235: 'GB', 236: 'GI', 237: 'GR', 238: 'HR', 239: 'GR', 240: 'GR',
  241: 'GR', 242: 'MA', 243: 'HU', 244: 'NL', 245: 'NL', 246: 'NL', 247: 'IT',
  248: 'MT', 249: 'MT', 250: 'IE', 251: 'IS', 252: 'LI', 253: 'LU', 254: 'MC',
  255: 'PT', 256: 'MT', 257: 'NO', 258: 'NO', 259: 'NO', 261: 'PL', 262: 'ME',
  263: 'PT', 264: 'RO', 265: 'SE', 266: 'SE', 267: 'SK', 268: 'SM', 269: 'CH',
  270: 'CZ', 271: 'TR', 272: 'UA', 273: 'RU', 274: 'MK', 275: 'LV', 276: 'EE',
  277: 'LT', 278: 'SI', 279: 'RS',
  301: 'AI', 303: 'US', 304: 'AG', 305: 'AG', 306: 'CW', 307: 'AW', 308: 'BS',
  309: 'BS', 310: 'BM', 311: 'BS', 312: 'BZ', 314: 'BB', 316: 'CA', 319: 'KY',
  321: 'CR', 323: 'CU', 325: 'DM', 327: 'DO', 329: 'GP', 330: 'GD', 331: 'GL',
  332: 'GT', 334: 'HN', 336: 'HT', 338: 'US', 339: 'JM', 341: 'KN', 343: 'LC',
  345: 'MX', 347: 'MQ', 348: 'MS', 350: 'NI', 351: 'PA', 352: 'PA', 353: 'PA',
  354: 'PA', 355: 'PA', 356: 'PA', 357: 'PA', 358: 'PR', 359: 'SV', 361: 'PM',
  362: 'TT', 364: 'TC', 366: 'US', 367: 'US', 368: 'US', 369: 'US', 370: 'PA',
  371: 'PA', 372: 'PA', 373: 'PA', 374: 'PA', 375: 'VC', 376: 'VC', 377: 'VC',
  378: 'VG', 379: 'VI',
  401: 'AF', 403: 'SA', 405: 'BD', 408: 'BH', 410: 'BT', 412: 'CN', 413: 'CN',
  414: 'CN', 416: 'TW', 417: 'LK', 419: 'IN', 422: 'IR', 423: 'AZ', 425: 'IQ',
  428: 'IL', 431: 'JP', 432: 'JP', 434: 'TM', 436: 'KZ', 437: 'UZ', 438: 'JO',
  440: 'KR', 441: 'KR', 443: 'PS', 445: 'KP', 447: 'KW', 450: 'LB', 451: 'KG',
  453: 'MO', 455: 'MV', 457: 'MN', 459: 'NP', 461: 'OM', 463: 'PK', 466: 'QA',
  468: 'SY', 470: 'AE', 471: 'AE', 472: 'TJ', 473: 'YE', 475: 'YE', 477: 'HK',
  478: 'BA',
  501: 'FR', 503: 'AU', 506: 'MM', 508: 'BN', 510: 'FM', 511: 'PW', 512: 'NZ',
  514: 'KH', 515: 'KH', 516: 'CX', 518: 'CK', 520: 'FJ', 523: 'CC', 525: 'ID',
  529: 'KI', 531: 'LA', 533: 'MY', 536: 'MP', 538: 'MH', 540: 'NC', 542: 'NU',
  544: 'NR', 546: 'PF', 548: 'PH', 553: 'PG', 555: 'PN', 557: 'SB', 559: 'AS',
  561: 'WS', 563: 'SG', 564: 'SG', 565: 'SG', 566: 'SG', 567: 'TH', 570: 'TO',
  572: 'TV', 574: 'VN', 576: 'VU', 577: 'VU', 578: 'WF',
  601: 'ZA', 603: 'AO', 605: 'DZ', 607: 'FR', 608: 'GB', 609: 'BI', 610: 'CM',
  611: 'CD', 612: 'CF', 613: 'CG', 615: 'CG', 616: 'KM', 617: 'CV', 618: 'FR',
  619: 'CI', 620: 'KM', 621: 'DJ', 622: 'EG', 624: 'ET', 625: 'ER', 626: 'GA',
  627: 'GH', 629: 'GM', 630: 'GW', 631: 'GQ', 632: 'GN', 633: 'BF', 634: 'KE',
  635: 'FR', 636: 'LR', 637: 'LR', 638: 'SS', 642: 'LY', 644: 'LS', 645: 'MU',
  647: 'MG', 649: 'ML', 650: 'MZ', 654: 'MR', 655: 'MW', 656: 'NE', 657: 'NG',
  659: 'NA', 660: 'RE', 661: 'RW', 662: 'SD', 663: 'SN', 664: 'SC', 665: 'SH',
  666: 'SO', 667: 'SL', 668: 'ST', 669: 'SZ', 670: 'TD', 671: 'TG', 672: 'TN',
  674: 'TZ', 675: 'UG', 676: 'CD', 677: 'TZ', 678: 'ZM', 679: 'ZW',
  701: 'AR', 710: 'BR', 720: 'BO', 725: 'CL', 730: 'CO', 735: 'EC', 740: 'FK',
  745: 'GF', 750: 'GY', 755: 'PY', 760: 'PE', 765: 'SR', 770: 'UY', 775: 'VE',
};

// Returns "<flag emoji> " (with trailing space) for a vessel's MMSI, or '' when
// the MID is unknown / the MMSI is malformed.
function flagEmoji(mmsi) {
  const n = Number(mmsi);
  if (!Number.isFinite(n) || n < 100000000) return '';
  const iso = MID_ISO[Math.floor(n / 1e6)];
  if (!iso) return '';
  return String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) + ' ';
}

// ── Ship-type label ──────────────────────────────────────────────────────────
// Mirrors public/js/helpers.js SHIP_TYPE_KEYS, but server-side and with literal
// strings (no i18n runtime here). Returns a short label or '' when the type is
// undefined/not-available (so the caption can omit it).
const TYPE_IT = {
  wig: 'WIG', fishing: 'Peschereccio', towing: 'Rimorchio', dredging: 'Draga',
  diving: 'Immersione', military: 'Militare', sailing: 'Vela', pleasure: 'Diporto',
  pilot: 'Pilotina', sar: 'SAR', tug: 'Rimorchiatore', port: 'Servizio porto',
  antipollution: 'Antinquinamento', coastguard: 'Guardia costiera', medical: 'Nave medica',
  special: 'Speciale', cargo: 'Cargo', tanker: 'Tanker', highSpeed: 'Alta velocità',
  passenger: 'Passeggeri', other: 'Altro',
};
const TYPE_EN = {
  wig: 'WIG', fishing: 'Fishing', towing: 'Towing', dredging: 'Dredging',
  diving: 'Diving', military: 'Military', sailing: 'Sailing', pleasure: 'Pleasure',
  pilot: 'Pilot', sar: 'SAR', tug: 'Tug', port: 'Port service',
  antipollution: 'Anti-pollution', coastguard: 'Coastguard', medical: 'Medical',
  special: 'Special', cargo: 'Cargo', tanker: 'Tanker', highSpeed: 'High-speed',
  passenger: 'Passenger', other: 'Other',
};

function typeKey(code) {
  if (code == null) return null;
  if (code === 0) return null; // not available
  if (code >= 20 && code <= 29) return 'wig';
  if (code === 30) return 'fishing';
  if (code === 31 || code === 32) return 'towing';
  if (code === 33) return 'dredging';
  if (code === 34) return 'diving';
  if (code === 35) return 'military';
  if (code === 36) return 'sailing';
  if (code === 37) return 'pleasure';
  if (code >= 40 && code <= 49) return 'highSpeed';
  if (code === 50) return 'pilot';
  if (code === 51) return 'sar';
  if (code === 52) return 'tug';
  if (code === 53) return 'port';
  if (code === 54) return 'antipollution';
  if (code === 55) return 'coastguard';
  if (code === 58) return 'medical';
  if (code === 59) return 'special';
  if (code >= 60 && code <= 69) return 'passenger';
  if (code >= 70 && code <= 79) return 'cargo';
  if (code >= 80 && code <= 89) return 'tanker';
  if (code >= 90 && code <= 99) return 'other';
  return null;
}

// Hazmat-carrying cargo/tanker subtypes (A–D) → flagged with ☢ like the web UI.
function isHazmat(code) {
  return (code >= 71 && code <= 74) || (code >= 81 && code <= 84);
}

function shipTypeLabel(code, lang) {
  const key = typeKey(code);
  if (!key) return '';
  const label = (lang === 'en' ? TYPE_EN : TYPE_IT)[key] || '';
  if (!label) return '';
  return isHazmat(code) ? `☢ ${label}` : label;
}

module.exports = { flagEmoji, shipTypeLabel };
