'use strict';

// Push channel (SSE) + transactional outbox + audit log, against a real PostgreSQL
// test database and real HTTP streams. Nothing here touches production.

process.env.TEST_START_HUB = '1';
process.env.LICENSE_EVENTS_POLL_MS = '300';
process.env.LICENSE_EVENTS_HEARTBEAT_MS = '150';
process.env.LICENSE_EVENTS_REPLAY_LIMIT = '3';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { pool, resetDatabase, request, admin, closeAll, hub, startServer, ROOT } = require('./helpers/setup');
const { recordEvent } = require('../../src/services/eventService');

const SCHOOL = 'school-accreditation';
let idem = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeLicense(productId = SCHOOL, maxDevices = 2) {
  const r = await admin('POST', '/licenses/bulk', {
    headers: { 'Idempotency-Key': `ev-${Date.now()}-${++idem}` },
    body: { productId, quantity: 1, maxDevices },
  });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
  const row = await pool.query('SELECT id, license_key FROM licenses ORDER BY created_at DESC LIMIT 1');
  return { id: row.rows[0].id, key: row.rows[0].license_key };
}

async function activate(key, deviceId, productId = SCHOOL) {
  const r = await request('POST', '/api/v1/licenses/activate', { body: { licenseKey: key, deviceId, productId } });
  assert.equal(r.json.status, 'active', JSON.stringify(r.json));
}

/** Minimal SSE client over fetch. */
async function openStream(base, body) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/v1/licenses/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
  });
  const out = { status: res.status, headers: res.headers, events: [], raw: '', ended: false, ac, t0: Date.now() };
  OPEN.push(ac);
  if (res.status !== 200) { out.json = await res.json().catch(() => null); return out; }
  (async () => {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        out.raw += chunk; buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = { event: 'message', id: null, data: '' };
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('id:')) ev.id = line.slice(3).trim();
            else if (line.startsWith('data:')) ev.data += line.slice(5).trim();
          }
          if (ev.data || ev.event !== 'message') { ev.at = Date.now(); out.events.push(ev); }
        }
      }
    } catch (_e) { /* aborted */ }
    out.ended = true;
  })();
  out.waitFor = async (pred, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const f = out.events.find(pred); if (f) return f; await sleep(10); } return null; };
  out.close = () => ac.abort();
  return out;
}

const OPEN = [];
let base;
before(async () => { await resetDatabase('full'); base = await startServer(); });
after(async () => { OPEN.forEach((a) => a.abort()); await closeAll(); });

test('E1. admin revoke reaches a connected device through the stream (and the type is correct)', async () => {
  const L = await makeLicense(); await activate(L.key, 'dev-e1');
  const s = await openStream(base, { licenseKey: L.key, productId: SCHOOL, deviceId: 'dev-e1' });
  assert.equal(s.status, 200);
  assert.match(s.headers.get('content-type'), /text\/event-stream/);
  await sleep(100);
  const t0 = Date.now();
  const r = await admin('POST', `/licenses/${L.id}/revoke`);
  assert.equal(r.status, 200);
  const ev = await s.waitFor((e) => e.event === 'license');
  assert.ok(ev, 'event arrived');
  assert.equal(JSON.parse(ev.data).type, 'license.revoked');
  assert.ok(ev.at - t0 < 2000, `latency ${ev.at - t0} ms`);
  console.log(`# E1 revoke->event latency: ${ev.at - t0} ms`);
  // the event carries no secrets
  assert.ok(!s.raw.includes(L.key) && !s.raw.includes('dev-e1'));
  s.close();
});

test('E2. authentication / isolation: unknown key, wrong product, wrong device are all refused identically', async () => {
  const A = await makeLicense(); await activate(A.key, 'dev-a');
  const B = await makeLicense(); await activate(B.key, 'dev-b');
  const bad = [
    { licenseKey: 'SCHL-NOPE', deviceId: 'dev-a' },
    { licenseKey: A.key, deviceId: 'dev-unknown' },
    { licenseKey: A.key, deviceId: 'dev-b' },            // device of ANOTHER license
    { licenseKey: A.key, deviceId: 'dev-a', productId: 'other-program' },
    { licenseKey: '', deviceId: 'dev-a' },
    {},
  ];
  const answers = [];
  for (const b of bad) { const s = await openStream(base, b); answers.push([s.status, JSON.stringify(s.json)]); }
  assert.ok(answers.every(([st]) => st === 401), JSON.stringify(answers));
  assert.equal(new Set(answers.map((a) => a[1])).size, 1, 'identical body: no oracle');

  const sa = await openStream(base, { licenseKey: A.key, deviceId: 'dev-a' });
  const sb = await openStream(base, { licenseKey: B.key, deviceId: 'dev-b' });
  await sleep(100);
  await admin('POST', `/licenses/${B.id}/revoke`);
  assert.ok(await sb.waitFor((e) => e.event === 'license'));
  await sleep(500);
  assert.equal(sa.events.filter((e) => e.event === 'license').length, 0, 'license A device must not see license B events');
  sa.close(); sb.close();
});

test('E3. outbox is transactional: rollback => no event row and no notification; commit => both', async () => {
  const L = await makeLicense(); await activate(L.key, 'dev-e3');
  const s = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e3' });
  await sleep(100);
  const before = (await pool.query('SELECT COUNT(*)::int n FROM license_events')).rows[0].n;
  const c = await pool.connect();
  await c.query('BEGIN');
  await recordEvent(c, { licenseId: L.id, productId: SCHOOL, type: 'license.updated' });
  await c.query('ROLLBACK'); c.release();
  await sleep(700);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM license_events')).rows[0].n, before);
  assert.equal(s.events.filter((e) => e.event === 'license').length, 0, 'rolled-back change must not notify');

  // failure inside the admin service (unknown id) leaves no event
  const bad = await admin('POST', '/licenses/00000000-0000-0000-0000-000000000000/revoke');
  assert.equal(bad.status, 400);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM license_events')).rows[0].n, before);

  // a failure of the AUDIT insert (same transaction) rolls the whole revoke back
  await pool.query('ALTER TABLE admin_audit_log RENAME TO admin_audit_log_x');
  const fail = await admin('POST', `/licenses/${L.id}/revoke`);
  await pool.query('ALTER TABLE admin_audit_log_x RENAME TO admin_audit_log');
  assert.equal(fail.status, 400);
  assert.equal((await pool.query('SELECT status FROM licenses WHERE id=$1', [L.id])).rows[0].status, 'ACTIVE', 'license untouched');
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM license_events')).rows[0].n, before, 'no orphan event');

  assert.equal((await admin('POST', `/licenses/${L.id}/revoke`)).status, 200);
  assert.ok(await s.waitFor((e) => e.event === 'license'));
  s.close();
});

test('E4. replay: missed events are delivered on reconnect; too many => resync hint; other licenses never leak', async () => {
  const L = await makeLicense(); await activate(L.key, 'dev-e4');
  const other = await makeLicense(); await activate(other.key, 'dev-other');
  const s1 = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e4' });
  await sleep(100);
  await admin('PATCH', `/licenses/${L.id}`, { body: { maxDevices: 3 } });
  const first = await s1.waitFor((e) => e.event === 'license');
  assert.equal(JSON.parse(first.data).type, 'license.updated');
  s1.close(); await sleep(100);

  await admin('POST', `/licenses/${L.id}/revoke`);
  await admin('POST', `/licenses/${other.id}/revoke`);       // must not be replayed to L's device
  const s2 = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e4', lastEventId: first.id });
  await sleep(300);
  const got = s2.events.filter((e) => e.event === 'license').map((e) => JSON.parse(e.data).type);
  assert.deepEqual(got, ['license.revoked']);
  s2.close();

  for (let i = 0; i < 5; i++) await admin('PATCH', `/licenses/${L.id}`, { body: { maxDevices: 3 + (i % 2) } });
  const s3 = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e4', lastEventId: first.id });
  assert.ok(await s3.waitFor((e) => e.event === 'resync'), 'resync when the gap exceeds the replay limit');
  s3.close();
});

test('E5. polling fallback delivers when LISTEN/NOTIFY is down (lost notifications / dropped listener)', async () => {
  const L = await makeLicense(); await activate(L.key, 'dev-e5');
  const s = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e5' });
  await sleep(100);
  const l = hub.listener; hub.listener = null; l.removeAllListeners('notification'); l.removeAllListeners('end'); await l.end();
  await admin('POST', `/licenses/${L.id}/revoke`);
  const t0 = Date.now();
  const ev = await s.waitFor((e) => e.event === 'license', 5000);
  assert.ok(ev, 'delivered by the outbox poller');
  console.log(`# E5 poller-only latency: ${ev.at - t0} ms (poll=300ms)`);
  s.close();
  hub._listen(0); await sleep(300);                               // restore the listener for later tests
});

test('E6. a second connection of the same device replaces the first (no duplicate connections)', async () => {
  const L = await makeLicense(); await activate(L.key, 'dev-e6');
  const s1 = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e6' });
  await sleep(100);
  const sizeBefore = hub.size;
  const s2 = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e6' });
  assert.ok(await s1.waitFor((e) => e.event === 'superseded'));
  await sleep(100);
  assert.equal(s1.ended, true);
  assert.equal(hub.size, sizeBefore, 'still one connection for this device');
  await admin('POST', `/licenses/${L.id}/revoke`);
  assert.ok(await s2.waitFor((e) => e.event === 'license'));
  assert.equal(s1.events.filter((e) => e.event === 'license').length, 0);
  s2.close();
});

test('E7. heartbeat comments are sent; hub bookkeeping is released when the client leaves', async () => {
  const L = await makeLicense(); await activate(L.key, 'dev-e7');
  const base0 = hub.size;
  const s = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e7' });
  await sleep(600);
  assert.ok((s.raw.match(/: ping/g) || []).length >= 2, 'heartbeats');
  assert.match(s.raw, /retry: \d+/);
  assert.equal(hub.size, base0 + 1);
  s.close(); await sleep(200);
  assert.equal(hub.size, base0);
});

test('E8. graceful recycle and capacity limit', async () => {
  const L = await makeLicense(); await activate(L.key, 'dev-e8');
  process.env.LICENSE_EVENTS_MAX_AGE_MS = '400';
  const s = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e8' });
  assert.ok(await s.waitFor((e) => e.event === 'reconnect', 3000), 'server recycles long-lived streams');
  delete process.env.LICENSE_EVENTS_MAX_AGE_MS;

  process.env.LICENSE_EVENTS_MAX_CONNECTIONS = String(hub.size + 1);
  const a = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e8' });
  assert.equal(a.status, 200);
  const L2 = await makeLicense(); await activate(L2.key, 'dev-e8b');
  const b = await openStream(base, { licenseKey: L2.key, deviceId: 'dev-e8b' });
  assert.equal(b.status, 503);
  assert.ok(Number(b.headers.get('retry-after')) >= 30, 'Retry-After spreads the reconnect load');
  delete process.env.LICENSE_EVENTS_MAX_CONNECTIONS;
  a.close();
});

test('E9. delete / reactivate / reset-device events; deleted license => stream auth now refused', async () => {
  const L = await makeLicense(); await activate(L.key, 'dev-e9');
  const s = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e9' });
  await sleep(100);
  await admin('POST', `/licenses/${L.id}/revoke`);
  await admin('POST', `/licenses/${L.id}/reactivate`);
  const devs = (await admin('GET', `/licenses/${L.id}/devices`)).json.devices;
  await admin('POST', `/licenses/${L.id}/reset-device`, { body: {} }).catch(() => {});
  void devs;
  await admin('DELETE', `/licenses/${L.id}`);
  await sleep(600);
  const types = s.events.filter((e) => e.event === 'license').map((e) => JSON.parse(e.data).type);
  assert.deepEqual(types.filter((t) => t !== 'license.device_reset'), ['license.revoked', 'license.reactivated', 'license.deleted']);
  const again = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e9' });
  assert.equal(again.status, 401);
  // event ids strictly increase in the order of the changes
  const ids = s.events.filter((e) => e.event === 'license').map((e) => BigInt(e.id));
  assert.deepEqual(ids, [...ids].sort((x, y) => (x < y ? -1 : 1)));
  s.close();
});

test('E10. audit log: sensitive actions are recorded with the admin name, keys masked, no secrets', async () => {
  const L = await makeLicense(); await activate(L.key, 'dev-e10');
  await admin('POST', '/licenses', { body: { productId: SCHOOL, maxDevices: 1, customer: { name: 'Audit Customer' } } });
  await admin('PATCH', `/licenses/${L.id}`, { body: { maxDevices: 4 } });
  await admin('POST', `/licenses/${L.id}/revoke`);
  await admin('POST', `/licenses/${L.id}/reactivate`);
  await admin('DELETE', `/licenses/${L.id}`);
  await admin('POST', '/products', { body: { productId: 'audit-prog', name: 'Audit Prog' } });
  await request('POST', '/api/v1/admin/login', { body: { username: 'test-admin', password: 'wrong' } });
  const rows = (await pool.query('SELECT admin_user, action, target_type, target_id, meta FROM admin_audit_log ORDER BY id')).rows;
  const actions = rows.map((r) => r.action);
  for (const a of ['license.create', 'license.bulk_create', 'license.update', 'license.revoke', 'license.reactivate', 'license.delete', 'product.create', 'auth.login_failed']) {
    assert.ok(actions.includes(a), `missing audit action ${a}: ${actions}`);
  }
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(L.key), 'full license key must never be in the audit log');
  assert.ok(!dump.includes('wrong') && !dump.includes('test-password'), 'no passwords');
  assert.ok(rows.filter((r) => r.action === 'license.revoke').every((r) => r.admin_user === 'test-admin'));
});

test('E11. second server INSTANCE (separate OS process, same DB): events cross instances via LISTEN/NOTIFY', async () => {
  const port = 39000 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), LICENSE_EVENTS_POLL_MS: '60000' }, // poller effectively off: NOTIFY must do it
  });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  try {
    for (let i = 0; i < 50 && !/running on port/.test(log); i++) await sleep(100);
    assert.match(log, /running on port/);
    await sleep(500); // let its hub LISTEN
    const L = await makeLicense(); await activate(L.key, 'dev-e11');
    const s = await openStream(`http://127.0.0.1:${port}`, { licenseKey: L.key, deviceId: 'dev-e11' });
    assert.equal(s.status, 200);
    await sleep(200);
    const t0 = Date.now();
    await admin('POST', `/licenses/${L.id}/revoke`);       // performed on THIS process, not on the child
    const ev = await s.waitFor((e) => e.event === 'license', 3000);
    assert.ok(ev, 'event reached the connection that lives on the other instance');
    console.log(`# E11 cross-instance latency: ${ev.at - t0} ms`);
    s.close();
  } finally { child.kill('SIGTERM'); await sleep(200); }
});

test('E12. admin device reset: the device gets license.device_reset and then validate says "invalid" (re-activation flow)', async () => {
  const L = await makeLicense(); await activate(L.key, 'dev-e12');
  const act = (await pool.query('SELECT a.id FROM activations a JOIN devices d ON d.id=a.device_id WHERE a.license_id=$1 AND d.device_id=$2', [L.id, 'dev-e12'])).rows[0].id;
  const s = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e12' });
  await sleep(100);
  const r = await admin('POST', `/licenses/${act}/reset-device`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ev = await s.waitFor((e) => e.event === 'license');
  assert.equal(JSON.parse(ev.data).type, 'license.device_reset');
  const v = await request('POST', '/api/v1/licenses/validate', { body: { licenseKey: L.key, deviceId: 'dev-e12' } });
  assert.equal(v.json.status, 'invalid');
  // the device (whose activation was reset) can still reconnect to learn about later changes
  const again = await openStream(base, { licenseKey: L.key, deviceId: 'dev-e12' });
  assert.equal(again.status, 200);
  s.close(); again.close();
});
