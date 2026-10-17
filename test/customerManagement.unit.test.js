'use strict';

// Pure unit tests (no database needed): `npm test`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/lib/validation');
const { neutralizeFormula, toCsv } = require('../src/services/exportService');
const { buildWhere } = require('../src/services/licenseRecordService');
const { normalizeRequest } = require('../src/services/bulkLicenseService');

test('sale price parsing is exact and strict', () => {
  assert.equal(v.parseSalePrice('1500'), '1500.00');
  assert.equal(v.parseSalePrice(1500.5), '1500.50');
  assert.equal(v.parseSalePrice('١٢٣٫٤'), '123.40');
  assert.equal(v.parseSalePrice('1,500.25'), '1500.25');
  assert.equal(v.parseSalePrice(''), null);
  assert.equal(v.parseSalePrice(null), null);
  for (const bad of ['-1', '1.234', 'abc', '1e5', NaN, Infinity, '99999999999', {}]) {
    assert.throws(() => v.parseSalePrice(bad), v.ValidationError, String(bad));
  }
});

test('price requires a currency; currency and date formats are checked', () => {
  assert.throws(() => v.parseSale({ salePrice: '10' }), /العملة/);
  assert.deepEqual(v.parseSale({ salePrice: '10', currency: 'egp' }).currency, 'EGP');
  assert.throws(() => v.parseCurrency('EG'));
  assert.throws(() => v.parseSoldAt('2026-02-30'));
  assert.equal(v.parseSoldAt('2026-02-28'), '2026-02-28');
});

test('names are normalised and bidi-spoofing characters are stripped', () => {
  assert.equal(v.parseName('  مدرسة   النور  '), 'مدرسة النور');
  assert.equal(v.parseName('a\u202Eb'), 'ab');
  assert.equal(v.parseName('   '), null);
  assert.throws(() => v.parseName('   ', { required: true }));
  assert.throws(() => v.parseName('x'.repeat(256)));
  assert.throws(() => v.parseName('a\u0000b'));
});

test('formula neutralisation', () => {
  for (const s of ['=1+1', '+1', '-1', '@A1', '\t=1', ' =1', '\r=1']) {
    assert.equal(neutralizeFormula(s), `'${s}`, JSON.stringify(s));
  }
  for (const s of ['مدرسة', 'SCHL-AAAA', 'a=b', '1500']) {
    assert.equal(neutralizeFormula(s), s);
  }
});

test('CSV output: BOM, CRLF, quoted text, exact money, empty cells, labels', () => {
  const { COLUMNS } = require('../src/services/exportService');
  const buf = toCsv([{ customer_number: 1, customer_name: 'مدرسة "أ"', license_id: 'L-1', license_key: 'K', status: 'ACTIVE',
    sale_status: 'sold', payment_status: 'partial', max_devices: 1, active_devices: 0, sale_price: '10.50', currency: 'EGP',
    license_type: 'perpetual', license_created_at: new Date('2026-01-02T03:04:05Z'), sold_at: null, notes: null }]);
  const text = buf.toString('utf8');
  assert.ok(text.startsWith('﻿'));
  assert.ok(text.endsWith('\r\n'));
  const line = text.split('\r\n')[1];
  assert.ok(line.startsWith('1,"مدرسة ""أ""",'));
  assert.ok(line.includes('"K","دائم"'));
  assert.ok(line.includes('10.50,"EGP"'), line);
  for (const removed of ['L-1', 'مباع', 'جزئي', 'فعال']) assert.ok(!line.includes(removed), `removed column leaked: ${removed}`);
  assert.ok(!line.includes('2026-01-02'), 'license creation date is no longer exported');
  assert.equal(text.split('\r\n')[0].split('","').length, COLUMNS.length);
  assert.equal(COLUMNS.length, 14);
  const removedHeaders = ['البريد الإلكتروني', 'مرجع الترخيص', 'معرّف البرنامج', 'الخطة', 'حالة الدفع', 'حالة البيع', 'أول تفعيل (UTC)', 'تاريخ إنشاء الترخيص', 'حالة الترخيص'];
  for (const h of removedHeaders) assert.ok(!COLUMNS.some((c) => c.header === h), `column still exported: ${h}`);
});

test('search filters are parameterised and wildcards are escaped', () => {
  const { where, params } = buildWhere({ q: "50%_\\'; DROP TABLE x;--" });
  assert.ok(!where.includes('DROP'));
  assert.ok(params[params.length - 1] !== undefined);
  assert.ok(params.some((p) => typeof p === 'string' && p.includes('\\%') && p.includes('\\_') && p.includes('\\\\')));
  assert.throws(() => buildWhere({ status: 'x' }));
  assert.throws(() => buildWhere({ q: 'x'.repeat(101) }));
});

test('bulk request requires an explicit product (no silent default)', () => {
  assert.throws(() => normalizeRequest({ quantity: 1 }), /البرنامج/);
  assert.throws(() => normalizeRequest({ quantity: 1, productId: '' }), /البرنامج/);
});

test('bulk request normalisation enforces the 1..1000 rules and refuses names / sale data', () => {
  assert.equal(normalizeRequest({ productId: 'p', quantity: 1000 }).quantity, 1000);
  for (const bad of [0, 1001, '', null, 1.5, undefined]) assert.throws(() => normalizeRequest({ productId: 'p', quantity: bad }), v.ValidationError);
  assert.throws(() => normalizeRequest({ productId: 'p', quantity: 3, customers: [{ name: 'a' }] }), /أسماء العملاء/);
  assert.throws(() => normalizeRequest({ productId: 'p', quantity: 3, defaults: { salePrice: 5 } }), /أسماء العملاء/);
  assert.throws(() => normalizeRequest({ productId: 'p', quantity: 1, duration: 'forever' }), /مدة/);
  assert.throws(() => normalizeRequest({ productId: 'p', quantity: 1, maxDevices: 0 }));
  assert.deepEqual(Object.keys(normalizeRequest({ productId: 'p', quantity: 2 })).sort(), ['duration', 'maxDevices', 'plan', 'productId', 'quantity']);
});
