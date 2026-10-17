'use strict';

// Tests 12, 13 and 15 of the brief: editing customer data never affects
// licensing, search / sort / pagination / export, and authorization.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const {
  pool, resetDatabase, request, admin, adminToken, closeAll,
} = require('./helpers/setup');
const { createBulkLicenses } = require('../../src/services/bulkLicenseService');

let idem = 0;
const newIdem = () => `api-batch-${Date.now()}-${++idem}`;
const { bulkWithSales } = require('./helpers/bulk');
const bulk = (input) => bulkWithSales(input);

const API = '/api/v1/licenses';
const act = (licenseKey, deviceId) => request('POST', `${API}/activate`, { body: { licenseKey, deviceId } });
const val = (licenseKey, deviceId) => request('POST', `${API}/validate`, { body: { licenseKey, deviceId } });

before(() => resetDatabase('full'));
beforeEach(async () => {
  await pool.query('TRUNCATE activations, devices, licenses, customers, license_batches CASCADE');
  await pool.query('UPDATE customer_number_counter SET last_number = 0');
});
after(closeAll);

async function licensingSnapshot() {
  const q = (sql) => pool.query(sql).then((r) => r.rows);
  return {
    licenses: await q('SELECT * FROM licenses ORDER BY id'),
    devices: await q('SELECT * FROM devices ORDER BY id'),
    activations: await q('SELECT * FROM activations ORDER BY id'),
  };
}

// ---------------------------------------------------------------------------
test('12. editing name / price / currency / notes never changes the license, devices or activations', async () => {
  const { items } = await bulk({
    customers: [{ name: 'مدرسة الأمل' }, { name: 'مدرسة الفجر' }],
    maxDevices: 2,
  });
  const [a, b] = items;

  assert.equal((await act(a.licenseKey, 'DEV-A1')).json.status, 'active');
  assert.equal((await act(a.licenseKey, 'DEV-A2')).json.status, 'active');
  assert.equal((await act(b.licenseKey, 'DEV-B1')).json.status, 'active');

  const before = await licensingSnapshot();

  const edits = [
    { name: 'مدرسة الأمل الدولية' },
    { salePrice: '0', currency: 'EGP' }, // a price of zero must not matter
    { salePrice: '99999999.99', currency: 'USD', soldAt: '2026-01-31', notes: 'ملاحظة' },
    { salePrice: null, currency: null, soldAt: null, notes: null },
  ];

  for (const body of edits) {
    const r = await admin('PATCH', `/customers/${a.customerId}`, { body });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }

  assert.deepEqual(await licensingSnapshot(), before, 'licenses/devices/activations are byte-identical');

  // Activation decisions are independent of the recorded price (checked AFTER the
  // snapshot because the existing validate endpoint legitimately updates last_seen_at).
  for (const price of ['0', '99999999.99']) {
    await admin('PATCH', `/customers/${a.customerId}`, { body: { salePrice: price, currency: 'EGP' } });
    assert.equal((await val(a.licenseKey, 'DEV-A1')).json.status, 'active');
  }
});

test('12b. validation: bad prices / currencies / dates / names are refused and change nothing', async () => {
  const { items } = await bulk({ productId: 'school-accreditation', customers: [{ name: 'مدرسة' }] });
  const id = items[0].customerId;
  const before = (await pool.query('SELECT * FROM customers WHERE id = $1', [id])).rows[0];

  const bad = [
    { salePrice: '-5', currency: 'EGP' },
    { salePrice: '12.345', currency: 'EGP' },
    { salePrice: 'abc', currency: 'EGP' },
    { salePrice: '100' }, // price without currency
    { currency: 'EG' },
    { currency: 'egp1' },
    { soldAt: '2026-02-31' },
    { soldAt: '01/02/2026' },
    { name: '   ' },
    { name: 'x'.repeat(256) },
    { notes: 'n'.repeat(2001) },
    { email: 'not-an-email' },
    {},
  ];

  for (const body of bad) {
    const r = await admin('PATCH', `/customers/${id}`, { body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }

  assert.deepEqual((await pool.query('SELECT * FROM customers WHERE id = $1', [id])).rows[0], before);

  // Arabic-Indic digits are accepted and stored canonically
  const ok = await admin('PATCH', `/customers/${id}`, { body: { salePrice: '١٥٠٠٫٥٠', currency: 'EGP' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.customer.sale_price, '1500.50');

  // unknown customer / malformed ref
  assert.equal((await admin('PATCH', '/customers/999999', { body: { name: 'x' } })).status, 404);
  assert.equal((await admin('GET', '/customers/not-a-ref')).status, 400);

  // customer details are addressable by number too, and list their licenses
  const byNumber = await admin('GET', `/customers/${items[0].customerNumber}`);
  assert.equal(byNumber.status, 200);
  assert.equal(byNumber.json.customer.id, id);
  assert.equal(byNumber.json.licenses.length, 1);
  assert.equal(byNumber.json.licenses[0].license_key, items[0].licenseKey);
});

// ---------------------------------------------------------------------------
async function seedForListing() {
  const customers = [];

  for (let i = 1; i <= 60; i += 1) {
    const row = { name: `مدرسة رقم ${i}` };
    if (i % 3 === 0) { row.salePrice = String(i * 10); row.currency = 'EGP'; row.soldAt = '2026-03-15'; }
    customers.push(row);
  }

  customers[4] = { name: 'مدرسة النور', salePrice: '1500', currency: 'EGP', notes: 'ملاحظة, بها فاصلة' };
  customers[5] = { name: 'مدرسة "المستقبل" الدولية', salePrice: '2500.50', currency: 'SAR', notes: 'سطر 1\nسطر 2' };

  return bulk({ productId: 'school-accreditation', customers, maxDevices: 2, plan: 'pro' });
}

test('13a. search by number / name / key (partial), sorting and pagination', async () => {
  const seeded = await seedForListing();
  const find = (n) => seeded.items.find((i) => i.customerNumber === n);

  // by customer number (with and without '#')
  for (const q of ['7', '#7']) {
    const r = await admin('GET', `/license-records?q=${encodeURIComponent(q)}&pageSize=200`);
    assert.ok(r.json.rows.some((row) => row.customer_number === 7), `q=${q}`);
  }

  // partial Arabic name
  let r = await admin('GET', `/license-records?q=${encodeURIComponent('النور')}`);
  assert.equal(r.json.total, 1);
  assert.equal(r.json.rows[0].customer_name, 'مدرسة النور');

  // partial key, case-insensitive
  const key = find(10).licenseKey;
  r = await admin('GET', `/license-records?q=${encodeURIComponent(key.slice(5, 14).toLowerCase())}`);
  assert.ok(r.json.rows.some((row) => row.license_key === key));

  // wildcard characters are literal, not patterns
  for (const q of ['%', '_', '\\']) {
    r = await admin('GET', `/license-records?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 0, `q=${q}`);
  }

  // SQL-injection attempts are inert
  for (const q of ["'; DROP TABLE customers; --", "' OR '1'='1", '1); DELETE FROM licenses; --']) {
    r = await admin('GET', `/license-records?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200);
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM licenses')).rows[0].n, 60);

  // sorting
  r = await admin('GET', '/license-records?sort=customer_number&dir=asc&pageSize=5');
  assert.deepEqual(r.json.rows.map((x) => x.customer_number), [1, 2, 3, 4, 5]);
  r = await admin('GET', '/license-records?sort=customer_number&dir=desc&pageSize=3');
  assert.deepEqual(r.json.rows.map((x) => x.customer_number), [60, 59, 58]);
  r = await admin('GET', '/license-records?sort=sale_price&dir=desc&pageSize=3');
  assert.equal(r.json.rows[0].customer_name, 'مدرسة المستقبل الدولية'.replace('المستقبل', '"المستقبل"'));
  r = await admin('GET', '/license-records?sort=sale_price&dir=asc&pageSize=200');
  const prices = r.json.rows.map((x) => x.sale_price);
  const firstNull = prices.indexOf(null);
  assert.ok(firstNull > 0 && prices.slice(firstNull).every((p) => p === null), 'NULL prices sort last');

  for (const bad of ['sort=password', 'sort=1;DROP TABLE x', 'dir=sideways', 'status=BOGUS', 'archived=maybe']) {
    assert.equal((await admin('GET', `/license-records?${bad}`)).status, 400, bad);
  }

  // pagination: disjoint pages whose union is everything
  const seen = new Set();
  let total = null;
  for (let page = 1; page <= 6; page += 1) {
    r = await admin('GET', `/license-records?sort=customer_number&dir=asc&pageSize=10&page=${page}`);
    total = r.json.total;
    assert.equal(r.json.totalPages, 6);
    assert.equal(r.json.rows.length, 10);
    r.json.rows.forEach((row) => { assert.ok(!seen.has(row.license_id)); seen.add(row.license_id); });
  }
  assert.equal(total, 60);
  assert.equal(seen.size, 60);

  r = await admin('GET', '/license-records?pageSize=10&page=99');
  assert.equal(r.json.page, 6, 'page past the end is clamped');

  // summary block
  assert.equal(r.json.summary.totalLicenses, 60);
  assert.equal(r.json.summary.active, 60);

  // status filter + incomplete filter
  await admin('POST', `/licenses/${find(2).licenseId}/revoke`);
  r = await admin('GET', '/license-records?status=REVOKED');
  assert.equal(r.json.total, 1);
  assert.equal(r.json.rows[0].customer_number, 2);

  r = await admin('GET', '/license-records?incomplete=1&pageSize=200');
  // 60 customers, prices set for 20 (multiples of 3) + 2 overridden => the rest are incomplete
  const complete = 60 - r.json.total;
  assert.ok(complete > 0 && complete < 60);
  assert.ok(r.json.rows.every((row) => row.sale_price === null));
});

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

test('13b. CSV export: Arabic is intact, quoting is right, formulas are neutralised, no secrets', async () => {
  const seeded = await seedForListing();
  const evil = await bulk({
    customers: [
      { name: '=HYPERLINK("http://evil.example","click")', notes: '@SUM(1+1)' },
      { name: '+cmd|\' /C calc\'!A0', notes: '-2+3' },
      { name: '\t=1+1', notes: '  =2+2' },
    ],
  });

  const res = await admin('POST', '/export', { raw: true, body: { format: 'csv', scope: 'all' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv; charset=utf-8/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="licenses-.*\.csv"/);

  const bytes = res.buffer;
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM present');

  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  assert.ok(text.includes('رقم العميل') && text.includes('مفتاح التفعيل') && text.includes('السعر الفعلي'));
  assert.ok(text.includes('مدرسة النور'));
  assert.ok(text.includes('"مدرسة ""المستقبل"" الدولية"'), 'embedded quotes are doubled');
  assert.ok(text.includes('"ملاحظة, بها فاصلة"'), 'comma stays inside the quoted field');
  assert.ok(text.includes('"سطر 1\nسطر 2"'), 'newline stays inside the quoted field');
  assert.ok(text.includes('\r\n'));

  // minimal RFC-4180 parser to count records
  const records = [];
  let field = ''; let row = []; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(field); records.push(row); row = []; field = ''; }
    else field += ch;
  }
  assert.equal(records.length, 1 + 60 + 3, 'header + every record');
  assert.ok(records.every((r) => r.length === require('../../src/services/exportService').COLUMNS.length), 'same column count on every record');

  // every dangerous leading character got an apostrophe
  const cells = records.flat();
  for (const cell of cells) {
    assert.ok(!/^\s*[=+\-@\t\r]/.test(cell), `unsafe cell leaked: ${JSON.stringify(cell)}`);
  }
  assert.ok(cells.includes(`'=HYPERLINK("http://evil.example","click")`));
  assert.ok(cells.includes("'@SUM(1+1)"));

  // no server secrets in the file
  const lower = text.toLowerCase();
  for (const secret of [process.env.JWT_SECRET, process.env.ADMIN_PASSWORD_HASH, process.env.DATABASE_URL, 'jwt', 'password']) {
    assert.ok(!lower.includes(String(secret).toLowerCase()), `secret-like text found: ${secret}`);
  }

  assert.ok(seeded && evil);
});

test('13c. XLSX export opens correctly; numbers are numbers, text never becomes a formula', async () => {
  await seedForListing();
  await bulk({ productId: 'school-accreditation', customers: [{ name: '=1+1', notes: '@x' }] });

  const res = await admin('POST', '/export', { raw: true, body: { format: 'xlsx', scope: 'all' } });
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get('content-type'),
    /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/
  );
  assert.deepEqual([...res.buffer.subarray(0, 2)], [0x50, 0x4b], 'a real ZIP/XLSX container');

  const wb = await parseXlsx(res.buffer);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'التراخيص');
  assert.equal(ws.rowCount, 1 + 61);
  assert.equal(ws.getRow(1).getCell(1).value, 'رقم العميل');
  assert.equal(ws.views[0].rightToLeft, true);

  // customer numbers are numeric
  assert.equal(typeof ws.getRow(2).getCell(1).value, 'number');

  const priceCol = require('../../src/services/exportService').COLUMNS.findIndex((c) => c.key === 'sale_price') + 1;
  let sawPrice = false;
  let sawNeutralised = false;

  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    row.eachCell({ includeEmpty: false }, (cell) => {
      assert.notEqual(typeof cell.value, 'object', `cell ${cell.address} is a rich/formula object`);
      assert.ok(!cell.formula, `cell ${cell.address} became a formula`);
      if (cell.col === priceCol) { sawPrice = true; assert.equal(typeof cell.value, 'number'); }
      if (cell.value === "'=1+1") sawNeutralised = true;
    });
  });

  assert.ok(sawPrice);
  assert.ok(sawNeutralised);
});

test('13d. export scopes: search results and a selection of rows', async () => {
  const seeded = await seedForListing();

  // scope=search uses the same filters as the table
  let res = await admin('POST', '/export', {
    raw: true,
    body: { format: 'csv', scope: 'search', filters: { q: 'النور' } },
  });
  assert.equal(res.headers.get('x-export-rows'), '1');

  // scope=selected
  const pick = [seeded.items[0], seeded.items[7], seeded.items[20]];
  res = await admin('POST', '/export', {
    raw: true,
    body: { format: 'xlsx', scope: 'selected', licenseIds: pick.map((p) => p.licenseId) },
  });
  assert.equal(res.headers.get('x-export-rows'), '3');
  const ws = (await parseXlsx(res.buffer)).worksheets[0];
  const numbers = [];
  ws.eachRow((row, n) => { if (n > 1) numbers.push(row.getCell(1).value); });
  assert.deepEqual(numbers.sort((x, y) => x - y), pick.map((p) => p.customerNumber).sort((x, y) => x - y));

  // validation
  for (const body of [
    { format: 'pdf', scope: 'all' },
    { format: 'csv', scope: 'everything' },
    { format: 'csv', scope: 'selected', licenseIds: [] },
    { format: 'csv', scope: 'selected', licenseIds: ['not-a-uuid'] },
  ]) {
    assert.equal((await admin('POST', '/export', { body })).status, 400, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------------------
test('15. authorization: every new admin endpoint refuses missing / invalid / expired / non-admin tokens', async () => {
  const { items } = await bulk({ productId: 'school-accreditation', customers: [{ name: 'مدرسة' }] });
  const [one] = items;
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM licenses')).rows[0].n;

  const endpoints = [
    ['GET', '/license-records'],
    ['GET', `/customers/${one.customerNumber}`],
    ['PATCH', `/customers/${one.customerNumber}`, { name: 'مخترق' }],
    ['POST', `/customers/${one.customerNumber}/archive`],
    ['POST', `/customers/${one.customerNumber}/unarchive`],
    ['POST', `/licenses/${one.licenseId}/assign-customer`, { name: 'x' }],
    ['POST', '/licenses/bulk', { quantity: 5, productId: 'school-accreditation' }],
    ['POST', '/export', { format: 'csv', scope: 'all' }],
  ];

  const tokens = {
    none: undefined,
    garbage: 'not.a.jwt',
    expired: adminToken({ expiresIn: -10 }),
    wrongRole: adminToken({ role: 'user' }),
  };
  const expectedStatus = { none: 401, garbage: 401, expired: 401, wrongRole: 403 };

  for (const [method, path, body] of endpoints) {
    for (const [kind, token] of Object.entries(tokens)) {
      const r = await request(method, `/api/v1/admin${path}`, {
        token,
        body,
        headers: path === '/licenses/bulk' ? { 'Idempotency-Key': newIdem() } : {},
      });
      assert.equal(r.status, expectedStatus[kind], `${method} ${path} with ${kind} token`);
    }
  }

  // nothing was changed by the refused calls
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM licenses')).rows[0].n, before);
  const row = (await pool.query('SELECT name, archived_at FROM customers WHERE id = $1', [one.customerId])).rows[0];
  assert.equal(row.name, 'مدرسة');
  assert.equal(row.archived_at, null);

  // the admin token travels in the Authorization header only: a query-string token is ignored
  const viaQuery = await request('GET', `/api/v1/admin/license-records?token=${adminToken()}`);
  assert.equal(viaQuery.status, 401);

  // the existing admin routes are still protected exactly as before
  assert.equal((await request('GET', '/api/v1/admin/licenses')).status, 401);
  assert.equal((await request('DELETE', `/api/v1/admin/licenses/${one.licenseId}`)).status, 401);

  // the activation endpoints stay public (the Windows client has no admin token)
  const pub = await request('POST', `${API}/validate`, { body: { licenseKey: one.licenseKey, deviceId: 'x' } });
  assert.equal(pub.json.status, 'invalid');
});

test('15b. body-size handling: big bodies are checked for auth FIRST; other routes keep the 50kb limit', async () => {
  const big = { customers: Array.from({ length: 1000 }, (_, i) => ({ name: `مدرسة ${i}`.padEnd(150, 'ا') })) };
  assert.ok(JSON.stringify(big).length > 100 * 1024);

  const unauth = await request('POST', '/api/v1/admin/licenses/bulk', {
    body: big,
    headers: { 'Idempotency-Key': newIdem() },
  });
  assert.equal(unauth.status, 401, 'rejected on auth, not parsed');

  const huge = await admin('POST', '/licenses/bulk', {
    body: { productId: 'school-accreditation', quantity: 1, junk: 'x'.repeat(2 * 1024 * 1024) },
    headers: { 'Idempotency-Key': newIdem() },
  });
  assert.equal(huge.status, 413, 'still capped at 1mb');

  const other = await request('POST', `${API}/activate`, {
    body: { licenseKey: 'x'.repeat(80 * 1024), deviceId: 'd' },
  });
  assert.equal(other.status, 413, 'the original 50kb limit still applies everywhere else');
});
