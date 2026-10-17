'use strict';

// Bulk license creation (1..1000) for the admin panel.
//
// Properties:
//   * ALL-OR-NOTHING: one database transaction. On any failure nothing is saved.
//   * Idempotent: the same Idempotency-Key + same payload returns the original
//     result (no duplicates on double click / retry). Same key + different
//     payload is rejected with 409.
//   * Customer numbers come from one block reserved atomically from the
//     gap-free counter, assigned in input order.
//   * Keys use the EXISTING format (generateLicenseKey); uniqueness is enforced
//     by the UNIQUE constraint, with automatic regeneration on collision.
//   * Never touches existing licenses, devices or activations.

const crypto = require('crypto');
const pool = require('../db/pool');
const { generateLicenseKey } = require('./licenseService');
const { assertProductUsableForNewLicenses } = require('./productService');
const {
  calculateExpiresAt,
  licenseTypeForDuration,
  ALLOWED_DURATIONS,
} = require('./adminLicenseService');
const { ConflictError } = require('../lib/errors');
const {
  ValidationError,
  parseIntegerInRange,
} = require('../lib/validation');

const MAX_BATCH = 1000;
const MAX_KEY_ROUNDS = 5;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,99}$/;

function normalizeRequest(input = {}) {
  const maxDevices = parseIntegerInRange(input.maxDevices ?? 1, {
    field: 'عدد الأجهزة',
    min: 1,
    max: 1000,
  });

  const duration = input.duration ?? 'lifetime';

  if (!ALLOWED_DURATIONS.includes(duration)) {
    throw new ValidationError(
      `مدة الترخيص غير صالحة. القيم المسموحة: ${ALLOWED_DURATIONS.join(', ')}.`
    );
  }

  const plan = typeof input.plan === 'string' && input.plan.trim() ? input.plan.trim() : 'lifetime';

  if ([...plan].length > 50) {
    throw new ValidationError('اسم الخطة طويل جدًا (الحد الأقصى 50 حرفًا).');
  }

  // No default: the admin must pick the program explicitly.
  const productId = input.productId;

  if (productId === undefined || productId === null || productId === '') {
    throw new ValidationError('يجب اختيار البرنامج قبل إنشاء التراخيص.');
  }

  if (typeof productId !== 'string' || productId.length > 100) {
    throw new ValidationError('معرّف المنتج غير صالح.');
  }

  // Keys are created UNSOLD and anonymous. Customer data is recorded later,
  // per license, after the sale. Legacy "with names" payloads are refused
  // explicitly instead of being silently ignored.
  for (const legacy of ['customers', 'defaults']) {
    if (input[legacy] !== undefined && input[legacy] !== null) {
      throw new ValidationError(
        'إنشاء التراخيص لم يعد يقبل أسماء العملاء أو بيانات البيع. ' +
          'أنشئ المفاتيح بالكمية فقط، ثم سجّل بيانات العميل داخل سجل كل مفتاح بعد البيع.'
      );
    }
  }

  const quantity = parseIntegerInRange(input.quantity, {
    field: 'الكمية',
    min: 1,
    max: MAX_BATCH,
  });

  return { maxDevices, duration, plan, productId, quantity };
}

function hashRequest(normalized) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

async function fetchBatchItems(client, licenseIds) {
  const result = await client.query(
    `
    SELECT
      u.ord::int AS position,
      l.id AS license_id,
      l.license_key,
      l.product_id,
      l.status,
      l.max_devices,
      l.expires_at,
      l.plan,
      l.license_type,
      l.created_at AS license_created_at,
      c.id AS customer_id,
      c.customer_number,
      c.sale_status
    FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id, ord)
    JOIN licenses l ON l.id = u.id
    LEFT JOIN customers c ON c.id = l.customer_id
    ORDER BY u.ord
    `,
    [licenseIds]
  );

  return result.rows;
}

function toResponse(batchId, items, replayed) {
  return {
    batchId,
    replayed,
    quantity: items.length,
    items: items.map((row) => ({
      index: row.position,
      customerNumber: row.customer_number === null ? null : Number(row.customer_number),
      customerId: row.customer_id,
      saleStatus: row.sale_status,
      licenseId: row.license_id,
      licenseKey: row.license_key,
      productId: row.product_id,
      status: row.status,
      maxDevices: row.max_devices,
      expiresAt: row.expires_at,
      plan: row.plan,
      licenseType: row.license_type,
    })),
  };
}

async function createBulkLicenses(input = {}, options = {}) {
  const db = options.db || pool;
  const createdBy = options.createdBy ? String(options.createdBy).slice(0, 100) : null;

  const idempotencyKey = input.idempotencyKey;

  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new ValidationError(
      'مفتاح منع التكرار (Idempotency-Key) مطلوب: 8 إلى 100 حرف (حروف وأرقام و - _ . :).'
    );
  }

  const normalized = normalizeRequest(input);
  const requestHash = hashRequest(normalized);
  const n = normalized.quantity;
  const expiresAt = calculateExpiresAt(normalized.duration);
  const licenseType = licenseTypeForDuration(normalized.duration);

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. Claim the idempotency key. A concurrent request with the same key
    //    blocks here until the first one commits or rolls back.
    const claim = await client.query(
      `
      INSERT INTO license_batches (idempotency_key, request_hash, quantity, created_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
      `,
      [idempotencyKey, requestHash, n, createdBy]
    );

    if (claim.rowCount === 0) {
      const existing = await client.query(
        'SELECT id, request_hash, license_ids FROM license_batches WHERE idempotency_key = $1',
        [idempotencyKey]
      );

      const batch = existing.rows[0];

      if (batch.request_hash !== requestHash) {
        throw new ConflictError(
          'مفتاح العملية مستخدم سابقًا مع بيانات مختلفة. لم يتم إنشاء أي ترخيص.',
          'idempotency_key_reused'
        );
      }

      const items = await fetchBatchItems(client, batch.license_ids);
      await client.query('ROLLBACK');
      client.release();

      return toResponse(batch.id, items, true);
    }

    const batchId = claim.rows[0].id;

    // 2. Product must exist (same rule as the existing single-license path).
    await assertProductUsableForNewLicenses(normalized.productId, client);

    // 3. Reserve a contiguous block of customer numbers atomically.
    const block = await client.query('SELECT allocate_customer_numbers($1::int) AS first', [n]);
    const firstNumber = block.rows[0].first;

    // 4. Customers, with explicit ids so licenses map to them unambiguously.
    const customerIds = Array.from({ length: n }, () => crypto.randomUUID());

    // Anonymous, UNSOLD sale records: no name, no price, no date.
    await client.query(
      `
      INSERT INTO customers (id, customer_number, sale_status)
      SELECT t.id, $1::bigint + t.ord - 1, 'unsold'
      FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ord)
      `,
      [firstNumber, customerIds]
    );

    // 5. Licenses. Keys are generated here and made unique by the DB constraint.
    const licenseIdByCustomer = new Map();
    let pending = customerIds.slice();

    for (let round = 0; pending.length > 0; round += 1) {
      if (round >= MAX_KEY_ROUNDS) {
        throw new Error('Could not generate unique license keys.');
      }

      const keys = new Set();

      while (keys.size < pending.length) {
        keys.add(generateLicenseKey());
      }

      const keyList = [...keys];

      const inserted = await client.query(
        `
        INSERT INTO licenses (
          license_key, product_id, status, max_devices, expires_at,
          customer_id, plan, license_type
        )
        SELECT t.license_key, $1::varchar, 'ACTIVE', $2::int, $3::timestamptz,
               t.customer_id, $4::varchar, $5::varchar
        FROM unnest($6::text[], $7::uuid[]) AS t(license_key, customer_id)
        ON CONFLICT (license_key) DO NOTHING
        RETURNING id, customer_id
        `,
        [
          normalized.productId,
          normalized.maxDevices,
          expiresAt,
          normalized.plan,
          licenseType,
          keyList,
          pending,
        ]
      );

      for (const row of inserted.rows) {
        licenseIdByCustomer.set(row.customer_id, row.id);
      }

      pending = pending.filter((id) => !licenseIdByCustomer.has(id));
    }

    const licenseIds = customerIds.map((id) => licenseIdByCustomer.get(id));

    if (licenseIds.length !== n || licenseIds.some((id) => !id)) {
      throw new Error('Bulk creation produced an inconsistent result.');
    }

    // 6. Record what the batch created, then read it back inside the transaction.
    await client.query('UPDATE license_batches SET license_ids = $2::uuid[] WHERE id = $1', [
      batchId,
      licenseIds,
    ]);

    const items = await fetchBatchItems(client, licenseIds);

    if (items.length !== n) {
      throw new Error('Bulk creation read-back mismatch.');
    }

    await client.query('COMMIT');
    client.release();

    return toResponse(batchId, items, false);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch (rollbackError) {
      client.release(rollbackError);
    }

    throw error;
  }
}

module.exports = {
  MAX_BATCH,
  IDEMPOTENCY_KEY_RE,
  normalizeRequest,
  createBulkLicenses,
};
