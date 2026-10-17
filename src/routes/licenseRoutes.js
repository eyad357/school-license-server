'use strict';

const express = require('express');
const {
  activateLicense,
  validateLicense,
  deactivateLicense,
} = require('../services/licenseService');

const router = express.Router();

router.post('/activate', async (req, res) => {
  try {
    const result = await activateLicense(req.body);
    res.status(result.status === 'active' ? 200 : 400).json(result);
  } catch (error) {
    console.error('Activation error:', error);
    res.status(500).json({
      status: 'SERVER_ERROR',
      message: 'Internal server error.',
    });
  }
});

router.post('/validate', async (req, res) => {
  try {
    const result = await validateLicense(req.body);
    res.status(result.status === 'active' ? 200 : 400).json(result);
  } catch (error) {
    console.error('Validation error:', error);
    res.status(500).json({
      status: 'SERVER_ERROR',
      message: 'Internal server error.',
    });
  }
});

router.post('/deactivate', async (req, res) => {
  try {
    const result = await deactivateLicense(req.body);
    // The service returns 'deactivated' (lower case); the old comparison with 'DEACTIVATED' never matched,
    // so a SUCCESSFUL deactivation was answered with HTTP 400 and clients showed it as a failure.
    // Body is unchanged; only the status code of this one success path is corrected (verified with
    // the already-sold Windows client: it treats 2xx without a recognised status as success).
    res.status(String(result.status).toLowerCase() === 'deactivated' ? 200 : 400).json(result);
  } catch (error) {
    console.error('Deactivation error:', error);
    res.status(500).json({
      status: 'SERVER_ERROR',
      message: 'Internal server error.',
    });
  }
});

module.exports = router;