'use strict';

// Resolves the PostgreSQL connection string.
//
// Why this exists: `new Pool({ connectionString: undefined })` (or an empty
// string) makes `pg` silently fall back to its built-in defaults - localhost
// port 5432 - which in a container produces
//   ECONNREFUSED 127.0.0.1:5432 / ::1:5432
// on every query while the app still looks "up". In production we refuse to
// start instead of guessing. Outside production (development, tests) the
// previous behaviour is unchanged.
//
// Secrets: the connection string is never put in an error message.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

// Railway does not set NODE_ENV by itself, so its own variables count too.
// NODE_ENV=test always wins (the test suites run with a local test database).
function isProduction(env = process.env) {
  if (env.NODE_ENV === 'production') return true;
  if (env.NODE_ENV === 'test') return false;

  return Boolean(
    env.RAILWAY_ENVIRONMENT ||
    env.RAILWAY_ENVIRONMENT_NAME ||
    env.RAILWAY_PROJECT_ID ||
    env.RAILWAY_SERVICE_ID
  );
}

// Names (never values) of database-related variables this process can see, so a
// misconfigured service is easy to diagnose from the log alone.
function describeDbEnv(env = process.env) {
  const parts = Object.keys(env)
    .filter((k) => /^(DATABASE|POSTGRES|PG[A-Z_]*$)/.test(k))
    .sort()
    .map((k) => {
      const v = String(env[k]);
      if (v.trim() === '') return `${k}=EMPTY(len ${v.length})`;
      // Only shape flags, never content.
      const flags = [];
      if (v.includes('${')) flags.push('unresolved-template');
      if (/^["']|["']$/.test(v.trim())) flags.push('wrapped-in-quotes');
      if (v !== v.trim()) flags.push('has-outer-whitespace');
      return `${k}=set(len ${v.length}${flags.length ? ', ' + flags.join('/') : ''})`;
    });
  // Non-secret identity of the running service/build, to prove WHICH deployment
  // produced this message.
  const where = [
    'RAILWAY_SERVICE_NAME', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_GIT_BRANCH',
    'RAILWAY_DEPLOYMENT_ID', 'RAILWAY_REPLICA_ID'
  ]
    .filter((k) => env[k])
    .map((k) => `${k}=${env[k]}`);
  if (env.RAILWAY_GIT_COMMIT_SHA) where.push(`RAILWAY_GIT_COMMIT_SHA=${String(env.RAILWAY_GIT_COMMIT_SHA).slice(0, 7)}`);
  where.push(`total_env_vars=${Object.keys(env).length}`, `cwd=${process.cwd()}`);

  return (
    `Seen by this process - database variables: ${parts.length ? parts.join(', ') : 'none'}` +
    `; ${where.join(', ')}.`
  );
}

function resolveDatabaseUrl(env = process.env) {
  const raw = typeof env.DATABASE_URL === 'string' ? env.DATABASE_URL.trim() : '';

  if (!isProduction(env)) {
    return raw || undefined; // unchanged development / test behaviour
  }

  if (!raw) {
    throw new Error(
      'DATABASE_URL is missing or empty in this service\'s environment. ' +
        'Refusing to start: without it the PostgreSQL driver would silently try localhost:5432. ' +
        'Set DATABASE_URL on THIS service (on Railway: a variable reference to the Postgres service\'s DATABASE_URL), apply the staged changes and redeploy. ' +
        describeDbEnv(env)
    );
  }

  let url;

  try {
    url = new URL(raw);
  } catch (_e) {
    throw new Error('DATABASE_URL is not a valid URL (value not shown for security).');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must start with postgres:// or postgresql:// (value not shown for security).');
  }

  if (LOOPBACK_HOSTS.has(url.hostname) && env.ALLOW_LOCAL_DATABASE !== '1') {
    throw new Error(
      `DATABASE_URL points to ${url.hostname} in a production environment, which is not this service's database. ` +
        'Use the real database host, or set ALLOW_LOCAL_DATABASE=1 only if a local database is intended.'
    );
  }

  return raw;
}

module.exports = { resolveDatabaseUrl, isProduction, describeDbEnv };
