'use strict';

// ESLint flat config (ESLint v9+). Two zones: Node/CommonJS backend in src/,
// browser/ESM frontend in public/js/.

const NODE_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  fetch: 'readonly', // global since Node 18 (engines require >=22.5.0)
  AbortController: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  console: 'readonly',
  localStorage: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  EventSource: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  performance: 'readonly',
  ResizeObserver: 'readonly',
  L: 'readonly', // Leaflet (loaded from CDN)
};

const COMMON_RULES = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^req$|^res$|^next$' }],
  'no-undef': 'error',
  'prefer-const': 'warn',
  eqeqeq: ['warn', 'smart'],
};

module.exports = [
  { ignores: ['node_modules/**', 'ais_data.db*', '*.zip'] },
  {
    files: ['src/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: NODE_GLOBALS },
    rules: COMMON_RULES,
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: BROWSER_GLOBALS },
    rules: COMMON_RULES,
  },
];
