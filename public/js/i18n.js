// i18n engine — language selection, translation lookup, DOM application.
// Language is stored in localStorage key 'lang'. Default: 'it'.
// On change: setLang() saves to localStorage and reloads the page.

import it from '../locales/it.js';
import en from '../locales/en.js';

const LANGS = { it, en };

export const SUPPORTED_LANGS = ['it', 'en'];
export const LANG_NAMES = { it: 'Italiano', en: 'English' };

// Date locale string for use in toLocaleTimeString / toLocaleDateString.
const DATE_LOCALES = { it: 'it-IT', en: 'en-GB' };

const _lang = (() => {
  const saved = localStorage.getItem('lang');
  return LANGS[saved] ? saved : 'it';
})();

export const lang = _lang;
export const DATE_LOCALE = DATE_LOCALES[_lang] || 'it-IT';

const strings = LANGS[_lang] || LANGS.it;
const fallback = LANGS.it;

/**
 * Translate a key. Optional vars object replaces {placeholder} tokens.
 * Falls back to Italian, then to the raw key if not found.
 */
export function t(key, vars) {
  let s = strings[key] ?? fallback[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : `{${k}}`));
  return s;
}

/** Change the active language and reload. */
export function setLang(newLang) {
  if (!LANGS[newLang]) return;
  localStorage.setItem('lang', newLang);
  location.reload();
}

/** Return the current language code. */
export function getLang() {
  return _lang;
}

/**
 * Apply translations to the DOM via data attributes.
 * Call once after DOMContentLoaded (or at module load time in a deferred script).
 *
 *   data-i18n="key"              → element.textContent
 *   data-i18n-html="key"         → element.innerHTML  (use sparingly)
 *   data-i18n-title="key"        → element.title
 *   data-i18n-aria="key"         → element.setAttribute('aria-label', …)
 *   data-i18n-placeholder="key"  → element.placeholder
 */
export function applyToDOM() {
  document.documentElement.lang = _lang;

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}
