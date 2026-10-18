'use strict';

// Read-only query layer behind the admin table AND the exports, so that
// "what you see" and "what you export" are produced by the same SQL.
//
// A "record" is one row of:   customers FULL OUTER JOIN licenses
//   - license with a customer          (normal case)
//   - license without a customer       (legacy rows: data can be completed later)
//   - customer without a license       (kept visible instead of silently hidden)
//
// Nothing here writes to the database, and nothing here is used by the
// activate / validate / deactivate code paths.

const pool = require('../db/pool');
const { ValidationError, isUuid } = require('../lib/validation');

const STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'];
const { SALE_STATUSES, PAYMENT_STATUSES } = require('../lib/validation');
const MAX_PAGE_SIZE = 200;
const MAX_EXPORT_ROWS = 50000;

const SORT_COLUMNS = Object.freeze({
  customer_number: 'c.customer_number',
  customer_name: 'c.name',
  license_key: 'l.license_key',
  status: 'l.status',
  max_devices: 'l.max_devices',
  active_devices: 'active_devices',
  sale_price: 'c.sale_price',
  sold_at: 'c.sold_at',
  city: 'c.city',
  sale_status: 'c.sale_status',
  payment_status: 'c.payment_status',
  created_at: 'COALESCE(l.created_at, c.created_at)',
});

const SELECT_COLUMNS = `
  l.id AS license_id,
  l.license_key,
  l.product_id,
  p.name AS product_name,
  l.status,
  l.max_devices,
  l.expires_at,
  l.plan,
  l.license_type,
  l.created_at AS license_created_at,
  c.id AS customer_id,
  c.customer_number::int AS customer_number,
  c.name AS customer_name,
  c.email AS customer_email,
  c.phone AS customer_phone,
  c.city AS city,
  c.school_type_id::int AS school_type_id,
  st.name AS school_type_name,
  c.school_stage_id::int AS school_stage_id,
  sg.name AS school_stage_name,
  c.sale_status,
  c.payment_status,
  c.sale_price,
  c.currency,
  to_char(c.sold_at, 'YYYY-MM-DD') AS sold_at,
  c.notes,
  c.created_at AS customer_created_at,
  c.archived_at,
  (
    SELECT COUNT(*)::int
    FROM activations a
    WHERE a.license_id = l.id
      AND a.deactivated_at IS NULL
  ) AS active_devices,
  (
    SELECT COUNT(*)::int
    FROM activations a
    WHERE a.license_id = l.id
  ) AS total_activations,
  (
    SELECT to_char(MIN(a.activated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    FROM activations a
    WHERE a.license_id = l.id
  ) AS first_activated_at
`;

const FROM_CLAUSE = `
  FROM customers c
  FULL OUTER JOIN licenses l
    ON l.customer_id = c.id
  LEFT JOIN products p
    ON p.product_id = l.product_id
  LEFT JOIN school_types st
    ON st.id = c.school_type_id
  LEFT JOIN school_stages sg
    ON sg.id = c.school_stage_id
`;

// A row needs attention when it has no customer, no name, or no recorded price.
// Unsold keys are not "incomplete": they simply have no sale yet.
const INCOMPLETE_SQL = `(
  c.id IS NULL
  OR (
    c.sale_status = 'sold'
    AND (c.name IS NULL OR btrim(c.name) = '' OR c.sale_price IS NULL)
  )
)`;

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Turns raw query-string / body filters into a validated, parameterised WHERE.
 * Returns { where, params }.
 */
function buildWhere(filters = {}) {
  const clauses = [];
  const params = [];

  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  // --- archived -----------------------------------------------------------
  const archived = filters.archived || 'exclude';

  if (!['exclude', 'include', 'only'].includes(archived)) {
    throw new ValidationError('قيمة archived غير صالحة.');
  }

  if (archived === 'exclude') {
    clauses.push('(c.id IS NULL OR c.archived_at IS NULL)');
  } else if (archived === 'only') {
    clauses.push('c.archived_at IS NOT NULL');
  }

  // --- status -------------------------------------------------------------
  if (filters.status) {
    const status = String(filters.status).toUpperCase();

    if (!STATUSES.includes(status)) {
      throw new ValidationError('حالة الترخيص غير صالحة.');
    }

    clauses.push(`l.status = ${push(status)}`);
  }

  // --- sale / payment status (separate from license status) ----------------
  if (filters.saleStatus) {
    const v = String(filters.saleStatus).toLowerCase();

    if (!SALE_STATUSES.includes(v)) {
      throw new ValidationError('حالة البيع غير صالحة.');
    }

    clauses.push(`c.sale_status = ${push(v)}`);
  }

  if (filters.paymentStatus) {
    const v = String(filters.paymentStatus).toLowerCase();

    if (v === 'none') {
      clauses.push('c.payment_status IS NULL');
    } else if (PAYMENT_STATUSES.includes(v)) {
      clauses.push(`c.payment_status = ${push(v)}`);
    } else {
      throw new ValidationError('حالة الدفع غير صالحة.');
    }
  }

  // --- school profile (all optional) --------------------------------------------
  if (filters.city !== undefined && filters.city !== null && filters.city !== '') {
    if (typeof filters.city !== 'string' || filters.city.length > 100) throw new ValidationError('المدينة غير صالحة.');
    clauses.push(`c.city ILIKE ${push(`%${escapeLike(filters.city.normalize('NFC').trim())}%`)} ESCAPE '\\'`);
  }

  for (const [key, column, label] of [
    ['schoolTypeId', 'c.school_type_id', 'نوع المدرسة'],
    ['schoolStageId', 'c.school_stage_id', 'المرحلة الدراسية'],
  ]) {
    const v = filters[key];
    if (v === undefined || v === null || v === '') continue;
    if (String(v).toLowerCase() === 'none') clauses.push(`${column} IS NULL`);
    else if (/^\d{1,15}$/.test(String(v))) clauses.push(`${column} = ${push(Number(v))}`);
    else throw new ValidationError(`${label} غير صالح.`);
  }

  // --- activation state ------------------------------------------------------
  if (filters.activation) {
    const v = String(filters.activation).toLowerCase();
    const active = `EXISTS (SELECT 1 FROM activations a WHERE a.license_id = l.id AND a.deactivated_at IS NULL)`;

    if (v === 'activated') clauses.push(active);
    else if (v === 'not_activated') clauses.push(`(l.id IS NOT NULL AND NOT ${active})`);
    else throw new ValidationError('حالة التفعيل غير صالحة.');
  }

  // --- one creation batch ----------------------------------------------------
  if (filters.batchId) {
    if (!isUuid(filters.batchId)) {
      throw new ValidationError('معرّف الدفعة غير صالح.');
    }

    clauses.push(
      `l.id = ANY(COALESCE((SELECT b.license_ids FROM license_batches b WHERE b.id = ${push(
        String(filters.batchId).toLowerCase()
      )}::uuid), '{}'::uuid[]))`
    );
  }

  // --- program (product) ---------------------------------------------------
  if (filters.productId !== undefined && filters.productId !== null && filters.productId !== '') {
    if (typeof filters.productId !== 'string' || filters.productId.length > 100) {
      throw new ValidationError('معرّف البرنامج غير صالح.');
    }

    clauses.push(`l.product_id = ${push(filters.productId)}`);
  }

  // --- incomplete data ----------------------------------------------------
  if (filters.incomplete === true || filters.incomplete === '1' || filters.incomplete === 'true') {
    clauses.push(INCOMPLETE_SQL);
  }

  // --- free-text search ---------------------------------------------------
  const q = typeof filters.q === 'string' ? filters.q.normalize('NFC').trim() : '';

  if (q.length > 100) {
    throw new ValidationError('نص البحث طويل جدًا.');
  }

  if (q) {
    const like = push(`%${escapeLike(q)}%`);
    const parts = [
      `c.name ILIKE ${like} ESCAPE '\\'`,
      `l.license_key ILIKE ${like} ESCAPE '\\'`,
      `c.email ILIKE ${like} ESCAPE '\\'`,
      `p.name ILIKE ${like} ESCAPE '\\'`,
      `c.city ILIKE ${like} ESCAPE '\\'`,
    ];

    const numeric = q.replace(/^#/, '');

    if (/^\d{1,15}$/.test(numeric)) {
      parts.push(`c.customer_number = ${push(numeric)}::bigint`);
    }

    clauses.push(`(${parts.join(' OR ')})`);
  }

  // --- explicit selection (export of selected rows) ------------------------
  const licenseIds = Array.isArray(filters.licenseIds) ? filters.licenseIds : [];
  const customerIds = Array.isArray(filters.customerIds) ? filters.customerIds : [];

  if (filters.licenseIds !== undefined || filters.customerIds !== undefined) {
    if (![...licenseIds, ...customerIds].every(isUuid)) {
      throw new ValidationError('قائمة التحديد تحتوي معرّفًا غير صالح.');
    }

    if (licenseIds.length + customerIds.length === 0) {
      throw new ValidationError('لم يتم تحديد أي سجل.');
    }

    clauses.push(
      `(l.id = ANY(${push(licenseIds)}::uuid[]) ` +
        `OR (l.id IS NULL AND c.id = ANY(${push(customerIds)}::uuid[])))`
    );
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function buildOrderBy(sort, dir) {
  const column = SORT_COLUMNS[sort || 'created_at'];

  if (!column) {
    throw new ValidationError('عمود الترتيب غير صالح.');
  }

  const direction = String(dir || 'desc').toLowerCase();

  if (!['asc', 'desc'].includes(direction)) {
    throw new ValidationError('اتجاه الترتيب غير صالح.');
  }

  // Deterministic tie-breakers => stable pagination.
  return (
    `ORDER BY ${column} ${direction.toUpperCase()} NULLS LAST, ` +
    `COALESCE(l.created_at, c.created_at) DESC, l.id ASC NULLS LAST, c.id ASC NULLS LAST`
  );
}

function parsePaging(filters) {
  let page = Number.parseInt(filters.page ?? '1', 10);
  let pageSize = Number.parseInt(filters.pageSize ?? '25', 10);

  if (!Number.isInteger(page) || page < 1) {
    page = 1;
  }

  if (!Number.isInteger(pageSize) || pageSize < 1) {
    pageSize = 25;
  }

  return { page, pageSize: Math.min(pageSize, MAX_PAGE_SIZE) };
}

async function listRecords(filters = {}, db = pool) {
  const { where, params } = buildWhere(filters);
  const orderBy = buildOrderBy(filters.sort, filters.dir);
  const { page, pageSize } = parsePaging(filters);

  const countResult = await db.query(
    `SELECT COUNT(*)::int AS total ${FROM_CLAUSE} ${where}`,
    params
  );

  const total = countResult.rows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

  const rowsResult = await db.query(
    `
    SELECT ${SELECT_COLUMNS}
    ${FROM_CLAUSE}
    ${where}
    ${orderBy}
    LIMIT ${pageSize} OFFSET ${(safePage - 1) * pageSize}
    `,
    params
  );

  return {
    rows: rowsResult.rows,
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}

/** Same filters/order as the table, no paging, hard-capped. */
async function listRecordsForExport(filters = {}, db = pool) {
  const { where, params } = buildWhere(filters);
  const orderBy = buildOrderBy(filters.sort, filters.dir);

  const result = await db.query(
    `
    SELECT ${SELECT_COLUMNS}
    ${FROM_CLAUSE}
    ${where}
    ${orderBy}
    LIMIT ${MAX_EXPORT_ROWS + 1}
    `,
    params
  );

  if (result.rows.length > MAX_EXPORT_ROWS) {
    throw new ValidationError(
      `عدد السجلات يتجاوز الحد الأقصى للتصدير (${MAX_EXPORT_ROWS}). استخدم فلاتر أضيق.`
    );
  }

  return result.rows;
}

async function getSummary(productId, db = pool) {
  const pFilter = productId ? 'WHERE product_id = $1' : '';
  const pParams = productId ? [productId] : [];
  const licenses = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
      COUNT(*) FILTER (WHERE status = 'REVOKED')::int AS revoked,
      COUNT(*) FILTER (WHERE status = 'EXPIRED')::int AS expired
    FROM licenses
    ${pFilter}
  `, pParams);

  const customers = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE archived_at IS NULL)::int AS customers,
      COUNT(*) FILTER (WHERE archived_at IS NOT NULL)::int AS archived_customers
    FROM customers
  `);

  const sales = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE c.sale_status = 'unsold')::int AS unsold,
      COUNT(*) FILTER (WHERE c.sale_status = 'sold')::int AS sold
    ${FROM_CLAUSE}
    WHERE l.id IS NOT NULL AND (c.id IS NULL OR c.archived_at IS NULL)
    ${productId ? 'AND l.product_id = $1' : ''}
  `, pParams);

  const incomplete = await db.query(`
    SELECT COUNT(*)::int AS n
    ${FROM_CLAUSE}
    WHERE (c.id IS NULL OR c.archived_at IS NULL) AND ${INCOMPLETE_SQL}
    ${productId ? 'AND l.product_id = $1' : ''}
  `, pParams);

  return {
    totalLicenses: licenses.rows[0].total,
    active: licenses.rows[0].active,
    revoked: licenses.rows[0].revoked,
    expired: licenses.rows[0].expired,
    unsold: sales.rows[0].unsold,
    sold: sales.rows[0].sold,
    customers: customers.rows[0].customers,
    archivedCustomers: customers.rows[0].archived_customers,
    incompleteRecords: incomplete.rows[0].n,
  };
}

module.exports = {
  STATUSES,
  SORT_COLUMNS,
  MAX_PAGE_SIZE,
  MAX_EXPORT_ROWS,
  buildWhere,
  listRecords,
  listRecordsForExport,
  getSummary,
};
