'use strict';

// Excel import / template for the sale-record data (name, phone, city, school type, school stage,
// price, currency, sale date, notes).
//
// What the import does: it UPDATES existing records, identified by "رقم العميل" and/or "مفتاح التفعيل".
// It never creates licenses/keys (use bulk creation for that), never touches the key, status, expiry,
// devices or activations, and never adds options to the lists (the admin manages them).
//
// Safety rules:
//   * all-or-nothing: every row is validated first and applied in ONE transaction; any error => nothing saved;
//   * dryRun=true runs exactly the same code and then rolls back (preview);
//   * a column that is absent from the file leaves that field untouched; a column that is present but has an
//     EMPTY cell also leaves the stored value untouched, unless clearEmpty=true is passed explicitly;
//   * unknown values for school type / stage (not an ACTIVE option) are reported with row + column, never auto-created;
//   * columns the importer does not use (e.g. the read-only columns of the export) are listed in `ignoredColumns`.

const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { ValidationError, parseName, parsePhone, parseCity, parseSalePrice, parseCurrency, parseSoldAt, parseNotes } = require('../lib/validation');
const { schoolTypes, schoolStages, optionKey } = require('./schoolOptionsService');
const { updateCustomerOn, withTransaction } = require('./customerService');
const { neutralizeFormula } = require('./exportService');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;

// header -> field. Header matching ignores spaces, tatweel, diacritics and alef/yaa variants.
const FIELDS = Object.freeze([
  { field: 'customerNumber', header: 'رقم العميل', width: 12 },
  { field: 'licenseKey', header: 'مفتاح التفعيل', width: 34 },
  { field: 'name', header: 'اسم العميل', width: 32 },
  { field: 'phone', header: 'الهاتف', width: 18 },
  { field: 'city', header: 'المدينة', width: 18 },
  { field: 'schoolType', header: 'نوع المدرسة', width: 18 },
  { field: 'schoolStage', header: 'المرحلة الدراسية', width: 20 },
  { field: 'salePrice', header: 'السعر الفعلي', width: 14 },
  { field: 'currency', header: 'العملة', width: 10 },
  { field: 'soldAt', header: 'تاريخ البيع', width: 14 },
  { field: 'notes', header: 'الملاحظات', width: 40 },
]);
const BY_KEY = new Map(FIELDS.map((f) => [optionKey(f.header), f]));
const HEADER_OF = Object.fromEntries(FIELDS.map((f) => [f.field, f.header]));

const SHEET_NAME = 'التراخيص';
const LISTS_SHEET = 'القوائم';

function cellText(cell) {
  let v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (Array.isArray(v.richText)) v = v.richText.map((r) => r.text).join('');
    else if (v.result !== undefined) v = v.result;
    else if (v.text !== undefined) v = v.text; // hyperlink
    else if (v.error) return '\u0000ERR';
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (v === null || v === undefined) return '';
  return typeof v === 'number' ? String(v) : String(v);
}

function fileProblem(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 'لم يتم إرفاق ملف Excel.';
  if (buffer.length > MAX_FILE_BYTES) return `حجم الملف أكبر من الحد المسموح (${MAX_FILE_BYTES / 1024 / 1024} ميغابايت).`;
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) return 'الملف ليس بصيغة Excel (.xlsx) صالحة.';
  return null;
}

async function readSheet(buffer) {
  const problem = fileProblem(buffer);
  if (problem) throw new ValidationError(problem);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (_e) {
    throw new ValidationError('تعذّرت قراءة الملف: ليس ملف Excel (.xlsx) سليمًا.');
  }
  const sheet = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets.find((w) => w.name !== LISTS_SHEET && w.rowCount > 0) || workbook.worksheets[0];
  if (!sheet) throw new ValidationError('الملف لا يحتوي أي ورقة.');
  return sheet;
}

/** Parse the sheet into { columns, rows, ignoredColumns, blankRows } or throw ValidationError (file-level). */
function parseSheet(sheet) {
  const headerRow = sheet.getRow(1);
  const columns = new Map(); // col index -> field spec
  const ignoredColumns = [];
  const seen = new Set();
  const maxCol = Math.max(sheet.columnCount, headerRow.cellCount);

  for (let c = 1; c <= maxCol; c += 1) {
    const text = cellText(headerRow.getCell(c)).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const spec = BY_KEY.get(optionKey(text));
    if (!spec) { ignoredColumns.push(text); continue; }
    if (seen.has(spec.field)) throw new ValidationError(`العمود «${spec.header}» مكرر في الصف الأول.`);
    seen.add(spec.field);
    columns.set(c, spec);
  }

  if (!seen.has('customerNumber') && !seen.has('licenseKey')) {
    throw new ValidationError('يجب أن يحتوي الملف على عمود «رقم العميل» أو «مفتاح التفعيل» لتحديد السجل المراد تحديثه.');
  }
  if (![...seen].some((f) => f !== 'customerNumber' && f !== 'licenseKey')) {
    throw new ValidationError('الملف لا يحتوي أي عمود بيانات للاستيراد (مثل المدينة أو نوع المدرسة).');
  }

  const rows = [];
  let blankRows = 0;
  const last = Math.min(sheet.rowCount, MAX_ROWS + 1 + 5000);
  for (let r = 2; r <= last; r += 1) {
    const row = sheet.getRow(r);
    const cells = {};
    let any = false;
    for (const [c, spec] of columns) {
      const t = cellText(row.getCell(c)).replace(/\s+$/g, '').replace(/^\s+/g, '');
      cells[spec.field] = t;
      if (t !== '') any = true;
    }
    if (!any) { blankRows += 1; continue; }
    rows.push({ rowNumber: r, cells });
  }
  if (rows.length > MAX_ROWS) throw new ValidationError(`عدد الصفوف يتجاوز الحد الأقصى للاستيراد (${MAX_ROWS}).`);
  if (rows.length === 0) throw new ValidationError('الملف لا يحتوي أي صف بيانات.');

  return { fields: new Set(seen), rows, ignoredColumns, blankRows };
}

function check(errors, rowNumber, field, fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ValidationError) {
      errors.push({ row: rowNumber, column: HEADER_OF[field], message: error.message });
      return undefined;
    }
    throw error;
  }
}

async function importRecords(buffer, { dryRun = false, clearEmpty = false, createdBy } = {}, db = pool) {
  const sheet = await readSheet(buffer);
  const parsed = parseSheet(sheet);
  const errors = [];

  const [typeMap, stageMap, allTypes, allStages] = await Promise.all([
    schoolTypes.activeKeyMap(db), schoolStages.activeKeyMap(db), schoolTypes.list(db), schoolStages.list(db),
  ]);
  const activeNames = (map, all) => all.filter((o) => o.is_active).map((o) => o.name);

  // ---- phase 1: per-row parsing (no database writes) --------------------------------
  const items = [];
  const seenCustomer = new Map();

  for (const { rowNumber, cells } of parsed.rows) {
    const item = { rowNumber, ref: null, patch: {}, keyText: cells.licenseKey || '', numberText: cells.customerNumber || '' };

    // identity
    let customerId = null;
    let byNumber = null;
    if (parsed.fields.has('customerNumber') && cells.customerNumber !== '') {
      const t = cells.customerNumber.replace(/^#/, '');
      if (!/^\d{1,15}$/.test(t)) errors.push({ row: rowNumber, column: HEADER_OF.customerNumber, message: `«${cells.customerNumber}» ليس رقم عميل صالحًا.` });
      else byNumber = t;
    }
    let byKey = null;
    if (parsed.fields.has('licenseKey') && cells.licenseKey !== '') {
      byKey = cells.licenseKey.trim();
      if (byKey.length > 100) { errors.push({ row: rowNumber, column: HEADER_OF.licenseKey, message: 'مفتاح التفعيل طويل جدًا.' }); byKey = null; }
    }
    if (byNumber === null && byKey === null) {
      if (!errors.some((e) => e.row === rowNumber)) errors.push({ row: rowNumber, column: `${HEADER_OF.customerNumber} / ${HEADER_OF.licenseKey}`, message: 'لا يوجد رقم عميل ولا مفتاح تفعيل لتحديد السجل.' });
      items.push(item); continue;
    }

    const found = new Set();
    if (byNumber !== null) {
      const r = await db.query('SELECT id FROM customers WHERE customer_number = $1::bigint', [byNumber]);
      if (r.rowCount === 0) errors.push({ row: rowNumber, column: HEADER_OF.customerNumber, message: `لا يوجد سجل بالرقم ${byNumber}.` });
      else found.add(r.rows[0].id);
    }
    if (byKey !== null) {
      const r = await db.query('SELECT customer_id FROM licenses WHERE license_key = $1', [byKey]);
      if (r.rowCount === 0) errors.push({ row: rowNumber, column: HEADER_OF.licenseKey, message: 'مفتاح التفعيل غير موجود.' });
      else if (!r.rows[0].customer_id) errors.push({ row: rowNumber, column: HEADER_OF.licenseKey, message: 'هذا الترخيص بلا سجل عميل؛ استكمل بياناته من لوحة الإدارة أولًا.' });
      else found.add(r.rows[0].customer_id);
    }
    if (found.size > 1) errors.push({ row: rowNumber, column: `${HEADER_OF.customerNumber} / ${HEADER_OF.licenseKey}`, message: 'رقم العميل ومفتاح التفعيل يخصّان سجلين مختلفين.' });
    if (found.size === 1) {
      customerId = [...found][0];
      if (seenCustomer.has(customerId)) errors.push({ row: rowNumber, column: HEADER_OF.customerNumber, message: `هذا السجل مكرر في الملف (ظهر أولًا في الصف ${seenCustomer.get(customerId)}).` });
      else seenCustomer.set(customerId, rowNumber);
    }
    item.ref = customerId;

    // values: an empty cell leaves the field untouched unless clearEmpty
    const set = (field, key, parse, { clearable = true } = {}) => {
      if (!parsed.fields.has(field)) return;
      const raw = cells[field];
      if (raw === '\u0000ERR') { errors.push({ row: rowNumber, column: HEADER_OF[field], message: 'الخلية تحتوي خطأ Excel.' }); return; }
      if (raw === '') { if (clearEmpty && clearable) item.patch[key] = null; return; }
      const value = check(errors, rowNumber, field, () => parse(raw));
      if (value !== undefined) item.patch[key] = value;
    };

    set('name', 'name', (v) => parseName(v), { clearable: false });
    set('phone', 'phone', (v) => parsePhone(v));
    set('city', 'city', (v) => parseCity(v));
    set('salePrice', 'salePrice', (v) => parseSalePrice(v));
    set('currency', 'currency', (v) => parseCurrency(v));
    set('soldAt', 'soldAt', (v) => parseSoldAt(v));
    set('notes', 'notes', (v) => parseNotes(v));

    const option = (field, key, map, all, label) => set(field, key, (v) => {
      const hit = map.get(optionKey(v));
      if (hit !== undefined) return hit;
      const inactive = all.find((o) => !o.is_active && optionKey(o.name) === optionKey(v));
      throw new ValidationError(inactive
        ? `${label} «${v}» معطّل ولا يمكن اختياره. الخيارات الفعّالة: ${activeNames(map, all).join('، ') || '—'}.`
        : `${label} «${v}» غير موجود في القائمة. الخيارات الفعّالة: ${activeNames(map, all).join('، ') || '—'}. (أضِف الخيار من لوحة الإدارة أولًا.)`);
    });
    option('schoolType', 'schoolTypeId', typeMap, allTypes, 'نوع المدرسة');
    option('schoolStage', 'schoolStageId', stageMap, allStages, 'المرحلة الدراسية');

    items.push(item);
  }

  const summary = { rows: parsed.rows.length, blankRows: parsed.blankRows, updated: 0, unchanged: 0 };
  const base = { dryRun, summary, ignoredColumns: parsed.ignoredColumns, errors };
  if (errors.length) return { ok: false, ...base };

  // ---- phase 2: apply in ONE transaction (rolled back for dryRun) -------------------------
  const marker = new Error('dry-run rollback');
  try {
    await withTransaction(db, async (client) => {
      for (const item of items) {
        if (Object.keys(item.patch).length === 0) { summary.unchanged += 1; continue; }
        try {
          await updateCustomerOn(client, item.ref, item.patch);
          summary.updated += 1;
        } catch (error) {
          if (error instanceof ValidationError || error.statusCode === 404 || error.statusCode === 409) {
            errors.push({ row: item.rowNumber, column: '', message: error.message });
            throw error;
          }
          throw error;
        }
      }
      if (dryRun) throw marker;
    });
  } catch (error) {
    if (error === marker) return { ok: true, ...base };
    if (errors.length) { summary.updated = 0; return { ok: false, ...base }; }
    throw error;
  }
  return { ok: true, ...base };
}

/** Empty template (optionally pre-filled with the keys that still need school data). */
async function buildTemplate({ prefill = 'none', productId } = {}, db = pool) {
  const [types, stages] = await Promise.all([schoolTypes.list(db, { activeOnly: true }), schoolStages.list(db, { activeOnly: true })]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'school-license-server';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(SHEET_NAME, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  sheet.columns = FIELDS.map((f) => ({ header: f.header, key: f.field, width: f.width }));
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { horizontal: 'center', vertical: 'middle' };

  let n = 0;
  if (prefill === 'unsold' || prefill === 'incomplete') {
    const params = [];
    let where = prefill === 'unsold' ? "c.sale_status = 'unsold'" : "c.city IS NULL OR c.school_type_id IS NULL OR c.school_stage_id IS NULL";
    where = `(${where}) AND c.archived_at IS NULL`;
    if (productId) { params.push(String(productId).slice(0, 100)); where += ` AND l.product_id = $${params.length}`; }
    const r = await db.query(
      `SELECT c.customer_number::int AS customer_number, l.license_key
         FROM customers c JOIN licenses l ON l.customer_id = c.id
        WHERE ${where} ORDER BY c.customer_number LIMIT ${MAX_ROWS}`, params);
    for (const row of r.rows) {
      sheet.addRow({ customerNumber: row.customer_number, licenseKey: neutralizeFormula(row.license_key) });
      n += 1;
    }
  }

  const lists = workbook.addWorksheet(LISTS_SHEET, { views: [{ rightToLeft: true }] });
  lists.columns = [{ header: 'نوع المدرسة', key: 't', width: 24 }, { header: 'المرحلة الدراسية', key: 's', width: 24 }];
  lists.getRow(1).font = { bold: true };
  const rowsN = Math.max(types.length, stages.length);
  for (let i = 0; i < rowsN; i += 1) lists.addRow({ t: types[i] ? types[i].name : null, s: stages[i] ? stages[i].name : null });

  const last = Math.max(n + 1, 1) + 2000; // validation also covers rows the user adds below
  const col = (letter) => FIELDS.findIndex((f) => f.field === letter) + 1;
  const dv = (field, listCol, count) => {
    if (!count) return;
    for (let r = 2; r <= last; r += 1) {
      sheet.getCell(r, col(field)).dataValidation = {
        type: 'list', allowBlank: true,
        formulae: [`'${LISTS_SHEET}'!$${listCol}$2:$${listCol}$${count + 1}`],
        showErrorMessage: true, errorStyle: 'stop', errorTitle: 'قيمة غير مسموحة', error: 'اختر قيمة من القائمة (تُدار من لوحة الإدارة).',
      };
    }
  };
  dv('schoolType', 'A', types.length);
  dv('schoolStage', 'B', stages.length);

  const help = workbook.addWorksheet('تعليمات', { views: [{ rightToLeft: true }] });
  help.getColumn(1).width = 110;
  [
    'تعليمات الاستيراد',
    'الاستيراد يحدّث بيانات سجلات موجودة فقط؛ لا ينشئ مفاتيح جديدة (أنشئ المفاتيح من لوحة الإدارة أولًا).',
    'حدّد السجل بعمود «رقم العميل» أو «مفتاح التفعيل» (أحدهما يكفي).',
    'الأعمدة الاختيارية: المدينة، نوع المدرسة، المرحلة الدراسية. يمكن تركها فارغة.',
    'الخلية الفارغة لا تمسح القيمة المحفوظة. لمسح القيم الفارغة فعّل خيار «اعتبار الخلايا الفارغة مسحًا» عند الاستيراد.',
    'نوع المدرسة والمرحلة الدراسية يجب أن يطابقا قائمة الخيارات الفعّالة (ورقة «القوائم»). لا تُضاف خيارات جديدة تلقائيًا.',
    'العمود غير الموجود في الملف لا يغيّر شيئًا. الأعمدة غير المعروفة تُتجاهل ويُعرض اسمها بعد الاستيراد.',
    'إذا كان في الملف أي خطأ فلن يُحفظ أي صف، وتظهر لك قائمة بالصف والعمود.',
  ].forEach((t, i) => { const c = help.addRow([t]).getCell(1); c.alignment = { wrapText: true, horizontal: 'right' }; if (i === 0) c.font = { bold: true }; });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { FIELDS, SHEET_NAME, LISTS_SHEET, MAX_FILE_BYTES, MAX_ROWS, importRecords, buildTemplate };
