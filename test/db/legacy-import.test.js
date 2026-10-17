'use strict';

// Legacy import (old schema -> v4.1): safe, idempotent, never overwrites, keeps the
// legacy activation API working for imported keys. Disposable test database only.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, request, admin, closeAll } = require('./helpers/setup');
const { parseCopyDump, importLegacy } = require('../../scripts/import-legacy-data');

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TS = '2026-01-01 10:00:00+00';

function dump({ customers, licenses, devices, activations, payments, extraCustomerCol } = {}) {
  const block = (t, cols, rows) => `COPY public.${t} (${cols}) FROM stdin;\n${rows.map((r) => r.join('\t')).join('\n')}\n\\.\n`;
  return [
    block('activations', 'id, license_id, device_id, activated_at, deactivated_at', activations ?? [[U(900), U(300), U(500), TS, '\\N']]),
    block('customers', 'id, name, email, created_at, updated_at' + (extraCustomerCol ? ', surprise' : ''), customers ?? [
      [U(100), 'Alice School', 'a@example.test', '2026-01-02 10:00:00+00', TS],
      [U(101), '\\N', '\\N', '2026-01-01 09:00:00+00', TS],
      [U(102), 'Bob Academy', 'b@example.test', '2026-01-03 10:00:00+00', TS]]),
    block('devices', 'id, device_id, created_at, last_seen_at', devices ?? [[U(500), 'LEGACY-DEV-1', TS, TS]]),
    block('licenses', 'id, license_key, product_id, status, max_devices, expires_at, created_at, updated_at, customer_id, plan, license_type',
      licenses ?? [
        [U(300), 'LEGACY-KEY-0001', 'school-accreditation', 'ACTIVE', '1', '\\N', TS, TS, U(100), 'pro', 'perpetual'],
        [U(301), 'LEGACY-KEY-0002', 'school-accreditation', 'REVOKED', '2', '2027-01-01 00:00:00+00', TS, TS, U(102), 'pro', 'perpetual']]),
    block('payment_orders', 'id, provider, provider_invoice_id, provider_payment_id, customer_reference, customer_name, customer_email, amount, currency, duration, plan, max_devices, product_id, status, license_id, created_at, updated_at',
      payments ?? [[U(700), 'myfatoorah', 'INV-1', 'PAY-1', 'REF-1', 'Alice School', 'a@example.test', '99.00', 'SAR', 'lifetime', 'pro', '1', 'school-accreditation', 'paid', U(300), TS, TS]]),
    block('products', 'id, product_id, name, created_at', [[U(1), 'school-accreditation', 'Accreditation Pro', TS]]),
  ].join('\n');
}

const run = (text, opts = {}) => {
  const c = pool.connect();
  return c.then(async (client) => {
    try { return await importLegacy(client, parseCopyDump(text), opts); } finally { client.release(); }
  });
};
const n = async (t) => (await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;

before(() => resetDatabase('full'));
beforeEach(() => resetDatabase('full'));
after(closeAll);

test('plan changes nothing; apply imports everything and verifies it', async () => {
  const plan = await run(dump());
  assert.equal(plan.committed, false);
  assert.equal(await n('customers'), 0);
  assert.equal(await n('licenses'), 0);

  const r = await run(dump(), { apply: true });
  assert.equal(r.committed, true);
  assert.deepEqual(r.inserted, { products: 0, customers: 3, licenses: 2, devices: 1, activations: 1, payment_orders: 1 });
  assert.deepEqual(r.verify, { customers: 0, licenses: 0, devices: 0, activations: 0, payment_orders: 0 });
  assert.equal(await n('admin_audit_log'), 1);
});

test('customers are numbered in creation order; sale_status follows the migration-007 rule', async () => {
  await run(dump(), { apply: true });
  const rows = (await pool.query('SELECT id, customer_number::int AS no, sale_status, payment_status, sale_price FROM customers ORDER BY customer_number')).rows;
  assert.deepEqual(rows.map((x) => x.id), [U(101), U(100), U(102)]);   // by created_at
  assert.deepEqual(rows.map((x) => x.no), [1, 2, 3]);
  assert.deepEqual(rows.map((x) => x.sale_status), ['unsold', 'sold', 'sold']);
  assert.ok(rows.every((x) => x.payment_status === null && x.sale_price === null));   // nothing invented
  assert.equal((await pool.query('SELECT last_number::int AS n FROM customer_number_counter')).rows[0].n, 3);
  // a new customer after the import continues the sequence
  const r = await pool.query("INSERT INTO customers (name) VALUES ('later') RETURNING customer_number::int AS no");
  assert.equal(r.rows[0].no, 4);
});

test('re-running is safe: nothing duplicated, nothing changed', async () => {
  await run(dump(), { apply: true });
  await assert.rejects(run(dump(), { apply: true }), /already has data/);
  const again = await run(dump(), { apply: true, allowNonEmpty: true });
  assert.deepEqual(again.inserted, { products: 0, customers: 0, licenses: 0, devices: 0, activations: 0, payment_orders: 0 });
  assert.equal(await n('customers'), 3);
  assert.equal(await n('licenses'), 2);
});

test('conflicts abort everything and never overwrite', async () => {
  await pool.query(`INSERT INTO licenses (id, license_key, product_id) VALUES ($1, 'LEGACY-KEY-0001', 'school-accreditation')`, [U(999)]);
  await assert.rejects(run(dump(), { apply: true, allowNonEmpty: true }), /license_key already used/);
  assert.equal(await n('customers'), 0);                                    // rolled back as a whole
  assert.equal((await pool.query('SELECT id FROM licenses')).rows[0].id, U(999));   // untouched

  await resetDatabase('full');
  await pool.query(`INSERT INTO customers (id, name) VALUES ($1, 'Different Name')`, [U(100)]);
  await assert.rejects(run(dump(), { apply: true, allowNonEmpty: true }), /same id, different content/);
  assert.equal((await pool.query('SELECT name FROM customers WHERE id=$1', [U(100)])).rows[0].name, 'Different Name');
});

test('broken source or schema is rejected before anything is written', async () => {
  await assert.rejects(run(dump({ licenses: [[U(300), 'K', 'no-such-product', 'ACTIVE', '1', '\\N', TS, TS, U(100), 'pro', 'perpetual']] }), { apply: true }), /product not in target/);
  await assert.rejects(run(dump({ licenses: [[U(300), 'K', 'school-accreditation', 'ACTIVE', '1', '\\N', TS, TS, U(555), 'pro', 'perpetual']] }), { apply: true }), /customer missing/);
  await assert.rejects(run(dump({ activations: [[U(900), U(300), U(599), TS, '\\N']] }), { apply: true }), /license or device missing/);
  await assert.rejects(run(dump({ extraCustomerCol: true, customers: [[U(100), 'x', 'y', TS, TS, 'z']] }), { apply: true }), /not the old schema/);
  assert.equal(await n('customers') + await n('licenses'), 0);
});

test('imported legacy keys still work through the unchanged activation API and the admin list', async () => {
  await run(dump(), { apply: true });
  // legacy contract (old repo HEAD): success on activate/validate/deactivate is HTTP 200 with lowercase status
  let r = await request('POST', '/api/v1/licenses/validate', { body: { licenseKey: 'LEGACY-KEY-0001', deviceId: 'LEGACY-DEV-1' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.message, 'License is valid.');
  r = await request('POST', '/api/v1/licenses/activate', { body: { licenseKey: 'LEGACY-KEY-0001', deviceId: 'LEGACY-DEV-2' } });
  assert.equal(r.json.status, 'device_limit_reached');   // the imported active activation still counts
  const list = await admin('GET', '/license-records?archived=exclude&sort=created_at&dir=desc&page=1&pageSize=25');
  assert.equal(list.status, 200);
  const keys = list.json.rows.map((x) => x.license_key);
  assert.ok(keys.includes('LEGACY-KEY-0001') && keys.includes('LEGACY-KEY-0002'));
});
