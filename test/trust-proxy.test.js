'use strict';

// Security regression tests for the proxy-addr / ip-address / trust-proxy hardening.
// No database needed. A tiny "edge proxy" plays the role of Railway's edge: like a real reverse proxy it
// APPENDS the address it saw on the socket to whatever X-Forwarded-For the client already sent.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const proxyaddr = require('proxy-addr');
const { parseTrustProxy } = require('../src/lib/trustProxy');

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

function get(port, { from, headers = {}, path = '/ip' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers, localAddress: from, agent: false }, (res) => {
      let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
}

/** Railway-like edge: appends the real peer address to X-Forwarded-For and forwards to the app. */
function edgeProxy(appPort) {
  return http.createServer((req, res) => {
    const peer = req.socket.remoteAddress.replace(/^::ffff:/, '');
    const incoming = req.headers['x-forwarded-for'];
    const headers = { ...req.headers, 'x-forwarded-for': incoming ? `${incoming}, ${peer}` : peer };
    const up = http.request({ host: '127.0.0.1', port: appPort, path: req.url, method: req.method, headers, agent: false }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
}

function ipApp(trust) {
  const app = express();
  app.set('trust proxy', trust);
  app.get('/ip', (req, res) => res.send(req.ip));
  return app;
}

test('T1. default config (1 hop) behind an edge proxy: req.ip is the real client, a forged X-Forwarded-For is ignored', async () => {
  const app = http.createServer(ipApp(parseTrustProxy(undefined)));
  const appPort = await listen(app); const edge = edgeProxy(appPort); const edgePort = await listen(edge);
  try {
    const real = await get(edgePort, { from: '127.0.0.2' });
    assert.equal(real.body, '127.0.0.2');
    for (const forged of ['1.2.3.4', '203.0.113.9, 198.51.100.7', '127.0.0.3', '::1', '10.0.0.1, 10.0.0.2, 10.0.0.3']) {
      const r = await get(edgePort, { from: '127.0.0.2', headers: { 'X-Forwarded-For': forged } });
      assert.equal(r.body, '127.0.0.2', `forged header "${forged}" must not change req.ip`);
    }
    const other = await get(edgePort, { from: '127.0.0.3', headers: { 'X-Forwarded-For': '127.0.0.2' } });
    assert.equal(other.body, '127.0.0.3', 'another client cannot borrow someone else\'s address');
  } finally { await close(edge); await close(app); }
});

test('T2. TRUST_PROXY=false (service reached directly): X-Forwarded-For is ignored completely', async () => {
  const app = http.createServer(ipApp(parseTrustProxy('false')));
  const port = await listen(app);
  try {
    const r = await get(port, { from: '127.0.0.2', headers: { 'X-Forwarded-For': '1.2.3.4' } });
    assert.equal(r.body, '127.0.0.2');
  } finally { await close(app); }
});

test('T3. DOCUMENTED LIMIT: with the default 1 hop, a service that is reachable WITHOUT the proxy can be spoofed (hence TRUST_PROXY=false there)', async () => {
  const app = http.createServer(ipApp(parseTrustProxy(undefined)));
  const port = await listen(app);
  try {
    const r = await get(port, { from: '127.0.0.2', headers: { 'X-Forwarded-For': '1.2.3.4' } });
    assert.equal(r.body, '1.2.3.4', 'this is why the service must only be reachable through the proxy');
  } finally { await close(app); }
});

test('T4. rate limit keyed on req.ip: rotating forged X-Forwarded-For values does not create new buckets behind the proxy', async () => {
  const app = express(); app.set('trust proxy', parseTrustProxy(undefined));
  app.use(rateLimit({ windowMs: 60000, limit: 5, standardHeaders: false, legacyHeaders: false }));
  app.get('/ip', (_req, res) => res.send('ok'));
  const server = http.createServer(app); const appPort = await listen(server);
  const edge = edgeProxy(appPort); const edgePort = await listen(edge);
  try {
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await get(edgePort, { from: '127.0.0.2', headers: { 'X-Forwarded-For': `9.9.9.${i}` } })).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429, 429]);
    assert.equal((await get(edgePort, { from: '127.0.0.3' })).status, 200, 'a different real client is unaffected');
  } finally { await close(edge); await close(server); }
});

test('T5. parseTrustProxy: safe defaults, refuses "trust everybody" shapes', () => {
  assert.equal(parseTrustProxy(undefined), 1);
  assert.equal(parseTrustProxy(''), 1);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('0'), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.deepEqual(parseTrustProxy('10.0.0.0/8, 192.168.1.5'), ['10.0.0.0/8', '192.168.1.5']);
  assert.deepEqual(parseTrustProxy('loopback'), ['loopback']);
  for (const bad of ['true', 'TRUE', '99', '0.0.0.0/0', '::/0', '::/64', '::ffff:0:0/8', '1.2.3.4/4', 'nonsense', '10.0.0.0/33', ',']) {
    assert.throws(() => parseTrustProxy(bad), /TRUST_PROXY/, `"${bad}" must be refused`);
  }
});

test('T6. proxy-addr >= 2.0.8: an IPv6 trust prefix shorter than /96 no longer "trusts" arbitrary public IPv4 addresses (GHSA-jqcg-44mw-7w3h)', () => {
  const version = require('proxy-addr/package.json').version;
  const [maj, min, pat] = version.split('.').map(Number);
  assert.ok(maj > 2 || (maj === 2 && (min > 0 || pat >= 8)), `proxy-addr ${version} is below 2.0.8`);
  // Cases that the vulnerable 2.0.7 answered "true" (found by differential fuzzing old vs new):
  const cases = [['::/64', '191.5.94.182'], ['::/8', '::ffff:168.55.186.61'], ['::ffff:0:0/8', '246.163.74.66'], ['::ffff:0:0/95', '211.200.88.135'], ['::ffff:0:0/64', '0:0:0:0:3975:ef49:9dff:b10c']];
  for (const [range, ip] of cases) assert.equal(proxyaddr.compile([range])(ip), false, `${range} must not trust ${ip}`);
  // legitimate behaviour is unchanged
  assert.equal(proxyaddr.compile(['10.0.0.0/8'])('10.1.2.3'), true);
  assert.equal(proxyaddr.compile(['10.0.0.0/8'])('::ffff:10.1.2.3'), true);
  assert.equal(proxyaddr.compile(['10.0.0.0/8'])('8.8.8.8'), false);
  assert.equal(proxyaddr.compile(['loopback'])('::ffff:127.0.0.1'), true);
});

test('T7. ip-address >= 10.7.1 works with express-rate-limit: IPv6 clients share one bucket per /56 (no easy bypass by rotating addresses)', () => {
  const version = require('ip-address/package.json').version;
  const [maj, min, pat] = version.split('.').map(Number);
  assert.ok(maj > 10 || (maj === 10 && (min > 7 || (min === 7 && pat >= 1))), `ip-address ${version} is below 10.7.1`);
  assert.equal(ipKeyGenerator('203.0.113.5'), '203.0.113.5');
  assert.equal(ipKeyGenerator('::ffff:203.0.113.5'), '203.0.113.5', 'IPv4-mapped IPv6 collapses to the IPv4 bucket');
  const a = ipKeyGenerator('2001:db8:aaaa:bb00:1:2:3:4');
  const b = ipKeyGenerator('2001:db8:aaaa:bbff:ffff:ffff:ffff:ffff');
  assert.equal(a, b, 'two addresses in the same /56 must share a key');
  assert.notEqual(a, ipKeyGenerator('2001:db8:aaaa:cc00::1'), 'a different /56 gets its own key');
});

test('T8. (sanity check, also passes on the old version; not a proof of the fix) huge garbage input is rejected quickly and the rate limiter never parses non-IPv6 text as IPv6', () => {
  const { Address6 } = require('ip-address');
  const started = process.hrtime.bigint();
  assert.throws(() => new Address6(':'.repeat(200000) + 'zz'));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 500, `parsing a 200 KB garbage string took ${ms.toFixed(0)} ms`);
  assert.equal(ipKeyGenerator('not-an-ip-' + 'x'.repeat(100000)).startsWith('not-an-ip-'), true, 'non-IPv6 text is returned untouched, never parsed as IPv6');
});

test('T9. uuid override: exceljs resolves uuid >= 11.1.1 and its only usage (v4) keeps working', () => {
  const exceljsPath = require.resolve('exceljs');
  const uuidPath = require.resolve('uuid', { paths: [exceljsPath] });
  const version = require(require('path').join(require('path').dirname(uuidPath), '..', '..', 'package.json')).version;
  const [maj, min, pat] = version.split('.').map(Number);
  assert.ok(maj > 11 || (maj === 11 && (min > 1 || (min === 1 && pat >= 1))), `uuid ${version} is below 11.1.1`);
  const { v4, validate, version: ver } = require(uuidPath);
  const id = v4();
  assert.ok(validate(id) && ver(id) === 4);
  assert.notEqual(v4(), v4());
});

test('T10. exceljs still writes and re-reads a workbook through the code path that calls uuid.v4 (data-bar conditional formatting) and an Arabic cell', async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('اختبار');
  ws.addRow(['الاسم', 'القيمة']); ws.addRow(['أحمد', 10]); ws.addRow(['منى', 20]);
  ws.addConditionalFormatting({ ref: 'B2:B3', rules: [{ type: 'dataBar', priority: 1, minLength: 0, maxLength: 100, gradient: true,
    cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF638EC6' }, border: false }] });
  const buffer = await wb.xlsx.writeBuffer();
  assert.ok(buffer.length > 1000);
  const text = Buffer.from(buffer).toString('latin1');
  assert.ok(buffer[0] === 0x50 && buffer[1] === 0x4b, 'is a zip/xlsx');
  const back = new ExcelJS.Workbook(); await back.xlsx.load(buffer);
  assert.equal(back.getWorksheet('اختبار').getCell('A2').value, 'أحمد');
  assert.equal(back.getWorksheet('اختبار').getCell('B3').value, 20);
  void text;
});
