'use strict';

const fs = require('fs');

/**
 * Stream a raw request body straight to `tmpPath`, never buffering the whole
 * upload in the process heap. express.raw() (the previous approach on these
 * routes) buffers the ENTIRE body into one same-sized Buffer before the
 * handler even runs — on a ~256MB heap, an upload of a few hundred MB (well
 * under a generous configured cap) is already enough to OOM, and the
 * subsequent fs.writeFileSync of that same buffer briefly doubles the peak.
 *
 * Enforces `maxBytes` incrementally as chunks arrive (destroying the request
 * and the partial file the moment the running total goes over, rather than
 * accumulating the whole thing first). On overage or a client-aborted upload
 * this already sends the error response and cleans up the temp file — the
 * caller only needs to check the resolved value and return if false.
 *
 * Resolves `true` once the file is fully written, `false` if the upload was
 * rejected (response already sent, temp file already removed). Rejects only
 * on an unexpected filesystem error.
 */
function streamUploadToFile(req, res, tmpPath, maxBytes) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    let bytes = 0;
    let settled = false;

    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      req.unpipe(out);
      req.destroy();
      out.destroy();
      fs.unlink(tmpPath, () => {});
      if (!res.headersSent) res.status(status).json({ error: message });
      resolve(false);
    };

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) fail(413, 'File troppo grande');
    });
    req.on('aborted', () => fail(400, 'Upload interrotto'));
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    out.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    out.on('finish', () => {
      if (!settled) { settled = true; resolve(true); }
    });
    req.pipe(out);
  });
}

module.exports = { streamUploadToFile };
