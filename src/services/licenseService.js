'use strict';

const crypto = require('crypto');
const pool = require('../db/pool');

const PRODUCT_ID = 'school-accreditation';

const STATUS = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  INVALID: 'invalid',
  DEVICE_LIMIT: 'device_limit_reached',
  DEACTIVATED: 'deactivated',
});

function generateLicenseKey() {
  const parts = Array.from({ length: 4 }, () =>
    crypto.randomBytes(3).toString('hex').toUpperCase()
  );

  return `SCHL-${parts.join('-')}`;
}

async function activateLicense({
  licenseKey,
  productId = PRODUCT_ID,
  deviceId,
}) {
  if (!licenseKey || !deviceId) {
    return {
      status: STATUS.INVALID,
      message: 'License key and device ID are required.',
    };
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const licenseResult = await client.query(
      `
      SELECT
        id,
        license_key,
        product_id,
        status,
        max_devices,
        expires_at
      FROM licenses
      WHERE license_key = $1
        AND product_id = $2
      FOR UPDATE
      `,
      [String(licenseKey).trim(), productId]
    );

    if (licenseResult.rowCount === 0) {
      await client.query('ROLLBACK');

      return {
        status: STATUS.INVALID,
        message: 'Invalid license key.',
      };
    }

    const license = licenseResult.rows[0];

    if (license.status === 'REVOKED') {
      await client.query('ROLLBACK');

      return {
        status: STATUS.REVOKED,
        message: 'This license has been revoked.',
      };
    }

    if (
      license.expires_at &&
      new Date(license.expires_at).getTime() <= Date.now()
    ) {
      await client.query(
        `
        UPDATE licenses
        SET status = 'EXPIRED',
            updated_at = NOW()
        WHERE id = $1
        `,
        [license.id]
      );

      await client.query('COMMIT');

      return {
        status: STATUS.EXPIRED,
        message: 'This license has expired.',
        expiresAt: license.expires_at,
      };
    }

    const deviceResult = await client.query(
      `
      INSERT INTO devices (device_id)
      VALUES ($1)
      ON CONFLICT (device_id)
      DO UPDATE SET last_seen_at = NOW()
      RETURNING id
      `,
      [deviceId]
    );

    const deviceDbId = deviceResult.rows[0].id;

    const existingActivation = await client.query(
      `
      SELECT id
      FROM activations
      WHERE license_id = $1
        AND device_id = $2
        AND deactivated_at IS NULL
      `,
      [license.id, deviceDbId]
    );

    if (existingActivation.rowCount > 0) {
      await client.query('COMMIT');

      return {
        status: STATUS.ACTIVE,
        message: 'License is already activated on this device.',
        expiresAt: license.expires_at,
        activationRef: existingActivation.rows[0].id,
      };
    }

    const activeDevicesResult = await client.query(
      `
      SELECT COUNT(*)::int AS count
      FROM activations
      WHERE license_id = $1
        AND deactivated_at IS NULL
      `,
      [license.id]
    );

    const activeDeviceCount = activeDevicesResult.rows[0].count;

    if (activeDeviceCount >= license.max_devices) {
      await client.query('ROLLBACK');

      return {
        status: STATUS.DEVICE_LIMIT,
        message: 'Maximum number of devices has been reached.',
      };
    }

    const activationResult = await client.query(
      `
      INSERT INTO activations (
        license_id,
        device_id
      )
      VALUES ($1, $2)
      RETURNING id
      `,
      [license.id, deviceDbId]
    );

    await client.query('COMMIT');

    return {
      status: STATUS.ACTIVE,
      message: 'License activated successfully.',
      expiresAt: license.expires_at,
      activationRef: activationResult.rows[0].id,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function validateLicense({
  licenseKey,
  productId = PRODUCT_ID,
  deviceId,
}) {
  if (!licenseKey || !deviceId) {
    return {
      status: STATUS.INVALID,
      message: 'License key and device ID are required.',
    };
  }

  const result = await pool.query(
    `
    SELECT
      l.id,
      l.status,
      l.expires_at,
      a.id AS activation_ref
    FROM licenses l
    JOIN devices d
      ON d.device_id = $3
    JOIN activations a
      ON a.license_id = l.id
     AND a.device_id = d.id
     AND a.deactivated_at IS NULL
    WHERE l.license_key = $1
      AND l.product_id = $2
    LIMIT 1
    `,
    [String(licenseKey).trim(), productId, deviceId]
  );

  if (result.rowCount === 0) {
    return {
      status: STATUS.INVALID,
      message: 'License is not active on this device.',
    };
  }

  const license = result.rows[0];

  if (license.status === 'REVOKED') {
    return {
      status: STATUS.REVOKED,
      message: 'This license has been revoked.',
    };
  }

  if (
    license.expires_at &&
    new Date(license.expires_at).getTime() <= Date.now()
  ) {
    await pool.query(
      `
      UPDATE licenses
      SET status = 'EXPIRED',
          updated_at = NOW()
      WHERE id = $1
      `,
      [license.id]
    );

    return {
      status: STATUS.EXPIRED,
      message: 'This license has expired.',
      expiresAt: license.expires_at,
    };
  }

  await pool.query(
    `
    UPDATE devices
    SET last_seen_at = NOW()
    WHERE device_id = $1
    `,
    [deviceId]
  );

  return {
    status: STATUS.ACTIVE,
    message: 'License is valid.',
    expiresAt: license.expires_at,
    activationRef: license.activation_ref,
  };
}

async function deactivateLicense({
  licenseKey,
  productId = PRODUCT_ID,
  deviceId,
}) {
  if (!licenseKey || !deviceId) {
    return {
      status: STATUS.INVALID,
      message: 'License key and device ID are required.',
    };
  }

  const result = await pool.query(
    `
    UPDATE activations a
    SET deactivated_at = NOW()
    FROM licenses l, devices d
    WHERE a.license_id = l.id
      AND a.device_id = d.id
      AND l.license_key = $1
      AND l.product_id = $2
      AND d.device_id = $3
      AND a.deactivated_at IS NULL
    RETURNING a.id
    `,
    [String(licenseKey).trim(), productId, deviceId]
  );

  if (result.rowCount === 0) {
    return {
      status: STATUS.INVALID,
      message: 'No active activation was found for this device.',
    };
  }

  return {
    status: STATUS.DEACTIVATED,
    message: 'License deactivated successfully.',
    activationRef: result.rows[0].id,
  };
}

module.exports = {
  PRODUCT_ID,
  STATUS,
  generateLicenseKey,
  activateLicense,
  validateLicense,
  deactivateLicense,
};