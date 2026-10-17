'use strict';

// Input validation / normalisation shared by the new customer-management code.
// Every function either returns a clean value or throws a ValidationError whose
// message is safe to show to the admin (Arabic-friendly, no internals).

class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.details = details;
  }
}

// Bidi override / isolate controls are stripped: they can make a name display
// differently from what is stored ("Trojan Source"-style spoofing in tables).
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
// C0/C1 control characters except TAB/LF/CR (kept only for notes).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function cleanText(value, { field, max, required = false, multiline = false }) {
  if (value === undefined || value === null) {
    if (required) {
      throw new ValidationError(`${field} مطلوب.`);
    }
    return null;
  }

  if (typeof value !== 'string') {
    throw new ValidationError(`${field} يجب أن يكون نصًا.`);
  }

  let text = value.normalize('NFC').replace(BIDI_CONTROLS, '');

  if (/\u0000/.test(text)) {
    throw new ValidationError(`${field} يحتوي على رموز غير مسموح بها.`);
  }

  text = text.replace(CONTROL_CHARS, multiline ? '' : ' ');
  text = multiline ? text.trim() : text.replace(/\s+/g, ' ').trim();

  if (text === '') {
    if (required) {
      throw new ValidationError(`${field} مطلوب.`);
    }
    return null;
  }

  if ([...text].length > max) {
    throw new ValidationError(`${field} طويل جدًا (الحد الأقصى ${max} حرفًا).`);
  }

  return text;
}

function parseName(value, { required = false } = {}) {
  return cleanText(value, { field: 'اسم العميل', max: 255, required });
}

function parseNotes(value) {
  return cleanText(value, { field: 'الملاحظات', max: 2000, multiline: true });
}

function parsePhone(value) {
  const phone = cleanText(value, { field: 'رقم الهاتف', max: 40 });

  if (phone === null) {
    return null;
  }

  if (!/^[0-9+()\-.\s\u0660-\u0669]{5,40}$/.test(phone)) {
    throw new ValidationError('صيغة رقم الهاتف غير صحيحة.');
  }

  return phone;
}

const SALE_STATUSES = ['unsold', 'sold'];
const PAYMENT_STATUSES = ['unpaid', 'paid', 'partial'];

function parseSaleStatus(value) {
  const v = String(value ?? '').trim().toLowerCase();

  if (!SALE_STATUSES.includes(v)) {
    throw new ValidationError('حالة البيع غير صالحة (unsold | sold).');
  }

  return v;
}

/** null/'' => null (not recorded). */
function parsePaymentStatus(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }

  const v = String(value).trim().toLowerCase();

  if (!PAYMENT_STATUSES.includes(v)) {
    throw new ValidationError('حالة الدفع غير صالحة (unpaid | paid | partial).');
  }

  return v;
}

function parseEmail(value) {
  const email = cleanText(value, { field: 'البريد الإلكتروني', max: 320 });

  if (email === null) {
    return null;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError('صيغة البريد الإلكتروني غير صحيحة.');
  }

  return email;
}

/**
 * Sale price: number or numeric string, max 2 decimals, >= 0.
 * Returned as a canonical string ("1500.00") so PostgreSQL NUMERIC never goes
 * through a binary float.
 */
function parseSalePrice(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  let text;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError('سعر البيع غير صالح.');
    }
    text = String(value);
  } else if (typeof value === 'string') {
    // Accept Arabic-Indic digits and the Arabic decimal separator.
    text = value
      .trim()
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/\u066B/g, '.')
      .replace(/[,\u066C\s]/g, '');
  } else {
    throw new ValidationError('سعر البيع غير صالح.');
  }

  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) {
    throw new ValidationError(
      'سعر البيع يجب أن يكون رقمًا غير سالب بحد أقصى خانتين عشريتين.'
    );
  }

  const [intPart, decPart = ''] = text.split('.');

  return `${intPart.replace(/^0+(?=\d)/, '')}.${decPart.padEnd(2, '0')}`;
}

function parseCurrency(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw new ValidationError('العملة غير صالحة.');
  }

  const code = value.trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(code)) {
    throw new ValidationError('العملة يجب أن تكون رمزًا من 3 أحرف (مثل EGP أو SAR).');
  }

  return code;
}

function parseSoldAt(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new ValidationError('تاريخ البيع يجب أن يكون بصيغة YYYY-MM-DD.');
  }

  const text = value.trim();
  const d = new Date(`${text}T00:00:00Z`);

  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) {
    throw new ValidationError('تاريخ البيع غير صالح.');
  }

  return text;
}

/** price and currency travel together: a price without a currency is ambiguous. */
function parseSale({ salePrice, currency, soldAt, notes }) {
  const sale_price = parseSalePrice(salePrice);
  const cur = parseCurrency(currency);

  if (sale_price !== null && cur === null) {
    throw new ValidationError('يجب اختيار العملة عند إدخال سعر البيع.');
  }

  return {
    salePrice: sale_price,
    currency: cur,
    soldAt: parseSoldAt(soldAt),
    notes: parseNotes(notes),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function assertUuid(value, field = 'المعرّف') {
  if (!isUuid(value)) {
    throw new ValidationError(`${field} غير صالح.`);
  }
  return value.toLowerCase();
}

function parseIntegerInRange(value, { field, min, max }) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    value = Number(value.trim());
  }

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} يجب أن يكون عددًا صحيحًا بين ${min} و${max}.`);
  }

  return value;
}

module.exports = {
  ValidationError,
  parseName,
  parseNotes,
  parseEmail,
  parsePhone,
  parseSaleStatus,
  parsePaymentStatus,
  SALE_STATUSES,
  PAYMENT_STATUSES,
  parseSalePrice,
  parseCurrency,
  parseSoldAt,
  parseSale,
  isUuid,
  assertUuid,
  parseIntegerInRange,
};
