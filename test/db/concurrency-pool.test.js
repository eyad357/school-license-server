'use strict';

// Regression: activations used to check "is the product disabled" through a SECOND pool connection while the
// activation transaction held the first one. With >= pool-size simultaneous new-device activations every
// connection waited for another one: the server hung silently (found by the 1000-device load test).
process.env.DB_POOL_MAX = '4'; // tiny pool on purpose: 40 concurrent activations would deadlock the old code
process.env.DB_CONNECT_TIMEOUT_MS = '8000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, request, admin, closeAll } = require('./helpers/setup');

before(() => resetDatabase('full'));
after(closeAll);

test('P1. 40 simultaneous NEW-device activations finish on a 4-connection pool (no pool starvation)', async () => {
  const created = await admin('POST', '/licenses/bulk', {
    headers: { 'Idempotency-Key': `pool-regression-${Date.now()}` },
    body: { productId: 'school-accreditation', quantity: 1, maxDevices: 40 },
  });
  assert.ok([200, 201].includes(created.status));
  const key = (await pool.query('SELECT license_key FROM licenses LIMIT 1')).rows[0].license_key;
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: 40 }, (_v, i) =>
    request('POST', '/api/v1/licenses/activate', { body: { licenseKey: key, deviceId: `POOL-DEV-${i}` } })));
  assert.ok(Date.now() - t0 < 7000, `took ${Date.now() - t0} ms`);
  assert.equal(rs.filter((r) => r.json.status === 'active').length, 40);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM activations WHERE deactivated_at IS NULL')).rows[0].n, 40);
});

test('P2. activation still works when the products.status column does not exist yet (migration 005 not applied)', async () => {
  await resetDatabase('full');
  await pool.query('ALTER TABLE products DROP COLUMN IF EXISTS status');
  await pool.query(`INSERT INTO licenses (license_key, product_id, status, max_devices) VALUES ('P2-KEY-0001','school-accreditation','ACTIVE',2)`);
  const a = await request('POST', '/api/v1/licenses/activate', { body: { licenseKey: 'P2-KEY-0001', deviceId: 'P2-DEV' } });
  assert.equal(a.json.status, 'active');
  const b = await request('POST', '/api/v1/licenses/activate', { body: { licenseKey: 'P2-KEY-0001', deviceId: 'P2-DEV-2' } });
  assert.equal(b.json.status, 'active');
});
