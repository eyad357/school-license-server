'use strict';

// Test helper: creates licenses the NEW way (quantity only, anonymous, unsold)
// and then — only when a test needs a "sold" record — records the customer data
// afterwards, exactly like the admin does after a sale. Production bulk creation
// no longer accepts customer names (see bulkLicenseService).

const { pool } = require('./setup');
const { createBulkLicenses } = require('../../../src/services/bulkLicenseService');

let n = 0;
const newIdem = () => `helper-batch-${Date.now()}-${++n}`;

async function bulkWithSales(input = {}) {
  const { customers, defaults, ...rest } = input;
  const quantity = customers ? customers.length : rest.quantity;

  const result = await createBulkLicenses({
    productId: 'school-accreditation',
    idempotencyKey: newIdem(),
    ...rest,
    quantity,
  });

  if (!customers) return result;

  for (let i = 0; i < customers.length; i += 1) {
    const raw = customers[i];
    const c = { ...(defaults || {}), ...(typeof raw === 'string' ? { name: raw } : raw) };
    const item = result.items[i];

    await pool.query(
      `UPDATE customers
       SET name = $2, email = $3, sale_price = $4, currency = $5, sold_at = $6, notes = $7,
           sale_status = 'sold'
       WHERE id = $1`,
      [item.customerId, c.name ?? null, c.email ?? null, c.salePrice ?? null, c.currency ?? null,
        c.soldAt ?? null, c.notes ?? null]
    );

    item.customerName = c.name ?? null;
    item.salePrice = c.salePrice ?? null;
    item.currency = c.currency ?? null;
  }

  return result;
}

module.exports = { bulkWithSales, newIdem };
