'use strict';

// Regression: `migrate.js --plan src/db/007_sale_status.sql` on a database where 004 has not been APPLIED
// failed with `column "sale_price" does not exist` (sale_price/sold_at are created by 004).
// Root cause = ordering, not a wrong column name. These tests pin the fix.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, readSql, closeAll } = require('./helpers/setup');
const { runMigration, snapshotProtected, ALL_MIGRATIONS } = require('../../scripts/migrate');
const fs = require('fs');
const path = require('path');

const hasColumn = async (c) =>
  (await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='customers' AND column_name=$1", [c])).rowCount === 1;
const migrate = async (sql, mode) => {
  const client = await pool.connect();
  try { return await runMigration(client, sql, { mode }); } finally { client.release(); }
};
const allSql = () => ALL_MIGRATIONS.map((f) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'db', f), 'utf8')).join('\n;\n');

before(async () => {
  await resetDatabase('legacy'); // exactly what production has today: schema + 002 + 003
  await pool.query("INSERT INTO customers (name, email) VALUES ('عميل أ', NULL), (NULL, NULL), ('  ', NULL), ('عميل ب', 'b@example.test')");
  const lic = (await pool.query(
    `INSERT INTO licenses (license_key, product_id, status, max_devices) VALUES ('TEST-LEGACY-0001','school-accreditation','ACTIVE',2) RETURNING id`)).rows[0].id;
  const dev = (await pool.query("INSERT INTO devices (device_id) VALUES ('TEST-DEV-1') RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO activations (license_id, device_id) VALUES ($1,$2)', [lic, dev]);
});
after(closeAll);

test('the legacy customers table really has no sale_price (the cause of the error)', async () => {
  assert.equal(await hasColumn('sale_price'), false);
  assert.equal(await hasColumn('sold_at'), false);
});

test('007 alone on a pre-004 database fails with a clear instruction, changes nothing', async () => {
  const before = await snapshotProtected(pool);
  await assert.rejects(() => migrate(readSql('saleStatus'), 'plan'), (e) => {
    assert.match(e.message, /Apply 004_customer_management\.sql first/);
    assert.doesNotMatch(e.message, /column "sale_price" does not exist/);
    return true;
  });
  assert.equal(await hasColumn('sale_status'), false, 'no partial change survived the rollback');
  assert.deepEqual(await snapshotProtected(pool), before);
});

test('--all plan (004+005+006+007 together) succeeds and rolls everything back', async () => {
  const before = await snapshotProtected(pool);
  await migrate(allSql(), 'plan');
  for (const c of ['customer_number', 'sale_price', 'sale_status', 'phone']) assert.equal(await hasColumn(c), false, c);
  assert.deepEqual(await snapshotProtected(pool), before);
});

test('--all apply: customers classified correctly, no payment_status invented, protected tables identical, re-run is a no-op', async () => {
  const before = await snapshotProtected(pool);
  const custBefore = (await pool.query('SELECT COUNT(*)::int n FROM customers')).rows[0].n;
  await migrate(allSql(), 'apply');

  assert.deepEqual(await snapshotProtected(pool), before, 'licenses/devices/activations/products unchanged');
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM customers')).rows[0].n, custBefore, 'no customer lost');
  const { rows } = await pool.query('SELECT name, sale_status, payment_status FROM customers');
  const sold = rows.filter((r) => r.sale_status === 'sold').map((r) => r.name).sort();
  assert.deepEqual(sold, ['عميل أ', 'عميل ب'].sort(), 'named => sold');
  assert.equal(rows.filter((r) => r.sale_status === 'unsold').length, 2, 'NULL / blank name => unsold');
  assert.ok(rows.every((r) => r.payment_status === null), 'payment_status never invented');

  const nums = (await pool.query('SELECT customer_number FROM customers ORDER BY customer_number')).rows.map((r) => Number(r.customer_number));
  assert.deepEqual(nums, [1, 2, 3, 4], 'existing customers numbered without gaps/duplicates');

  const snap = await snapshotProtected(pool);
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='customers' ORDER BY 1")).rows.length;
  await migrate(allSql(), 'apply');
  assert.deepEqual(await snapshotProtected(pool), snap);
  assert.equal((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='customers'")).rows.length, cols, 'no duplicate columns');
});

test('after 004 is applied, 007 runs on its own again (the normal one-file-at-a-time path)', async () => {
  await resetDatabase('legacy');
  await migrate(readSql('customerManagement'), 'apply');
  await migrate(readSql('productsPlatform'), 'apply');
  await migrate(readSql('eventsAudit'), 'apply');
  await migrate(readSql('saleStatus'), 'plan');
  await migrate(readSql('saleStatus'), 'apply');
  assert.equal(await hasColumn('sale_status'), true);
});
