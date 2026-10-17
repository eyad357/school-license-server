'use strict';

// Migration 007 (sale_status / payment_status / phone) against a database that
// already has 004-006 applied and real-looking data. Test database only.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, readSql, closeAll } = require('./helpers/setup');
const { runMigration, assertNonDestructive, snapshotProtected } = require('../../scripts/migrate');

const hasColumn = async (c) =>
  (await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='customers' AND column_name=$1", [c])).rowCount === 1;

const run = async (key, mode) => {
  const client = await pool.connect();
  try { return await runMigration(client, readSql(key), { mode }); } finally { client.release(); }
};

before(async () => {
  await resetDatabase('legacy');
  // pre-existing data in the OLD shape (before 004)
  const cid = async (name) => (await pool.query('INSERT INTO customers (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  const named = await cid('عميل قديم له اسم');
  const blank = (await pool.query('INSERT INTO customers (name) VALUES (NULL) RETURNING id')).rows[0].id;
  const lic = async (key, customer) => (await pool.query(
    `INSERT INTO licenses (license_key, product_id, status, max_devices, customer_id, plan, license_type)
     VALUES ($1,'school-accreditation','ACTIVE',2,$2,'pro','perpetual') RETURNING id`, [key, customer])).rows[0].id;
  const l1 = await lic('SCHL-OLD000-000001-AAAAAA-AAAAAA', named);
  await lic('SCHL-OLD000-000002-BBBBBB-BBBBBB', blank);
  const d = (await pool.query("INSERT INTO devices (device_id) VALUES ('OLD-DEV-1') RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO activations (license_id, device_id) VALUES ($1,$2)', [l1, d]);

  await run('customerManagement', 'apply');
  await run('productsPlatform', 'apply');
  await run('eventsAudit', 'apply');

  // 004-era sale data on one more row (price only, no name)
  const priced = await cid('x');
  await pool.query("UPDATE customers SET name = NULL, sale_price = 99, currency = 'EGP' WHERE id = $1", [priced]);
});
after(closeAll);

test('007 is additive: the SQL contains nothing destructive', () => {
  assertNonDestructive(readSql('saleStatus'));
});

test('007 plan (dry run) changes nothing', async () => {
  const before = await snapshotProtected(pool);
  await run('saleStatus', 'plan');
  assert.equal(await hasColumn('sale_status'), false);
  assert.deepEqual(await snapshotProtected(pool), before);
});

test('007 apply: licenses/devices/activations untouched, back-fill is conservative, re-run is a no-op', async () => {
  const before = await snapshotProtected(pool);
  const customersBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM customers')).rows[0].n;

  await run('saleStatus', 'apply');

  assert.deepEqual(await snapshotProtected(pool), before, 'licenses/devices/activations identical');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM customers')).rows[0].n, customersBefore, 'no customer lost');
  for (const c of ['sale_status', 'payment_status', 'phone']) assert.equal(await hasColumn(c), true, c);

  const { rows } = await pool.query('SELECT name, sale_price, sale_status, payment_status FROM customers ORDER BY customer_number');
  assert.deepEqual(rows.map((r) => r.sale_status), ['sold', 'unsold', 'sold'], 'named => sold, empty => unsold, priced => sold');
  assert.ok(rows.every((r) => r.payment_status === null), 'payment status is never invented');

  const again = await snapshotProtected(pool);
  await run('saleStatus', 'apply');
  assert.deepEqual(await snapshotProtected(pool), again);
  assert.deepEqual((await pool.query('SELECT sale_status FROM customers ORDER BY customer_number')).rows.map((r) => r.sale_status), ['sold', 'unsold', 'sold']);
});

test('007 constraints: invalid statuses and "paid but unsold" are refused by the database', async () => {
  const id = (await pool.query("INSERT INTO customers (name) VALUES (NULL) RETURNING id")).rows[0].id;
  await assert.rejects(() => pool.query("UPDATE customers SET sale_status = 'maybe' WHERE id = $1", [id]), /customers_sale_status_valid/);
  await assert.rejects(() => pool.query("UPDATE customers SET payment_status = 'free' WHERE id = $1", [id]), /customers_payment_status_valid/);
  await assert.rejects(() => pool.query("UPDATE customers SET payment_status = 'paid' WHERE id = $1", [id]), /customers_unsold_not_paid/);
  await pool.query("UPDATE customers SET sale_status = 'sold', payment_status = 'paid' WHERE id = $1", [id]);
});

test('007 on a database WITHOUT 004 fails with a clear prerequisite message, changes nothing, and works once 004-006 are applied', async () => {
  await resetDatabase('legacy'); // schema + 002 + 003 only: no sale_price column
  await pool.query("INSERT INTO customers (name) VALUES ('عميل قديم')");
  const before = await snapshotProtected(pool);

  await assert.rejects(() => run('saleStatus', 'apply'), (e) => {
    assert.match(e.message, /007 needs migration 004 first/);
    assert.match(e.message, /sale_price/);
    assert.doesNotMatch(e.message, /does not exist/);
    return true;
  });
  assert.equal(await hasColumn('sale_status'), false, 'rolled back: nothing added');
  assert.deepEqual(await snapshotProtected(pool), before);

  await run('customerManagement', 'apply');
  await run('productsPlatform', 'apply');
  await run('eventsAudit', 'apply');
  await run('saleStatus', 'apply');
  assert.equal(await hasColumn('sale_status'), true);
  assert.deepEqual((await pool.query('SELECT sale_status, payment_status FROM customers')).rows, [{ sale_status: 'sold', payment_status: null }]);
});
