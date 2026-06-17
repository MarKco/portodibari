'use strict';

const path = require('path');
const express = require('express');
const apiLogger = require('./middleware/api-logger');
const basicAuth = require('./middleware/auth');
const apiRoutes = require('./routes');
const { setUiLang } = require('./config');

/** Build and return the configured Express application. */
function createApp() {
  const app = express();

  // Auth gate first: protects static files, API and SSE alike. No-op when
  // AUTH_PASSWORD is unset (see src/middleware/auth.js).
  app.use(basicAuth);

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Mirror the browser's active language (sent as ?lang= on every API call) so
  // the operational log — including background events with no request — writes
  // in whatever language the app is currently showing.
  app.use('/api', (req, res, next) => {
    if (req.query.lang) setUiLang(req.query.lang);
    next();
  });

  // Log + broadcast every API call, then serve it.
  app.use('/api', apiLogger);
  app.use('/api', apiRoutes);

  return app;
}

module.exports = createApp;
