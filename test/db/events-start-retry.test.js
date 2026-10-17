'use strict';

// If the database is not reachable when the server boots (Railway starts the app and Postgres at
// the same time), the push hub must NOT stay dead until the next deploy: clients would keep
// connecting to /licenses/events, get heartbeats, and never receive a revoke.

process.env.LICENSE_EVENTS_START_RETRY_MS = '60';
process.env.LICENSE_EVENTS_POLL_MS = '200';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, resetDatabase, closeAll } = require('./helpers/setup');
const { EventHub } = require('../../src/services/eventService');

after(closeAll);
const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

test('hub start failure (database down at boot) is retried automatically and then works', async () => {
  await resetDatabase('full');
  const hub = new EventHub();
  const realQuery = pool.query.bind(pool);
  let failing = true;
  pool.query = (...args) => (failing ? Promise.reject(new Error('simulated: database not ready')) : realQuery(...args));
  try {
    await assert.rejects(hub.start(), /database not ready/);
    assert.equal(hub.started, false, 'a failed start must not leave the hub marked as started');
    failing = false;                                   // database becomes reachable
    assert.ok(await until(() => hub.started && hub.pollTimer && hub.listener), 'hub recovered by itself');

    // and it really dispatches: a stored event reaches a registered connection
    const got = [];
    const lic = '00000000-0000-4000-8000-0000000000aa';
    hub.add(lic, 'DEV-1', { send: (e) => got.push(e.type), close() {} });
    await realQuery(`INSERT INTO license_events (license_id, product_id, type) VALUES ($1, 'school-accreditation', 'license.revoked')`, [lic]).catch(async () => {
      // license_events may require an existing license row: create one
      await realQuery(`INSERT INTO licenses (id, license_key, product_id) VALUES ($1, 'RETRY-KEY-1', 'school-accreditation')`, [lic]);
      await realQuery(`INSERT INTO license_events (license_id, product_id, type) VALUES ($1, 'school-accreditation', 'license.revoked')`, [lic]);
    });
    assert.ok(await until(() => got.includes('license.revoked')), 'revoke event delivered after recovery');
  } finally {
    pool.query = realQuery;
    await hub.stop();
  }
});

test('stop() cancels a pending start retry', async () => {
  const hub = new EventHub();
  const realQuery = pool.query.bind(pool);
  pool.query = () => Promise.reject(new Error('down'));
  try {
    await assert.rejects(hub.start());
    await hub.stop();
    pool.query = realQuery;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(hub.started, false, 'no zombie retry after stop()');
  } finally { pool.query = realQuery; }
});
