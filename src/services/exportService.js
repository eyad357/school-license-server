'use strict';

// XLSX / CSV export of the admin records.
//
// Safety rules applied to every text cell:
//   * spreadsheet-formula neutralisation: a text value that would be read as a
//     formula (starts with = + - @ TAB CR, ignoring leading spaces) is prefixed
//     with an apostrophe. Numbers are written as real numbers.
//   * CSV is UTF-8 WITH BOM and CRLF so Arabic opens correctly in Excel.
//   * No secrets are ever exported: only the columns listed below.

const ExcelJS = require('exceljs');

// header (Arabic), key, kind
const COLUMNS = Object.freeze([
  { key: 'customer_number', header: 'رقم العميل', kind: 'int', width: 12 },
  { key: 'customer_name', header: 'اسم العميل', kind: 'text', width: 32 },
  { key: 'customer_phone', header: 'الهاتف', kind: 'text', width: 18 },
  { key: 'product_name', header: 'البرنامج', kind: 'text', width: 26 },
  { key: 'license_key', header: 'مفتاح التفعيل', kind: 'text', width: 34 },
  { key: 'license_type', header: 'نوع الترخيص', kind: 'text', width: 14 },
  { key: 'expires_at', header: 'تاريخ الانتهاء', kind: 'datetime', width: 22 },
  { key: 'sale_price', header: 'السعر الفعلي', kind: 'money', width: 14 },
  { key: 'currency', header: 'العملة', kind: 'text', width: 10 },
  { key: 'sold_at', header: 'تاريخ البيع', kind: 'text', width: 14 },
  { key: 'activation_state', header: 'حالة التفعيل', kind: 'text', width: 14 },
  { key: 'max_devices', header: 'الحد الأقصى للأجهزة', kind: 'int', width: 20 },
  { key: 'active_devices', header: 'عدد الأجهزة المستخدمة', kind: 'int', width: 22 },
  { key: 'notes', header: 'الملاحظات', kind: 'text', width: 40 },
  // School profile (migration 008). Appended AFTER the original columns so the old layout is unchanged.
  { key: 'city', header: 'المدينة', kind: 'text', width: 18 },
  { key: 'school_type_name', header: 'نوع المدرسة', kind: 'text', width: 18 },
  { key: 'school_stage_name', header: 'المرحلة الدراسية', kind: 'text', width: 20 },
]);

const VALUE_LABELS = Object.freeze({
  sale_status: { unsold: 'غير مباع', sold: 'مباع' },
  payment_status: { unpaid: 'غير مدفوع', paid: 'مدفوع', partial: 'جزئي' },
  status: { ACTIVE: 'فعال', REVOKED: 'ملغى', EXPIRED: 'منتهي' },
  license_type: { perpetual: 'دائم', subscription: 'مؤقت' },
});

/** Adds the derived columns and Arabic labels (does not mutate the input). */
function prepareRow(row) {
  const out = { ...row };
  out.activation_state = row.license_id
    ? (row.active_devices > 0 ? 'مفعّل' : 'غير مفعّل')
    : '';
  for (const [key, map] of Object.entries(VALUE_LABELS)) {
    if (out[key] && map[out[key]]) out[key] = map[out[key]];
  }
  return out;
}

const FORMULA_START = /^[\s]*[=+\-@\t\r]/;

function neutralizeFormula(text) {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function formatDateTime(value) {
  if (!value) {
    return '';
  }

  const d = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(d.getTime())) {
    return '';
  }

  // UTC, fixed format => identical output on every machine.
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// Normalised cell value per column kind.
//   returns { text } for strings or { number } for numerics, or {} for empty.
function cellValue(row, column) {
  const raw = row[column.key];

  if (raw === null || raw === undefined || raw === '') {
    return {};
  }

  switch (column.kind) {
    case 'int':
      return { number: Number(raw) };
    case 'money':
      return { number: Number(raw), money: String(raw) };
    case 'datetime':
      return { text: formatDateTime(raw) };
    default:
      return { text: neutralizeFormula(String(raw)) };
  }
}

function csvEscape(text) {
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  const lines = [COLUMNS.map((c) => csvEscape(c.header)).join(',')];

  for (const raw of rows) {
    const row = prepareRow(raw);
    lines.push(
      COLUMNS.map((column) => {
        const cell = cellValue(row, column);

        if (cell.number !== undefined) {
          // Keep the exact stored decimal text for money, plain digits for ints.
          return cell.money !== undefined ? cell.money : String(cell.number);
        }

        return csvEscape(cell.text ?? '');
      }).join(',')
    );
  }

  // BOM + CRLF.
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

async function toXlsx(rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'school-license-server';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('التراخيص', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { horizontal: 'center', vertical: 'middle' };

  for (const raw of rows) {
    const row = prepareRow(raw);
    const added = sheet.addRow({});

    COLUMNS.forEach((column, index) => {
      const cell = added.getCell(index + 1);
      const value = cellValue(row, column);

      if (value.number !== undefined) {
        cell.value = value.number;

        if (column.kind === 'money') {
          cell.numFmt = '#,##0.00';
        }
      } else if (value.text !== undefined) {
        // A plain JS string => stored as a string cell, never as a formula.
        cell.value = value.text;
      }
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function exportFilename(format, prefix = 'licenses') {
  const d = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  return `${prefix}-${d}.${format}`;
}

module.exports = {
  COLUMNS,
  neutralizeFormula,
  toCsv,
  toXlsx,
  exportFilename,
};
