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
    res.status(result.status === 'deactivated' ? 200 : 400).json(result);
  } catch (error) {
    console.error('Deactivation error:', error);
    res.status(500).json({
      status: 'SERVER_ERROR',
      message: 'Internal server error.',
    });
  }
});

module.exports = router;