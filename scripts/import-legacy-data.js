'use strict';

/**
 * Legacy data import (old production schema -> v4.1 schema). NON-DESTRUCTIVE.
 *
 *   DATABASE_URL=<target> node scripts/import-legacy-data.js --source <data.sql> --plan
 *   DATABASE_URL=<target> node scripts/import-legacy-data.js --source <data.sql> --apply
 *
 * --source   a plain-SQL, data-only pg_dump (COPY ... FROM stdin blocks) of the OLD database.
 *            It is only READ; nothing is ever written to the old database.
 * --plan     (default) runs everything inside a transaction and ROLLS BACK. Nothing is saved.
 * --apply    same, then COMMITs (only if every check passed).
 * --allow-non-empty   by default the target must have no customers/licenses/devices/payment rows,
 *            so that legacy customers get numbers 1..N in creation order. With this flag the
 *            legacy rows are added after the existing ones (numbering continues).
 *
 * Guarantees
 *   - never DELETE / UPDATE / TRUNCATE / DROP anything; only INSERT of rows that are not there yet
 *   - re-running is safe: rows that already exist with identical content are skipped
 *   - a row that exists with the same id but DIFFERENT content, or that collides with another
 *     row on a unique value (license key, device id, payment references), aborts the whole
 *     import (full rollback) instead of being replaced
 *   - every legacy row is compared with what ended up in the target before COMMIT
 *   - the connection string, passwords and personal data are never printed (counts/ids only)
 *
 * Customer numbers (migration 004/007 semantics): legacy customers are numbered in
 * (created_at, id) order via allocate_customer_numbers(); sale_status is 'sold' when the
 * customer has a name (same rule migration 007 applies), otherwise 'unsold'. payment_status,
 * sale_price, sold_at stay NULL: the old schema never stored them and nothing is invented.
 */

const fs = require('fs');
const path = require('path');

// table -> columns the OLD schema had (the order of insertion respects foreign keys)
const LEGACY_TABLES = {
  products: ['id', 'product_id', 'name', 'created_at'],
  customers: ['id', 'name', 'email', 'created_at', 'updated_at'],
  licenses: ['id', 'license_key', 'product_id', 'status', 'max_devices', 'expires_at', 'created_at',
    'updated_at', 'customer_id', 'plan', 'license_type'],
  devices: ['id', 'device_id', 'created_at', 'last_seen_at'],
  activations: ['id', 'license_id', 'device_id', 'activated_at', 'deactivated_at'],
  payment_orders: ['id', 'provider', 'provider_invoice_id', 'provider_payment_id', 'customer_reference',
    'customer_name', 'customer_email', 'amount', 'currency', 'duration', 'plan', 'max_devices',
    'product_id', 'status', 'license_id', 'created_at', 'updated_at'],
};
const ORDER = ['products', 'customers', 'licenses', 'devices', 'activations', 'payment_orders'];

function unescapeCopy(v) {
  if (v === '\\N') return null;
  return v.replace(/\\(.)/g, (_m, c) => ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '\\': '\\' }[c] ?? c));
}

/** Parses COPY blocks of a plain-SQL pg_dump. Returns { table: { columns, rows } }. */
function parseCopyDump(text) {
  const out = {};
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (cur === null) {
      const m = /^COPY (?:public\.)?"?(\w+)"? \(([^)]*)\) FROM stdin;$/.exec(line);
      if (m) {
        cur = m[1];
        out[cur] = { columns: m[2].split(',').map((s) => s.trim().replace(/"/g, '')), rows: [] };
      }
    } else if (line === '\\.') {
      cur = null;
    } else {
      out[cur].rows.push(line.split('\t').map(unescapeCopy));
    }
  }
  return out;
}

function validateSource(data) {
  const problems = [];
  for (const t of ORDER) {
    if (!data[t]) { problems.push(`table ${t} is missing from the source file`); continue; }
    const have = data[t].columns;
    for (const c of LEGACY_TABLES[t]) if (!have.includes(c)) problems.push(`${t}.${c} is missing in the source`);
    const extra = have.filter((c) => !LEGACY_TABLES[t].includes(c));
    if (extra.length) problems.push(`${t} has unexpected columns (${extra.join(', ')}): source is not the old schema`);
    for (const r of data[t].rows) if (r.length !== have.length) { problems.push(`${t}: malformed row`); break; }
  }
  return problems;
}

const q = (s) => `"${s}"`;

async function loadTemp(client, data) {
  for (const t of ORDER) {
    const cols = LEGACY_TABLES[t];
    const idx = cols.map((c) => data[t].columns.indexOf(c));
    // temp table with the same column types as the real one, but only the legacy columns
    await client.query(`CREATE TEMP TABLE ${q('lg_' + t)} ON COMMIT DROP AS SELECT ${cols.map(q).join(', ')} FROM ${q(t)} WITH NO DATA`);
    for (let i = 0; i < data[t].rows.length; i += 200) {
      const chunk = data[t].rows.slice(i, i + 200);
      const params = [];
      const values = chunk.map((r) => `(${idx.map((j) => { params.push(r[j]); return `$${params.length}`; }).join(', ')})`);
      await client.query(`INSERT INTO ${q('lg_' + t)} (${cols.map(q).join(', ')}) VALUES ${values.join(', ')}`, params);
    }
  }
}

const cnt = async (client, sql) => Number((await client.query(sql)).rows[0].n);
const ids = async (client, sql) => (await client.query(sql)).rows.map((r) => r.id).slice(0, 20);

async function importLegacy(client, data, { apply = false, allowNonEmpty = false, log = () => {} } = {}) {
  const report = { mode: apply ? 'apply' : 'plan', source: {}, inserted: {}, skipped: {}, conflicts: [], checks: [] };
  const problems = validateSource(data);
  if (problems.length) throw new Error('Source file rejected:\n - ' + problems.join('\n - '));
  for (const t of ORDER) report.source[t] = data[t].rows.length;

  await client.query('BEGIN');
  try {
    await client.query('LOCK TABLE customers, licenses, devices, activations, payment_orders, products IN SHARE ROW EXCLUSIVE MODE');

    // Target must be the v4.1 schema (migrations 004-007 applied).
    const needed = ['customer_number', 'sale_status', 'payment_status', 'phone'];
    const have = (await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'customers'`
    )).rows.map((r) => r.column_name);
    const lacking = needed.filter((c) => !have.includes(c));
    if (lacking.length) throw new Error(`Target is not the v4.1 schema: customers lacks ${lacking.join(', ')}. Apply migrations 004-007 first.`);

    report.targetBefore = {};
    for (const t of ORDER) report.targetBefore[t] = await cnt(client, `SELECT COUNT(*) AS n FROM ${q(t)}`);
    const occupied = ['customers', 'licenses', 'devices', 'activations', 'payment_orders'].filter((t) => report.targetBefore[t] > 0);
    if (occupied.length && !allowNonEmpty) {
      throw new Error(`Target already has data in: ${occupied.join(', ')}. Refusing, so that legacy customers keep numbers 1..N. ` +
        'Use a clean target, or pass --allow-non-empty to append after the existing rows.');
    }

    await loadTemp(client, data);

    // ---- conflicts: same id with different content / unique-value collisions with a different row
    const diff = (t, cols) => `SELECT l.id FROM ${q('lg_' + t)} l JOIN ${q(t)} x ON x.id = l.id
       WHERE (${cols.map((c) => `l.${q(c)}`).join(', ')}) IS DISTINCT FROM (${cols.map((c) => `x.${q(c)}`).join(', ')})`;
    const checks = [
      ['customers: same id, different content', diff('customers', LEGACY_TABLES.customers)],
      ['licenses: same id, different content', diff('licenses', LEGACY_TABLES.licenses)],
      ['devices: same id, different content', diff('devices', LEGACY_TABLES.devices)],
      ['activations: same id, different content', diff('activations', LEGACY_TABLES.activations)],
      ['payment_orders: same id, different content', diff('payment_orders', LEGACY_TABLES.payment_orders)],
      ['licenses: license_key already used by another license',
        'SELECT l.id FROM lg_licenses l JOIN licenses x ON x.license_key = l.license_key AND x.id <> l.id'],
      ['devices: device_id already used by another device',
        'SELECT l.id FROM lg_devices l JOIN devices x ON x.device_id = l.device_id AND x.id <> l.id'],
      ['payment_orders: reference/invoice/payment/license already used by another order',
        `SELECT l.id FROM lg_payment_orders l JOIN payment_orders x ON x.id <> l.id AND (
            x.customer_reference = l.customer_reference
         OR (l.provider_invoice_id IS NOT NULL AND x.provider_invoice_id = l.provider_invoice_id)
         OR (l.provider_payment_id IS NOT NULL AND x.provider_payment_id = l.provider_payment_id)
         OR (l.license_id IS NOT NULL AND x.license_id = l.license_id))`],
      // ---- referential integrity of what we are about to insert
      ['licenses: product not in target products',
        'SELECT l.id FROM lg_licenses l WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.product_id = l.product_id)'],
      ['licenses: customer missing',
        `SELECT l.id FROM lg_licenses l WHERE l.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lg_customers c WHERE c.id = l.customer_id)
           AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = l.customer_id)`],
      ['activations: license or device missing',
        `SELECT a.id FROM lg_activations a WHERE NOT (EXISTS (SELECT 1 FROM lg_licenses l WHERE l.id = a.license_id) OR EXISTS (SELECT 1 FROM licenses l WHERE l.id = a.license_id))
           OR NOT (EXISTS (SELECT 1 FROM lg_devices d WHERE d.id = a.device_id) OR EXISTS (SELECT 1 FROM devices d WHERE d.id = a.device_id))`],
      ['payment_orders: license missing',
        `SELECT p.id FROM lg_payment_orders p WHERE p.license_id IS NOT NULL AND NOT (EXISTS (SELECT 1 FROM lg_licenses l WHERE l.id = p.license_id) OR EXISTS (SELECT 1 FROM licenses l WHERE l.id = p.license_id))`],
    ];
    for (const [label, sql] of checks) {
      const n = await cnt(client, `SELECT COUNT(*) AS n FROM (${sql}) s`);
      report.checks.push({ label, problems: n });
      if (n) report.conflicts.push({ label, count: n, ids: await ids(client, sql) });
    }
    // a different product name for the same product_id is reported, never overwritten
    report.productNameDiffers = await cnt(client,
      'SELECT COUNT(*) AS n FROM lg_products l JOIN products p ON p.product_id = l.product_id AND p.name <> l.name');
    if (report.conflicts.length) {
      const e = new Error('Conflicts found; nothing was imported:\n' + report.conflicts.map((c) => ` - ${c.label}: ${c.count} (ids: ${c.ids.join(', ')})`).join('\n'));
      e.report = report;
      throw e;
    }

    // ---- insert (only rows that are not already there)
    const ins = async (t, sql) => { report.inserted[t] = (await client.query(sql)).rowCount; report.skipped[t] = report.source[t] - report.inserted[t]; };

    // products: matched by product_id; the target's own row is kept
    await ins('products', `INSERT INTO products (id, product_id, name, created_at)
       SELECT l.id, l.product_id, l.name, l.created_at FROM lg_products l
       WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.product_id = l.product_id OR p.id = l.id)`);

    // customers: numbers allocated in (created_at, id) order
    const newCustomers = await cnt(client, 'SELECT COUNT(*) AS n FROM lg_customers l WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = l.id)');
    if (newCustomers > 0) {
      await ins('customers', `WITH base AS (SELECT allocate_customer_numbers(${newCustomers}) AS first_no)
         INSERT INTO customers (id, name, email, created_at, updated_at, customer_number, sale_status)
         SELECT n.id, n.name, n.email, n.created_at, n.updated_at,
                (SELECT first_no FROM base) + ROW_NUMBER() OVER (ORDER BY n.created_at, n.id) - 1,
                CASE WHEN n.name IS NOT NULL AND btrim(n.name) <> '' THEN 'sold' ELSE 'unsold' END
         FROM (SELECT l.* FROM lg_customers l WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = l.id)) n`);
    } else { report.inserted.customers = 0; report.skipped.customers = report.source.customers; }

    for (const t of ['licenses', 'devices', 'activations', 'payment_orders']) {
      const cols = LEGACY_TABLES[t].map(q).join(', ');
      await ins(t, `INSERT INTO ${q(t)} (${cols}) SELECT ${LEGACY_TABLES[t].map((c) => 'l.' + q(c)).join(', ')} FROM ${q('lg_' + t)} l
         WHERE NOT EXISTS (SELECT 1 FROM ${q(t)} x WHERE x.id = l.id)`);
    }

    // ---- verification: every legacy row must now exist unchanged in the target
    report.verify = {};
    for (const t of ORDER.filter((x) => x !== 'products')) {
      const cols = LEGACY_TABLES[t];
      const missing = await cnt(client, `SELECT COUNT(*) AS n FROM (SELECT ${cols.map(q).join(', ')} FROM ${q('lg_' + t)}
          EXCEPT SELECT ${cols.map(q).join(', ')} FROM ${q(t)}) s`);
      report.verify[t] = missing;
      if (missing) throw new Error(`Verification failed: ${missing} ${t} row(s) differ from the source after import.`);
    }
    const counter = await client.query('SELECT last_number FROM customer_number_counter WHERE id = 1');
    const maxNo = await cnt(client, 'SELECT COALESCE(MAX(customer_number), 0) AS n FROM customers');
    report.customerNumbers = { counter: Number(counter.rows[0].last_number), max: maxNo };
    if (report.customerNumbers.counter < maxNo) throw new Error('customer_number_counter is behind the highest customer number.');
    report.dupNumbers = await cnt(client, 'SELECT COUNT(*) AS n FROM (SELECT customer_number FROM customers GROUP BY 1 HAVING COUNT(*) > 1) s');
    if (report.dupNumbers) throw new Error('Duplicate customer numbers.');
    report.targetAfter = {};
    for (const t of ORDER) report.targetAfter[t] = await cnt(client, `SELECT COUNT(*) AS n FROM ${q(t)}`);
    report.activeActivations = await cnt(client, 'SELECT COUNT(*) AS n FROM activations WHERE deactivated_at IS NULL');

    if (apply) {
      await client.query(`INSERT INTO admin_audit_log (admin_user, action, target_type, target_id, meta)
         VALUES ('system', 'legacy_import', 'database', NULL, $1::jsonb)`, [JSON.stringify({ inserted: report.inserted, skipped: report.skipped })]);
      await client.query('COMMIT');
      report.committed = true;
    } else {
      await client.query('ROLLBACK');
      report.committed = false;
    }
    log(`done (${report.committed ? 'COMMITTED' : 'ROLLED BACK - plan only'})`);
    return report;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_r) { /* already closed */ }
    throw e;
  }
}

function printReport(r, log) {
  log(`Mode: ${r.mode.toUpperCase()} -> ${r.committed ? 'COMMITTED' : 'ROLLED BACK (nothing saved)'}`);
  log('table            source  inserted  skipped  target before -> after');
  for (const t of ORDER) {
    log(`${t.padEnd(16)} ${String(r.source[t]).padStart(6)} ${String(r.inserted[t]).padStart(9)} ${String(r.skipped[t]).padStart(8)}  ${String(r.targetBefore[t]).padStart(6)} -> ${r.targetAfter[t]}`);
  }
  log(`Verification (legacy rows missing/different in target): ${JSON.stringify(r.verify)}`);
  log(`Customer numbers: highest ${r.customerNumbers.max}, counter ${r.customerNumbers.counter}; duplicates ${r.dupNumbers}`);
  log(`Active activations in target: ${r.activeActivations}`);
  if (r.productNameDiffers) log(`Note: ${r.productNameDiffers} product(s) have a different name in the target; the target name was kept.`);
}

async function main() {
  const args = process.argv.slice(2);
  const get = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const source = get('--source');
  const apply = args.includes('--apply');
  if (!source || (args.includes('--apply') && args.includes('--plan'))) {
    console.error('Usage: node scripts/import-legacy-data.js --source <old-data.sql> [--plan | --apply] [--allow-non-empty]');
    process.exitCode = 2; return;
  }
  require('dotenv').config();
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exitCode = 2; return; }

  let host = 'unknown'; let dbName = 'unknown';
  try { const u = new URL(process.env.DATABASE_URL); host = u.hostname; dbName = u.pathname.replace(/^\//, ''); } catch (_e) { /* unknown */ }
  console.log(`Target database: ${dbName} @ ${host}`);
  console.log(`Source file: ${path.basename(source)}`);

  const data = parseCopyDump(fs.readFileSync(path.resolve(source), 'utf8'));
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const report = await importLegacy(client, data, { apply, allowNonEmpty: args.includes('--allow-non-empty'), log: (m) => console.log(m) });
    printReport(report, (m) => console.log(m));
  } catch (e) {
    console.error('\nIMPORT STOPPED - nothing was saved.\n' + e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) main();
module.exports = { parseCopyDump, validateSource, importLegacy, LEGACY_TABLES, ORDER };
