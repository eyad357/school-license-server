'use strict';

// Migration 004 against a database that looks like production TODAY
// (schema + 002 + 003, with existing licenses, devices, activations, customers).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, readSql, request, admin, closeAll } = require('./helpers/setup');
const {
  runMigration, assertNonDestructive, snapshotProtected,
} = require('../../scripts/migrate');
const { createCustomerAndLicense } = require('../../src/services/adminLicenseService');

const hasColumn = async (table, column) =>
  (await pool.query(
    'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
    [table, column]
  )).rowCount === 1;

const ids = {};

async function seedLegacy() {
  await resetDatabase('legacy');

  // customers inserted OUT of chronological order on purpose
  const c = async (name, createdAt) =>
    (await pool.query(
      'INSERT INTO customers (name, email, created_at) VALUES ($1, $2, $3) RETURNING id',
      [name, `${name}@example.test`, createdAt]
    )).rows[0].id;

  ids.cNew = await c('الأحدث', '2026-03-03T00:00:00Z');
  ids.cOld = await c('الأقدم', '2026-01-01T00:00:00Z');
  ids.cMid = await c('الأوسط', '2026-02-02T00:00:00Z');

  const l = async (key, status, max, customerId, expires = null) =>
    (await pool.query(
      `INSERT INTO licenses (license_key, product_id, status, max_devices, expires_at, customer_id, plan, license_type)
       VALUES ($1, 'school-accreditation', $2, $3, $4, $5, 'pro', 'perpetual') RETURNING id`,
      [key, status, max, expires, customerId]
    )).rows[0].id;

  ids.lOld = await l('SCHL-LEGACY-000001-AAAAAA-AAAAAA', 'ACTIVE', 2, ids.cOld);
  ids.lMid = await l('SCHL-LEGACY-000002-BBBBBB-BBBBBB', 'REVOKED', 1, ids.cMid);
  ids.lNone = await l('SCHL-LEGACY-000003-CCCCCC-CCCCCC', 'ACTIVE', 3, null); // no customer at all
  ids.lNew = await l('SCHL-LEGACY-000004-DDDDDD-DDDDDD', 'ACTIVE', 1, ids.cNew);

  const dev = async (d) =>
    (await pool.query('INSERT INTO devices (device_id) VALUES ($1) RETURNING id', [d])).rows[0].id;
  const d1 = await dev('LEGACY-DEV-1');
  const d2 = await dev('LEGACY-DEV-2');

  await pool.query('INSERT INTO activations (license_id, device_id) VALUES ($1, $2), ($1, $3)', [ids.lOld, d1, d2]);
  await pool.query(
    'INSERT INTO activations (license_id, device_id, deactivated_at) VALUES ($1, $2, NOW())',
    [ids.lMid, d1]
  );
}

async function migrate(mode) {
  const client = await pool.connect();
  try {
    const result = await runMigration(client, readSql('customerManagement'), { mode });
    // 007 (sale status) builds on 004; the app code requires both.
    if (mode === 'apply') await runMigration(client, readSql('saleStatus'), { mode });
    return result;
  } finally {
    client.release();
  }
}

after(closeAll);

test('M1. dry run (--plan) shows the numbering and saves NOTHING', async () => {
  await seedLegacy();
  const before = await snapshotProtected(pool);

  const result = await migrate('plan');

  assert.equal(result.report.customers, 3);
  assert.equal(await hasColumn('customers', 'customer_number'), false, 'rolled back');
  assert.deepEqual(await snapshotProtected(pool), before);
});

test('M2. apply: existing licenses, devices, activations are byte-identical; customers numbered by created_at', async () => {
  await seedLegacy();
  const before = await snapshotProtected(pool);
  const licensesBefore = (await pool.query('SELECT * FROM licenses ORDER BY id')).rows;

  await migrate('apply');

  assert.deepEqual(await snapshotProtected(pool), before);
  assert.deepEqual((await pool.query('SELECT * FROM licenses ORDER BY id')).rows, licensesBefore);

  const { rows } = await pool.query('SELECT id, customer_number FROM customers ORDER BY customer_number');
  assert.deepEqual(rows.map((r) => r.id), [ids.cOld, ids.cMid, ids.cNew], 'oldest customer gets #1');
  assert.deepEqual(rows.map((r) => Number(r.customer_number)), [1, 2, 3]);

  // nothing invented for the sales data
  const sales = (await pool.query(
    'SELECT COUNT(*)::int AS n FROM customers WHERE sale_price IS NOT NULL OR currency IS NOT NULL OR sold_at IS NOT NULL OR notes IS NOT NULL'
  )).rows[0].n;
  assert.equal(sales, 0);

  // the license that had no customer is still there, still unlinked
  const orphan = (await pool.query('SELECT customer_id FROM licenses WHERE id = $1', [ids.lNone])).rows[0];
  assert.equal(orphan.customer_id, null);
});

test('M3. re-running the migration is a no-op (no renumbering)', async () => {
  const numbersBefore = (await pool.query('SELECT id, customer_number FROM customers ORDER BY id')).rows;
  const protectedBefore = await snapshotProtected(pool);

  await migrate('apply');

  assert.deepEqual((await pool.query('SELECT id, customer_number FROM customers ORDER BY id')).rows, numbersBefore);
  assert.deepEqual(await snapshotProtected(pool), protectedBefore);
  assert.equal(Number((await pool.query('SELECT last_number FROM customer_number_counter')).rows[0].last_number), 3);
});

test('M4. the existing client contract still works on migrated legacy data', async () => {
  const key = 'SCHL-LEGACY-000001-AAAAAA-AAAAAA';

  // already-registered device keeps validating, new device within the limit activates
  assert.equal((await request('POST', '/api/v1/licenses/validate', { body: { licenseKey: key, deviceId: 'LEGACY-DEV-1' } })).json.status, 'active');
  assert.equal((await request('POST', '/api/v1/licenses/activate', { body: { licenseKey: key, deviceId: 'LEGACY-DEV-3' } })).json.status, 'device_limit_reached');
  assert.equal((await request('POST', '/api/v1/licenses/validate', { body: { licenseKey: 'SCHL-LEGACY-000002-BBBBBB-BBBBBB', deviceId: 'LEGACY-DEV-1' } })).json.status, 'invalid');

  // revoked legacy license is still refused
  assert.equal((await request('POST', '/api/v1/licenses/activate', { body: { licenseKey: 'SCHL-LEGACY-000002-BBBBBB-BBBBBB', deviceId: 'X' } })).json.status, 'revoked');
});

test('M5. legacy license without a customer is visible, flagged incomplete, and can be completed explicitly', async () => {
  const list = await admin('GET', '/license-records?incomplete=1&pageSize=200');
  const row = list.json.rows.find((r) => r.license_id === ids.lNone);
  assert.ok(row, 'listed');
  assert.equal(row.customer_id, null);
  assert.equal(row.customer_number, null);

  const licenseBefore = (await pool.query('SELECT * FROM licenses WHERE id = $1', [ids.lNone])).rows[0];

  const done = await admin('POST', `/licenses/${ids.lNone}/assign-customer`, {
    body: { name: 'مدرسة قديمة', salePrice: '1200', currency: 'EGP' },
  });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.customer.customer_number, 4, 'next number, nothing reused or guessed');

  const licenseAfter = (await pool.query('SELECT * FROM licenses WHERE id = $1', [ids.lNone])).rows[0];
  assert.deepEqual({ ...licenseAfter, customer_id: null }, { ...licenseBefore, customer_id: null });
  assert.equal(licenseAfter.customer_id, done.json.customer.id);

  // a license that already has a customer is never silently re-linked
  const again = await admin('POST', `/licenses/${ids.lNone}/assign-customer`, { body: { name: 'آخر' } });
  assert.equal(again.status, 409);
  const linkedOther = await admin('POST', `/licenses/${ids.lOld}/assign-customer`, { body: { name: 'آخر' } });
  assert.equal(linkedOther.status, 409);
});

test('M6. old code paths (single license creation / payment flow) keep working and get a number', async () => {
  const { customer } = await createCustomerAndLicense({ productId: 'school-accreditation', customer: { name: 'من المسار القديم' }, maxDevices: 1 });
  const n = (await pool.query('SELECT customer_number FROM customers WHERE id = $1', [customer.id])).rows[0].customer_number;
  assert.equal(Number(n), 5);

  // an insert that does not know about the new column at all (like the old app during a deploy)
  const raw = await pool.query("INSERT INTO customers (name) VALUES ('old app insert') RETURNING customer_number");
  assert.equal(Number(raw.rows[0].customer_number), 6);
});

test('M7. a failing migration rolls back completely and leaves the database as it was', async () => {
  await seedLegacy();
  const before = await snapshotProtected(pool);

  const client = await pool.connect();
  try {
    await assert.rejects(
      () => runMigration(client, `${readSql('customerManagement')}\nSELECT 1/0;`, { mode: 'apply' }),
      /division by zero/
    );
  } finally {
    client.release();
  }

  assert.equal(await hasColumn('customers', 'customer_number'), false);
  assert.equal(await hasColumn('customers', 'sale_price'), false);
  assert.equal((await pool.query("SELECT to_regclass('license_batches') AS t")).rows[0].t, null);
  assert.deepEqual(await snapshotProtected(pool), before);

  // and it can simply be run again afterwards
  await migrate('apply');
  assert.equal(await hasColumn('customers', 'customer_number'), true);
});

test('M8. the runner refuses destructive SQL; migration 004 itself is clean', async () => {
  for (const bad of [
    'DROP TABLE licenses;',
    'ALTER TABLE licenses DROP COLUMN license_key;',
    'TRUNCATE devices;',
    'DELETE FROM activations;',
    'ALTER TABLE licenses RENAME TO x;',
  ]) {
    assert.throws(() => assertNonDestructive(bad), /destructive/i, bad);
  }

  assert.doesNotThrow(() => assertNonDestructive(readSql('customerManagement')));
  assert.doesNotThrow(() => assertNonDestructive('-- DROP TABLE in a comment\nSELECT 1;'));
});

test('M9. a brand-new database (schema.sql + 002 + 003 + 004) builds cleanly', async () => {
  await resetDatabase('full');
  for (const t of ['products', 'licenses', 'devices', 'activations', 'customers', 'payment_orders', 'license_batches', 'customer_number_counter']) {
    assert.notEqual((await pool.query('SELECT to_regclass($1) AS t', [t])).rows[0].t, null, t);
  }
});
