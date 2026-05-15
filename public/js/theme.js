// Theme switching — persisted in localStorage, applied to <html data-theme>.
// The pre-paint script in index.html sets the initial value; this only wires
// the toggle button and keeps the stored value in sync.

const STORAGE_KEY = 'theme';

function current() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function apply(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — runtime only */
  }
}

export function initTheme() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    apply(current() === 'light' ? 'dark' : 'light');
  });
}
