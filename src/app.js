'use strict';

const path = require('path');
const express = require('express');
const apiLogger = require('./middleware/api-logger');
const sessionAuth = require('./middleware/session-auth');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
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

  // Global gate: everything past here requires an active session.
  app.use(sessionAuth.gate);

  // Read-only impersonation: block state-changing requests while an admin views
  // another user's world (admin/auth surfaces stay open so they can exit).
  app.use(sessionAuth.blockImpersonationWrites);

  // Admin surface (page + /api/admin/*); each route enforces admin itself.
  app.use(adminRoutes);

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', apiRoutes);

  return app;
}

module.exports = createApp;
