'use strict';

/**
 * Safe migration runner.
 *
 *   node scripts/migrate.js --plan  [file]   dry run: executes inside a transaction, prints what
 *                                            would change, then ROLLS BACK. Nothing is saved.
 *   node scripts/migrate.js --apply [file]   executes, verifies, then COMMITs.
 *
 * Default file: src/db/004_customer_management.sql (pass src/db/005_products_platform.sql for the multi-product migration;
 * run 004 first, then 005, 006, 007 - each is its own transaction and each is idempotent)
 * Reads DATABASE_URL from the environment (or .env). It never prints secrets.
 *
 * Guarantees:
 *   - the whole file runs in ONE transaction (any error => full rollback)
 *   - files containing destructive statements are refused
 *   - the content of licenses / devices / activations / products is fingerprinted
 *     before and after; any difference aborts and rolls back
 */

const fs = require('fs');
const path = require('path');

const DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN|SCHEMA|DATABASE|INDEX|CONSTRAINT|TRIGGER|FUNCTION)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+\w+\s+DROP|RENAME\s+(TO|COLUMN))\b/i;

// Tables whose data must be byte-for-byte identical after the migration.
const PROTECTED_TABLES = [
  {
    name: 'licenses',
    // Only the columns that existed before this migration.
    fingerprint: `
      SELECT COUNT(*)::int AS n,
             COALESCE(md5(string_agg(
               concat_ws('|', id, license_key, product_id, status, max_devices,
                         expires_at, customer_id, plan, license_type, created_at),
               E'\\n' ORDER BY id)), '') AS digest
      FROM licenses`,
  },
  {
    name: 'devices',
    fingerprint: `
      SELECT COUNT(*)::int AS n,
             COALESCE(md5(string_agg(
               concat_ws('|', id, device_id, created_at, last_seen_at), E'\\n' ORDER BY id)), '') AS digest
      FROM devices`,
  },
  {
    name: 'activations',
    fingerprint: `
      SELECT COUNT(*)::int AS n,
             COALESCE(md5(string_agg(
               concat_ws('|', id, license_id, device_id, activated_at, deactivated_at),
               E'\\n' ORDER BY id)), '') AS digest
      FROM activations`,
  },
  {
    name: 'products',
    fingerprint: `
      SELECT COUNT(*)::int AS n,
             COALESCE(md5(string_agg(concat_ws('|', id, product_id, name), E'\\n' ORDER BY id)), '') AS digest
      FROM products`,
  },
];

function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function assertNonDestructive(sql) {
  const match = stripSqlComments(sql).match(DESTRUCTIVE);

  if (match) {
    throw new Error(
      `Refusing to run: migration contains a destructive statement ("${match[0]}").`
    );
  }
}

async function tableExists(client, name) {
  const r = await client.query('SELECT to_regclass($1) AS t', [`public.${name}`]);
  return r.rows[0].t !== null;
}

async function snapshotProtected(client) {
  const out = {};

  for (const table of PROTECTED_TABLES) {
    if (!(await tableExists(client, table.name))) {
      out[table.name] = null;
      continue;
    }

    const r = await client.query(table.fingerprint);
    out[table.name] = r.rows[0];
  }

  return out;
}

function diffSnapshots(before, after) {
  const problems = [];

  for (const table of PROTECTED_TABLES) {
    const b = before[table.name];
    const a = after[table.name];

    if (JSON.stringify(b) !== JSON.stringify(a)) {
      problems.push(
        `${table.name}: before=${JSON.stringify(b)} after=${JSON.stringify(a)}`
      );
    }
  }

  return problems;
}

/**
 * Runs `sql` on `client` inside a transaction and verifies the protected tables.
 * mode: 'apply' => COMMIT on success, 'plan' => always ROLLBACK.
 * Returns { before, after, report }.
 */
async function runMigration(client, sql, { mode = 'plan', log = () => {} } = {}) {
  assertNonDestructive(sql);

  const hasCustomers = await tableExists(client, 'customers');

  if (!hasCustomers) {
    throw new Error(
      'Table "customers" does not exist. Apply src/db/002_customers.sql first.'
    );
  }

  await client.query('BEGIN');

  try {
    const before = await snapshotProtected(client);
    const customersBefore = (
      await client.query('SELECT COUNT(*)::int AS n FROM customers')
    ).rows[0].n;

    await client.query(sql);

    const after = await snapshotProtected(client);
    const problems = diffSnapshots(before, after);

    if (problems.length) {
      throw new Error(
        'Protected tables changed during migration; aborting:\n  ' +
          problems.join('\n  ')
      );
    }

    const customersAfter = (
      await client.query('SELECT COUNT(*)::int AS n FROM customers')
    ).rows[0].n;

    if (customersAfter !== customersBefore) {
      throw new Error(
        `Customer row count changed (${customersBefore} -> ${customersAfter}); aborting.`
      );
    }

    const hasNumber = (await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='customers' AND column_name='customer_number'`
    )).rowCount > 0;
    // Files that run before 004 (e.g. 003) legitimately leave customers without a number yet.
    const numbering = hasNumber
      ? await client.query('SELECT id, customer_number, created_at FROM customers ORDER BY customer_number ASC')
      : { rows: [] };

    if (hasNumber) {
      const dup = await client.query(`
        SELECT COUNT(*)::int AS n FROM (
          SELECT customer_number FROM customers GROUP BY 1 HAVING COUNT(*) > 1
        ) d
      `);

      if (dup.rows[0].n !== 0) {
        throw new Error('Duplicate customer numbers detected; aborting.');
      }
    }

    const report = {
      customers: customersAfter,
      numbering: numbering.rows,
      protected: after,
    };

    if (mode === 'apply') {
      await client.query('COMMIT');
      log('COMMITTED.');
    } else {
      await client.query('ROLLBACK');
      log('Dry run finished: ROLLED BACK. Nothing was saved.');
    }

    return { before, after, report };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--apply') ? 'apply' : args.includes('--plan') ? 'plan' : null;
  const fileArg = args.find((a) => !a.startsWith('--'));

  if (!mode) {
    console.error('Usage: node scripts/migrate.js (--plan | --apply) [file.sql]');
    process.exitCode = 2;
    return;
  }

  require('dotenv').config();

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exitCode = 2;
    return;
  }

  const file = path.resolve(
    fileArg || path.join(__dirname, '..', 'src', 'db', '004_customer_management.sql')
  );
  const sql = fs.readFileSync(file, 'utf8');

  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  let host = 'unknown';
  let dbName = 'unknown';

  try {
    const u = new URL(process.env.DATABASE_URL);
    host = u.hostname;
    dbName = u.pathname.replace(/^\//, '');
  } catch (_e) {
    /* leave as unknown */
  }

  console.log(`Mode: ${mode.toUpperCase()}`);
  console.log(`File: ${path.relative(process.cwd(), file)}`);
  console.log(`Target database: ${dbName} @ ${host}`);

  await client.connect();

  try {
    const result = await runMigration(client, sql, {
      mode,
      log: (m) => console.log(m),
    });

    console.log('\nProtected tables (row count + content fingerprint) - identical before/after:');
    for (const t of PROTECTED_TABLES) {
      const s = result.after[t.name];
      console.log(`  ${t.name}: ${s ? `${s.n} rows, md5 ${s.digest || '(empty)'}` : '(table not present)'}`);
    }

    const nums = result.report.numbering.map((r) => Number(r.customer_number));
    console.log(`\nCustomers: ${result.report.customers}` + (nums.length ? `, numbered #${nums[0]}..#${nums[nums.length - 1]} (no duplicates)` : ' (not numbered yet)'));
  } catch (error) {
    console.error(`\nMIGRATION FAILED - everything was rolled back: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

module.exports = {
  runMigration,
  assertNonDestructive,
  snapshotProtected,
  PROTECTED_TABLES,
};

if (require.main === module) {
  main();
}
