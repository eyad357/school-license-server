'use strict';

// Shared setup for the real-database tests. REQUIRE THIS FIRST in every
// test/db/*.test.js file: it sets the environment BEFORE the app/pool modules
// are loaded, and it refuses to run against anything that is not a disposable
// test database.

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function fail(message) {
  throw new Error(
    `\n\n[test safety] ${message}\n` +
      'Real-DB tests need an EMPTY, DISPOSABLE PostgreSQL database, e.g.:\n' +
      '  TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/license_test npm run test:db\n' +
      'They DROP and recreate the "public" schema of that database.\n'
  );
}

function resolveTestDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    fail('TEST_DATABASE_URL is not set.');
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch (_e) {
    fail('TEST_DATABASE_URL is not a valid URL.');
  }

  const dbName = parsed.pathname.replace(/^\//, '');
  const localHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];

  if (!/(^|[_-])test([_-]|$)/i.test(dbName)) {
    fail(`Refusing: database name "${dbName}" must contain the word "test" (e.g. license_test).`);
  }

  if (!localHosts.includes(parsed.hostname) && process.env.ALLOW_REMOTE_TEST_DB !== '1') {
    fail(
      `Refusing: host "${parsed.hostname}" is not local. Set ALLOW_REMOTE_TEST_DB=1 only if this is a throw-away test database.`
    );
  }

  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
    // Same value is fine; a *different* DATABASE_URL is simply overridden below.
  }

  return url;
}

const TEST_DATABASE_URL = resolveTestDatabaseUrl();

// Override whatever .env / the shell provided - the app must only ever see the test DB.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-jwt-secret-not-used-anywhere-else';
process.env.ADMIN_USERNAME = 'test-admin';
process.env.API_RATE_LIMIT_MAX = '1000000';

const bcrypt = require('bcryptjs');
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('test-password', 4);

const jwt = require('jsonwebtoken');
const pool = require(path.join(ROOT, 'src', 'db', 'pool'));

// Double check: the pool really points at the test DB.
if (pool.options.connectionString !== TEST_DATABASE_URL) {
  fail('The connection pool is not using TEST_DATABASE_URL.');
}

const app = require(path.join(ROOT, 'src', 'index.js'));
const { hub } = require(path.join(ROOT, 'src', 'services', 'eventService'));

const MIGRATIONS = {
  schema: 'src/db/schema.sql',
  customers: 'src/db/002_customers.sql',
  payments: 'src/db/003_payment_orders.sql',
  customerManagement: 'src/db/004_customer_management.sql',
  productsPlatform: 'src/db/005_products_platform.sql',
  eventsAudit: 'src/db/006_events_audit.sql',
  saleStatus: 'src/db/007_sale_status.sql',
};

function readSql(key) {
  return fs.readFileSync(path.join(ROOT, MIGRATIONS[key]), 'utf8');
}

/**
 * Wipes the test database and rebuilds it.
 *   stage 'legacy' => schema + 002 + 003 only (what production has today)
 *   stage 'full'   => legacy + 004 + 005 (the new version)
 */
async function resetDatabase(stage = 'full') {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');

  await pool.query(readSql('schema'));
  await pool.query(readSql('customers'));
  await pool.query(readSql('payments'));

  if (stage === 'full') {
    await pool.query('BEGIN');
    try {
      await pool.query(readSql('customerManagement'));
      await pool.query(readSql('productsPlatform'));
      await pool.query(readSql('eventsAudit'));
      await pool.query(readSql('saleStatus'));
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
}

function adminToken({ role = 'admin', expiresIn = '1h' } = {}) {
  return jwt.sign({ role, username: 'test-admin' }, process.env.JWT_SECRET, { expiresIn });
}

let server;
let baseUrl;

async function startServer() {
  if (server) {
    return baseUrl;
  }

  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', resolve);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (process.env.TEST_START_HUB === '1') await hub.start();
  return baseUrl;
}

async function stopServer() {
  await hub.stop().catch(() => {});
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
}

async function request(method, urlPath, { token, body, headers = {}, raw = false } = {}) {
  await startServer();

  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;

  if (!raw) {
    try {
      json = JSON.parse(buffer.toString('utf8'));
    } catch (_e) {
      json = null;
    }
  }

  return { status: response.status, headers: response.headers, json, buffer };
}

const admin = (method, urlPath, options = {}) =>
  request(method, `/api/v1/admin${urlPath}`, { token: adminToken(), ...options });

async function closeAll() {
  await stopServer();
  await pool.end();
}

module.exports = {
  ROOT,
  pool,
  app,
  resetDatabase,
  readSql,
  adminToken,
  startServer,
  stopServer,
  request,
  admin,
  closeAll,
  hub,
};
