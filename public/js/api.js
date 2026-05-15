// Thin fetch wrapper for the JSON API.
import { lang } from './i18n.js';

export async function api(path, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (method === 'GET') {
    path += (path.includes('?') ? '&' : '?') + `lang=${lang}`;
  }
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
