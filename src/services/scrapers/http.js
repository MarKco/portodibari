'use strict';

const https = require('https');
const { curly } = require('node-libcurl');

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Small pool of realistic recent desktop UAs. fetchHttp/fetchViaCurl pick one at
// random per request instead of always sending the exact same string — a cheap
// anti-fingerprinting measure for fallback-mode's higher scrape volume (see
// services/fallback-mode.js). BROWSER_UA itself stays the fixed default for
// low-volume on-demand callers (e.g. equasis.js) that don't need rotation.
const UA_POOL = [
  BROWSER_UA,
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];
function pickUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

/** Parse a Retry-After header (seconds or HTTP-date) into a millisecond delay, or null. */
function parseRetryAfter(value) {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** Classify a fetch failure for backoff/circuit-breaker decisions (status-code-aware). */
function classifyFailure(err) {
  const status = (err && err.status) || null;
  return { status, isBlocked: status === 403, isRateLimited: status === 429, retryAfterMs: (err && err.retryAfterMs) || null };
}

// A ship details page is a few hundred KB at most; this is a generous cap
// against a runaway/anti-bot response, not a realistic expectation.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// `timeout` below only measures socket INACTIVITY: a slow drip that keeps
// sending a few bytes just often enough never goes idle long enough to trip
// it, and `body +=` would grow unbounded on a ~256MB heap. This is a hard
// deadline on the whole request regardless of activity.
const ABS_DEADLINE_MS = 20000;

/** GET a URL over HTTPS, following up to 3 redirects, returning the body text. */
function fetchHttp(url, depth = 0) {
  if (depth > 3) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': pickUA(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
      },
      timeout: 12000,
    };
    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        // Resolve the Location against the current URL — VesselFinder redirects
        // unknown vessels to a *relative* path (e.g. "/vessels"), which would
        // otherwise throw "Invalid URL" when re-parsed without a base.
        const next = new URL(res.headers.location, url).href;
        fetchHttp(next, depth + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error(`HTTP ${res.statusCode}`);
        err.status = res.statusCode;
        err.retryAfterMs = parseRetryAfter(res.headers['retry-after']);
        reject(err);
        return;
      }
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > MAX_BODY_BYTES) {
          req.destroy(new Error('Response body too large'));
          return;
        }
        body += chunk;
      });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    const deadline = setTimeout(() => req.destroy(new Error('Deadline exceeded')), ABS_DEADLINE_MS);
    req.on('close', () => clearTimeout(deadline));
    req.end();
  });
}

// MarineTraffic sits behind Cloudflare, which fingerprints the TLS ClientHello
// (JA3/JA4) and blocks Node's https/http2 clients with 403 regardless of headers.
// libcurl's TLS stack passes, so MT requests go through node-libcurl (which
// bundles its own libcurl — no system `curl` binary needed on the deploy host).
function fetchViaCurl(url, extraHeaders = {}) {
  const httpHeader = Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`);
  return curly
    .get(url, {
      followLocation: true,
      maxRedirs: 3,
      acceptEncoding: '', // --compressed: accept any encoding libcurl can decode
      timeout: 12,
      userAgent: pickUA(),
      httpHeader,
      curlyResponseBodyParser: false, // keep the body a raw Buffer; callers parse it
    })
    .then(({ statusCode, data, headers }) => {
      if (statusCode !== 200) {
        const err = new Error(`HTTP ${statusCode}`);
        err.status = statusCode;
        const h = (Array.isArray(headers) ? headers[headers.length - 1] : headers) || {};
        err.retryAfterMs = parseRetryAfter(h['retry-after'] || h['Retry-After']);
        throw err;
      }
      return data.toString('utf8');
    });
}

/** Strip HTML tags and decode the most common entities to plain text. */
function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Best-effort extraction of ship attributes from a details page: Open Graph
 * photo/title, plus any `<tr><td>label</td><td>value</td></tr>` or
 * `<dt>/<dd>` key/value pairs.
 */
function parseShipHtml(html) {
  const r = {};

  const ogImg =
    html.match(/property="og:image"\s+content="([^"]+)"/i) ||
    html.match(/content="([^"]+)"\s+property="og:image"/i);
  if (ogImg) r._photo = ogImg[1];

  const ogTitle =
    html.match(/property="og:title"\s+content="([^"]+)"/i) ||
    html.match(/content="([^"]+)"\s+property="og:title"/i);
  if (ogTitle) r._pageTitle = ogTitle[1];

  // Table rows: each <tr> with two <td> cells
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(html)) !== null) {
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let td;
    while ((td = tdRe.exec(tr[1])) !== null) tds.push(stripHtml(td[1]));
    if (tds.length >= 2) {
      const label = tds[0].replace(/:$/, '').trim();
      const value = tds[1].trim();
      if (label && value && label.length < 60 && value.length < 300 && !label.includes('\n')) {
        r[label] = value;
      }
    }
  }

  // Definition list pattern
  const dtRe = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let dt;
  while ((dt = dtRe.exec(html)) !== null) {
    const label = stripHtml(dt[1]).replace(/:$/, '').trim();
    const value = stripHtml(dt[2]).trim();
    if (label && value && label.length < 60 && value.length < 300) {
      r[label] = value;
    }
  }

  return r;
}

module.exports = { BROWSER_UA, pickUA, classifyFailure, fetchHttp, fetchViaCurl, stripHtml, parseShipHtml };
