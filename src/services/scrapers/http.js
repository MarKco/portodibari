'use strict';

const https = require('https');
const { execFile } = require('child_process');

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
        'User-Agent': BROWSER_UA,
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
        fetchHttp(res.headers.location, depth + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

// MarineTraffic sits behind Cloudflare, which fingerprints the TLS ClientHello
// (JA3/JA4) and blocks Node's https/http2 clients with 403 regardless of headers.
// curl's TLS stack passes, so MT requests are made through a curl subprocess.
function fetchViaCurl(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-S', '-L', '--compressed', '-m', '12', '-A', BROWSER_UA];
    for (const [k, v] of Object.entries(extraHeaders)) args.push('-H', `${k}: ${v}`);
    args.push('-w', '\n%{http_code}', url);
    execFile('curl', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl: ${err.message}`));
      const nl = stdout.lastIndexOf('\n');
      const code = Number(stdout.slice(nl + 1).trim());
      const body = stdout.slice(0, nl);
      if (code !== 200) return reject(new Error(`HTTP ${code}`));
      resolve(body);
    });
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

module.exports = { BROWSER_UA, fetchHttp, fetchViaCurl, stripHtml, parseShipHtml };
