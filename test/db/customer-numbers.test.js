'use strict';

// Tests 6-11 of the brief: bulk creation, customer numbers, uniqueness,
// stability, no reuse, concurrency.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, admin, closeAll } = require('./helpers/setup');
const { createBulkLicenses } = require('../../src/services/bulkLicenseService');
const { createCustomerAndLicense } = require('../../src/services/adminLicenseService');

const KEY_FORMAT = /^SCHL-[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/;
let idem = 0;
const newIdem = () => `test-batch-${Date.now()}-${++idem}`;

const { bulkWithSales } = require('./helpers/bulk');
const bulk = (input) => bulkWithSales(input);

async function dbCounts() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM customers) AS customers,
      (SELECT COUNT(*)::int FROM licenses) AS licenses,
      (SELECT COUNT(DISTINCT license_key)::int FROM licenses) AS distinct_keys,
      (SELECT COUNT(DISTINCT customer_number)::int FROM customers) AS distinct_numbers,
      (SELECT COALESCE(MIN(customer_number), 0)::int FROM customers) AS min_number,
      (SELECT COALESCE(MAX(customer_number), 0)::int FROM customers) AS max_number
  `);
  return rows[0];
}

before(() => resetDatabase('full'));
beforeEach(async () => {
  await pool.query('TRUNCATE activations, devices, licenses, customers, license_batches CASCADE');
  await pool.query('UPDATE customer_number_counter SET last_number = 0');
});
after(closeAll);

test('6. 100 licenses: keys and customer numbers are unique, numbers run 1..100 in order', async () => {
  const result = await bulk({ productId: 'school-accreditation', quantity: 100, maxDevices: 2, duration: 'lifetime', plan: 'pro' });

  assert.equal(result.quantity, 100);
  assert.equal(result.items.length, 100);

  const keys = new Set(result.items.map((i) => i.licenseKey));
  assert.equal(keys.size, 100);
  assert.ok(result.items.every((i) => KEY_FORMAT.test(i.licenseKey)), 'key format unchanged');

  assert.deepEqual(
    result.items.map((i) => i.customerNumber),
    Array.from({ length: 100 }, (_, i) => i + 1)
  );

  const c = await dbCounts();
  assert.deepEqual(
    { customers: c.customers, licenses: c.licenses, distinct_keys: c.distinct_keys, distinct_numbers: c.distinct_numbers },
    { customers: 100, licenses: 100, distinct_keys: 100, distinct_numbers: 100 }
  );

  // every license really is linked to its own customer
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM licenses l JOIN customers c ON c.id = l.customer_id`
  );
  assert.equal(rows[0].n, 100);
});

test('7. 1000 licenses via the HTTP API complete; 0 / 1001 are rejected', async () => {
  const started = Date.now();
  const res = await admin('POST', '/licenses/bulk', {
    headers: { 'Idempotency-Key': newIdem() },
    body: { productId: 'school-accreditation', quantity: 1000, maxDevices: 1, duration: 'lifetime', plan: 'pro' },
  });
  const ms = Date.now() - started;

  assert.equal(res.status, 201, JSON.stringify(res.json).slice(0, 300));
  assert.equal(res.json.items.length, 1000);
  assert.equal(new Set(res.json.items.map((i) => i.licenseKey)).size, 1000);
  console.log(`# 1000 licenses created over HTTP in ${ms} ms`);

  const c = await dbCounts();
  assert.equal(c.licenses, 1000);
  assert.equal(c.customers, 1000);
  assert.equal(c.distinct_keys, 1000);
  assert.equal(c.min_number, 1);
  assert.equal(c.max_number, 1000);

  for (const quantity of [0, 1001, -5, 'abc', 2.5]) {
    const bad = await admin('POST', '/licenses/bulk', {
      headers: { 'Idempotency-Key': newIdem() },
      body: { quantity },
    });
    assert.equal(bad.status, 400, `quantity ${quantity}`);
  }

  assert.equal((await dbCounts()).licenses, 1000, 'rejected requests created nothing');
});

test('8. keys are created anonymous and UNSOLD; legacy "names" payloads are refused; data is added later', async () => {
  const before0 = await dbCounts();

  // --- legacy payloads are rejected clearly and create nothing -----------------
  for (const legacy of [
    { customers: [{ name: 'مدرسة النور' }] },
    { quantity: 2, customers: ['أ', 'ب'] },
    { quantity: 2, defaults: { salePrice: '100', currency: 'EGP' } },
  ]) {
    await assert.rejects(
      () => createBulkLicenses({ productId: 'school-accreditation', idempotencyKey: newIdem(), ...legacy }),
      (e) => e.statusCode === 400 && /أسماء العملاء/.test(e.message)
    );
  }
  assert.deepEqual(await dbCounts(), before0, 'nothing was created');

  // --- anonymous batch: numbers exist, no customer data, status unsold ---------
  const unnamed = await createBulkLicenses({ productId: 'school-accreditation', idempotencyKey: newIdem(), quantity: 4, maxDevices: 1 });
  assert.deepEqual(unnamed.items.map((i) => i.customerNumber), [1, 2, 3, 4]);
  assert.ok(unnamed.items.every((i) => i.saleStatus === 'unsold'));
  assert.ok(!('customerName' in unnamed.items[0]), 'response carries no customer name');

  const { rows: raw } = await pool.query(
    'SELECT name, email, phone, sale_price, currency, sold_at, notes, sale_status, payment_status FROM customers'
  );
  assert.equal(raw.length, 4);
  assert.ok(raw.every((r) => r.name === null && r.email === null && r.phone === null && r.sale_price === null
    && r.currency === null && r.sold_at === null && r.notes === null && r.sale_status === 'unsold' && r.payment_status === null));

  // unsold keys are NOT "incomplete" (they are simply not sold yet)
  const incomplete = await admin('GET', '/license-records?incomplete=1&pageSize=200');
  assert.equal(incomplete.status, 200);
  assert.equal(incomplete.json.rows.length, 0);

  const unsold = await admin('GET', '/license-records?saleStatus=unsold&pageSize=200');
  assert.equal(unsold.json.rows.length, 4);

  // --- a name can be added afterwards without touching the license ----------------
  const target = unnamed.items[0];
  const licenseBefore = (await pool.query('SELECT * FROM licenses WHERE id = $1', [target.licenseId])).rows[0];
  const patch = await admin('PATCH', `/customers/${target.customerId}`, { body: { name: 'مدرسة الإخلاص' } });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.customer.customer_number, target.customerNumber);
  assert.equal(patch.json.customer.sale_status, 'sold', 'recording a buyer marks the key sold');
  assert.deepEqual(
    (await pool.query('SELECT * FROM licenses WHERE id = $1', [target.licenseId])).rows[0],
    licenseBefore
  );
});

test('9. the customer number never changes when name / price / notes are edited', async () => {
  const { items } = await bulk({ productId: 'school-accreditation', customers: [{ name: 'مدرسة أ' }, { name: 'مدرسة ب' }] });
  const [first] = items;

  const edits = [
    { name: 'مدرسة أ المعدلة' },
    { salePrice: '1500.5', currency: 'egp' },
    { salePrice: 2000, currency: 'SAR', soldAt: '2026-09-01', notes: 'دفعت نقدًا' },
    { notes: null, soldAt: null },
  ];

  for (const body of edits) {
    const r = await admin('PATCH', `/customers/${first.customerId}`, { body });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.customer.customer_number, first.customerNumber);
  }

  const { rows } = await pool.query('SELECT customer_number, sale_price, currency FROM customers WHERE id = $1', [
    first.customerId,
  ]);
  assert.equal(Number(rows[0].customer_number), first.customerNumber);
  assert.equal(rows[0].sale_price, '2000.00');
  assert.equal(rows[0].currency, 'SAR');

  // the database itself refuses to change a number, whoever tries
  await assert.rejects(
    () => pool.query('UPDATE customers SET customer_number = 9999 WHERE id = $1', [first.customerId]),
    /immutable/
  );

  // and the API cannot even ask for it (field is ignored, number unchanged)
  const sneaky = await admin('PATCH', `/customers/${first.customerId}`, {
    body: { name: 'x مدرسة', customer_number: 77, customerNumber: 77 },
  });
  assert.equal(sneaky.status, 200);
  assert.equal(sneaky.json.customer.customer_number, first.customerNumber);
});

test('10. numbers of archived or deleted customers are never reused', async () => {
  const a = await bulk({ productId: 'school-accreditation', customers: [{ name: 'أ' }, { name: 'ب' }, { name: 'ج' }] });
  assert.deepEqual(a.items.map((i) => i.customerNumber), [1, 2, 3]);

  // archive #3 (soft) -> next is 4
  assert.equal((await admin('POST', `/customers/${a.items[2].customerId}/archive`)).status, 200);
  const b = await bulk({ productId: 'school-accreditation', quantity: 1 });
  assert.equal(b.items[0].customerNumber, 4);

  // hard-delete the newest customer row (#4) -> next is 5, not 4
  await pool.query('DELETE FROM customers WHERE id = $1', [b.items[0].customerId]);
  const c = await bulk({ productId: 'school-accreditation', quantity: 1 });
  assert.equal(c.items[0].customerNumber, 5);

  // the legacy single-license path (used by the payment flow) shares the same counter
  const legacy = await createCustomerAndLicense({ productId: 'school-accreditation', customer: { name: 'مسار قديم' }, maxDevices: 1 });
  const { rows } = await pool.query('SELECT customer_number FROM customers WHERE id = $1', [legacy.customer.id]);
  assert.equal(Number(rows[0].customer_number), 6);

  // archived customers are hidden by default but still listed on request
  const hidden = await admin('GET', '/license-records?pageSize=200');
  assert.ok(!hidden.json.rows.some((r) => r.customer_id === a.items[2].customerId));
  const shown = await admin('GET', '/license-records?archived=include&pageSize=200');
  assert.ok(shown.json.rows.some((r) => r.customer_id === a.items[2].customerId));

  // restoring keeps the same number
  const restored = await admin('POST', `/customers/${a.items[2].customerId}/unarchive`);
  assert.equal(restored.json.customer.customer_number, 3);
  assert.equal(restored.json.customer.archived_at, null);
});

test('11. concurrent creation produces unique, gap-free numbers and unique keys', async () => {
  const bulkJobs = Array.from({ length: 10 }, () => bulk({ productId: 'school-accreditation', quantity: 30, maxDevices: 1 }));
  const legacyJobs = Array.from({ length: 20 }, (_, i) =>
    createCustomerAndLicense({ productId: 'school-accreditation', customer: { name: `قديم ${i}` }, maxDevices: 1 })
  );

  const results = await Promise.all([...bulkJobs, ...legacyJobs]);
  assert.equal(results.length, 30);

  const c = await dbCounts();
  assert.equal(c.customers, 320);
  assert.equal(c.licenses, 320);
  assert.equal(c.distinct_keys, 320);
  assert.equal(c.distinct_numbers, 320);
  assert.equal(c.min_number, 1);
  assert.equal(c.max_number, 320, 'numbers are contiguous: no gaps, no duplicates');

  // each bulk job got ONE contiguous block, in input order
  for (const result of results.slice(0, 10)) {
    const numbers = result.items.map((i) => i.customerNumber);
    assert.deepEqual(numbers, Array.from({ length: 30 }, (_, i) => numbers[0] + i));
  }

  const counter = await pool.query('SELECT last_number FROM customer_number_counter');
  assert.equal(Number(counter.rows[0].last_number), 320);
});
