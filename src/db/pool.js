'use strict';

const { Pool } = require('pg');
const { resolveDatabaseUrl } = require('./config');

const pool = new Pool({
  // In production a missing/empty DATABASE_URL throws here (see ./config) instead of
  // letting pg fall back to localhost:5432.
  connectionString: resolveDatabaseUrl(),
  // A request must never wait forever for a connection (a starved pool used to hang silently).
  max: Number(process.env.DB_POOL_MAX) || 20,
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10000,
});

module.exports = pool;