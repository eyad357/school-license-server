'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const {
  createCustomerAndLicense,
  listLicenses,
  listLicenseDevices,
  resetDevice,
  revokeLicense,
  reactivateLicense,
  updateLicense,
} = require('../services/adminLicenseService');

const { requireAdmin } = require('../middleware/adminAuth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({
        status: 'invalid',
        message: 'Username and password are required.',
      });
    }

    if (username !== process.env.ADMIN_USERNAME) {
      return res.status(401).json({
        status: 'unauthorized',
        message: 'Invalid credentials.',
      });
    }

    const valid = await bcrypt.compare(
      password,
      process.env.ADMIN_PASSWORD_HASH
    );

    if (!valid) {
      return res.status(401).json({
        status: 'unauthorized',
        message: 'Invalid credentials.',
      });
    }

    const token = jwt.sign(
      {
        role: 'admin',
        username,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '8h',
      }
    );

    return res.json({
      status: 'ok',
      token,
    });
  } catch (error) {
    console.error('Admin login error:', error);

    return res.status(500).json({
      status: 'server_error',
      message: 'Internal server error.',
    });
  }
});

router.get('/licenses', requireAdmin, async (_req, res) => {
  try {
    const licenses = await listLicenses();

    return res.json({
      status: 'ok',
      licenses,
    });
  } catch (error) {
    console.error('List licenses error:', error);

    return res.status(500).json({
      status: 'server_error',
      message: 'Internal server error.',
    });
  }
});

router.get('/licenses/:id/devices', requireAdmin, async (req, res) => {
  try {
    const devices = await listLicenseDevices(req.params.id);

    return res.json({
      status: 'ok',
      devices,
    });
  } catch (error) {
    console.error('List license devices error:', error);

    return res.status(500).json({
      status: 'server_error',
      message: 'Internal server error.',
    });
  }
});

router.post('/licenses', requireAdmin, async (req, res) => {
  try {
    const result = await createCustomerAndLicense({
      customer: req.body.customer || {},
      productId: req.body.productId,
      maxDevices: req.body.maxDevices,
      duration: req.body.duration || 'lifetime',
      plan: req.body.plan || 'lifetime',
    });

    return res.status(201).json({
      status: 'created',
      ...result,
    });
  } catch (error) {
    console.error('Create customer/license error:', error);

    return res.status(400).json({
      status: 'invalid',
      message: error.message,
    });
  }
});

router.post('/licenses/:id/reset-device', requireAdmin, async (req, res) => {
  try {
    const result = await resetDevice(req.params.id);

    return res.json({
      status: 'ok',
      ...result,
    });
  } catch (error) {
    console.error('Reset device error:', error);

    return res.status(400).json({
      status: 'invalid',
      message: error.message,
    });
  }
});

router.post('/licenses/:id/revoke', requireAdmin, async (req, res) => {
  try {
    const license = await revokeLicense(req.params.id);

    return res.json({
      status: 'ok',
      license,
    });
  } catch (error) {
    console.error('Revoke license error:', error);

    return res.status(400).json({
      status: 'invalid',
      message: error.message,
    });
  }
});

router.post('/licenses/:id/reactivate', requireAdmin, async (req, res) => {
  try {
    const license = await reactivateLicense(req.params.id);

    return res.json({
      status: 'ok',
      license,
    });
  } catch (error) {
    console.error('Reactivate license error:', error);

    return res.status(400).json({
      status: 'invalid',
      message: error.message,
    });
  }
});

router.delete('/licenses/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      DELETE FROM licenses
      WHERE id = $1
      RETURNING id, license_key
      `,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: 'not_found',
        message: 'License not found.',
      });
    }

    return res.json({
      status: 'deleted',
      licenseId: result.rows[0].id,
    });
  } catch (error) {
    console.error('Delete license error:', error);

    return res.status(500).json({
      status: 'server_error',
      message: 'Internal server error.',
    });
  }
});

router.patch('/licenses/:id', requireAdmin, async (req, res) => {
  try {
    const license = await updateLicense(
      req.params.id,
      {
        maxDevices: req.body.maxDevices,
        duration: req.body.duration,
        plan: req.body.plan,
      }
    );

    return res.json({
      status: 'ok',
      license,
    });
  } catch (error) {
    console.error('Update license error:', error);

    return res.status(400).json({
      status: 'invalid',
      message: error.message,
    });
  }
});

module.exports = router;