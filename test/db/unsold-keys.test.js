'use strict';

// Acceptance tests for "create keys first, record the sale later":
// bulk creation is anonymous + UNSOLD; customer/sale data is added afterwards
// per license and never touches the key, devices or activations.
// Runs ONLY against the disposable test database.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { pool, resetDatabase, request, admin, closeAll } = require('./helpers/setup');
const { createBulkLicenses } = require('../../src/services/bulkLicenseService');
const { COLUMNS } = require('../../src/services/exportService');

const API = '/api/v1/licenses';
let idem = 0;
const newIdem = () => `unsold-batch-${Date.now()}-${++idem}`;
const SCHOOL = 'school-accreditation';

const create = (body, key = newIdem()) =>
  admin('POST', '/licenses/bulk', { headers: { 'Idempotency-Key': key }, body: { productId: SCHOOL, ...body } });

const counts = async () => (await pool.query(`
  SELECT (SELECT COUNT(*)::int FROM customers) AS customers,
         (SELECT COUNT(*)::int FROM licenses) AS licenses,
         (SELECT COUNT(*)::int FROM license_batches) AS batches,
         (SELECT last_number::int FROM customer_number_counter) AS counter`)).rows[0];

async function licensingSnapshot() {
  const q = (sql) => pool.query(sql).then((r) => r.rows);
  return {
    licenses: await q('SELECT * FROM licenses ORDER BY id'),
    devices: await q('SELECT * FROM devices ORDER BY id'),
    activations: await q('SELECT * FROM activations ORDER BY id'),
  };
}

function parseCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const records = []; let field = ''; let row = []; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(field); records.push(row); row = []; field = ''; }
    else field += ch;
  }
  return records;
}

before(() => resetDatabase('full'));
beforeEach(async () => {
  await pool.query('TRUNCATE activations, devices, licenses, customers, license_batches CASCADE');
  await pool.query('UPDATE customer_number_counter SET last_number = 0');
});
after(closeAll);

// ---------------------------------------------------------------- 1, 2, 5
test('T1/T2/T5. batches of 1, 100 and 1000 anonymous keys; no duplicate keys or numbers', async () => {
  const seen = new Set();
  let expectedTotal = 0;

  for (const quantity of [1, 100, 1000]) {
    const res = await create({ quantity, maxDevices: 2, duration: 'lifetime', plan: 'pro' });
    assert.equal(res.status, 201, JSON.stringify(res.json).slice(0, 300));
    assert.equal(res.json.items.length, quantity);
    expectedTotal += quantity;

    for (const item of res.json.items) {
      assert.ok(!seen.has(item.licenseKey), 'key unique across batches');
      seen.add(item.licenseKey);
      assert.equal(item.saleStatus, 'unsold');
      assert.equal(item.productId, SCHOOL);
    }
  }

  const c = await counts();
  assert.equal(c.licenses, expectedTotal);
  assert.equal(c.customers, expectedTotal);
  assert.equal(c.counter, expectedTotal);

  const d = (await pool.query(`
    SELECT COUNT(DISTINCT license_key)::int AS keys,
           (SELECT COUNT(DISTINCT customer_number)::int FROM customers) AS numbers,
           (SELECT COUNT(*)::int FROM customers WHERE name IS NOT NULL OR email IS NOT NULL
              OR phone IS NOT NULL OR sale_price IS NOT NULL OR currency IS NOT NULL
              OR sold_at IS NOT NULL OR notes IS NOT NULL OR sale_status <> 'unsold') AS with_data,
           (SELECT COUNT(*)::int FROM licenses WHERE status <> 'ACTIVE' OR max_devices <> 2) AS odd
    FROM licenses`)).rows[0];
  assert.deepEqual(d, { keys: expectedTotal, numbers: expectedTotal, with_data: 0, odd: 0 });
  assert.equal(seen.size, 1101);
});

test('T5b. names / sale data in the create request are refused (nothing is created)', async () => {
  for (const body of [{ customers: [{ name: 'x' }] }, { quantity: 3, defaults: { salePrice: '5', currency: 'EGP' } }]) {
    const res = await create(body);
    assert.equal(res.status, 400);
    assert.match(res.json.message, /أسماء العملاء/);
  }
  assert.equal((await counts()).licenses, 0);
});

// ---------------------------------------------------------------------- 3
test('T3. a failure in the middle of a 100-key batch rolls EVERYTHING back (no keys, no numbers, no batch row)', async () => {
  const faultyDb = (failOn) => ({
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          if (failOn.test(String(sql))) throw new Error('simulated database failure');
          return client.query(sql, params);
        },
        release(err) { client.release(err); },
      };
    },
  });

  const before = await counts();

  // fails while inserting the licenses (customers rows were already inserted in the transaction)
  await assert.rejects(
    () => createBulkLicenses({ productId: SCHOOL, idempotencyKey: newIdem(), quantity: 100 },
      { db: faultyDb(/INSERT INTO licenses/) }),
    /simulated database failure/
  );
  assert.deepEqual(await counts(), before);

  // fails on the final read-back/UPDATE of the batch
  await assert.rejects(
    () => createBulkLicenses({ productId: SCHOOL, idempotencyKey: newIdem(), quantity: 100 },
      { db: faultyDb(/UPDATE license_batches/) }),
    /simulated database failure/
  );
  assert.deepEqual(await counts(), before);

  // an unknown program also fails the whole request without leftovers
  const bad = await create({ quantity: 100, productId: 'no-such-program' });
  assert.ok(bad.status >= 400 && bad.status < 500);
  assert.deepEqual(await counts(), before);

  // and a healthy retry afterwards starts at number 1 (nothing was wasted)
  const ok = await create({ quantity: 5 });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.json.items.map((i) => i.customerNumber), [1, 2, 3, 4, 5]);
});

// ---------------------------------------------------------------------- 4
test('T4. re-sending the same request (double click / retry) does not create a second batch', async () => {
  const key = newIdem();
  const [a, b] = await Promise.all([create({ quantity: 50 }, key), create({ quantity: 50 }, key)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.deepEqual(a.json.items.map((i) => i.licenseKey), b.json.items.map((i) => i.licenseKey));

  const third = await create({ quantity: 50 }, key);
  assert.equal(third.status, 200);
  assert.equal(third.json.replayed, true);

  const c = await counts();
  assert.deepEqual({ licenses: c.licenses, customers: c.customers, batches: c.batches }, { licenses: 50, customers: 50, batches: 1 });

  const conflict = await create({ quantity: 51 }, key);
  assert.equal(conflict.status, 409, 'same key + different payload is refused');
  assert.equal((await counts()).licenses, 50);
});

// ------------------------------------------------------------------ 6, 7, 9
test('T6/T7/T9. sale data is added after creation and never changes the key, device id or activation; old client API unchanged', async () => {
  const res = await create({ quantity: 3, maxDevices: 2 });
  const [a, b] = res.json.items;

  // old client contract on a freshly created key
  const act = await request('POST', `${API}/activate`, { body: { licenseKey: a.licenseKey, deviceId: 'DEV-AAA-1' } });
  assert.equal(act.status, 200, 'legacy contract (old repo HEAD): activate success is HTTP 200');
  assert.equal(act.json.status, 'active');
  assert.equal((await request('POST', `${API}/activate`, { body: { licenseKey: a.licenseKey, deviceId: 'DEV-AAA-2' } })).json.status, 'active');
  assert.equal((await request('POST', `${API}/activate`, { body: { licenseKey: a.licenseKey, deviceId: 'DEV-AAA-3' } })).json.status, 'device_limit_reached');
  assert.equal((await request('POST', `${API}/activate`, { body: { licenseKey: b.licenseKey, deviceId: 'DEV-BBB-1' } })).json.status, 'active');
  assert.equal((await request('POST', `${API}/validate`, { body: { licenseKey: a.licenseKey, deviceId: 'DEV-AAA-1' } })).json.status, 'active');

  // activation alone does NOT make it "sold"
  let row = (await admin('GET', `/license-records?q=${a.licenseKey}`)).json.rows[0];
  assert.equal(row.sale_status, 'unsold');
  assert.equal(row.customer_name, null);
  assert.equal(row.active_devices, 2);

  const before = await licensingSnapshot();

  // record the sale afterwards
  const edit = await admin('PATCH', `/customers/${a.customerId}`, {
    body: {
      name: 'مدرسة الأمل', phone: '+20 100 000 0000', email: 'school@example.com',
      salePrice: '1750.50', currency: 'EGP', soldAt: '2026-10-01', paymentStatus: 'partial', notes: 'دفعة أولى',
    },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));
  assert.equal(edit.json.customer.sale_status, 'sold');
  assert.equal(edit.json.customer.payment_status, 'partial');
  assert.equal(edit.json.customer.customer_number, a.customerNumber, 'record number is permanent');

  for (const body of [
    { name: 'مدرسة الأمل الدولية' },
    { salePrice: '2000', currency: 'USD', paymentStatus: 'paid' },
    { soldAt: '2026-10-05', notes: null },
    { paymentStatus: 'unpaid', phone: null },
  ]) {
    assert.equal((await admin('PATCH', `/customers/${a.customerId}`, { body })).status, 200);
  }

  assert.deepEqual(await licensingSnapshot(), before, 'licenses/devices/activations byte-identical');

  row = (await admin('GET', `/license-records?q=${a.licenseKey}`)).json.rows[0];
  assert.deepEqual(
    [row.customer_name, row.sale_price, row.currency, row.sold_at, row.sale_status, row.payment_status, row.license_key],
    ['مدرسة الأمل الدولية', '2000.00', 'USD', '2026-10-05', 'sold', 'unpaid', a.licenseKey]
  );

  // validation + separation of statuses
  const unpaidNotSold = await admin('PATCH', `/customers/${b.customerId}`, { body: { paymentStatus: 'paid' } });
  assert.equal(unpaidNotSold.status, 400, 'an unsold key cannot be marked paid');
  assert.equal((await admin('PATCH', `/customers/${b.customerId}`, { body: { saleStatus: 'maybe' } })).status, 400);
  assert.equal((await admin('PATCH', `/customers/${b.customerId}`, { body: { notes: 'ملاحظة فقط' } })).json.customer.sale_status, 'unsold', 'a note alone is not a sale');
  assert.equal((await admin('PATCH', `/customers/${b.customerId}`, { body: { phone: 'abc' } })).status, 400);

  // old client still works after the edits; deactivate success is 200 (fixed earlier)
  assert.equal((await request('POST', `${API}/validate`, { body: { licenseKey: a.licenseKey, deviceId: 'DEV-AAA-2' } })).json.status, 'active');
  const deact = await request('POST', `${API}/deactivate`, { body: { licenseKey: a.licenseKey, deviceId: 'DEV-AAA-2' } });
  assert.equal(deact.status, 200);
});

// ---------------------------------------------------------------------- 8
test('T8. CSV and Excel export: unsold keys separate from sold licenses, all required columns', async () => {
  const res = await create({ quantity: 6, maxDevices: 1 });
  const items = res.json.items;

  // sell two of them
  await admin('PATCH', `/customers/${items[0].customerId}`, {
    body: { name: '=HYPERLINK("x")', salePrice: '300', currency: 'EGP', soldAt: '2026-09-01', paymentStatus: 'paid', phone: '0100000000' },
  });
  await admin('PATCH', `/customers/${items[1].customerId}`, { body: { name: 'مدرسة "ب"', salePrice: '450.5', currency: 'SAR', paymentStatus: 'unpaid' } });
  await request('POST', `${API}/activate`, { body: { licenseKey: items[0].licenseKey, deviceId: 'EXP-DEV-1' } });

  // --- unsold CSV
  const unsold = await admin('POST', '/export', { raw: true, body: { format: 'csv', scope: 'unsold' } });
  assert.equal(unsold.status, 200);
  assert.match(unsold.headers.get('content-disposition'), /unsold-keys-.*\.csv/);
  assert.equal(unsold.headers.get('x-export-rows'), '4');
  const u = parseCsv(unsold.buffer);
  assert.deepEqual([...unsold.buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(u.length, 1 + 4);
  assert.deepEqual(u[0], COLUMNS.map((c) => c.header));
  const col = (name) => COLUMNS.findIndex((c) => c.key === name);
  const unsoldKeys = new Set(items.slice(2).map((i) => i.licenseKey));
  assert.deepEqual(new Set(u.slice(1).map((r) => r[col('license_key')])), unsoldKeys);
  assert.ok(u.slice(1).every((r) => r[col('customer_name')] === '' && r[col('sale_price')] === '' && r[col('sold_at')] === ''));
  assert.ok(u.slice(1).every((r) => /^\d+$/.test(r[col('customer_number')]) && r[col('license_key')].length > 10));

  // --- sold XLSX
  const sold = await admin('POST', '/export', { raw: true, body: { format: 'xlsx', scope: 'sold' } });
  assert.equal(sold.status, 200);
  assert.match(sold.headers.get('content-disposition'), /sold-licenses-.*\.xlsx/);
  assert.equal(sold.headers.get('x-export-rows'), '2');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(sold.buffer);
  const ws = wb.worksheets[0];
  assert.equal(ws.rowCount, 3);
  assert.deepEqual(COLUMNS.map((c, i) => ws.getRow(1).getCell(i + 1).value), COLUMNS.map((c) => c.header));

  const byNumber = {};
  ws.eachRow((row, n) => { if (n > 1) byNumber[row.getCell(1).value] = row; });
  const r0 = byNumber[items[0].customerNumber];
  assert.equal(typeof r0.getCell(col('customer_number') + 1).value, 'number');
  assert.equal(r0.getCell(col('customer_name') + 1).value, `'=HYPERLINK("x")`, 'formula neutralised, never a formula');
  assert.equal(r0.getCell(col('sale_price') + 1).value, 300);
  assert.equal(r0.getCell(col('currency') + 1).value, 'EGP');
  assert.equal(r0.getCell(col('sold_at') + 1).value, '2026-09-01');
  assert.equal(r0.getCell(col('activation_state') + 1).value, 'مفعّل');
  assert.equal(r0.getCell(col('active_devices') + 1).value, 1);
  assert.equal(r0.getCell(col('license_key') + 1).value, items[0].licenseKey);
  assert.equal(r0.getCell(col('license_type') + 1).value, 'دائم');
  const r1 = byNumber[items[1].customerNumber];
  assert.equal(r1.getCell(col('activation_state') + 1).value, 'غير مفعّل');
  assert.equal(r1.getCell(col('customer_name') + 1).value, 'مدرسة "ب"');

  // --- the batch itself (what the create screen exports) and filter by batch
  const batch = await admin('POST', '/export', {
    raw: true, body: { format: 'csv', scope: 'selected', licenseIds: items.map((i) => i.licenseId) },
  });
  assert.equal(parseCsv(batch.buffer).length, 1 + 6);

  const byBatch = await admin('GET', `/license-records?batchId=${res.json.batchId}&pageSize=200`);
  assert.equal(byBatch.json.total, 6);
  assert.equal((await admin('GET', '/license-records?batchId=not-a-uuid')).status, 400);

  // payment filter + activation filter
  assert.equal((await admin('GET', '/license-records?paymentStatus=paid')).json.total, 1);
  assert.equal((await admin('GET', '/license-records?activation=activated')).json.total, 1);
  assert.equal((await admin('GET', '/license-records?saleStatus=sold')).json.total, 2);

  // summary separates sold / unsold from license status
  const sum = (await admin('GET', '/license-records')).json.summary;
  assert.equal(sum.unsold, 4);
  assert.equal(sum.sold, 2);
  assert.equal(sum.active, 6);
});

// --------------------------------------------------------------------- 10
test('T10. an existing sold/anonymous mix and live devices survive creating more batches', async () => {
  const first = await create({ quantity: 4 });
  await request('POST', `${API}/activate`, { body: { licenseKey: first.json.items[0].licenseKey, deviceId: 'KEEP-1' } });
  await admin('PATCH', `/customers/${first.json.items[0].customerId}`, { body: { name: 'عميل قائم', salePrice: '10', currency: 'EGP' } });
  const before = await licensingSnapshot();
  const customersBefore = (await pool.query('SELECT * FROM customers ORDER BY customer_number')).rows;

  await create({ quantity: 100 });
  await create({ quantity: 100 });

  const after = await licensingSnapshot();
  // everything that existed before is still there, byte-identical
  for (const table of ['licenses', 'devices', 'activations']) {
    assert.deepEqual(after[table].slice(0).filter((r) => before[table].some((o) => o.id === r.id)).sort((x, y) => x.id.localeCompare(y.id)),
      before[table].sort((x, y) => x.id.localeCompare(y.id)), table);
  }
  const customersAfter = (await pool.query('SELECT * FROM customers WHERE customer_number <= 4 ORDER BY customer_number')).rows;
  assert.deepEqual(customersAfter, customersBefore);
});
