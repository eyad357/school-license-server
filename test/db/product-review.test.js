'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, request, admin, closeAll } = require('./helpers/setup');

before(() => resetDatabase('full'));
after(closeAll);

test('R0. with the production schema (FK licenses.product_id -> products) the review list is empty: no license can reference an unknown product', async () => {
  const r = await admin('GET', '/products-review');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items, []);
});

test('R1. unknown-product legacy licenses land in a read-only review list; nothing is changed; activation still works', async () => {
  // the production FK normally makes this impossible; drop it only to simulate a foreign/imported dataset
  await pool.query('ALTER TABLE licenses DROP CONSTRAINT IF EXISTS licenses_product_id_fkey');
  await pool.query(`INSERT INTO licenses (license_key, product_id, status, max_devices) VALUES
    ('LEGACY-0001','mystery-app','ACTIVE',1), ('LEGACY-0002','mystery-app','REVOKED',1), ('KNOWN-0001','school-accreditation','ACTIVE',1)`);
  const before = (await pool.query('SELECT md5(string_agg(concat_ws(\'|\',id,license_key,product_id,status),\',\' ORDER BY id)) h, count(*) n FROM licenses')).rows[0];
  const prodsBefore = (await pool.query('SELECT count(*)::int n FROM products')).rows[0].n;
  const r = await admin('GET', '/products-review');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((i) => [i.product_id, i.licenses, i.active, i.revoked]), [['mystery-app', 2, 1, 1]]);
  const after1 = (await pool.query('SELECT md5(string_agg(concat_ws(\'|\',id,license_key,product_id,status),\',\' ORDER BY id)) h, count(*) n FROM licenses')).rows[0];
  assert.deepEqual(after1, before);
  assert.equal((await pool.query('SELECT count(*)::int n FROM products')).rows[0].n, prodsBefore);
  const a = await request('POST', '/api/v1/licenses/activate', { body: { licenseKey: 'LEGACY-0001', productId: 'mystery-app', deviceId: 'D-LEG' } });
  assert.equal(a.json.status, 'active');
  const rv = await request('POST', '/api/v1/licenses/activate', { body: { licenseKey: 'LEGACY-0002', productId: 'mystery-app', deviceId: 'D-LEG2' } });
  assert.equal(rv.json.status, 'revoked'); // never auto-reactivated
  assert.equal((await admin('GET', '/products-review', { token: 'bad' })).status === 200, false);
});

test('L1. admin login: 10 failed attempts are allowed, the 11th is blocked with 429', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await request('POST', '/api/v1/admin/login', { body: { username: 'x', password: 'wrong' } });
  assert.equal(last.status, 429);
});
