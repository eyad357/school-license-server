'use strict';

// Customer / sales data management.
//
// IMPORTANT: everything in this file writes to the `customers` table only
// (plus the single `licenses.customer_id` link in assignCustomerToLicense).
// Nothing here touches license keys, license status, max_devices, expiry,
// devices or activations, and nothing here is called from the
// activate / validate / deactivate code paths.

const pool = require('../db/pool');
const { schoolTypes, schoolStages } = require('./schoolOptionsService');
const { NotFoundError, ConflictError } = require('../lib/errors');
const audit = require('./auditService');
const {
  ValidationError,
  parseName,
  parseEmail,
  parsePhone,
  parseCity,
  parseSaleStatus,
  parsePaymentStatus,
  parseSale,
  parseSalePrice,
  parseCurrency,
  parseSoldAt,
  parseNotes,
  isUuid,
} = require('../lib/validation');

const CUSTOMER_COLUMNS = `
  id,
  customer_number::int AS customer_number,
  name,
  email,
  phone,
  city,
  school_type_id::int AS school_type_id,
  school_stage_id::int AS school_stage_id,
  (SELECT t.name FROM school_types t WHERE t.id = customers.school_type_id) AS school_type_name,
  (SELECT g.name FROM school_stages g WHERE g.id = customers.school_stage_id) AS school_stage_name,
  sale_status,
  payment_status,
  sale_price,
  currency,
  to_char(sold_at, 'YYYY-MM-DD') AS sold_at,
  notes,
  created_at,
  updated_at,
  archived_at
`;

async function withTransaction(db, fn) {
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch (rollbackError) {
      // Connection is unusable; make the pool discard it.
      client.release(rollbackError);
    }
    throw error;
  }
}

/** `ref` is either the customer UUID or the public customer number. */
async function resolveCustomerRow(client, ref, { lock = false } = {}) {
  const suffix = lock ? 'FOR UPDATE' : '';
  const text = String(ref ?? '').trim().replace(/^#/, '');

  let result;

  if (isUuid(text)) {
    result = await client.query(
      `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = $1 ${suffix}`,
      [text.toLowerCase()]
    );
  } else if (/^\d{1,15}$/.test(text)) {
    result = await client.query(
      `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE customer_number = $1::bigint ${suffix}`,
      [text]
    );
  } else {
    throw new ValidationError('معرّف العميل غير صالح.');
  }

  if (result.rowCount === 0) {
    throw new NotFoundError('العميل غير موجود.');
  }

  return result.rows[0];
}

async function getCustomerDetails(ref, db = pool) {
  const customer = await resolveCustomerRow(db, ref);

  const licenses = await db.query(
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
      (
        SELECT COUNT(*)::int
        FROM activations a
        WHERE a.license_id = l.id
          AND a.deactivated_at IS NULL
      ) AS active_devices
    FROM licenses l
    WHERE l.customer_id = $1
    ORDER BY l.created_at DESC, l.id ASC
    `,
    [customer.id]
  );

  return { customer, licenses: licenses.rows };
}

const PATCHABLE = [
  'name', 'email', 'phone', 'salePrice', 'currency', 'soldAt', 'notes',
  'saleStatus', 'paymentStatus', 'city', 'schoolTypeId', 'schoolStageId',
];

/**
 * Partial update. A field that is `undefined` is left unchanged; `null` or ''
 * clears optional fields (price, currency, date, notes, email). The name can be
 * changed but never cleared.
 */
async function updateCustomer(ref, patch = {}, db = pool) {
  if (!patch || typeof patch !== 'object') {
    throw new ValidationError('بيانات التعديل غير صالحة.');
  }

  const provided = PATCHABLE.filter((key) => patch[key] !== undefined);

  if (provided.length === 0) {
    throw new ValidationError('لا توجد بيانات للتعديل.');
  }

  return withTransaction(db, (client) => updateCustomerOn(client, ref, patch));
}

/** Same as updateCustomer but inside a transaction the caller already owns (Excel import). */
async function updateCustomerOn(client, ref, patch) {
  {
    const current = await resolveCustomerRow(client, ref, { lock: true });

    const next = {
      name: current.name,
      email: current.email,
      phone: current.phone,
      city: current.city,
      schoolTypeId: current.school_type_id,
      schoolStageId: current.school_stage_id,
      saleStatus: current.sale_status,
      paymentStatus: current.payment_status,
      salePrice: current.sale_price,
      currency: current.currency,
      soldAt: current.sold_at,
      notes: current.notes,
    };

    if (patch.name !== undefined) {
      const name = parseName(patch.name);

      if (name === null) {
        throw new ValidationError('اسم العميل لا يمكن أن يكون فارغًا.');
      }

      next.name = name;
    }

    if (patch.email !== undefined) {
      next.email = parseEmail(patch.email);
    }

    if (patch.phone !== undefined) {
      next.phone = parsePhone(patch.phone);
    }

    if (patch.city !== undefined) {
      next.city = parseCity(patch.city);
    }

    // Optional lists: undefined = leave as is, null/'' = clear, id = must be an ACTIVE option
    // (an inactive option the record already has may be kept unchanged).
    if (patch.schoolTypeId !== undefined) {
      next.schoolTypeId = await schoolTypes.resolveId(patch.schoolTypeId, client, { allowId: current.school_type_id });
    }

    if (patch.schoolStageId !== undefined) {
      next.schoolStageId = await schoolStages.resolveId(patch.schoolStageId, client, { allowId: current.school_stage_id });
    }

    if (patch.salePrice !== undefined) {
      next.salePrice = parseSalePrice(patch.salePrice);
    }

    if (patch.currency !== undefined) {
      next.currency = parseCurrency(patch.currency);
    }

    if (patch.soldAt !== undefined) {
      next.soldAt = parseSoldAt(patch.soldAt);
    }

    if (patch.notes !== undefined) {
      next.notes = parseNotes(patch.notes);
    }

    if (next.salePrice !== null && next.currency === null) {
      throw new ValidationError('يجب اختيار العملة عند إدخال سعر البيع.');
    }

    // Sale / payment status are separate from license status and activation.
    if (patch.saleStatus !== undefined) {
      next.saleStatus = parseSaleStatus(patch.saleStatus);
    } else if (
      next.saleStatus === 'unsold' &&
      (next.name !== null || next.salePrice !== null || next.soldAt !== null)
    ) {
      // Recording a buyer / price / sale date means the key was sold.
      next.saleStatus = 'sold';
    }

    if (patch.paymentStatus !== undefined) {
      next.paymentStatus = parsePaymentStatus(patch.paymentStatus);
    }

    if (next.saleStatus === 'unsold' && next.paymentStatus && next.paymentStatus !== 'unpaid') {
      throw new ValidationError('لا يمكن تسجيل دفع لمفتاح غير مباع. غيّر حالة البيع إلى «مباع» أولًا.');
    }

    const result = await client.query(
      `
      UPDATE customers
      SET name = $2,
          email = $3,
          sale_price = $4,
          currency = $5,
          sold_at = $6,
          notes = $7,
          phone = $8,
          sale_status = $9,
          payment_status = $10,
          city = $11,
          school_type_id = $12,
          school_stage_id = $13,
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${CUSTOMER_COLUMNS}
      `,
      [
        current.id,
        next.name,
        next.email,
        next.salePrice,
        next.currency,
        next.soldAt,
        next.notes,
        next.phone,
        next.saleStatus,
        next.paymentStatus,
        next.city,
        next.schoolTypeId,
        next.schoolStageId,
      ]
    );

    return result.rows[0];
  }
}

async function setArchived(ref, archived, db = pool) {
  return withTransaction(db, async (client) => {
    const current = await resolveCustomerRow(client, ref, { lock: true });

    const result = await client.query(
      `
      UPDATE customers
      SET archived_at = ${archived ? 'COALESCE(archived_at, NOW())' : 'NULL'},
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${CUSTOMER_COLUMNS}
      `,
      [current.id]
    );

    return result.rows[0];
  });
}

const archiveCustomer = (ref, db) => setArchived(ref, true, db);
const unarchiveCustomer = (ref, db) => setArchived(ref, false, db);

/**
 * Completes a license that has no customer yet (typically a legacy license).
 * Never guesses: the admin either supplies a new customer's data or the id /
 * number of an existing customer explicitly. A license that is already linked is
 * never re-linked (409).
 */
async function assignCustomerToLicense(licenseId, input = {}, db = pool) {
  if (!isUuid(licenseId)) {
    throw new ValidationError('معرّف الترخيص غير صالح.');
  }

  const existingRef = input.customerId ?? input.customerNumber;

  return withTransaction(db, async (client) => {
    const licenseResult = await client.query(
      'SELECT id, customer_id FROM licenses WHERE id = $1 FOR UPDATE',
      [licenseId.toLowerCase()]
    );

    if (licenseResult.rowCount === 0) {
      throw new NotFoundError('الترخيص غير موجود.');
    }

    if (licenseResult.rows[0].customer_id) {
      throw new ConflictError('هذا الترخيص مرتبط بعميل بالفعل.', 'already_linked');
    }

    let customer;

    if (existingRef !== undefined && existingRef !== null && existingRef !== '') {
      customer = await resolveCustomerRow(client, existingRef, { lock: true });
    } else {
      const name = parseName(input.name, { required: true });
      const email = parseEmail(input.email);
      const sale = parseSale(input);
      const city = parseCity(input.city);
      const schoolTypeId = (await schoolTypes.resolveId(input.schoolTypeId, client)) ?? null;
      const schoolStageId = (await schoolStages.resolveId(input.schoolStageId, client)) ?? null;

      const created = await client.query(
        `
        INSERT INTO customers (name, email, phone, sale_price, currency, sold_at, notes,
                               sale_status, payment_status, city, school_type_id, school_stage_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'sold', $8, $9, $10, $11)
        RETURNING ${CUSTOMER_COLUMNS}
        `,
        [name, email, parsePhone(input.phone), sale.salePrice, sale.currency, sale.soldAt,
          sale.notes, parsePaymentStatus(input.paymentStatus), city, schoolTypeId, schoolStageId]
      );

      customer = created.rows[0];
    }

    // The ONLY change made to the licenses table: the customer link.
    await client.query('UPDATE licenses SET customer_id = $2 WHERE id = $1', [
      licenseId.toLowerCase(),
      customer.id,
    ]);

    return { licenseId: licenseId.toLowerCase(), customer };
  });
}

/** Renumbers ALL customers 1..N (keeps current order) inside the caller's transaction. */
async function renumberCustomersOn(client) {
  await client.query('LOCK TABLE customers IN ACCESS EXCLUSIVE MODE');
  await client.query('ALTER TABLE customers DISABLE TRIGGER trg_customers_protect_customer_number');
  // Step 1 moves every number out of the way (unique index), step 2 assigns 1..N.
  await client.query('UPDATE customers SET customer_number = customer_number + 1000000000000');
  await client.query(`
    UPDATE customers c
    SET customer_number = r.rn
    FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY customer_number) AS rn FROM customers) r
    WHERE c.id = r.id`);
  await client.query('ALTER TABLE customers ENABLE TRIGGER trg_customers_protect_customer_number');
  await client.query(
    'UPDATE customer_number_counter SET last_number = (SELECT COALESCE(MAX(customer_number), 0) FROM customers) WHERE id = 1'
  );
}

/** Standalone renumbering (no deletion). Order is preserved; only gaps are closed. */
async function renumberCustomers(auditCtx = {}, db = pool) {
  return withTransaction(db, async (client) => {
    await renumberCustomersOn(client);
    const n = (await client.query('SELECT COUNT(*)::int AS n FROM customers')).rows[0].n;
    await audit.record(client, { ...auditCtx, action: 'customer.renumber', targetType: 'customer', targetId: null,
      meta: { total: n } }, { strict: true });
    return { total: n };
  });
}

/**
 * Permanently deletes customer records that have NO license attached.
 * Customers that still own a license are never touched (reported as skipped).
 * Afterwards ALL customers are renumbered 1..N with no gaps (delete #3 => old #4 becomes #3).
 * One transaction (the number-protection trigger is disabled only inside it); the audit write is strict.
 */
async function deleteCustomersWithoutLicense(customerIds, auditCtx = {}, db = pool) {
  if (!Array.isArray(customerIds) || customerIds.length === 0) {
    throw new ValidationError('لم يتم تحديد أي سجل للحذف.');
  }
  if (customerIds.length > 1000) throw new ValidationError('الحد الأقصى 1000 سجل في المرة الواحدة.');
  if (!customerIds.every((id) => typeof id === 'string' && isUuid(id))) {
    throw new ValidationError('معرّف عميل غير صالح.');
  }
  const ids = [...new Set(customerIds.map((id) => id.toLowerCase()))];

  return withTransaction(db, async (client) => {
    const del = await client.query(
      `DELETE FROM customers c
        WHERE c.id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM licenses l WHERE l.customer_id = c.id)
        RETURNING c.id, c.customer_number::int AS n`,
      [ids]
    );
    for (const row of del.rows) {
      await audit.record(client, { ...auditCtx, action: 'customer.delete', targetType: 'customer', targetId: row.id,
        meta: { customerNumber: row.n } }, { strict: true });
    }
    let renumbered = false;
    if (del.rowCount > 0) { await renumberCustomersOn(client); renumbered = true; }
    return { deleted: del.rowCount, skipped: ids.length - del.rowCount, renumbered };
  });
}

module.exports = {
  withTransaction,
  deleteCustomersWithoutLicense,
  renumberCustomers,
  getCustomerDetails,
  updateCustomer,
  updateCustomerOn,
  archiveCustomer,
  unarchiveCustomer,
  assignCustomerToLicense,
};
