'use strict';

const express = require('express');

const router = express.Router();

// Mounted at /api in app.js. Each sub-router declares paths relative to /api.
router.use(require('./stream'));
router.use(require('./ships'));
router.use(require('./readings'));
router.use(require('./events'));
router.use(require('./notifications'));
router.use(require('./logs'));
router.use(require('./settings'));
router.use(require('./areas'));
router.use(require('./berths'));
router.use(require('./export'));

module.exports = router;
