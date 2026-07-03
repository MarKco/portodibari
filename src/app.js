'use strict';

const path = require('path');
const express = require('express');
const apiLogger = require('./middleware/api-logger');
const sessionAuth = require('./middleware/session-auth');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const heatmapRoutes = require('./routes/heatmap');
const heatmapPublicRoutes = require('./routes/heatmap-public');
const apiRoutes = require('./routes');
const { setUiLang } = require('./config');

/** Build and return the configured Express application. */
function createApp() {
  const app = express();
  // Behind a reverse proxy: trust X-Forwarded-* so req.ip / secure cookies work.
  app.set('trust proxy', true);

  app.use(express.json());

  // Resolve the session cookie → req.user on every request (never blocks).
  app.use(sessionAuth.attachUser);

  // Mirror the browser's active language (sent as ?lang= on every API call) so
  // the operational log — including background events with no request — writes
  // in whatever language the app is currently showing.
  app.use('/api', (req, res, next) => {
    if (req.query.lang) setUiLang(req.query.lang);
    next();
  });

  // Log + broadcast every API call (auth endpoints included; their bodies are
  // suppressed by the logger's NO_BODY_LOG list so passwords never persist).
  app.use('/api', apiLogger);

  // Public auth surface (login/register/reset pages + /api/auth/*). Mounted
  // BEFORE the gate — the only routes reachable without a session.
  app.use(authRoutes);

  // PWA assets must be reachable WITHOUT a session: the browser fetches the
  // manifest/icons on the login page and registers the service worker at the
  // root scope. Served before the gate; they expose no user data.
  const publicDir = path.join(__dirname, '..', 'public');
  app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache'); // always revalidate the SW itself
    res.type('text/javascript').sendFile(path.join(publicDir, 'sw.js'));
  });
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').sendFile(path.join(publicDir, 'manifest.webmanifest'));
  });
  app.get('/offline.html', (req, res) => res.sendFile(path.join(publicDir, 'offline.html')));
  app.use('/icons', express.static(path.join(publicDir, 'icons')));

  // Public heatmap page + data — no session required.
  app.use(heatmapPublicRoutes);

  // Global gate: everything past here requires an active session.
  app.use(sessionAuth.gate);

  // Read-only impersonation: block state-changing requests while an admin views
  // another user's world (admin/auth surfaces stay open so they can exit).
  app.use(sessionAuth.blockImpersonationWrites);

  // Admin surface (page + /api/admin/*); each route enforces admin itself.
  app.use(adminRoutes);

  // Admin-only global coverage heatmap (page + /api/heatmap/*); self-gated.
  app.use(heatmapRoutes);

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', apiRoutes);

  // Final error handler: turn an uncaught route error into a 500 instead of a
  // hung request, and keep it off the process's uncaughtException path.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(`[HTTP] ${req.method} ${req.originalUrl}: ${err && err.stack || err}`);
    if (res.headersSent) return;
    res.status(err.status || 500).json({ error: 'Errore interno del server' });
  });

  return app;
}

module.exports = createApp;
