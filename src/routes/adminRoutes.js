'use strict';

const rateLimit = require('express-rate-limit');

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
const audit = require('../services/auditService');
const { recordEvent } = require('../services/eventService');

const router = express.Router();

// Brute-force guard for the admin password (on top of the general API limit). Only failed logins are counted.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many failed login attempts. Try again later.' },
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({
        status: 'invalid',
        message: 'Username and password are required.',
      });
    }

    if (username !== process.env.ADMIN_USERNAME) {
      await audit.record(pool, { admin: 'unknown', action: 'auth.login_failed', targetType: 'auth', ip: req.ip, meta: {} });
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
      await audit.record(pool, { admin: String(username).slice(0, 100), action: 'auth.login_failed', targetType: 'auth', ip: req.ip, meta: {} });
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

    await audit.record(pool, { admin: String(username).slice(0, 100), action: 'auth.login', targetType: 'auth', ip: req.ip, meta: {} });

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

    await audit.record(pool, { ...audit.fromReq(req), action: 'license.create', targetType: 'license',
      targetId: result.license && result.license.id,
      meta: { key: audit.maskKey(result.license && result.license.license_key), productId: result.license && result.license.product_id } });

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
    const result = await resetDevice(req.params.id, audit.fromReq(req));

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
    const license = await revokeLicense(req.params.id, audit.fromReq(req));

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
    const license = await reactivateLicense(req.params.id, audit.fromReq(req));

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
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `
      DELETE FROM licenses
      WHERE id = $1
      RETURNING id, license_key, product_id
      `,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        status: 'not_found',
        message: 'License not found.',
      });
    }

    const row = result.rows[0];
    // Same transaction as the DELETE: devices still holding this key learn about it.
    await recordEvent(client, { licenseId: row.id, productId: row.product_id, type: 'license.deleted' });
    await audit.record(client, { ...audit.fromReq(req), action: 'license.delete', targetType: 'license', targetId: row.id,
      meta: { key: audit.maskKey(row.license_key), productId: row.product_id } }, { strict: true });
    await client.query('COMMIT');

    return res.json({
      status: 'deleted',
      licenseId: row.id,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Delete license error:', error);

    return res.status(500).json({
      status: 'server_error',
      message: 'Internal server error.',
    });
  } finally {
    client.release();
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
      },
      audit.fromReq(req)
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