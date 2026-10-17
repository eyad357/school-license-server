'use strict';

// Multi-product platform: product management, explicit product on creation,
// cross-product isolation, disabled-product policy, filters, signing, and
// migration 005 against a production-shaped (pre-005) database.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool, resetDatabase, readSql, request, admin, closeAll } = require('./helpers/setup');
const { runMigration, snapshotProtected } = require('../../scripts/migrate');
const signing = require('../../src/services/signingService');
const { createCustomerAndLicense } = require('../../src/services/adminLicenseService');

const API = '/api/v1/licenses';
const SCHOOL = 'school-accreditation';
const EXAM = 'exam-manager';
let idem = 0;
const newIdem = () => `mp-batch-${Date.now()}-${++idem}`;
const post = (route, body) => request('POST', `${API}/${route}`, { body });

const bulk = (productId, extra = {}) =>
  admin('POST', '/licenses/bulk', {
    headers: { 'Idempotency-Key': newIdem() },
    body: { productId, quantity: 1, maxDevices: 1, ...extra },
  });

before(() => resetDatabase('full'));
after(closeAll);

test('P1. products are listed with counters; the existing school product is reused', async () => {
  const r = await admin('GET', '/products');
  assert.equal(r.status, 200);
  const school = r.json.products.find((p) => p.product_id === SCHOOL);
  assert.ok(school);
  assert.equal(school.status, 'active');
  assert.deepEqual([school.licenses, school.customers, school.devices], [0, 0, 0]);
});

test('P2. add a second program; duplicate / malformed ids are refused; id cannot change', async () => {
  const ok = await admin('POST', '/products', { body: { productId: EXAM, name: 'مدير الاختبارات', description: 'برنامج ثانٍ' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.product.status, 'active');

  const dup = await admin('POST', '/products', { body: { productId: EXAM, name: 'x' } });
  assert.equal(dup.status, 409);

  for (const bad of ['Exam', 'a', '-x-', 'with space', 'é', 'x'.repeat(65), '']) {
    const r = await admin('POST', '/products', { body: { productId: bad, name: 'x' } });
    assert.equal(r.status, 400, `rejects "${bad}"`);
  }

  const rename = await admin('PATCH', `/products/${EXAM}`, { body: { name: 'مدير الاختبارات 2', description: 'وصف جديد' } });
  assert.equal(rename.status, 200);
  assert.equal(rename.json.product.name, 'مدير الاختبارات 2');

  const changeId = await admin('PATCH', `/products/${EXAM}`, { body: { productId: 'other', name: 'n' } });
  assert.equal(changeId.status, 400);

  // even a direct SQL attempt cannot change the identifier
  await assert.rejects(() => pool.query("UPDATE products SET product_id = 'hack' WHERE product_id = $1", [EXAM]), /immutable/);

  const badStatus = await admin('PATCH', `/products/${EXAM}`, { body: { status: 'paused' } });
  assert.equal(badStatus.status, 400);
  assert.equal((await admin('PATCH', '/products/nope', { body: { name: 'x' } })).status, 404);
});

test('P3. a license cannot be created without an explicit, existing, active program', async () => {
  const none = await admin('POST', '/licenses/bulk', { headers: { 'Idempotency-Key': newIdem() }, body: { quantity: 1 } });
  assert.equal(none.status, 400);
  assert.match(none.json.message, /البرنامج/);

  assert.equal((await bulk('missing-product')).status, 400);

  const single = await admin('POST', '/licenses', { body: { customer: { name: 'x' } } });
  assert.equal(single.status, 400);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM licenses')).rows[0].n, 0, 'nothing was created');
});

const keys = {};
test('P4. licenses are created for each program and linked to it', async () => {
  const a = await bulk(SCHOOL, { quantity: 2, customers: undefined });
  const b = await bulk(EXAM, { quantity: 3 });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.equal(b.status, 201);
  keys.school = a.json.items[0].licenseKey;
  keys.exam = b.json.items[0].licenseKey;

  const single = await admin('POST', '/licenses', { body: { productId: EXAM, customer: { name: 'فردي' }, maxDevices: 1 } });
  assert.equal(single.status, 201, JSON.stringify(single.json));

  const rows = (await pool.query('SELECT product_id, COUNT(*)::int n FROM licenses GROUP BY 1 ORDER BY 1')).rows;
  assert.deepEqual(rows.map((r) => [r.product_id, r.n]), [[EXAM, 4], [SCHOOL, 2]]);

  // customer numbers stay unique and gap-free across programs
  const nums = (await pool.query('SELECT customer_number::int n FROM customers ORDER BY 1')).rows.map((r) => r.n);
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6]);
});

test('P5. a key of program A can never be used inside program B', async () => {
  const dev = 'MP-DEV-1';

  // school client (sends its own productId) with an EXAM key
  for (const route of ['activate', 'validate', 'deactivate']) {
    const r = await post(route, { licenseKey: keys.exam, productId: SCHOOL, deviceId: dev });
    assert.equal(r.json.status, 'invalid', `${route} school->exam key`);
  }
  // old clients that send no productId are the school program
  assert.equal((await post('activate', { licenseKey: keys.exam, deviceId: dev })).json.status, 'invalid');
  // exam client with a school key
  assert.equal((await post('activate', { licenseKey: keys.school, productId: EXAM, deviceId: dev })).json.status, 'invalid');

  // each works in its own program
  const okS = await post('activate', { licenseKey: keys.school, productId: SCHOOL, deviceId: dev });
  const okE = await post('activate', { licenseKey: keys.exam, productId: EXAM, deviceId: dev });
  assert.equal(okS.json.status, 'active');
  assert.equal(okE.json.status, 'active');
  assert.equal((await post('validate', { licenseKey: keys.exam, productId: SCHOOL, deviceId: dev })).json.status, 'invalid');
  assert.equal((await post('validate', { licenseKey: keys.exam, productId: EXAM, deviceId: dev })).json.status, 'active');
});

test('P6. filters, summary, counters and export are program-aware', async () => {
  const all = await admin('GET', '/license-records?pageSize=200');
  assert.equal(all.json.total, 6);
  const onlyExam = await admin('GET', `/license-records?productId=${EXAM}&pageSize=200`);
  assert.equal(onlyExam.json.total, 4);
  assert.ok(onlyExam.json.rows.every((r) => r.product_id === EXAM && r.product_name === 'مدير الاختبارات 2'));
  assert.equal(onlyExam.json.summary.totalLicenses, 4);
  assert.equal((await admin('GET', `/license-records?productId=${SCHOOL}`)).json.total, 2);
  assert.equal((await admin('GET', '/license-records?productId=nothing')).json.total, 0);
  // searching by program name works too
  assert.equal((await admin('GET', `/license-records?q=${encodeURIComponent('الاختبارات')}`)).json.total, 4);

  const list = (await admin('GET', '/products')).json.products;
  const exam = list.find((p) => p.product_id === EXAM);
  const school = list.find((p) => p.product_id === SCHOOL);
  assert.deepEqual([exam.licenses, exam.customers, exam.devices], [4, 4, 1]);
  assert.deepEqual([school.licenses, school.customers, school.devices], [2, 2, 1]);

  const csv = await admin('POST', '/export', { body: { format: 'csv', scope: 'search', filters: { productId: EXAM } }, raw: true });
  const text = csv.buffer.toString('utf8');
  assert.ok(text.includes('البرنامج'));
  assert.equal(text.trim().split('\r\n').length, 5, 'header + 4 rows');
});

test('P7. disabling a program blocks NEW licenses and NEW devices only', async () => {
  const off = await admin('PATCH', `/products/${EXAM}`, { body: { status: 'disabled' } });
  assert.equal(off.json.product.status, 'disabled');

  assert.equal((await bulk(EXAM)).status, 400);
  assert.equal((await admin('POST', '/licenses', { body: { productId: EXAM, customer: { name: 'y' } } })).status, 400);

  // already-activated device keeps working, and re-activation on it still answers active
  assert.equal((await post('validate', { licenseKey: keys.exam, productId: EXAM, deviceId: 'MP-DEV-1' })).json.status, 'active');
  assert.equal((await post('activate', { licenseKey: keys.exam, productId: EXAM, deviceId: 'MP-DEV-1' })).json.status, 'active');
  // a new device cannot be added
  const fresh = await post('activate', { licenseKey: keys.exam, productId: EXAM, deviceId: 'MP-DEV-NEW' });
  assert.equal(fresh.json.status, 'invalid');
  assert.match(fresh.json.message, /not available/);

  // a customer who has already PAID still gets a license (payment path)
  const paid = await createCustomerAndLicense({ productId: EXAM, fromPayment: true, customer: { name: 'paid' }, maxDevices: 1 });
  assert.ok(paid.license);

  // the other program is unaffected
  assert.equal((await bulk(SCHOOL)).status, 201);

  await admin('PATCH', `/products/${EXAM}`, { body: { status: 'active' } });
  assert.equal((await post('activate', { licenseKey: keys.exam, productId: EXAM, deviceId: 'MP-DEV-NEW' })).json.status, 'device_limit_reached');
});

test('P8. products API requires an admin token', async () => {
  for (const [m, p, b] of [['GET', '/api/v1/admin/products'], ['POST', '/api/v1/admin/products', { productId: 'zz-zz', name: 'x' }], ['PATCH', `/api/v1/admin/products/${EXAM}`, { name: 'x' }]]) {
    assert.equal((await request(m, p, { body: b })).status, 401, `${m} ${p}`);
  }
});

// ------------------------------------------------------------------ signing
function verify(signed, publicKey) {
  const ok = crypto.verify(null, Buffer.from(signed.payload, 'utf8'), publicKey, Buffer.from(signed.signature, 'base64url'));
  return ok ? JSON.parse(Buffer.from(signed.payload, 'base64url').toString('utf8')) : null;
}

test('S1. without a signing key responses are unchanged (no signedLicense)', async () => {
  delete process.env.LICENSE_SIGNING_PRIVATE_KEY; signing.reset();
  const r = await post('validate', { licenseKey: keys.school, productId: SCHOOL, deviceId: 'MP-DEV-1' });
  assert.equal(r.json.status, 'active');
  assert.equal('signedLicense' in r.json, false);
});

test('S2. with a signing key, activate/validate return a verifiable, device+program-bound signature', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  process.env.LICENSE_SIGNING_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
  process.env.LICENSE_SIGNING_KEY_ID = 'test1';
  signing.reset();

  const v = await post('validate', { licenseKey: keys.school, productId: SCHOOL, deviceId: 'MP-DEV-1' });
  assert.equal(v.json.status, 'active');
  assert.equal(v.json.signedLicense.alg, 'Ed25519');
  assert.equal(v.json.signedLicense.kid, 'test1');
  const payload = verify(v.json.signedLicense, publicKey);
  assert.ok(payload, 'signature verifies');
  assert.equal(payload.productId, SCHOOL);
  assert.equal(payload.deviceId, 'MP-DEV-1');
  assert.equal(payload.licenseKey, keys.school);
  assert.equal(payload.expiresAt, null);

  // tampering is detected, a different key does not verify
  const tampered = { ...v.json.signedLicense, payload: Buffer.from(JSON.stringify({ ...payload, deviceId: 'other' })).toString('base64url') };
  assert.equal(verify(tampered, publicKey), null);
  assert.equal(verify(v.json.signedLicense, crypto.generateKeyPairSync('ed25519').publicKey), null);

  // not-active answers never carry a signature
  const bad = await post('validate', { licenseKey: keys.exam, productId: SCHOOL, deviceId: 'MP-DEV-1' });
  assert.equal('signedLicense' in bad.json, false);

  // the private key never appears in any response
  assert.ok(!JSON.stringify(v.json).includes('PRIVATE'));
});

test('S3. an invalid signing key disables signing but never breaks activation', async () => {
  process.env.LICENSE_SIGNING_PRIVATE_KEY = 'not a key'; signing.reset();
  const r = await post('validate', { licenseKey: keys.school, productId: SCHOOL, deviceId: 'MP-DEV-1' });
  assert.equal(r.json.status, 'active');
  assert.equal('signedLicense' in r.json, false);
  delete process.env.LICENSE_SIGNING_PRIVATE_KEY; signing.reset();
});

// ------------------------------------------------------------ migration 005
test('M005. migration 005 on a pre-005 production-shaped database: additive, identical protected data, idempotent', async () => {
  await resetDatabase('legacy');
  await pool.query('BEGIN');
  await pool.query(readSql('customerManagement'));
  await pool.query('COMMIT');

  await pool.query(`INSERT INTO licenses (license_key, product_id, status, max_devices) VALUES
    ('SCHL-OLD-000001-AAAAAA-AAAAAA','school-accreditation','ACTIVE',2),
    ('SCHL-OLD-000002-BBBBBB-BBBBBB','school-accreditation','REVOKED',1)`);
  const d = (await pool.query("INSERT INTO devices (device_id) VALUES ('OLD-DEV-1') RETURNING id")).rows[0].id;
  const l = (await pool.query("SELECT id FROM licenses WHERE license_key LIKE '%000001%'")).rows[0].id;
  await pool.query('INSERT INTO activations (license_id, device_id) VALUES ($1,$2)', [l, d]);

  // new code against the OLD (pre-005) schema: activation still works (also updates last_seen_at)
  assert.equal((await post('validate', { licenseKey: 'SCHL-OLD-000001-AAAAAA-AAAAAA', deviceId: 'OLD-DEV-1' })).json.status, 'active');

  const before = await snapshotProtected(pool);
  const client = await pool.connect();
  try {
    // dry run changes nothing
    await runMigration(client, readSql('productsPlatform'), { mode: 'plan' });
    const col = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='status'");
    assert.equal(col.rowCount, 0, 'plan rolled back');

    const res = await runMigration(client, readSql('productsPlatform'), { mode: 'apply' });
    assert.deepEqual(res.after, before, 'protected tables identical');
    await runMigration(client, readSql('productsPlatform'), { mode: 'apply' }); // idempotent
  } finally {
    client.release();
  }

  const prod = (await pool.query('SELECT product_id, name, status, description FROM products')).rows;
  assert.deepEqual(prod, [{ product_id: 'school-accreditation', name: 'Accreditation Pro', status: 'active', description: null }]);

  assert.deepEqual(await snapshotProtected(pool), before, 'data untouched after the migration');

  // existing activation + license behave exactly as before after the migration
  assert.equal((await post('validate', { licenseKey: 'SCHL-OLD-000001-AAAAAA-AAAAAA', deviceId: 'OLD-DEV-1' })).json.status, 'active');
  assert.equal((await post('activate', { licenseKey: 'SCHL-OLD-000002-BBBBBB-BBBBBB', deviceId: 'X' })).json.status, 'revoked');
});
