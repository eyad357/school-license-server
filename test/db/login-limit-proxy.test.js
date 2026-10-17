'use strict';

// End-to-end check of the ADMIN LOGIN limiter (10 failed attempts / 15 min / IP) against the REAL app
// (spawned as child processes with a local test database), behind a Railway-like edge proxy.
// Verifies that forged X-Forwarded-For values cannot be used to get unlimited password guesses.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { resetDatabase, closeAll, ROOT } = require('./helpers/setup');

const HASH = bcrypt.hashSync('correct-horse', 4);
const children = [];

function startApp(extraEnv) {
  return new Promise((resolve, reject) => {
    const port = 42000 + Math.floor(Math.random() * 900);
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: 'test', JWT_SECRET: 'login-limit-test',
        ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: HASH, LOGIN_RATE_LIMIT_MAX: '10', API_RATE_LIMIT_MAX: '100000', ...extraEnv },
    });
    children.push(child);
    let log = '';
    const onData = (d) => { log += d; if (/running on port/.test(log)) resolve({ port, child, log: () => log }); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!/running on port/.test(log)) reject(new Error(`app exited ${code}: ${log.slice(0, 400)}`)); });
    setTimeout(() => reject(new Error('app did not start: ' + log.slice(0, 400))), 8000);
  });
}

function edgeProxy(appPort) {
  return http.createServer((req, res) => {
    const peer = req.socket.remoteAddress.replace(/^::ffff:/, '');
    const inc = req.headers['x-forwarded-for'];
    const up = http.request({ host: '127.0.0.1', port: appPort, path: req.url, method: req.method, agent: false,
      headers: { ...req.headers, 'x-forwarded-for': inc ? `${inc}, ${peer}` : peer } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
}

function login(port, { from, password = 'wrong', xff }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: 'admin', password });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (xff) headers['X-Forwarded-For'] = xff;
    const req = http.request({ host: '127.0.0.1', port, path: '/api/v1/admin/login', method: 'POST', headers, localAddress: from, agent: false }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(body);
  });
}

before(() => resetDatabase('full'));
after(async () => { children.forEach((c) => c.kill('SIGTERM')); await closeAll(); });

test('LP1. default (1 hop) behind the edge proxy: 10 wrong passwords with ROTATING forged X-Forwarded-For -> the 11th is 429', async () => {
  const app = await startApp({});
  const edge = edgeProxy(app.port); await new Promise((r) => edge.listen(0, '127.0.0.1', r));
  const edgePort = edge.address().port;
  try {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push(await login(edgePort, { from: '127.0.0.2', xff: `198.51.100.${i}` }));
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
    assert.deepEqual(codes.slice(10), [429, 429]);
    // the attacker's lock does not lock out a different real client, and the real admin password still works for them
    assert.equal(await login(edgePort, { from: '127.0.0.3', password: 'correct-horse' }), 200);
  } finally { edge.closeAllConnections?.(); edge.close(); }
});

test('LP2. TRUST_PROXY=false (reached directly): forged X-Forwarded-For is ignored, 11th attempt is 429', async () => {
  const app = await startApp({ TRUST_PROXY: 'false' });
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push(await login(app.port, { from: '127.0.0.2', xff: `203.0.113.${i}` }));
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
  assert.equal(codes[10], 429);
});

test('LP3. an unsafe TRUST_PROXY makes the service refuse to start (fail closed)', async () => {
  for (const bad of ['true', '::/64', '0.0.0.0/0']) {
    await assert.rejects(startApp({ TRUST_PROXY: bad }), /TRUST_PROXY/, bad);
  }
});
