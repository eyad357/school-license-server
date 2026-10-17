'use strict';

// The app must connect with DATABASE_URL and must never fall back to localhost
// in production. No database is needed here (the pool is created, not used).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveDatabaseUrl, isProduction } = require('../src/db/config');

const ROOT = path.resolve(__dirname, '..');
const RAILWAY_URL = 'postgresql://app:s3cr3t-pw@postgres.railway.internal:5432/railway';

test('production: a missing / empty / blank DATABASE_URL refuses to start (no silent localhost)', () => {
  for (const env of [
    { NODE_ENV: 'production' },
    { NODE_ENV: 'production', DATABASE_URL: '' },
    { NODE_ENV: 'production', DATABASE_URL: '   ' },
    { RAILWAY_ENVIRONMENT: 'production' },
    { RAILWAY_PROJECT_ID: 'abc', DATABASE_URL: '' },
  ]) {
    assert.throws(() => resolveDatabaseUrl(env), /DATABASE_URL is missing or empty/, JSON.stringify(env));
  }
});

test('production: the real DATABASE_URL is used exactly as given (trimmed)', () => {
  assert.equal(resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: RAILWAY_URL }), RAILWAY_URL);
  assert.equal(resolveDatabaseUrl({ RAILWAY_ENVIRONMENT: 'production', DATABASE_URL: `  ${RAILWAY_URL}\n` }), RAILWAY_URL);
  assert.equal(resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h.proxy.rlwy.net:1234/db' }), 'postgres://u:p@h.proxy.rlwy.net:1234/db');
});

test('production: loopback hosts and malformed values are refused, with no secret in the message', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0']) {
    assert.throws(
      () => resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: `postgres://u:topsecret@${host}:5432/x` }),
      (e) => /production environment/.test(e.message) && !e.message.includes('topsecret')
    );
  }
  assert.equal(
    resolveDatabaseUrl({ NODE_ENV: 'production', ALLOW_LOCAL_DATABASE: '1', DATABASE_URL: 'postgres://u:p@localhost:5432/x' }),
    'postgres://u:p@localhost:5432/x',
    'explicit opt-out only'
  );
  assert.throws(() => resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: 'not a url with topsecret' }), (e) => !e.message.includes('topsecret'));
  assert.throws(() => resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: 'mysql://u:p@db.example.com/x' }), /postgres/);
});

test('environment detection: Railway variables imply production, NODE_ENV=test never does', () => {
  assert.equal(isProduction({ NODE_ENV: 'production' }), true);
  assert.equal(isProduction({ RAILWAY_SERVICE_ID: 'x' }), true);
  assert.equal(isProduction({ NODE_ENV: 'test', RAILWAY_ENVIRONMENT: 'production' }), false);
  assert.equal(isProduction({}), false);
  assert.equal(isProduction({ NODE_ENV: 'development' }), false);
});

test('development / test behaviour is unchanged (local tests keep working)', () => {
  assert.equal(resolveDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/license_test' }), 'postgres://postgres@127.0.0.1:5432/license_test');
  assert.equal(resolveDatabaseUrl({}), undefined);
});

// ---- the real modules, in a clean child process --------------------------------
function child(code, env) {
  return spawnSync(process.execPath, ['-e', code], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('src/db/pool.js really connects with DATABASE_URL (host, port and database come from it)', () => {
  const r = child(
    "const p=require('./src/db/pool');const o=p.options;" +
      "console.log(JSON.stringify({cs:o.connectionString,host:o.host,port:o.port})); p.end();",
    { NODE_ENV: 'production', DATABASE_URL: RAILWAY_URL }
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.cs, RAILWAY_URL);
  assert.equal(out.host, undefined, 'no host override / no localhost default');
});

test('src/db/pool.js aborts startup in production without DATABASE_URL, with a clear message', () => {
  for (const env of [{ NODE_ENV: 'production' }, { RAILWAY_ENVIRONMENT: 'production' }, { NODE_ENV: 'production', DATABASE_URL: '' }]) {
    const r = child("require('./src/db/pool');console.log('STARTED')", env);
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.ok(!r.stdout.includes('STARTED'));
    assert.match(r.stderr, /DATABASE_URL is missing or empty/);
  }
});

test('no code path builds a database connection from process.env.DATABASE_URL directly', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) { if (name !== 'public') walk(p); continue; }
      if (!p.endsWith('.js') || p.endsWith(path.join('db', 'config.js'))) continue;
      if (/process\.env\.DATABASE_URL/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(offenders, [], 'src must go through src/db/config.js');
});

test('the startup error names the database variables the process can see, never their values', () => {
  const env = {
    NODE_ENV: 'production', DATABASE_URL: '  ', PGHOST: 'secret-host.example', DATABASE_PUBLIC_URL: 'postgres://u:topsecret@h/x',
    RAILWAY_SERVICE_NAME: 'my-app', JWT_SECRET: 'unrelated-secret',
  };
  assert.throws(
    () => resolveDatabaseUrl(env),
    (e) => /DATABASE_URL=EMPTY/.test(e.message) && /DATABASE_PUBLIC_URL=set/.test(e.message) && /PGHOST=set/.test(e.message) &&
      /RAILWAY_SERVICE_NAME=my-app/.test(e.message) &&
      !/topsecret|secret-host|unrelated-secret/.test(e.message)
  );
  assert.throws(() => resolveDatabaseUrl({ NODE_ENV: 'production' }), /database variables: none/);
});

test('describeDbEnv reports shape and build identity but never values', () => {
  const { describeDbEnv } = require('../src/db/config');
  const secret = 'S3cretPassw0rd';
  const out = describeDbEnv({
    DATABASE_URL: `postgres://u:${secret}@h.railway.internal:5432/db`,
    PGPASSWORD: secret,
    DATABASE_PUBLIC_URL: '${{Postgres.DATABASE_URL}}',
    POSTGRES_DB: '',
    RAILWAY_SERVICE_NAME: 'svc',
    RAILWAY_GIT_COMMIT_SHA: 'b2c8c5e10916c3793219f5105274cb80b1ac56d3'
  });
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes('railway.internal'));
  assert.match(out, /DATABASE_URL=set\(len \d+\)/);
  assert.match(out, /DATABASE_PUBLIC_URL=set\(len \d+, unresolved-template\)/);
  assert.match(out, /POSTGRES_DB=EMPTY\(len 0\)/);
  assert.match(out, /RAILWAY_GIT_COMMIT_SHA=b2c8c5e[,;. ]/);
  assert.ok(!out.includes('b2c8c5e10916'));
});
