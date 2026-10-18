'use strict';

// School profile: city, school type and school stage on the sale record, the admin-managed option lists,
// the Excel template / import / export. Runs ONLY against the disposable test database.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { pool, resetDatabase, readSql, request, admin, adminToken, closeAll } = require('./helpers/setup');
const { bulkWithSales } = require('./helpers/bulk');
const { runMigration, assertNonDestructive } = require('../../scripts/migrate');
const { optionKey } = require('../../src/services/schoolOptionsService');

const SCHOOL = 'school-accreditation';
const DEFAULT_TYPES = ['حكومي', 'أهلي', 'رياض الأطفال', 'تربية خاصة'];
const DEFAULT_STAGES = ['رياض الأطفال', 'ابتدائي', 'متوسط', 'ثانوي', 'تربية خاصة'];

before(() => resetDatabase('full'));
beforeEach(async () => {
  await pool.query('TRUNCATE activations, devices, licenses, customers, license_batches CASCADE');
  await pool.query('UPDATE customer_number_counter SET last_number = 0');
  // restore the default lists exactly as the migration creates them
  await pool.query('DROP TABLE IF EXISTS school_types CASCADE');
  await pool.query('DROP TABLE IF EXISTS school_stages CASCADE');
  await pool.query('ALTER TABLE customers DROP COLUMN IF EXISTS school_type_id, DROP COLUMN IF EXISTS school_stage_id');
  await pool.query(readSql('schoolProfile'));
});
after(closeAll);

const names = (r) => r.json.items.map((o) => o.name);
const types = async () => (await admin('GET', '/school-types')).json.items;
const stages = async () => (await admin('GET', '/school-stages')).json.items;
const byName = (list, name) => list.find((o) => o.name === name);

async function oneRecord() {
  const r = await bulkWithSales({ productId: SCHOOL, quantity: 1, maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  return r.items[0];
}

async function licensingSnapshot() {
  const q = (sql) => pool.query(sql).then((r) => r.rows);
  return { licenses: await q('SELECT * FROM licenses ORDER BY id'), devices: await q('SELECT * FROM devices ORDER BY id'), activations: await q('SELECT * FROM activations ORDER BY id') };
}

async function xlsx(rows, headers = ['رقم العميل', 'المدينة', 'نوع المدرسة', 'المرحلة الدراسية']) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('التراخيص');
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// request() JSON-encodes bodies, so the binary upload goes through fetch against the same server.
async function upload(buffer, query = '', { token = adminToken() } = {}) {
  const { startServer } = require('./helpers/setup');
  const base = await startServer();
  const r = await fetch(`${base}/api/v1/admin/records/import${query}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/octet-stream' },
    body: buffer,
  });
  let json = null;
  try { json = await r.json(); } catch (_e) { /* not json */ }
  return { status: r.status, json };
}

async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

// ------------------------------------------------------------------ migration

test('SP1. migration 008 is non-destructive, idempotent, and seeds EXACTLY the agreed defaults', async () => {
  assertNonDestructive(readSql('schoolProfile'));
  assert.deepEqual(names({ json: { items: await types() } }), DEFAULT_TYPES);
  assert.deepEqual(names({ json: { items: await stages() } }), DEFAULT_STAGES);

  // two SEPARATE lists: nothing leaks between them
  assert.ok(!DEFAULT_TYPES.includes('ابتدائي') && !(await types()).some((o) => ['ابتدائي', 'متوسط', 'ثانوي'].includes(o.name)));
  assert.ok(!(await stages()).some((o) => ['حكومي', 'أهلي'].includes(o.name)));

  // the SQL-seeded comparison keys equal what the JS normaliser computes (otherwise duplicates would slip through)
  for (const t of ['school_types', 'school_stages']) {
    const { rows } = await pool.query(`SELECT name, name_key FROM ${t}`);
    for (const row of rows) assert.equal(row.name_key, optionKey(row.name), `${t}: ${row.name}`);
  }

  // re-running never re-seeds, never overwrites an admin edit
  const t1 = byName(await types(), 'حكومي');
  await admin('PATCH', `/school-types/${t1.id}`, { body: { name: 'حكومي (عام)' } });
  await admin('DELETE', `/school-stages/${byName(await stages(), 'ثانوي').id}`);
  const client = await pool.connect();
  try { await runMigration(client, readSql('schoolProfile'), { mode: 'apply' }); await runMigration(client, readSql('schoolProfile'), { mode: 'apply' }); } finally { client.release(); }
  assert.ok(names({ json: { items: await types() } }).includes('حكومي (عام)'));
  assert.ok(!names({ json: { items: await types() } }).includes('حكومي'));
  assert.ok(!names({ json: { items: await stages() } }).includes('ثانوي'));
});

test('SP2. applying 008 on a database with existing sold/unsold records and devices changes none of them', async () => {
  await resetDatabase('full');
  const r = await bulkWithSales({ productId: SCHOOL, customers: ['مدرسة أ', 'مدرسة ب'], maxDevices: 2, duration: 'lifetime', plan: 'pro' });
  await pool.query('INSERT INTO devices (device_id) VALUES ($1)', ['dev-1']);
  const dev = (await pool.query('SELECT id FROM devices')).rows[0].id;
  const lic = (await pool.query('SELECT id FROM licenses LIMIT 1')).rows[0].id;
  await pool.query('INSERT INTO activations (license_id, device_id) VALUES ($1, $2)', [lic, dev]);

  const before = { ...(await licensingSnapshot()), customers: (await pool.query('SELECT id, name, sale_status, customer_number FROM customers ORDER BY id')).rows };
  await pool.query('DROP TABLE school_types CASCADE');
  await pool.query('DROP TABLE school_stages CASCADE');
  await pool.query('ALTER TABLE customers DROP COLUMN school_type_id, DROP COLUMN school_stage_id, DROP COLUMN city');
  const client = await pool.connect();
  try {
    const plan = await runMigration(client, readSql('schoolProfile'), { mode: 'plan' });
    assert.ok(plan);
    assert.equal((await pool.query("SELECT to_regclass('public.school_types') AS t")).rows[0].t, null, 'plan must roll back');
    await runMigration(client, readSql('schoolProfile'), { mode: 'apply' });
  } finally { client.release(); }

  const after = { ...(await licensingSnapshot()), customers: (await pool.query('SELECT id, name, sale_status, customer_number FROM customers ORDER BY id')).rows };
  assert.deepEqual(after, before);
  const nulls = (await pool.query('SELECT COUNT(*)::int AS n FROM customers WHERE city IS NULL AND school_type_id IS NULL AND school_stage_id IS NULL')).rows[0].n;
  assert.equal(nulls, r.items.length, 'old rows have the new fields empty');
});

// ------------------------------------------------------------------ option management

test('SP3. option lists: add / rename / deactivate / delete, duplicates, validation, independence', async () => {
  // add
  const added = await admin('POST', '/school-types', { body: { name: '  مدرسة   دولية ' } });
  assert.equal(added.status, 201);
  assert.equal(added.json.schoolType.name, 'مدرسة دولية');
  assert.equal(added.json.schoolType.is_active, true);

  // same name in the OTHER list is allowed (independent lists)
  assert.equal((await admin('POST', '/school-stages', { body: { name: 'مدرسة دولية' } })).status, 201);

  // duplicates: spaces, alef forms, diacritics, case
  for (const dup of ['مدرسة دولية', 'مدرسه  دولية'.replace('مدرسه', 'مدرسة'), 'أهلي', 'اهلي', 'أَهْلِي', ' أهلي ', 'ـأهلي']) {
    const res = await admin('POST', '/school-types', { body: { name: dup } });
    assert.equal(res.status, 409, `duplicate accepted: ${dup}`);
    assert.equal(res.json.code, 'duplicate');
  }

  // invalid names
  for (const bad of ['', '   ', null, 123, '---', '‮', 'x'.repeat(101)]) {
    const res = await admin('POST', '/school-types', { body: { name: bad } });
    assert.equal(res.status, 400, `accepted invalid name: ${JSON.stringify(bad)}`);
  }
  assert.equal((await admin('POST', '/school-types', { body: {} })).status, 400);

  // rename an UNUSED option needs no confirmation; duplicate rename is refused
  const intl = byName(await types(), 'مدرسة دولية');
  assert.equal((await admin('PATCH', `/school-types/${intl.id}`, { body: { name: 'أهلي' } })).status, 409);
  const renamed = await admin('PATCH', `/school-types/${intl.id}`, { body: { name: 'دولي' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.schoolType.name, 'دولي');

  // deactivate / reactivate
  assert.equal((await admin('PATCH', `/school-types/${intl.id}`, { body: { isActive: false } })).json.schoolType.is_active, false);
  assert.equal((await admin('PATCH', `/school-types/${intl.id}`, { body: { isActive: 'no' } })).status, 400);
  assert.equal((await admin('PATCH', `/school-types/${intl.id}`, { body: {} })).status, 400);
  assert.equal((await admin('PATCH', `/school-types/${intl.id}`, { body: { isActive: true } })).json.schoolType.is_active, true);

  // delete unused
  assert.equal((await admin('DELETE', `/school-types/${intl.id}`)).status, 200);
  assert.equal((await admin('GET', `/school-types`)).json.items.some((o) => o.id === intl.id), false);
  assert.equal((await admin('DELETE', `/school-types/${intl.id}`)).status, 404);
  assert.equal((await admin('DELETE', `/school-types/abc`)).status, 400);
  assert.equal((await admin('PATCH', `/school-types/0`, { body: { name: 'x' } })).status, 400);

  // both lists in one call
  const both = await admin('GET', '/school-options');
  assert.deepEqual(both.json.schoolTypes.map((o) => o.name), DEFAULT_TYPES);
  assert.ok(both.json.schoolStages.some((o) => o.name === 'مدرسة دولية'));
});

test('SP4. an option used by records: rename needs confirmation, delete is blocked, deactivate keeps the records', async () => {
  const rec = await oneRecord();
  const gov = byName(await types(), 'حكومي');
  const prim = byName(await stages(), 'ابتدائي');
  const patch = await admin('PATCH', `/customers/${rec.customerId}`, { body: { schoolTypeId: gov.id, schoolStageId: prim.id } });
  assert.equal(patch.status, 200);

  assert.equal(byName(await types(), 'حكومي').usage_count, 1);

  // delete blocked
  const del = await admin('DELETE', `/school-types/${gov.id}`);
  assert.equal(del.status, 409);
  assert.equal(del.json.code, 'in_use');
  assert.ok(/1/.test(del.json.message));
  assert.equal((await admin('DELETE', `/school-stages/${prim.id}`)).status, 409);

  // rename needs confirm
  const noConfirm = await admin('PATCH', `/school-types/${gov.id}`, { body: { name: 'حكومي عام' } });
  assert.equal(noConfirm.status, 409);
  assert.equal(noConfirm.json.code, 'confirmation_required');
  assert.equal(byName(await types(), 'حكومي').usage_count, 1, 'nothing renamed without confirmation');
  const ok = await admin('PATCH', `/school-types/${gov.id}`, { body: { name: 'حكومي عام', confirm: true } });
  assert.equal(ok.status, 200);

  // the record follows the rename (linked by id), keeps the link
  const rows = (await admin('GET', '/license-records')).json.rows;
  assert.equal(rows[0].school_type_name, 'حكومي عام');
  assert.equal(rows[0].school_type_id, gov.id);

  // deactivate: record keeps it; pickers (new selections) refuse it
  assert.equal((await admin('PATCH', `/school-types/${gov.id}`, { body: { isActive: false } })).status, 200);
  assert.equal((await admin('GET', '/license-records')).json.rows[0].school_type_name, 'حكومي عام');
  const rec2 = await oneRecord();
  const refused = await admin('PATCH', `/customers/${rec2.customerId}`, { body: { schoolTypeId: gov.id } });
  assert.equal(refused.status, 400);
  // ...but re-saving the first record with its unchanged (now inactive) option is fine
  assert.equal((await admin('PATCH', `/customers/${rec.customerId}`, { body: { schoolTypeId: gov.id, city: 'الرياض' } })).status, 200);

  // once the usage is gone it can be deleted
  assert.equal((await admin('PATCH', `/customers/${rec.customerId}`, { body: { schoolTypeId: null } })).status, 200);
  assert.equal((await admin('DELETE', `/school-types/${gov.id}`)).status, 200);
});

test('SP5. every option-management endpoint needs an admin token (API, not just hidden buttons)', async () => {
  const gov = byName(await types(), 'حكومي');
  const calls = [
    ['GET', '/school-options'], ['GET', '/school-types'], ['GET', '/school-stages'],
    ['POST', '/school-types', { name: 'x1' }], ['POST', '/school-stages', { name: 'x2' }],
    ['PATCH', `/school-types/${gov.id}`, { name: 'y' }], ['PATCH', `/school-stages/${gov.id}`, { name: 'y' }],
    ['DELETE', `/school-types/${gov.id}`], ['DELETE', `/school-stages/${gov.id}`],
    ['GET', '/records/import-template'],
  ];
  const wrongRole = adminToken({ role: 'viewer' });
  for (const [method, path, body] of calls) {
    const none = await request(method, `/api/v1/admin${path}`, { body });
    assert.equal(none.status, 401, `${method} ${path} without token`);
    const bad = await request(method, `/api/v1/admin${path}`, { token: 'not-a-token', body });
    assert.equal(bad.status, 401, `${method} ${path} bad token`);
    const role = await request(method, `/api/v1/admin${path}`, { token: wrongRole, body });
    assert.equal(role.status, 403, `${method} ${path} non-admin`);
  }
  assert.equal((await upload(Buffer.from('x'), '', { token: null })).status, 401);
  assert.equal((await upload(Buffer.from('x'), '', { token: wrongRole })).status, 403);
  // nothing changed
  assert.deepEqual((await types()).map((o) => o.name), DEFAULT_TYPES);
  assert.deepEqual((await stages()).map((o) => o.name), DEFAULT_STAGES);
});

// ------------------------------------------------------------------ record form (API)

test('SP6. record API: fill all three, leave optional ones empty, edit, re-open, clear, independent fields, old requests', async () => {
  const rec = await oneRecord();
  const gov = byName(await types(), 'حكومي');
  const ahli = byName(await types(), 'أهلي');
  const sec = byName(await stages(), 'ثانوي');

  // a brand-new key has all three empty
  let c = (await admin('GET', `/customers/${rec.customerId}`)).json.customer;
  assert.equal(c.city, null); assert.equal(c.school_type_id, null); assert.equal(c.school_stage_id, null);

  // old-style request (no new fields) works
  assert.equal((await admin('PATCH', `/customers/${rec.customerId}`, { body: { name: 'مدرسة النور', salePrice: '100', currency: 'SAR' } })).status, 200);

  // all three
  const res = await admin('PATCH', `/customers/${rec.customerId}`, { body: { city: '  الرياض ', schoolTypeId: gov.id, schoolStageId: sec.id } });
  assert.equal(res.status, 200);
  c = (await admin('GET', `/customers/${rec.customerId}`)).json.customer;
  assert.equal(c.city, 'الرياض');
  assert.equal(c.school_type_name, 'حكومي');
  assert.equal(c.school_stage_name, 'ثانوي');

  // a later request that does not mention them leaves them alone
  await admin('PATCH', `/customers/${rec.customerId}`, { body: { notes: 'ملاحظة' } });
  c = (await admin('GET', `/customers/${rec.customerId}`)).json.customer;
  assert.equal(c.city, 'الرياض'); assert.equal(c.school_type_id, gov.id); assert.equal(c.school_stage_id, sec.id);

  // independent: change only the type, the stage stays
  await admin('PATCH', `/customers/${rec.customerId}`, { body: { schoolTypeId: String(ahli.id) } });
  c = (await admin('GET', `/customers/${rec.customerId}`)).json.customer;
  assert.equal(c.school_type_name, 'أهلي'); assert.equal(c.school_stage_name, 'ثانوي');

  // "kindergarten" is a valid TYPE and a valid STAGE, independently
  const kgType = byName(await types(), 'رياض الأطفال');
  const kgStage = byName(await stages(), 'رياض الأطفال');
  assert.equal((await admin('PATCH', `/customers/${rec.customerId}`, { body: { schoolTypeId: kgType.id, schoolStageId: byName(await stages(), 'ابتدائي').id } })).status, 200);
  // an id from the other list is just another id: it must belong to ITS list
  const typeIdNotInStages = Math.max(...(await stages()).map((o) => o.id)) + 50;
  assert.equal((await admin('PATCH', `/customers/${rec.customerId}`, { body: { schoolStageId: typeIdNotInStages } })).status, 400);
  void kgStage;

  // invalid values
  for (const body of [{ schoolTypeId: 99999 }, { schoolTypeId: 'abc' }, { schoolStageId: -1 }, { schoolStageId: 1.5 }, { city: 'x'.repeat(101) }, { city: 5 }]) {
    assert.equal((await admin('PATCH', `/customers/${rec.customerId}`, { body })).status, 400, JSON.stringify(body));
  }

  // clear each independently, with null and with ''
  await admin('PATCH', `/customers/${rec.customerId}`, { body: { city: '', schoolTypeId: null } });
  c = (await admin('GET', `/customers/${rec.customerId}`)).json.customer;
  assert.equal(c.city, null); assert.equal(c.school_type_id, null); assert.ok(c.school_stage_id);
  await admin('PATCH', `/customers/${rec.customerId}`, { body: { schoolStageId: '' } });
  assert.equal((await admin('GET', `/customers/${rec.customerId}`)).json.customer.school_stage_id, null);

  // the details response of the table has the same data
  await admin('PATCH', `/customers/${rec.customerId}`, { body: { city: 'جدة', schoolTypeId: gov.id } });
  const row = (await admin('GET', '/license-records')).json.rows[0];
  assert.equal(row.city, 'جدة'); assert.equal(row.school_type_name, 'حكومي'); assert.equal(row.school_stage_name, null);
});

test('SP7. legacy license without a customer: assign-customer accepts the new fields (and still works without them)', async () => {
  const gov = byName(await types(), 'حكومي');
  const sec = byName(await stages(), 'ثانوي');
  for (const k of ['LEG-A', 'LEG-B']) {
    await pool.query("INSERT INTO licenses (license_key, product_id, status, max_devices, plan, license_type) VALUES ($1, $2, 'ACTIVE', 1, 'pro', 'perpetual')", [k, SCHOOL]);
  }
  const [a, b] = (await pool.query("SELECT id, license_key FROM licenses ORDER BY license_key")).rows;
  const ra = await admin('POST', `/licenses/${a.id}/assign-customer`, { body: { name: 'قديمة', city: 'الدمام', schoolTypeId: gov.id, schoolStageId: sec.id } });
  assert.equal(ra.status, 200);
  assert.equal(ra.json.customer.city, 'الدمام'); assert.equal(ra.json.customer.school_type_name, 'حكومي'); assert.equal(ra.json.customer.school_stage_name, 'ثانوي');
  const rb = await admin('POST', `/licenses/${b.id}/assign-customer`, { body: { name: 'قديمة 2' } });
  assert.equal(rb.status, 200);
  assert.equal(rb.json.customer.city, null);
  const bad = await pool.query("INSERT INTO licenses (license_key, product_id, status, max_devices, plan, license_type) VALUES ('LEG-C', $1, 'ACTIVE', 1, 'pro', 'perpetual') RETURNING id", [SCHOOL]);
  assert.equal((await admin('POST', `/licenses/${bad.rows[0].id}/assign-customer`, { body: { name: 'x', schoolTypeId: 12345 } })).status, 400);
});

test('SP8. filters and search by city / type / stage', async () => {
  const gov = byName(await types(), 'حكومي');
  const ahli = byName(await types(), 'أهلي');
  const prim = byName(await stages(), 'ابتدائي');
  const r = await bulkWithSales({ productId: SCHOOL, quantity: 3, maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  await admin('PATCH', `/customers/${r.items[0].customerId}`, { body: { city: 'الرياض', schoolTypeId: gov.id, schoolStageId: prim.id } });
  await admin('PATCH', `/customers/${r.items[1].customerId}`, { body: { city: 'جدة', schoolTypeId: ahli.id } });
  const q = async (qs) => (await admin('GET', `/license-records?${qs}`)).json;
  assert.equal((await q(`schoolTypeId=${gov.id}`)).total, 1);
  assert.equal((await q(`schoolTypeId=${ahli.id}`)).total, 1);
  assert.equal((await q(`schoolStageId=${prim.id}`)).total, 1);
  assert.equal((await q('schoolStageId=none')).total, 2);
  assert.equal((await q('schoolTypeId=none')).total, 1);
  assert.equal((await q('city=جد')).total, 1);
  assert.equal((await q('q=الرياض')).total, 1);
  assert.equal((await admin('GET', '/license-records?schoolTypeId=abc')).status, 400);
  assert.equal((await q('sort=city&dir=asc')).rows.length, 3);
});

test('SP9. editing the school profile never touches licenses, devices or activations', async () => {
  const rec = await oneRecord();
  await pool.query('INSERT INTO devices (device_id) VALUES ($1)', ['dev-x']);
  await pool.query('INSERT INTO activations (license_id, device_id) SELECT l.id, d.id FROM licenses l, devices d');
  const before = await licensingSnapshot();
  const gov = byName(await types(), 'حكومي');
  await admin('PATCH', `/customers/${rec.customerId}`, { body: { city: 'مكة', schoolTypeId: gov.id } });
  await admin('PATCH', `/school-types/${gov.id}`, { body: { name: 'حكومي ٢', confirm: true } });
  await admin('PATCH', `/school-types/${gov.id}`, { body: { isActive: false } });
  assert.deepEqual(await licensingSnapshot(), before);
});

// ------------------------------------------------------------------ Excel

test('SP10. export: old 14 columns first and unchanged, 3 new columns match the database', async () => {
  const gov = byName(await types(), 'حكومي');
  const sec = byName(await stages(), 'ثانوي');
  const r = await bulkWithSales({ productId: SCHOOL, customers: [{ name: 'مدرسة أ' }, { name: 'مدرسة ب' }, { name: 'مدرسة ج' }], maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  await admin('PATCH', `/customers/${r.items[0].customerId}`, { body: { city: 'الرياض', schoolTypeId: gov.id, schoolStageId: sec.id } });
  await admin('PATCH', `/customers/${r.items[1].customerId}`, { body: { city: '=SUM(A1)' } });
  const res = await admin('POST', '/export', { raw: true, body: { format: 'xlsx', scope: 'all', filters: { sort: 'customer_number', dir: 'asc' } } });
  assert.equal(res.status, 200);
  const wb = await readXlsx(res.buffer);
  const ws = wb.worksheets[0];
  const headers = ws.getRow(1).values.slice(1);
  assert.deepEqual(headers.slice(0, 14), ['رقم العميل', 'اسم العميل', 'الهاتف', 'البرنامج', 'مفتاح التفعيل', 'نوع الترخيص', 'تاريخ الانتهاء', 'السعر الفعلي', 'العملة', 'تاريخ البيع', 'حالة التفعيل', 'الحد الأقصى للأجهزة', 'عدد الأجهزة المستخدمة', 'الملاحظات']);
  assert.deepEqual(headers.slice(14), ['المدينة', 'نوع المدرسة', 'المرحلة الدراسية']);
  const get = (row, h) => ws.getRow(row).getCell(headers.indexOf(h) + 1).value;
  assert.equal(get(2, 'اسم العميل'), 'مدرسة أ');
  assert.equal(get(2, 'المدينة'), 'الرياض'); assert.equal(get(2, 'نوع المدرسة'), 'حكومي'); assert.equal(get(2, 'المرحلة الدراسية'), 'ثانوي');
  assert.equal(get(3, 'المدينة'), "'=SUM(A1)", 'formula text neutralised');
  assert.equal(get(3, 'نوع المدرسة'), null); assert.equal(get(4, 'المدينة'), null);
  assert.equal(get(2, 'رقم العميل'), 1);

  const csv = await admin('POST', '/export', { raw: true, body: { format: 'csv', scope: 'all' } });
  const head = csv.buffer.toString('utf8').replace(/^﻿/, '').split('\r\n')[0];
  assert.ok(head.endsWith('"المدينة","نوع المدرسة","المرحلة الدراسية"'));
});

test('SP11. template: columns, dropdowns, lists sheet reflects the current admin lists', async () => {
  const empty = await admin('GET', '/records/import-template', { raw: true });
  assert.equal(empty.status, 200);
  assert.match(empty.headers.get('content-type'), /spreadsheetml/);
  let wb = await readXlsx(empty.buffer);
  const ws = wb.getWorksheet('التراخيص');
  assert.deepEqual(ws.getRow(1).values.slice(1), ['رقم العميل', 'مفتاح التفعيل', 'اسم العميل', 'الهاتف', 'المدينة', 'نوع المدرسة', 'المرحلة الدراسية', 'السعر الفعلي', 'العملة', 'تاريخ البيع', 'الملاحظات']);
  const lists = wb.getWorksheet('القوائم');
  const col = (n) => lists.getColumn(n).values.slice(2).filter(Boolean);
  assert.deepEqual(col(1), DEFAULT_TYPES);
  assert.deepEqual(col(2), DEFAULT_STAGES);
  const dvType = ws.getCell(2, 6).dataValidation; const dvStage = ws.getCell(2, 7).dataValidation;
  assert.equal(dvType.type, 'list'); assert.equal(dvStage.type, 'list');
  assert.ok(dvType.formulae[0].includes('القوائم') && dvType.formulae[0].includes('$A$2:$A$5'));
  assert.ok(dvStage.formulae[0].includes('$B$2:$B$6'));
  assert.equal(ws.getCell(2, 5).dataValidation, undefined, 'city is free text');

  // change the lists => the next template follows (inactive ones are not offered)
  await admin('POST', '/school-types', { body: { name: 'مدرسة دولية' } });
  await admin('PATCH', `/school-stages/${byName(await stages(), 'متوسط').id}`, { body: { isActive: false } });
  wb = await readXlsx((await admin('GET', '/records/import-template', { raw: true })).buffer);
  const l2 = wb.getWorksheet('القوائم');
  assert.ok(l2.getColumn(1).values.includes('مدرسة دولية'));
  assert.ok(!l2.getColumn(2).values.includes('متوسط'));
  assert.ok(wb.getWorksheet('التراخيص').getCell(2, 6).dataValidation.formulae[0].includes('$A$2:$A$6'));

  // pre-filled with records that still lack school data
  const r = await bulkWithSales({ productId: SCHOOL, quantity: 2, maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  await admin('PATCH', `/customers/${r.items[0].customerId}`, { body: { city: 'x', schoolTypeId: byName(await types(), 'حكومي').id, schoolStageId: byName(await stages(), 'ثانوي').id } });
  const pre = await readXlsx((await admin('GET', '/records/import-template?prefill=incomplete', { raw: true })).buffer);
  const pw = pre.getWorksheet('التراخيص');
  assert.equal(pw.getRow(2).getCell(1).value, 2);
  assert.equal(pw.getRow(2).getCell(2).value, r.items[1].licenseKey);
  assert.equal(pw.getRow(3).getCell(1).value, null);
});

test('SP12. import: full file saves the new columns; all other columns keep their values', async () => {
  const r = await bulkWithSales({ productId: SCHOOL, customers: [{ name: 'مدرسة أ', salePrice: '150', currency: 'SAR', notes: 'قديمة', phone: undefined }, { name: 'مدرسة ب' }], maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  const before = (await pool.query('SELECT name, sale_price, currency, notes, sale_status, customer_number FROM customers ORDER BY customer_number')).rows;
  const lic = await licensingSnapshot();
  const file = await xlsx([[1, 'الرياض', 'حكومي', 'ثانوي'], [2, 'جدة', ' أهلي ', 'رياض الأطفال']]);
  const res = await upload(file);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.status, 'imported');
  assert.equal(res.json.summary.updated, 2);
  const rows = (await admin('GET', '/license-records?sort=customer_number&dir=asc')).json.rows;
  assert.deepEqual(rows.map((x) => [x.city, x.school_type_name, x.school_stage_name]), [['الرياض', 'حكومي', 'ثانوي'], ['جدة', 'أهلي', 'رياض الأطفال']]);
  const afterRows = (await pool.query('SELECT name, sale_price, currency, notes, sale_status, customer_number FROM customers ORDER BY customer_number')).rows;
  assert.deepEqual(afterRows, before, 'no other column changed');
  assert.deepEqual(await licensingSnapshot(), lic);
  void r;
});

test('SP13. import by license key, many columns, price/currency/date/notes/name, dates as Excel dates', async () => {
  const r = await bulkWithSales({ productId: SCHOOL, quantity: 2, maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('التراخيص');
  ws.addRow(['مفتاح التفعيل', 'اسم العميل', 'الهاتف', 'المدينة', 'نوع المدرسة', 'المرحلة الدراسية', 'السعر الفعلي', 'العملة', 'تاريخ البيع', 'الملاحظات', 'البرنامج', 'حالة التفعيل']);
  ws.addRow([r.items[0].licenseKey, 'مدرسة النور', '0501234567', 'الرياض', 'أهلي', 'ابتدائي', 1200.5, 'sar', new Date(Date.UTC(2026, 0, 15)), 'ملاحظة جديدة', 'اسم البرنامج', 'مفعّل']);
  const res = await upload(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(res.json.ignoredColumns.sort(), ['البرنامج', 'حالة التفعيل'].sort(), 'unused columns are reported, not silently dropped');
  const c = (await admin('GET', `/customers/${r.items[0].customerId}`)).json.customer;
  assert.equal(c.name, 'مدرسة النور'); assert.equal(c.phone, '0501234567'); assert.equal(c.sale_price, '1200.50');
  assert.equal(c.currency, 'SAR'); assert.equal(c.sold_at, '2026-01-15'); assert.equal(c.notes, 'ملاحظة جديدة');
  assert.equal(c.sale_status, 'sold');
  assert.equal(c.school_type_name, 'أهلي'); assert.equal(c.school_stage_name, 'ابتدائي');
  // the second record is untouched
  assert.equal((await admin('GET', `/customers/${r.items[1].customerId}`)).json.customer.city, null);
});

test('SP14. old file (no new columns) imports fine and never wipes saved city/type/stage; absent column != empty cell', async () => {
  const rec = await oneRecord();
  const gov = byName(await types(), 'حكومي');
  const sec = byName(await stages(), 'ثانوي');
  await admin('PATCH', `/customers/${rec.customerId}`, { body: { city: 'الرياض', schoolTypeId: gov.id, schoolStageId: sec.id } });

  // old layout: only name + price + currency
  const old = await xlsx([[1, 'مدرسة قديمة', 99, 'EGP']], ['رقم العميل', 'اسم العميل', 'السعر الفعلي', 'العملة']);
  const res = await upload(old);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  let c = (await admin('GET', `/customers/${rec.customerId}`)).json.customer;
  assert.equal(c.name, 'مدرسة قديمة');
  assert.equal(c.city, 'الرياض'); assert.equal(c.school_type_id, gov.id); assert.equal(c.school_stage_id, sec.id);

  // columns present but cells EMPTY: default = leave unchanged
  const blanks = await xlsx([[1, null, null, null, 'ملاحظة']], ['رقم العميل', 'المدينة', 'نوع المدرسة', 'المرحلة الدراسية', 'الملاحظات']);
  assert.equal((await upload(blanks)).status, 200);
  c = (await admin('GET', `/customers/${rec.customerId}`)).json.customer;
  assert.equal(c.city, 'الرياض'); assert.equal(c.school_type_id, gov.id); assert.equal(c.school_stage_id, sec.id); assert.equal(c.notes, 'ملاحظة');

  // ...unless clearing is explicitly requested
  const clear = await upload(blanks, '?clearEmpty=1');
  assert.equal(clear.status, 200, JSON.stringify(clear.json));
  c = (await admin('GET', `/customers/${rec.customerId}`)).json.customer;
  assert.equal(c.city, null); assert.equal(c.school_type_id, null); assert.equal(c.school_stage_id, null);
});

test('SP15. import validation: bad values are reported with row + column and NOTHING is saved (all-or-nothing)', async () => {
  const r = await bulkWithSales({ productId: SCHOOL, quantity: 3, maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  await admin('POST', '/school-types', { body: { name: 'مؤقت' } });
  const temp = byName(await types(), 'مؤقت');
  await admin('PATCH', `/school-types/${temp.id}`, { body: { isActive: false } });
  const snapshot = async () => (await pool.query('SELECT customer_number, name, city, school_type_id, school_stage_id, sale_status FROM customers ORDER BY customer_number')).rows;
  const before = await snapshot();

  const file = await xlsx([
    [1, 'الرياض', 'حكومي', 'ثانوي'],         // valid
    [2, 'جدة', 'مدرسة غير موجودة', 'ابتدائي'], // unknown type
    [3, 'x'.repeat(101), 'أهلي', 'ثانوي'],   // city too long
    [3, 'مكرر', null, null],                  // duplicate record in file
    [99, 'الدمام', 'أهلي', null],             // no such record
    [2, 'جدة', 'مؤقت', 'ابتدائي'],            // inactive option (and duplicate of row 3 -> reported)
    ['abc', 'x', null, null],                 // bad number
    [null, 'بلا معرّف', null, null],          // no identifier
    [1, 'الرياض', 'ابتدائي', 'حكومي'],        // values in the wrong lists (type<->stage swapped)
  ]);
  const res = await upload(file);
  assert.equal(res.status, 422);
  assert.equal(res.json.status, 'invalid');
  const has = (row, col, re) => res.json.errors.some((e) => e.row === row && e.column === col && re.test(e.message));
  assert.ok(has(3, 'نوع المدرسة', /غير موجود/), JSON.stringify(res.json.errors));
  assert.ok(has(4, 'المدينة', /طويل/));
  assert.ok(has(5, 'رقم العميل', /مكرر/));
  assert.ok(has(6, 'رقم العميل', /لا يوجد سجل/));
  assert.ok(has(7, 'نوع المدرسة', /معطّل/));
  assert.ok(has(8, 'رقم العميل', /ليس رقم عميل/));
  assert.ok(res.json.errors.some((e) => e.row === 9 && /لا يوجد رقم عميل/.test(e.message)));
  assert.ok(has(10, 'نوع المدرسة', /غير موجود/) && has(10, 'المرحلة الدراسية', /غير موجود/));
  assert.deepEqual(await snapshot(), before, 'nothing saved');
  // the row-3 message lists the valid choices and says to add it from the admin panel (no silent creation)
  assert.ok(res.json.errors.find((e) => e.row === 3).message.includes('حكومي'));
  assert.deepEqual((await types()).map((o) => o.name), [...DEFAULT_TYPES, 'مؤقت']);
  void r;
});

test('SP16. import: dry run saves nothing; same file then applies; a late database error rolls everything back', async () => {
  const r = await bulkWithSales({ productId: SCHOOL, quantity: 2, maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  const file = await xlsx([[1, 'الرياض', 'حكومي', 'ثانوي'], [2, 'جدة', 'أهلي', 'متوسط']]);
  const dry = await upload(file, '?dryRun=1');
  assert.equal(dry.status, 200);
  assert.equal(dry.json.status, 'preview');
  assert.equal(dry.json.summary.updated, 2);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM customers WHERE city IS NOT NULL')).rows[0].n, 0);
  assert.equal((await upload(file)).status, 200);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM customers WHERE city IS NOT NULL')).rows[0].n, 2);

  // a business rule that only the database layer knows (price without currency) fails the WHOLE file
  await pool.query('UPDATE customers SET city = NULL, school_type_id = NULL, school_stage_id = NULL');
  const bad = await xlsx([[1, 'الرياض', 'حكومي', null], [2, 'جدة', null, null, 500]], ['رقم العميل', 'المدينة', 'نوع المدرسة', 'المرحلة الدراسية', 'السعر الفعلي']);
  const res = await upload(bad);
  assert.equal(res.status, 422);
  assert.ok(res.json.errors.some((e) => e.row === 3 && /العملة/.test(e.message)), JSON.stringify(res.json.errors));
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM customers WHERE city IS NOT NULL')).rows[0].n, 0, 'first row rolled back too');
  void r;
});

test('SP17. import: file-level problems are refused clearly', async () => {
  await oneRecord();
  assert.equal((await upload(Buffer.alloc(0))).status, 400);
  assert.equal((await upload(Buffer.from('not an excel file'))).status, 400);
  assert.equal((await upload(Buffer.from('PK\u0003\u0004garbage'))).status, 400);
  const noId = await upload(await xlsx([['x', 'y']], ['المدينة', 'نوع المدرسة']));
  assert.equal(noId.status, 400); assert.match(noId.json.message, /رقم العميل|مفتاح التفعيل/);
  const onlyId = await upload(await xlsx([[1]], ['رقم العميل']));
  assert.equal(onlyId.status, 400);
  const dupCol = await upload(await xlsx([[1, 'a', 'b']], ['رقم العميل', 'المدينة', 'المدينة']));
  assert.equal(dupCol.status, 400); assert.match(dupCol.json.message, /مكرر/);
  const empty = await upload(await xlsx([], ['رقم العميل', 'المدينة']));
  assert.equal(empty.status, 400);
  const big = Buffer.concat([Buffer.from('PK'), Buffer.alloc(6 * 1024 * 1024)]);
  assert.ok([400, 413].includes((await upload(big)).status));
});

test('SP18. round trip: export -> edit city/type/stage in the file -> import -> export shows the edits; blank rows skipped', async () => {
  const r = await bulkWithSales({ productId: SCHOOL, customers: [{ name: 'مدرسة أ' }, { name: 'مدرسة ب' }], maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  const exp = await admin('POST', '/export', { raw: true, body: { format: 'xlsx', scope: 'all', filters: { sort: 'customer_number', dir: 'asc' } } });
  const wb = await readXlsx(exp.buffer);
  const ws = wb.worksheets[0];
  const col = (h) => ws.getRow(1).values.indexOf(h);
  ws.getRow(2).getCell(col('المدينة')).value = 'الرياض';
  ws.getRow(2).getCell(col('نوع المدرسة')).value = 'حكومي';
  ws.getRow(3).getCell(col('المرحلة الدراسية')).value = 'ابتدائي';
  ws.addRow([]); // a blank row
  const res = await upload(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.summary.blankRows >= 0, true);
  assert.ok(res.json.ignoredColumns.includes('البرنامج'));
  const rows = (await admin('GET', '/license-records?sort=customer_number&dir=asc')).json.rows;
  assert.deepEqual(rows.map((x) => [x.customer_name, x.city, x.school_type_name, x.school_stage_name]), [['مدرسة أ', 'الرياض', 'حكومي', null], ['مدرسة ب', null, null, 'ابتدائي']]);
  void r;
});

test('SP19. the lists survive a "restart" (data lives in the database), and a renamed option shows in the next template and export', async () => {
  const ahli = byName(await types(), 'أهلي');
  await admin('PATCH', `/school-types/${ahli.id}`, { body: { name: 'أهلي خاص' } });
  await admin('POST', '/school-stages', { body: { name: 'جامعي' } });
  // "restart": fresh module state + re-run of the (idempotent) migration exactly like a deploy would
  const client = await pool.connect();
  try { await runMigration(client, readSql('schoolProfile'), { mode: 'apply' }); } finally { client.release(); }
  assert.deepEqual((await types()).map((o) => o.name), ['حكومي', 'أهلي خاص', 'رياض الأطفال', 'تربية خاصة']);
  assert.ok((await stages()).some((o) => o.name === 'جامعي'));
  const rec = await oneRecord();
  await admin('PATCH', `/customers/${rec.customerId}`, { body: { schoolTypeId: ahli.id } });
  const wb = await readXlsx((await admin('GET', '/records/import-template', { raw: true })).buffer);
  assert.ok(wb.getWorksheet('القوائم').getColumn(1).values.includes('أهلي خاص'));
  const exp = await readXlsx((await admin('POST', '/export', { raw: true, body: { format: 'xlsx', scope: 'all' } })).buffer);
  const ws = exp.worksheets[0];
  assert.equal(ws.getRow(2).getCell(16).value, 'أهلي خاص');
});
