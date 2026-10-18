'use strict';

// Deleting customer records that have no license. Runs ONLY against the disposable test database.

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, admin, closeAll } = require('./helpers/setup');
const { bulkWithSales } = require('./helpers/bulk');

before(() => resetDatabase('full'));
beforeEach(async () => {
  await pool.query('TRUNCATE activations, devices, licenses, customers, license_batches CASCADE');
  await pool.query('UPDATE customer_number_counter SET last_number = 0');
});
after(closeAll);

test('deletes only license-less customers, keeps customers that own a license, renumbers 1..N', async () => {
  const b = await bulkWithSales({ productId: 'school-accreditation', quantity: 1, maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  const withLicense = (await pool.query('SELECT customer_id FROM licenses LIMIT 1')).rows[0].customer_id;
  const a = (await pool.query("INSERT INTO customers (name) VALUES ('بدون ترخيص 1') RETURNING id")).rows[0].id;
  const c = (await pool.query("INSERT INTO customers (name) VALUES ('بدون ترخيص 2') RETURNING id")).rows[0].id;
  const before = (await pool.query('SELECT id, customer_number::int n FROM customers ORDER BY n')).rows;
  const keep = before.find((r) => r.id === withLicense);
  const licBefore = (await pool.query('SELECT count(*)::int n FROM licenses')).rows[0].n;

  const r = await admin('POST', '/records/delete-customers', { body: { customerIds: [a, c, withLicense] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, 2);
  assert.equal(r.json.skipped, 1);

  const left = (await pool.query('SELECT id, customer_number::int n FROM customers')).rows;
  assert.equal(left.length, 1);
  assert.equal(left[0].id, withLicense);
  assert.equal(left[0].n, 1, 'renumbered to 1..N');
  assert.equal(r.json.renumbered, true);
  assert.ok(keep);
  assert.equal((await pool.query('SELECT count(*)::int n FROM licenses')).rows[0].n, licBefore, 'licenses untouched');
  assert.equal((await pool.query("SELECT count(*)::int n FROM admin_audit_log WHERE action='customer.delete'")).rows[0].n, 2);
  assert.ok(b);
});

test('validation: empty list, bad id, too many', async () => {
  assert.equal((await admin('POST', '/records/delete-customers', { body: { customerIds: [] } })).status, 400);
  assert.equal((await admin('POST', '/records/delete-customers', { body: { customerIds: ['x'] } })).status, 400);
  assert.equal((await admin('POST', '/records/delete-customers', { body: {} })).status, 400);
  assert.equal((await admin('POST', '/records/delete-customers', { body: { customerIds: Array(1001).fill('00000000-0000-4000-8000-000000000000') } })).status, 400);
});

test('deleting #3 of 5 shifts #4,#5 down; numbers stay 1..N; next new customer continues after N', async () => {
  const ids = [];
  for (let i = 1; i <= 5; i++) ids.push((await pool.query('INSERT INTO customers (name) VALUES ($1) RETURNING id', [`c${i}`])).rows[0].id);
  const r = await admin('POST', '/records/delete-customers', { body: { customerIds: [ids[2]] } });
  assert.equal(r.status, 200);
  const rows = (await pool.query('SELECT name, customer_number::int n FROM customers ORDER BY n')).rows;
  assert.deepEqual(rows.map((x) => [x.name, x.n]), [['c1', 1], ['c2', 2], ['c4', 3], ['c5', 4]]);
  const nx = (await pool.query("INSERT INTO customers (name) VALUES ('new') RETURNING customer_number::int n")).rows[0].n;
  assert.equal(nx, 5);
});

test('standalone renumber closes gaps, keeps order and licenses, and continues the counter', async () => {
  await pool.query("INSERT INTO customers (name) VALUES ('a'),('b'),('c'),('d')");
  await pool.query("ALTER TABLE customers DISABLE TRIGGER trg_customers_protect_customer_number");
  await pool.query("UPDATE customers SET customer_number = CASE name WHEN 'a' THEN 21 WHEN 'b' THEN 23 WHEN 'c' THEN 30 ELSE 45 END");
  await pool.query("ALTER TABLE customers ENABLE TRIGGER trg_customers_protect_customer_number");
  const r = await admin('POST', '/records/renumber', { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 4);
  const rows = (await pool.query('SELECT name, customer_number::int n FROM customers ORDER BY n')).rows;
  assert.deepEqual(rows.map((x) => [x.name, x.n]), [['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
  assert.equal((await pool.query("SELECT count(*)::int n FROM admin_audit_log WHERE action='customer.renumber'")).rows[0].n, 1);
});
