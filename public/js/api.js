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
  // Session expired / not logged in → bounce to the login page.
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('HTTP 401');
  }
  if (!res.ok) {
    // Surface the server's {error} message when present (e.g. validation),
    // falling back to the status code. Callers that ignore the message are
    // unaffected.
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
  return res.json();
}
