'use strict';

const db = require('../db');
const { broadcastLog } = require('../realtime');
const { MAX_BODY } = require('../config');

// Paths (relative to the /api mount) whose request/response bodies must NOT be
// persisted: they carry sensitive content (Equasis ownership data) or bulky
// payloads (base64 databases in backup/restore/bundle). The log line itself
// (method, path, status, duration) is still recorded — only the bodies are
// dropped, so the audit trail stays without leaking/bloating.
const NO_BODY_LOG = /^\/(equasis-log|bundle|restore|backups|settings)\b/;

// Records every /api request (method, path, status, duration, bodies) to the
// api_log table and broadcasts it to the live SSE log stream. The log stream
// endpoint itself is skipped to avoid logging the long-lived connection.
function apiLogger(req, res, next) {
  if (req.path === '/logs/stream') return next();

  const start = Date.now();
  const captureBodies = !NO_BODY_LOG.test(req.path);
  const reqBody =
    captureBodies && req.body && Object.keys(req.body).length
      ? JSON.stringify(req.body).slice(0, MAX_BODY)
      : null;

  let resBody = null;
  const origJson = res.json.bind(res);
  res.json = (data) => {
    if (captureBodies) resBody = JSON.stringify(data).slice(0, MAX_BODY);
    return origJson(data);
  };

  res.on('finish', () => {
    const entry = db.insertLog({
      method: req.method,
      path: req.originalUrl.slice(0, 200),
      status: res.statusCode,
      duration_ms: Date.now() - start,
      request_body: reqBody,
      response_body: resBody,
    });
    broadcastLog(entry);
  });

  next();
}

module.exports = apiLogger;
