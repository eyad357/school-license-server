'use strict';

// Real admin dashboard (index.html + app.js) in jsdom against the real server + test DB:
// the school-profile fields of the record form, the options-management tab, and the Excel import dialog.
// It proves the screens are wired to the API; it is not a visual/pixel test.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ExcelJS = require('exceljs');
const { pool, resetDatabase, startServer, closeAll, ROOT } = require('./helpers/setup');
const { bulkWithSales } = require('./helpers/bulk');

let dom; let w; let downloads; let promptAnswer; let confirmAnswer = true;
const $ = (id) => w.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await sleep(25); }
  throw new Error(`timeout waiting for: ${label}`);
}
function type(el, value) { el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); }
function change(el, value) { el.value = value; el.dispatchEvent(new w.Event('change', { bubbles: true })); }
const optionTexts = (sel) => [...$(sel).options].map((o) => o.textContent);

before(async () => {
  await resetDatabase('full');
  await bulkWithSales({ productId: 'school-accreditation', quantity: 2, maxDevices: 1, duration: 'lifetime', plan: 'pro' });
  const base = await startServer();
  const dir = path.join(ROOT, 'src', 'admin', 'public');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(/<script src="[^"]*"><\/script>/, '');
  const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  downloads = [];
  dom = new JSDOM(html, { url: `${base}/admin`, runScripts: 'outside-only', pretendToBeVisual: true });
  w = dom.window;
  w.fetch = (u, o) => fetch(new URL(u, base), o);
  w.confirm = () => confirmAnswer;
  w.prompt = () => promptAnswer;
  w.alert = () => {};
  // jsdom has no Blob.arrayBuffer (every real browser does)
  w.Blob.prototype.arrayBuffer = function arrayBuffer() {
    return new Promise((resolve, reject) => { const fr = new w.FileReader(); fr.onload = () => resolve(Buffer.from(fr.result)); fr.onerror = reject; fr.readAsArrayBuffer(this); });
  };
  w.URL.createObjectURL = (blob) => { downloads.push(blob); return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function click() { downloads.push({ download: this.download }); };
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async () => {} } });
  w.eval(js);
});
after(async () => { dom.window.close(); await closeAll(); });

test('UI-SP1. login; the options tab lists the agreed defaults in two separate lists', async () => {
  $('username').value = 'test-admin'; $('password').value = 'test-password';
  $('loginForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !$('dashboardView').classList.contains('hidden'), 'dashboard');
  await until(() => $('licensesTableBody').querySelectorAll('tr').length === 2, 'rows');

  $('tabSchoolOptions').click();
  await until(() => $('schoolTypesBody').querySelectorAll('tr').length === 4, 'types loaded');
  const rowsText = (id) => [...$(id).querySelectorAll('tr')].map((tr) => tr.querySelector('td').textContent.trim());
  assert.deepEqual(rowsText('schoolTypesBody'), ['حكومي', 'أهلي', 'رياض الأطفال', 'تربية خاصة']);
  assert.deepEqual(rowsText('schoolStagesBody'), ['رياض الأطفال', 'ابتدائي', 'متوسط', 'ثانوي', 'تربية خاصة']);
  assert.ok(!rowsText('schoolTypesBody').includes('ابتدائي'));
  assert.ok(!rowsText('schoolStagesBody').includes('حكومي'));
  assert.ok($('licensesPanel').classList.contains('hidden'), 'options tab replaces the records panel');
});

test('UI-SP2. add an option (appears at once), duplicate shows a clear error, lists stay independent', async () => {
  const form = w.document.querySelector('[data-option-form="school-types"]');
  type(form.querySelector('input'), 'مدرسة دولية');
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('schoolTypesBody').querySelectorAll('tr').length === 5, 'type added');
  assert.equal($('schoolStagesBody').querySelectorAll('tr').length, 5, 'stages untouched');

  type(form.querySelector('input'), ' أهلي ');
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /موجود بالفعل/.test($('schoolTypesMessage').textContent), 'duplicate message');
  assert.equal($('schoolTypesBody').querySelectorAll('tr').length, 5);
});

test('UI-SP3. record form: the new fields save, re-open, show in the table, and clear', async () => {
  $('tabLicenses').click();
  await until(() => !$('licensesPanel').classList.contains('hidden'), 'licenses panel');
  w.document.querySelector('#licensesTableBody [data-action="customer"]').click();
  await until(() => $('customerModalSub').textContent.includes('رقم العميل'), 'form opened');

  assert.deepEqual(optionTexts('cSchoolType'), ['— بدون —', 'حكومي', 'أهلي', 'رياض الأطفال', 'تربية خاصة', 'مدرسة دولية']);
  assert.deepEqual(optionTexts('cSchoolStage'), ['— بدون —', 'رياض الأطفال', 'ابتدائي', 'متوسط', 'ثانوي', 'تربية خاصة']);
  assert.equal($('cCity').value, ''); assert.equal($('cSchoolType').value, ''); assert.equal($('cSchoolStage').value, '');

  type($('cCity'), 'الرياض');
  change($('cSchoolType'), [...$('cSchoolType').options].find((o) => o.textContent === 'حكومي').value);
  change($('cSchoolStage'), [...$('cSchoolStage').options].find((o) => o.textContent === 'ثانوي').value);
  $('customerForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('customerModal').classList.contains('hidden'), 'saved');

  await until(() => $('licensesTableBody').textContent.includes('الرياض'), 'table shows city');
  const text = $('licensesTableBody').textContent;
  assert.ok(text.includes('حكومي') && text.includes('ثانوي'));
  const { rows } = await pool.query('SELECT city, school_type_id, school_stage_id FROM customers WHERE city IS NOT NULL');
  assert.equal(rows.length, 1); assert.ok(rows[0].school_type_id && rows[0].school_stage_id);

  // reopen: values come back
  [...w.document.querySelectorAll('#licensesTableBody [data-action="customer"]')].find((b) => b.closest('tr').textContent.includes('الرياض')).click();
  await until(() => $('cCity').value === 'الرياض', 'city reloaded');
  assert.equal($('cSchoolType').selectedOptions[0].textContent, 'حكومي');
  assert.equal($('cSchoolStage').selectedOptions[0].textContent, 'ثانوي');

  // clear the optional ones and save without errors
  type($('cCity'), ''); change($('cSchoolType'), ''); change($('cSchoolStage'), '');
  $('customerForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('customerModal').classList.contains('hidden'), 'saved cleared');
  const cleared = await pool.query('SELECT COUNT(*)::int AS n FROM customers WHERE city IS NOT NULL OR school_type_id IS NOT NULL OR school_stage_id IS NOT NULL');
  assert.equal(cleared.rows[0].n, 0);
});

test('UI-SP4. a used option: rename asks for confirmation, delete is refused, deactivate keeps it on the record', async () => {
  // give record 1 the type "حكومي" through the form
  w.document.querySelector('#licensesTableBody [data-action="customer"]').click();
  await until(() => $('customerModalSub').textContent.includes('رقم العميل'), 'form');
  const govId = [...$('cSchoolType').options].find((o) => o.textContent === 'حكومي').value;
  change($('cSchoolType'), govId);
  $('customerForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('customerModal').classList.contains('hidden'), 'saved');

  $('tabSchoolOptions').click();
  await until(() => /مستخدم في 1/.test($('schoolTypesBody').textContent), 'usage shown');
  const govRow = () => [...$('schoolTypesBody').querySelectorAll('tr')].find((tr) => tr.querySelector('td').textContent.trim().startsWith('حكومي'));

  govRow().querySelector('[data-oaction="delete"]').click();
  await until(() => /لا يمكن حذف/.test($('schoolTypesMessage').textContent), 'delete refused');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM school_types WHERE name = 'حكومي'")).rows[0].n, 1);

  promptAnswer = 'حكومي عام';
  confirmAnswer = true;
  govRow().querySelector('[data-oaction="rename"]').click();
  await until(() => $('schoolTypesBody').textContent.includes('حكومي عام'), 'renamed');

  govRow().querySelector('[data-oaction="toggle"]').click();
  await until(() => /معطّل/.test(govRow().textContent), 'deactivated');

  $('tabLicenses').click();
  w.document.querySelector('#licensesTableBody [data-action="customer"]').click();
  await until(() => $('customerModalSub').textContent.includes('رقم العميل'), 'form again');
  await until(() => $('cSchoolType').selectedOptions[0] && $('cSchoolType').selectedOptions[0].textContent.includes('حكومي عام'), 'inactive option kept on the record');
  assert.ok($('cSchoolType').selectedOptions[0].textContent.includes('معطّل'));
  const second = [...$('cSchoolType').options].filter((o) => o.textContent.includes('حكومي عام'));
  assert.equal(second.length, 1);
  w.document.querySelector('[data-close="customerModal"]').click();
});

test('UI-SP5. template download and the Excel import dialog (preview, errors, apply)', async () => {
  confirmAnswer = true;
  const before = downloads.length;
  $('importTemplateBtn').click();
  await until(() => downloads.some((d) => d.download && /import-template.*\.xlsx$/.test(d.download)), 'template download');
  assert.ok(downloads.length > before);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('التراخيص');
  ws.addRow(['رقم العميل', 'المدينة', 'نوع المدرسة', 'المرحلة الدراسية']);
  ws.addRow([2, 'جدة', 'أهلي', 'ابتدائي']);
  ws.addRow([1, 'مكة', 'نوع خاطئ', 'ثانوي']);
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  const file = new w.File([bytes], 'schools.xlsx');
  Object.defineProperty($('importFile'), 'files', { value: [file], configurable: true });
  $('importFile').dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.ok(!$('importModal').classList.contains('hidden'));
  assert.equal($('importFileName').textContent, 'schools.xlsx');

  $('importPreviewBtn').click();
  await until(() => !$('importErrorsBox').classList.contains('hidden'), 'errors shown');
  const errText = $('importErrorsBody').textContent;
  assert.ok(errText.includes('نوع المدرسة') && errText.includes('نوع خاطئ'));
  assert.equal($('importErrorsBody').querySelector('td').textContent, '3', 'row number reported');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM customers WHERE city = 'جدة'")).rows[0].n, 0, 'nothing saved');

  // fix the file: now valid; preview first (saves nothing) then apply
  ws.getRow(3).getCell(3).value = 'حكومي عام';
  // "حكومي عام" is inactive now => still refused with a clear message
  Object.defineProperty($('importFile'), 'files', { value: [new w.File([Buffer.from(await wb.xlsx.writeBuffer())], 'schools.xlsx')], configurable: true });
  $('importPreviewBtn').click();
  await until(() => /معطّل/.test($('importErrorsBody').textContent), 'inactive option refused');

  ws.getRow(3).getCell(3).value = 'مدرسة دولية';
  Object.defineProperty($('importFile'), 'files', { value: [new w.File([Buffer.from(await wb.xlsx.writeBuffer())], 'schools.xlsx')], configurable: true });
  $('importPreviewBtn').click();
  await until(() => /الفحص ناجح/.test($('importMessage').textContent), 'preview ok');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM customers WHERE city IS NOT NULL")).rows[0].n, 0);

  $('importApplyBtn').click();
  await until(() => /تم الاستيراد/.test($('importMessage').textContent), 'imported');
  await until(() => $('licensesTableBody').textContent.includes('جدة') && $('licensesTableBody').textContent.includes('مكة'), 'table refreshed');
  const rows = (await pool.query('SELECT c.customer_number::int AS n, c.city, t.name AS type, s.name AS stage FROM customers c LEFT JOIN school_types t ON t.id = c.school_type_id LEFT JOIN school_stages s ON s.id = c.school_stage_id ORDER BY 1')).rows;
  assert.deepEqual(rows, [{ n: 1, city: 'مكة', type: 'مدرسة دولية', stage: 'ثانوي' }, { n: 2, city: 'جدة', type: 'أهلي', stage: 'ابتدائي' }]);
});

test('UI-SP6. filters by type / stage / city work from the table toolbar', async () => {
  $('importModal').classList.add('hidden');
  const intl = [...$('schoolTypeFilter').options].find((o) => o.textContent === 'مدرسة دولية');
  assert.ok(intl, 'type filter lists the options');
  change($('schoolTypeFilter'), intl.value);
  await until(() => $('licensesTableBody').querySelectorAll('tr').length === 1 && $('licensesTableBody').textContent.includes('مكة'), 'filtered by type');
  change($('schoolTypeFilter'), '');
  change($('schoolStageFilter'), [...$('schoolStageFilter').options].find((o) => o.textContent === 'ابتدائي').value);
  await until(() => $('licensesTableBody').querySelectorAll('tr').length === 1 && $('licensesTableBody').textContent.includes('جدة'), 'filtered by stage');
  change($('schoolStageFilter'), '');
  type($('searchInput'), 'مكة');
  await until(() => $('licensesTableBody').querySelectorAll('tr').length === 1, 'search by city');
  type($('searchInput'), '');
  await until(() => $('licensesTableBody').querySelectorAll('tr').length === 2, 'search cleared');
  await sleep(100);
});
