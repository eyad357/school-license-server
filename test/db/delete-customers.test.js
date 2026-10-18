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

test('deletes only license-less customers, keeps customers that own a license, no renumbering', async () => {
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
  assert.equal(left[0].n, keep.n, 'numbers are not shifted');
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
