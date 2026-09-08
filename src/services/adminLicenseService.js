'use strict';

const pool = require('../db/pool');
const { generateLicenseKey, PRODUCT_ID } = require('./licenseService');

// The four supported license durations. The UI may only ever send one of
// these values; the server is the sole authority on the resulting
// expires_at timestamp.
const ALLOWED_DURATIONS = ['lifetime', '1_month', '3_months', '1_year'];

/**
 * Adds `months` calendar months to `date`, clamping the day-of-month so
 * that e.g. Jan 31 + 1 month lands on Feb 28/29 instead of overflowing
 * into March. Operates in UTC so the result is timezone-stable.
 */
function addCalendarMonths(date, months) {
  const result = new Date(date.getTime());
  const originalDay = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();

  result.setUTCDate(Math.min(originalDay, daysInTargetMonth));

  return result;
}

function validateDuration(duration) {
  if (!ALLOWED_DURATIONS.includes(duration)) {
    throw new Error(
      `Invalid duration. Must be one of: ${ALLOWED_DURATIONS.join(', ')}.`
    );
  }
}

/**
 * Server-side calculation of expires_at for a given duration. The client
 * never supplies expires_at directly; it only ever chooses a duration.
 */
function calculateExpiresAt(duration, from = new Date()) {
  validateDuration(duration);

  if (duration === 'lifetime') {
    return null;
  }

  if (duration === '1_month') {
    return addCalendarMonths(from, 1).toISOString();
  }

  if (duration === '3_months') {
    return addCalendarMonths(from, 3).toISOString();
  }

  // '1_year'
  return addCalendarMonths(from, 12).toISOString();
}

function licenseTypeForDuration(duration) {
  return duration === 'lifetime' ? 'perpetual' : 'subscription';
}

async function createCustomerAndLicense({
  customer = {},
  productId = PRODUCT_ID,
  maxDevices = 1,
  duration = 'lifetime',
  plan = 'lifetime',
}) {
  if (!Number.isInteger(maxDevices) || maxDevices < 1) {
    throw new Error('maxDevices must be a positive integer.');
  }

  validateDuration(duration);

  const expiresAt = calculateExpiresAt(duration);
  const licenseType = licenseTypeForDuration(duration);

  if (plan.length > 50) {
    throw new Error('plan is too long.');
  }

  if (licenseType.length > 50) {
    throw new Error('licenseType is too long.');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let customerId = null;

    const name = customer.name ? String(customer.name).trim() : null;
    const email = customer.email ? String(customer.email).trim() : null;

    if (name || email) {
      const customerResult = await client.query(
        `
        INSERT INTO customers (
          name,
          email
        )
        VALUES ($1, $2)
        RETURNING id, name, email
        `,
        [name, email]
      );

      customerId = customerResult.rows[0].id;
    }

    const productResult = await client.query(
      `
      SELECT product_id
      FROM products
      WHERE product_id = $1
      `,
      [productId]
    );

    if (productResult.rowCount === 0) {
      throw new Error('Product not found.');
    }

    let licenseKey;

    for (;;) {
      const candidate = generateLicenseKey();

      const existing = await client.query(
        `
        SELECT id
        FROM licenses
        WHERE license_key = $1
        `,
        [candidate]
      );

      if (existing.rowCount === 0) {
        licenseKey = candidate;
        break;
      }
    }

    const licenseResult = await client.query(
      `
      INSERT INTO licenses (
        license_key,
        product_id,
        status,
        max_devices,
        expires_at,
        customer_id,
        plan,
        license_type
      )
      VALUES (
        $1,
        $2,
        'ACTIVE',
        $3,
        $4,
        $5,
        $6,
        $7
      )
      RETURNING
        id,
        license_key,
        product_id,
        status,
        max_devices,
        expires_at,
        customer_id,
        plan,
        license_type,
        created_at
      `,
      [
        licenseKey,
        productId,
        maxDevices,
        expiresAt,
        customerId,
        plan,
        licenseType,
      ]
    );

    await client.query('COMMIT');

    return {
      customer: customerId
        ? {
            id: customerId,
            name,
            email,
          }
        : null,
      license: licenseResult.rows[0],
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listLicenses() {
  const result = await pool.query(
    `
    SELECT
      l.id,
      l.license_key,
      l.product_id,
      l.status,
      l.max_devices,
      l.expires_at,
      l.plan,
      l.license_type,
      l.created_at,
      l.updated_at,
      c.id AS customer_id,
      c.name AS customer_name,
      c.email AS customer_email,

      (
        SELECT COUNT(*)::int
        FROM activations a
        WHERE a.license_id = l.id
          AND a.deactivated_at IS NULL
      ) AS active_devices

    FROM licenses l
    LEFT JOIN customers c
      ON c.id = l.customer_id
    ORDER BY l.created_at DESC
    `
  );

  return result.rows;
}

async function listLicenseDevices(licenseId) {
  const result = await pool.query(
    `
    SELECT
      a.id AS activation_id,
      d.id AS device_db_id,
      d.device_id,
      a.activated_at,
      a.deactivated_at,
      d.last_seen_at
    FROM activations a
    JOIN devices d
      ON d.id = a.device_id
    WHERE a.license_id = $1
    ORDER BY a.activated_at DESC
    `,
    [licenseId]
  );

  return result.rows;
}

async function resetDevice(activationId) {
  const result = await pool.query(
    `
    UPDATE activations
    SET deactivated_at = NOW()
    WHERE id = $1
      AND deactivated_at IS NULL
    RETURNING id, license_id, device_id
    `,
    [activationId]
  );

  if (result.rowCount === 0) {
    throw new Error('Active device activation not found.');
  }

  return {
    activationId: result.rows[0].id,
    licenseId: result.rows[0].license_id,
    deviceDbId: result.rows[0].device_id,
  };
}

async function revokeLicense(licenseId) {
  const result = await pool.query(
    `
    UPDATE licenses
    SET
      status = 'REVOKED',
      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      license_key,
      product_id,
      status,
      max_devices,
      expires_at,
      customer_id,
      plan,
      license_type
    `,
    [licenseId]
  );

  if (result.rowCount === 0) {
    throw new Error('License not found.');
  }

  return result.rows[0];
}

async function reactivateLicense(licenseId) {
  const result = await pool.query(
    `
    SELECT
      id,
      license_key,
      product_id,
      status,
      max_devices,
      expires_at,
      customer_id,
      plan,
      license_type
    FROM licenses
    WHERE id = $1
    `,
    [licenseId]
  );

  if (result.rowCount === 0) {
    throw new Error('License not found.');
  }

  const license = result.rows[0];

  if (
    license.expires_at &&
    new Date(license.expires_at).getTime() <= Date.now()
  ) {
    throw new Error(
      'This license has expired. Extend its expiration date before reactivating it.'
    );
  }

  const updated = await pool.query(
    `
    UPDATE licenses
    SET
      status = 'ACTIVE',
      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      license_key,
      product_id,
      status,
      max_devices,
      expires_at,
      customer_id,
      plan,
      license_type
    `,
    [licenseId]
  );

  return updated.rows[0];
}
async function updateLicense(
  licenseId,
  {
    maxDevices,
    duration,
    plan,
  }
) {
  const currentResult = await pool.query(
    `
    SELECT
      id,
      max_devices,
      expires_at
    FROM licenses
    WHERE id = $1
    `,
    [licenseId]
  );

  if (currentResult.rowCount === 0) {
    throw new Error('License not found.');
  }

  const current = currentResult.rows[0];

  if (
    maxDevices !== undefined &&
    (
      !Number.isInteger(maxDevices) ||
      maxDevices < 1
    )
  ) {
    throw new Error(
      'maxDevices must be a positive integer.'
    );
  }

  const activeResult = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM activations
    WHERE license_id = $1
      AND deactivated_at IS NULL
    `,
    [licenseId]
  );

  const activeDevices = activeResult.rows[0].count;

  if (
    maxDevices !== undefined &&
    maxDevices < activeDevices
  ) {
    throw new Error(
      `Cannot reduce max devices below the current active device count (${activeDevices}).`
    );
  }

  let normalizedExpiresAt =
    current.expires_at;

  // license_type is derived from duration, not settable directly. undefined
  // means "leave unchanged" for the COALESCE below.
  let normalizedLicenseType;

  if (duration !== undefined) {
    // Throws a clear validation error for any unsupported value.
    normalizedExpiresAt = calculateExpiresAt(duration);
    normalizedLicenseType = licenseTypeForDuration(duration);
  }

  if (
    plan !== undefined &&
    plan !== null &&
    String(plan).length > 50
  ) {
    throw new Error('plan is too long.');
  }

  const result = await pool.query(
    `
    UPDATE licenses
    SET
      max_devices = COALESCE($2, max_devices),
      expires_at = $3,
      plan = COALESCE($4, plan),
      license_type = COALESCE($5, license_type),
      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      license_key,
      product_id,
      status,
      max_devices,
      expires_at,
      customer_id,
      plan,
      license_type,
      updated_at
    `,
    [
      licenseId,
      maxDevices ?? null,
      normalizedExpiresAt,
      plan ?? null,
      normalizedLicenseType ?? null,
    ]
  );

  return result.rows[0];
}
module.exports = {
  createCustomerAndLicense,
  listLicenses,
  listLicenseDevices,
  resetDevice,
  revokeLicense,
  reactivateLicense,
  updateLicense,
  ALLOWED_DURATIONS,
  calculateExpiresAt,
  licenseTypeForDuration,
};