'use strict';
// LOCAL load simulation of the license push channel. Refuses any DB that is not local and named *test*.
//   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/license_load_test node scripts/load-sse.js [devices=1000]
// Numbers are LOOPBACK numbers (client and server on one machine): they show CPU/memory/fan-out behaviour of the code,
// NOT internet latency and NOT Railway capacity.
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const { Client } = require('pg');
const DB = process.env.TEST_DATABASE_URL; const N = Number(process.argv[2] || 1000);
const u = DB && new URL(DB);
if (!DB || !['127.0.0.1', 'localhost'].includes(u.hostname) || !/test/i.test(u.pathname)) { console.error('Refusing: need a LOCAL TEST_DATABASE_URL containing "test".'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 43500 + Math.floor(Math.random() * 300); const base = `http://127.0.0.1:${port}`;
const rss = (pid) => Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024;
const pct = (a, q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];

(async () => {
  const c = new Client({ connectionString: DB }); await c.connect();
  await c.query('DROP SCHEMA public CASCADE'); await c.query('CREATE SCHEMA public');
  for (const f of ['schema.sql', '002_customers.sql', '003_payment_orders.sql', '004_customer_management.sql', '005_products_platform.sql', '006_events_audit.sql']) await c.query(fs.readFileSync(path.join(__dirname, '..', 'src/db', f), 'utf8'));
  const srv = spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), DATABASE_URL: DB, NODE_ENV: 'test', JWT_SECRET: 'x', ADMIN_USERNAME: 'a', ADMIN_PASSWORD_HASH: require('bcryptjs').hashSync('p', 4), API_RATE_LIMIT_MAX: '1000000', LICENSE_EVENTS_HEARTBEAT_MS: '5000' } });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 80 && !/running on port/.test(log); i++) await sleep(100);
  const tok = (await (await fetch(`${base}/api/v1/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'p' }) })).json()).token;
  const adm = (m, p, b, h = {}) => fetch(`${base}/api/v1/admin${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...h }, body: b ? JSON.stringify(b) : undefined });
  const idle = rss(srv.pid);
  let t = Date.now();
  const br = await adm('POST', '/licenses/bulk', { productId: 'school-accreditation', quantity: N, maxDevices: 1 }, { 'Idempotency-Key': 'load-test-key-0001' });
  console.log(`bulk create ${N} licenses: HTTP ${br.status} in ${Date.now() - t} ms`); if (br.status >= 300) { console.log(await br.text()); process.exit(1); }
  const lic = (await c.query('SELECT id, license_key FROM licenses ORDER BY id')).rows;
  // activate every device (real API)
  t = Date.now(); let ok = 0;
  for (let i = 0; i < lic.length; i += 50) await Promise.all(lic.slice(i, i + 50).map(async (l, j) => { const r = await fetch(`${base}/api/v1/licenses/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licenseKey: l.license_key, productId: 'school-accreditation', deviceId: `load-dev-${i + j}` }) }); if ((await r.json()).status === 'active') ok++; }));
  console.log(`activated ${ok}/${N} devices in ${Date.now() - t} ms`);
  // open N streams
  const got = new Map(); const aborts = []; let open = 0;
  const openOne = async (l, i) => {
    const ac = new AbortController(); aborts.push(ac);
    const r = await fetch(`${base}/api/v1/licenses/events`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licenseKey: l.license_key, productId: 'school-accreditation', deviceId: `load-dev-${i}` }) });
    if (r.status !== 200) return; open++;
    (async () => { const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value); if (/event: license/.test(buf) && !got.has(l.id)) got.set(l.id, Date.now()); if (buf.length > 4096) buf = buf.slice(-512); } } catch (_e) { /* aborted */ } })();
  };
  t = Date.now();
  for (let i = 0; i < lic.length; i += 100) await Promise.all(lic.slice(i, i + 100).map((l, j) => openOne(l, i + j)));
  await sleep(1500);
  const connected = rss(srv.pid);
  console.log(`opened ${open}/${N} streams in ${Date.now() - t} ms; server RSS idle=${idle.toFixed(0)} MB, with ${open} streams=${connected.toFixed(1)} MB (${((connected - idle) / open * 1024).toFixed(1)} KB/stream)`);
  // heartbeat load for 10 s
  const cpu0 = process.cpuUsage(); await sleep(10000);
  // fan-out: revoke 200 licenses at once
  const K = Math.min(200, N); const sent = new Map(); t = Date.now();
  await Promise.all(lic.slice(0, K).map(async (l) => { sent.set(l.id, Date.now()); await adm('POST', `/licenses/${l.id}/revoke`); }));
  await sleep(4000);
  const lat = lic.slice(0, K).map((l) => (got.has(l.id) ? got.get(l.id) - sent.get(l.id) : null));
  const okLat = lat.filter((x) => x != null && x >= 0).sort((a, b) => a - b);
  console.log(`burst revoke ${K} licenses at once with ${open} open streams: delivered ${okLat.length}/${K}; latency ms p50=${pct(okLat, 0.5)} p95=${pct(okLat, 0.95)} max=${okLat[okLat.length - 1]}`);
  const others = lic.slice(K).filter((l) => got.has(l.id)).length;
  console.log(`isolation: streams of NON-revoked licenses that received an event: ${others} (must be 0)`);
  console.log(`server RSS after burst: ${rss(srv.pid).toFixed(1)} MB; server log errors: ${(log.match(/error/gi) || []).length}`);
  const hub = await (await fetch(`${base}/api/v1/health`)).text().catch(() => '');
  void hub; void cpu0;
  aborts.forEach((a) => a.abort()); await sleep(500);
  srv.kill('SIGTERM'); await c.end();
  process.exit(okLat.length === K && others === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
