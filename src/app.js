'use strict';

const path = require('path');
const express = require('express');
const apiLogger = require('./middleware/api-logger');
const { securityHeaders, csrfGuard } = require('./middleware/security');
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

  // Security response headers on everything (login page + static assets too).
  app.use(securityHeaders);

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

  // Reject cross-origin state changes (CSRF defense-in-depth). After the logger
  // so a blocked attempt is still recorded in the audit trail.
  app.use('/api', csrfGuard);

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
  // Self-hosted vendor libraries (Leaflet). Non-sensitive static assets, served
  // before the gate so the public heatmap page (and the login-time SW precache)
  // can load them without a session.
  app.use('/vendor', express.static(path.join(publicDir, 'vendor')));

  // Public heatmap page + data — no session required.
  app.use(heatmapPublicRoutes);

  // User manual (static HTML + screenshots + PDF) — public so it is linkable from
  // the login page and shareable externally. Documentation only, no user data.
  app.use('/manuale', express.static(path.join(__dirname, '..', 'docs', 'manuale')));

  // Global gate: everything past here requires an active session.
  app.use(sessionAuth.gate);

  // Read-only impersonation: block state-changing requests while an admin views
  // another user's world (admin/auth surfaces stay open so they can exit).
  app.use(sessionAuth.blockImpersonationWrites);

  // Admin surface (page + /api/admin/*); each route enforces admin itself.
  app.use(adminRoutes);

  // Admin-only global coverage heatmap (page + /api/heatmap/*); self-gated.
  app.use(heatmapRoutes);

  // Admin manual (static HTML + screenshots + PDF). Gated to admins: reachable
  // only by the session owner with the admin role; everyone else is bounced to
  // the public user manual. The sidebar link is likewise admin-only.
  app.use('/manuale_admin', (req, res, next) => {
    if (req.realUser && req.realUser.role === 'admin') return next();
    return res.redirect('/manuale/');
  }, express.static(path.join(__dirname, '..', 'docs', 'manuale_admin')));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', apiRoutes);

  // Final error handler: turn an uncaught route error into a 500 instead of a
  // hung request, and keep it off the process's uncaughtException path. The 4-arg
  // signature (next included) is what marks this as Express error middleware.
  app.use((err, req, res, next) => {
    console.error(`[HTTP] ${req.method} ${req.originalUrl}: ${err && err.stack || err}`);
    if (res.headersSent) return;
    res.status(err.status || 500).json({ error: 'Errore interno del server' });
  });

  return app;
}

module.exports = createApp;
