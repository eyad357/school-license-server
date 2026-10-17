'use strict';

// Test 14 of the brief: database failure, lost connection, repeated requests.
// Also the idempotency guarantees of bulk creation.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, admin, request, closeAll } = require('./helpers/setup');
const { createBulkLicenses } = require('../../src/services/bulkLicenseService');

let idem = 0;
const newIdem = () => `rel-batch-${Date.now()}-${++idem}`;

async function state() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM customers) AS customers,
      (SELECT COUNT(*)::int FROM licenses) AS licenses,
      (SELECT COUNT(*)::int FROM license_batches) AS batches,
      (SELECT last_number::int FROM customer_number_counter) AS counter
  `);
  return rows[0];
}

/** A db whose connections throw according to `decide(sql, callNumber)`. */
function faultyDb(decide) {
  return {
    async connect() {
      const client = await pool.connect();
      let calls = 0;

      return {
        async query(sql, params) {
          calls += 1;
          const error = decide(String(sql), calls);
          if (error) {
            throw error;
          }
          return client.query(sql, params);
        },
        release(err) {
          client.release(err);
        },
      };
    },
  };
}

before(() => resetDatabase('full'));
beforeEach(async () => {
  await pool.query('TRUNCATE activations, devices, licenses, customers, license_batches CASCADE');
  await pool.query('UPDATE customer_number_counter SET last_number = 0');
});
after(closeAll);

test('14a. the same request twice (double click / retry) creates the licenses only once', async () => {
  const key = newIdem();
  const input = { productId: 'school-accreditation',
    idempotencyKey: key,
    quantity: 3,
    maxDevices: 2,
  };

  const first = await createBulkLicenses(input);
  const second = await createBulkLicenses(input);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(
    second.items.map((i) => i.licenseKey),
    first.items.map((i) => i.licenseKey)
  );

  assert.deepEqual(await state(), { customers: 3, licenses: 3, batches: 1, counter: 3 });
});

test('14b. six simultaneous identical requests create exactly one batch', async () => {
  const key = newIdem();
  const input = { productId: 'school-accreditation', idempotencyKey: key, quantity: 25, maxDevices: 1 };

  const results = await Promise.all(Array.from({ length: 6 }, () => createBulkLicenses(input)));

  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(results.filter((r) => r.replayed).length, 5);

  const reference = results[0].items.map((i) => i.licenseKey).join();
  assert.ok(results.every((r) => r.items.map((i) => i.licenseKey).join() === reference));

  assert.deepEqual(await state(), { customers: 25, licenses: 25, batches: 1, counter: 25 });
});

test('14c. the same key with a different payload is rejected (409) and creates nothing', async () => {
  const key = newIdem();
  await createBulkLicenses({ productId: 'school-accreditation', idempotencyKey: key, quantity: 2 });
  const before = await state();

  await assert.rejects(
    () => createBulkLicenses({ productId: 'school-accreditation', idempotencyKey: key, quantity: 3 }),
    (e) => e.statusCode === 409 && e.code === 'idempotency_key_reused'
  );

  assert.deepEqual(await state(), before);

  // over HTTP as well
  const key2 = newIdem();
  const ok = await admin('POST', '/licenses/bulk', { headers: { 'Idempotency-Key': key2 }, body: { productId: 'school-accreditation', quantity: 2 } });
  assert.equal(ok.status, 201);
  const clash = await admin('POST', '/licenses/bulk', { headers: { 'Idempotency-Key': key2 }, body: { productId: 'school-accreditation', quantity: 4 } });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.status, 'conflict');
});

test('14d. a missing or malformed idempotency key is refused before anything is written', async () => {
  const before = await state();

  for (const bad of [undefined, '', 'short', 'has space in it', 'x'.repeat(101)]) {
    const r = await admin('POST', '/licenses/bulk', {
      headers: bad === undefined ? {} : { 'Idempotency-Key': bad },
      body: { productId: 'school-accreditation', quantity: 2 },
    });
    assert.equal(r.status, 400, `key ${JSON.stringify(bad)}`);
  }

  assert.deepEqual(await state(), before);
});

test('14e. a failure in the middle of creation leaves NOTHING behind and wastes no number', async () => {
  const key = newIdem();
  const input = { productId: 'school-accreditation', idempotencyKey: key, quantity: 3 };
  const before = await state();

  const db = faultyDb((sql) =>
    /INSERT INTO licenses/.test(sql) ? new Error('simulated database failure') : null
  );

  await assert.rejects(() => createBulkLicenses(input, { db }), /simulated database failure/);

  // customers were inserted inside the transaction, but rolled back with it
  assert.deepEqual(await state(), before);

  // the same key can be used again, and numbering starts at 1 (no gap)
  const retry = await createBulkLicenses(input);
  assert.equal(retry.replayed, false);
  assert.deepEqual(retry.items.map((i) => i.customerNumber), [1, 2, 3]);
});

test('14f. a failure at COMMIT time saves nothing', async () => {
  const before = await state();
  const db = faultyDb((sql) => (sql === 'COMMIT' ? new Error('simulated commit failure') : null));

  await assert.rejects(
    () => createBulkLicenses({ productId: 'school-accreditation', idempotencyKey: newIdem(), quantity: 10 }, { db }),
    /simulated commit failure/
  );

  assert.deepEqual(await state(), before);
});

test('14g. a dropped connection (even ROLLBACK fails) leaves no data and no stuck lock', async () => {
  const before = await state();

  const db = faultyDb((sql) => {
    if (/INSERT INTO licenses/.test(sql)) {
      return Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    }
    if (sql === 'ROLLBACK') {
      return Object.assign(new Error('connection already closed'), { code: 'ECONNRESET' });
    }
    return null;
  });

  await assert.rejects(
    () => createBulkLicenses({ productId: 'school-accreditation', idempotencyKey: newIdem(), quantity: 10 }, { db }),
    /ECONNRESET/
  );

  // The broken connection was discarded by the pool, so the server aborted its transaction:
  assert.deepEqual(await state(), before);

  // ...and the counter row is not left locked: a new job finishes quickly and starts at #1.
  const started = Date.now();
  const next = await createBulkLicenses({ productId: 'school-accreditation', idempotencyKey: newIdem(), quantity: 5 });
  assert.ok(Date.now() - started < 5000, 'no lock left behind by the dead connection');
  assert.deepEqual(next.items.map((i) => i.customerNumber), [1, 2, 3, 4, 5]);
});

test('14h. HTTP: database outage returns a generic error, leaks nothing, creates nothing, then recovers', async () => {
  const realConnect = pool.connect.bind(pool);
  const realQuery = pool.query.bind(pool);
  const refused = () =>
    Promise.reject(Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }));

  const before = await state();
  const silenced = console.error;
  console.error = () => {};

  let bulkRes;
  let listRes;
  let activateRes;

  try {
    pool.connect = refused;
    pool.query = refused;

    bulkRes = await admin('POST', '/licenses/bulk', {
      headers: { 'Idempotency-Key': newIdem() },
      body: { productId: 'school-accreditation', quantity: 3 },
    });
    listRes = await admin('GET', '/license-records');
    activateRes = await request('POST', '/api/v1/licenses/activate', {
      body: { licenseKey: 'SCHL-AAAAAA-BBBBBB-CCCCCC-DDDDDD', deviceId: 'D1' },
    });
  } finally {
    pool.connect = realConnect;
    pool.query = realQuery;
    console.error = silenced;
  }

  for (const res of [bulkRes, listRes]) {
    assert.equal(res.status, 500);
    assert.equal(res.json.status, 'server_error');
    assert.ok(!/ECONNREFUSED|10\.0\.0\.5|5432/.test(JSON.stringify(res.json)), 'no internals leaked');
  }

  // existing client API keeps its existing failure contract
  assert.equal(activateRes.status, 500);
  assert.deepEqual(activateRes.json, { status: 'SERVER_ERROR', message: 'Internal server error.' });

  assert.deepEqual(await state(), before);

  // recovery
  const ok = await admin('POST', '/licenses/bulk', {
    headers: { 'Idempotency-Key': newIdem() },
    body: { productId: 'school-accreditation', quantity: 3 },
  });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.json.items.map((i) => i.customerNumber), [1, 2, 3]);
});

test('14i. HTTP: two simultaneous identical POSTs (double click) create one batch', async () => {
  const headers = { 'Idempotency-Key': newIdem() };
  const body = { productId: 'school-accreditation', quantity: 1, maxDevices: 1 };

  const [a, b] = await Promise.all([
    admin('POST', '/licenses/bulk', { headers, body }),
    admin('POST', '/licenses/bulk', { headers, body }),
  ]);

  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.json.items[0].licenseKey, b.json.items[0].licenseKey);
  assert.deepEqual(await state(), { customers: 1, licenses: 1, batches: 1, counter: 1 });
});
