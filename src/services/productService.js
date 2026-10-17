'use strict';

// Product (program) management for the multi-product license platform.
//
// Rules:
//   * product_id is a permanent, unique slug. It can be set ONLY at creation.
//     (Also enforced by the DB trigger from 005_products_platform.sql.)
//   * Products are never deleted (licenses reference them).
//   * status 'disabled' means: no NEW licenses can be created for it and no NEW
//     device can be activated. Devices that are already activated keep
//     validating normally, so disabling a product never locks existing users.

const pool = require('../db/pool');
const { ValidationError, parseIntegerInRange } = require('../lib/validation');
const { NotFoundError, ConflictError } = require('../lib/errors');

const PRODUCT_STATUSES = ['active', 'disabled'];
const PRODUCT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])$/;

function cleanText(value, field, max, required) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} مطلوب.`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} يجب أن يكون نصًا.`);
  const text = value.normalize('NFC').replace(/[‪-‮⁦-⁩\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) {
    if (required) throw new ValidationError(`${field} مطلوب.`);
    return null;
  }
  if ([...text].length > max) throw new ValidationError(`${field} طويل جدًا (الحد الأقصى ${max}).`);
  return text;
}

function parseProductId(value) {
  if (typeof value !== 'string' || !PRODUCT_ID_RE.test(value)) {
    throw new ValidationError(
      'معرّف البرنامج يجب أن يكون حروفًا إنجليزية صغيرة وأرقامًا وشرطات فقط (2–64 حرفًا) ويبدأ وينتهي بحرف أو رقم.'
    );
  }
  return value;
}

const SELECT = `
  SELECT
    p.product_id,
    p.name,
    p.description,
    p.status,
    p.created_at,
    p.updated_at,
    (SELECT COUNT(*)::int FROM licenses l WHERE l.product_id = p.product_id) AS licenses,
    (SELECT COUNT(*)::int FROM licenses l WHERE l.product_id = p.product_id AND l.status = 'ACTIVE') AS active_licenses,
    (SELECT COUNT(DISTINCT l.customer_id)::int FROM licenses l
       WHERE l.product_id = p.product_id AND l.customer_id IS NOT NULL) AS customers,
    (SELECT COUNT(*)::int FROM activations a JOIN licenses l ON l.id = a.license_id
       WHERE l.product_id = p.product_id AND a.deactivated_at IS NULL) AS devices
  FROM products p
`;

async function listProducts(db = pool) {
  const r = await db.query(`${SELECT} ORDER BY p.created_at ASC, p.product_id ASC`);
  return r.rows;
}

async function getProduct(productId, db = pool) {
  const r = await db.query(`${SELECT} WHERE p.product_id = $1`, [productId]);
  if (r.rowCount === 0) throw new NotFoundError('البرنامج غير موجود.');
  return r.rows[0];
}

async function createProduct(input = {}, db = pool) {
  const productId = parseProductId(input.productId);
  const name = cleanText(input.name, 'اسم البرنامج', 255, true);
  const description = cleanText(input.description, 'الوصف', 2000, false);

  try {
    await db.query(
      `INSERT INTO products (product_id, name, description, status) VALUES ($1, $2, $3, 'active')`,
      [productId, name, description]
    );
  } catch (error) {
    if (error.code === '23505') {
      throw new ConflictError('معرّف البرنامج مستخدم بالفعل.', 'product_exists');
    }
    throw error;
  }
  return getProduct(productId, db);
}

async function updateProduct(productId, input = {}, db = pool) {
  if (input.productId !== undefined && input.productId !== productId) {
    throw new ValidationError('لا يمكن تغيير معرّف البرنامج بعد إنشائه.');
  }
  if (input.product_id !== undefined && input.product_id !== productId) {
    throw new ValidationError('لا يمكن تغيير معرّف البرنامج بعد إنشائه.');
  }

  const sets = [];
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };

  if (input.name !== undefined) sets.push(`name = ${push(cleanText(input.name, 'اسم البرنامج', 255, true))}`);
  if (input.description !== undefined) sets.push(`description = ${push(cleanText(input.description, 'الوصف', 2000, false))}`);
  if (input.status !== undefined) {
    if (!PRODUCT_STATUSES.includes(input.status)) {
      throw new ValidationError(`حالة البرنامج يجب أن تكون: ${PRODUCT_STATUSES.join(' أو ')}.`);
    }
    sets.push(`status = ${push(input.status)}`);
  }
  if (sets.length === 0) throw new ValidationError('لا توجد حقول للتعديل.');

  sets.push('updated_at = NOW()');
  const r = await db.query(
    `UPDATE products SET ${sets.join(', ')} WHERE product_id = ${push(productId)} RETURNING product_id`,
    params
  );
  if (r.rowCount === 0) throw new NotFoundError('البرنامج غير موجود.');
  return getProduct(productId, db);
}

/**
 * Used when CREATING licenses. A product must be chosen explicitly (no
 * silent default), must exist and must be active.
 * `db` may be a transaction client.
 */
async function assertProductUsableForNewLicenses(productId, db = pool) {
  if (productId === undefined || productId === null || productId === '') {
    throw new ValidationError('يجب اختيار البرنامج قبل إنشاء الترخيص.');
  }
  if (typeof productId !== 'string' || productId.length > 100) {
    throw new ValidationError('معرّف البرنامج غير صالح.');
  }
  // to_jsonb(...)->>'status' yields NULL (not an error) if migration 005 has not
  // been applied yet, which is treated as 'active'.
  const r = await db.query("SELECT to_jsonb(p)->>'status' AS status FROM products p WHERE p.product_id = $1", [productId]);
  if (r.rowCount === 0) throw new ValidationError('البرنامج المحدد غير مسجّل.');
  if (r.rows[0].status === 'disabled') {
    throw new ValidationError('هذا البرنامج معطّل إداريًا؛ لا يمكن إنشاء تراخيص جديدة له.');
  }
}

/**
 * Activation-path check. Never throws: if the 005 migration has not been
 * applied yet (no "status" column) the product is treated as active, so the
 * school client keeps working during a mis-ordered deployment.
 */
async function isProductDisabled(productId, db = pool) {
  try {
    const r = await db.query('SELECT status FROM products WHERE product_id = $1', [productId]);
    return r.rowCount > 0 && r.rows[0].status === 'disabled';
  } catch (_error) {
    return false;
  }
}

/**
 * REVIEW LIST: licenses whose product_id does not match any registered product (legacy / unknown program).
 * Read-only on purpose: nothing is relinked, renamed or created automatically. The admin decides: register the
 * slug as a product (POST /products) — which changes NO license — or leave it. Device activation keeps working
 * for these licenses exactly as before, because activation matches the license's own product_id.
 */
async function listUnregisteredProductLicenses() {
  const r = await pool.query(`
    SELECT l.product_id,
           COUNT(*)::int AS licenses,
           COUNT(*) FILTER (WHERE UPPER(l.status) = 'ACTIVE')::int AS active,
           COUNT(*) FILTER (WHERE UPPER(l.status) = 'REVOKED')::int AS revoked,
           COUNT(*) FILTER (WHERE UPPER(l.status) = 'EXPIRED')::int AS expired,
           MIN(l.created_at) AS first_created_at,
           MAX(l.created_at) AS last_created_at
      FROM licenses l
      LEFT JOIN products p ON p.product_id = l.product_id
     WHERE p.product_id IS NULL
     GROUP BY l.product_id
     ORDER BY COUNT(*) DESC, l.product_id`);
  return r.rows;
}

module.exports = {
  listUnregisteredProductLicenses,
  PRODUCT_STATUSES,
  parseProductId,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  assertProductUsableForNewLicenses,
  isProductDisabled,
};
