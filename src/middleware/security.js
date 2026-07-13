'use strict';

// Defense-in-depth HTTP hardening: security response headers + a CSRF
// origin check on state-changing requests. Both are deliberately dependency-free
// (no helmet) to match the project's lightweight middleware style.

// Content-Security-Policy. The allowlist mirrors the origins the app actually
// uses today: Leaflet + its marker images from unpkg, OSM/OpenSeaMap raster
// tiles, Google Fonts, and the Overpass API queried client-side by seamarks.js.
//
// NOTE: 'unsafe-inline' is currently required on script-src/style-src because
// index.html and the login page ship inline <script>/<style> blocks and a few
// inline event handlers. Removing it (and the unpkg entries) depends on
// self-hosting Leaflet and de-inlining those scripts — tracked as a later
// hardening batch. Even with 'unsafe-inline', this CSP still blocks framing
// (clickjacking), plugin/object embedding, <base> hijacking, and script/connect
// to any non-allowlisted origin.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https://unpkg.com https://*.tile.openstreetmap.org https://tiles.openseamap.org",
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://overpass-api.de",
  "worker-src 'self'",
].join('; ');

/**
 * Set security headers on every response. Mounted first, so it also covers the
 * login page, static assets and the service worker. HSTS is only emitted over
 * HTTPS (req.secure reflects X-Forwarded-Proto behind the trusted proxy) so it
 * never pins a plain-HTTP deploy.
 */
function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // NOT 'no-referrer': OpenStreetMap's volunteer tile servers reject requests
  // without a Referer (403). This still strips the path and never leaks the
  // referrer to less-secure (HTTP) destinations, but sends the origin so the
  // OSM/OpenSeaMap tiles keep loading.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/** The host the request was addressed to, honoring the reverse proxy. */
function requestHost(req) {
  const fwd = req.headers['x-forwarded-host'];
  const raw = (fwd || req.headers.host || '').split(',')[0].trim();
  return raw.toLowerCase();
}

/**
 * CSRF guard for state-changing requests. Complements the SameSite=Lax cookie
 * and the application/json-only body parser: a cross-site POST/PATCH/DELETE from
 * a browser always carries an Origin (and usually a Referer) that will not match
 * our host, so we reject it. Requests with neither header are let through — a
 * browser cannot omit Origin on a cross-origin state change, so those are
 * same-origin XHR or non-browser clients, already covered by SameSite.
 */
function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const host = requestHost(req);
  const source = req.headers.origin || req.headers.referer;
  if (source) {
    let ok = false;
    try {
      ok = new URL(source).host.toLowerCase() === host;
    } catch {
      ok = false;
    }
    if (!ok) {
      return res.status(403).json({ error: 'Richiesta cross-origin rifiutata (CSRF)' });
    }
  }
  next();
}

module.exports = { securityHeaders, csrfGuard };
