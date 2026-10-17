'use strict';

// Tests 1-5 of the brief: the EXISTING activation system must behave exactly as
// before. These are characterisation tests: they pin what the code does today
// (including its quirks) so any accidental change fails loudly.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, request, admin, closeAll } = require('./helpers/setup');

const API = '/api/v1/licenses';
const PRODUCT = 'school-accreditation';

let seq = 0;
const newKey = () => `SCHL-T${String(++seq).padStart(5, '0')}-AAAAAA-BBBBBB-CCCCCC`;

async function seedLicense({ status = 'ACTIVE', maxDevices = 1, expiresAt = null } = {}) {
  const key = newKey();
  const { rows } = await pool.query(
    `INSERT INTO licenses (license_key, product_id, status, max_devices, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [key, PRODUCT, status, maxDevices, expiresAt]
  );
  return { id: rows[0].id, key };
}

const post = (route, body) => request('POST', `${API}/${route}`, { body });
const activate = (licenseKey, deviceId) => post('activate', { licenseKey, deviceId });
const validate = (licenseKey, deviceId) => post('validate', { licenseKey, deviceId });
const deactivate = (licenseKey, deviceId) => post('deactivate', { licenseKey, deviceId });

const licenseRow = async (id) =>
  (await pool.query('SELECT * FROM licenses WHERE id = $1', [id])).rows[0];

before(() => resetDatabase('full'));
beforeEach(async () => {
  await pool.query('TRUNCATE activations, devices, licenses RESTART IDENTITY CASCADE');
});
after(closeAll);

test('1. activate / validate / deactivate keep the exact existing response contract', async () => {
  const { id, key } = await seedLicense();

  // --- activate (first time) ---
  let r = await activate(key, 'DEV-1');
  assert.deepEqual(Object.keys(r.json).sort(), ['activationRef', 'expiresAt', 'message', 'status']);
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.message, 'License activated successfully.');
  assert.equal(r.json.expiresAt, null);
  assert.match(r.json.activationRef, /^[0-9a-f-]{36}$/);
  // Matches the old repo's last commit ("Fix license API success HTTP status"): success is HTTP 200.
  // Windows clients read the body `status` first, so they accept both 200 and the former 400.
  assert.equal(r.status, 200);
  const activationRef = r.json.activationRef;

  // --- activate again on the same device ---
  r = await activate(key, 'DEV-1');
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.message, 'License is already activated on this device.');
  assert.equal(r.json.activationRef, activationRef);

  // --- validate ---
  r = await validate(key, 'DEV-1');
  assert.deepEqual(Object.keys(r.json).sort(), ['activationRef', 'expiresAt', 'message', 'status']);
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.message, 'License is valid.');
  assert.equal(r.json.activationRef, activationRef);

  r = await validate(key, 'SOME-OTHER-DEVICE');
  assert.deepEqual(r.json, { status: 'invalid', message: 'License is not active on this device.' });

  // --- bad input ---
  r = await post('activate', { licenseKey: key });
  assert.deepEqual(r.json, { status: 'invalid', message: 'License key and device ID are required.' });

  r = await activate('SCHL-NOPE-NOPE-NOPE-NOPE', 'DEV-1');
  assert.deepEqual(r.json, { status: 'invalid', message: 'Invalid license key.' });

  // --- deactivate ---
  r = await deactivate(key, 'DEV-1');
  assert.deepEqual(r.json, {
    status: 'deactivated',
    message: 'License deactivated successfully.',
    activationRef,
  });

  r = await deactivate(key, 'DEV-1');
  assert.deepEqual(r.json, {
    status: 'invalid',
    message: 'No active activation was found for this device.',
  });

  r = await validate(key, 'DEV-1');
  assert.equal(r.json.status, 'invalid');

  // The license row itself was never modified by any of this.
  const row = await licenseRow(id);
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.max_devices, 1);
});

test('2. a REVOKED license is rejected by activate and validate', async () => {
  const { id, key } = await seedLicense({ maxDevices: 2 });

  assert.equal((await activate(key, 'DEV-1')).json.status, 'active');

  const revoke = await admin('POST', `/licenses/${id}/revoke`);
  assert.equal(revoke.status, 200);
  assert.equal(revoke.json.license.status, 'REVOKED');

  // existing device -> validate says revoked
  let r = await validate(key, 'DEV-1');
  assert.deepEqual(r.json, { status: 'revoked', message: 'This license has been revoked.' });

  // new device -> activation says revoked
  r = await activate(key, 'DEV-2');
  assert.deepEqual(r.json, { status: 'revoked', message: 'This license has been revoked.' });
  assert.equal(r.status, 400);

  // revoking never deletes the registered device
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM activations WHERE license_id = $1 AND deactivated_at IS NULL',
    [id]
  );
  assert.equal(rows[0].n, 1);
});

test('3. revoking one license does not affect an independent license', async () => {
  const a = await seedLicense();
  const b = await seedLicense();

  await activate(a.key, 'DEV-A');
  await activate(b.key, 'DEV-B');

  const snapshot = async (id) => ({
    license: await licenseRow(id),
    activations: (
      await pool.query('SELECT id, device_id, deactivated_at FROM activations WHERE license_id = $1', [id])
    ).rows,
  });

  const beforeB = await snapshot(b.id);

  assert.equal((await admin('POST', `/licenses/${a.id}/revoke`)).status, 200);

  assert.deepEqual(await snapshot(b.id), beforeB);
  assert.equal((await validate(b.key, 'DEV-B')).json.status, 'active');
  assert.equal((await validate(a.key, 'DEV-A')).json.status, 'revoked');
});

test('4. reactivation works and keeps the registered devices', async () => {
  const { id, key } = await seedLicense({ maxDevices: 2 });

  await activate(key, 'DEV-1');
  await admin('POST', `/licenses/${id}/revoke`);
  assert.equal((await validate(key, 'DEV-1')).json.status, 'revoked');

  const re = await admin('POST', `/licenses/${id}/reactivate`);
  assert.equal(re.status, 200);
  assert.equal(re.json.license.status, 'ACTIVE');

  // the original device is valid again without re-activating
  assert.equal((await validate(key, 'DEV-1')).json.status, 'active');
  // and a second device can now activate
  assert.equal((await activate(key, 'DEV-2')).json.status, 'active');

  // an EXPIRED license cannot be reactivated without extending it (existing rule)
  const expired = await seedLicense({ expiresAt: new Date(Date.now() - 86400000).toISOString() });
  const bad = await admin('POST', `/licenses/${expired.id}/reactivate`);
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /expired/i);
});

test('5. device limits are respected (also under concurrent activations)', async () => {
  const { id, key } = await seedLicense({ maxDevices: 2 });

  assert.equal((await activate(key, 'DEV-1')).json.status, 'active');
  assert.equal((await activate(key, 'DEV-2')).json.status, 'active');

  let r = await activate(key, 'DEV-3');
  assert.deepEqual(r.json, {
    status: 'device_limit_reached',
    message: 'Maximum number of devices has been reached.',
  });

  // freeing a slot lets the third device in
  assert.equal((await deactivate(key, 'DEV-1')).json.status, 'deactivated');
  assert.equal((await activate(key, 'DEV-3')).json.status, 'active');

  // the existing admin rule: cannot shrink below the active device count
  const shrink = await admin('PATCH', `/licenses/${id}`, { body: { maxDevices: 1 } });
  assert.equal(shrink.status, 400);

  // race: one free slot, five devices try at once -> exactly one wins
  const single = await seedLicense({ maxDevices: 1 });
  const results = await Promise.all(
    ['R1', 'R2', 'R3', 'R4', 'R5'].map((d) => activate(single.key, d))
  );
  const winners = results.filter((x) => x.json.status === 'active');
  assert.equal(winners.length, 1);
  assert.equal(
    results.filter((x) => x.json.status === 'device_limit_reached').length,
    4
  );
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM activations WHERE license_id = $1 AND deactivated_at IS NULL',
    [single.id]
  );
  assert.equal(rows[0].n, 1);
});

test('existing expiry behaviour is unchanged (expired status is stored on first use)', async () => {
  const { id, key } = await seedLicense({ expiresAt: new Date(Date.now() - 1000).toISOString() });

  const r = await activate(key, 'DEV-1');
  assert.equal(r.json.status, 'expired');
  assert.equal(r.json.message, 'This license has expired.');
  assert.equal((await licenseRow(id)).status, 'EXPIRED');
});

test('13. deactivate success is HTTP 200 (was 400 by a case typo); every failure stays 400; body unchanged', async () => {
  await resetDatabase('full');
  const created = await admin('POST', '/licenses/bulk', {
    headers: { 'Idempotency-Key': `contract-13-${Date.now()}` },
    body: { productId: 'school-accreditation', quantity: 1, maxDevices: 1 },
  });
  assert.ok([200, 201].includes(created.status));
  const key = (await pool.query('SELECT license_key FROM licenses LIMIT 1')).rows[0].license_key;
  await activate(key, 'DEV-13');
  const ok = await deactivate(key, 'DEV-13');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'deactivated');
  const again = await deactivate(key, 'DEV-13');
  assert.equal(again.status, 400);
  assert.equal(again.json.status, 'invalid');
  // activate/validate success are HTTP 200 (same as the old repo HEAD)
  const act = await activate(key, 'DEV-13');
  assert.equal(act.json.status, 'active');
  assert.equal(act.status, 200);
});
