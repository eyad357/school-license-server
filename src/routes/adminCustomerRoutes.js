'use strict';

// Admin API for customer management, sales data, bulk creation and export.
// Every route is protected by requireAdmin (applied per route on purpose: this
// router shares the /api/v1/admin prefix with adminRoutes.js, which owns the
// unauthenticated /login endpoint).

const express = require('express');
const { requireAdmin } = require('../middleware/adminAuth');
const audit = require('../services/auditService');
const { createBulkLicenses } = require('../services/bulkLicenseService');
const {
  getCustomerDetails,
  updateCustomer,
  archiveCustomer,
  unarchiveCustomer,
  assignCustomerToLicense,
} = require('../services/customerService');
const {
  listRecords,
  listRecordsForExport,
  getSummary,
} = require('../services/licenseRecordService');
const { toCsv, toXlsx, exportFilename } = require('../services/exportService');
const { ValidationError } = require('../lib/validation');
const {
  listProducts,
  listUnregisteredProductLicenses,
  getProduct,
  createProduct,
  updateProduct,
} = require('../services/productService');

const router = express.Router();

// index.js skips its 50kb parser for these two paths; they parse up to 1mb here,
// only after the admin token has been verified.
const largeJson = express.json({ limit: '1mb' });

function handle(label, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;

      if (statusCode >= 500) {
        console.error(`${label} error:`, error);

        return res.status(500).json({
          status: 'server_error',
          message: 'حدث خطأ داخلي في الخادم. لم يتم حفظ أي تغيير غير مكتمل.',
        });
      }

      return res.status(statusCode).json({
        status: statusCode === 404 ? 'not_found' : statusCode === 409 ? 'conflict' : 'invalid',
        code: error.code,
        message: error.message,
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Table: paginated, searchable, sortable
// ---------------------------------------------------------------------------
router.get(
  '/license-records',
  requireAdmin,
  handle('List records', async (req, res) => {
    const [page, summary] = await Promise.all([
      listRecords(req.query),
      getSummary(req.query.productId || undefined),
    ]);

    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', ...page, summary });
  })
);

// ---------------------------------------------------------------------------
// Products (programs)
// ---------------------------------------------------------------------------
router.get(
  '/products',
  requireAdmin,
  handle('List products', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', products: await listProducts() });
  })
);

router.get(
  '/products-review',
  requireAdmin,
  handle('Unregistered products review list', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', note: 'Licenses whose product is not registered. Read-only: nothing is changed automatically.', items: await listUnregisteredProductLicenses() });
  })
);

router.get(
  '/products/:productId',
  requireAdmin,
  handle('Get product', async (req, res) => {
    res.json({ status: 'ok', product: await getProduct(req.params.productId) });
  })
);

router.post(
  '/products',
  requireAdmin,
  handle('Create product', async (req, res) => {
    const product = await createProduct(req.body || {});
    await audit.record(null, { ...audit.fromReq(req), action: 'product.create', targetType: 'product', targetId: product.product_id || (req.body || {}).productId, meta: {} });
    res.status(201).json({ status: 'created', product });
  })
);

router.patch(
  '/products/:productId',
  requireAdmin,
  handle('Update product', async (req, res) => {
    const product = await updateProduct(req.params.productId, req.body || {});
    await audit.record(null, { ...audit.fromReq(req), action: 'product.update', targetType: 'product', targetId: req.params.productId, meta: { fields: Object.keys(req.body || {}) } });
    res.json({ status: 'ok', product });
  })
);

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
router.get(
  '/customers/:ref',
  requireAdmin,
  handle('Get customer', async (req, res) => {
    const details = await getCustomerDetails(req.params.ref);

    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', ...details });
  })
);

router.patch(
  '/customers/:ref',
  requireAdmin,
  handle('Update customer', async (req, res) => {
    const customer = await updateCustomer(req.params.ref, req.body || {});
    await audit.record(null, { ...audit.fromReq(req), action: 'customer.update', targetType: 'customer', targetId: req.params.ref, meta: { fields: Object.keys(req.body || {}) } });

    res.json({ status: 'ok', customer });
  })
);

router.post(
  '/customers/:ref/archive',
  requireAdmin,
  handle('Archive customer', async (req, res) => {
    const customer = await archiveCustomer(req.params.ref);
    await audit.record(null, { ...audit.fromReq(req), action: 'customer.archive', targetType: 'customer', targetId: req.params.ref, meta: {} });

    res.json({ status: 'ok', customer });
  })
);

router.post(
  '/customers/:ref/unarchive',
  requireAdmin,
  handle('Unarchive customer', async (req, res) => {
    const customer = await unarchiveCustomer(req.params.ref);
    await audit.record(null, { ...audit.fromReq(req), action: 'customer.unarchive', targetType: 'customer', targetId: req.params.ref, meta: {} });

    res.json({ status: 'ok', customer });
  })
);

// Complete a license that has no customer yet (legacy licenses).
router.post(
  '/licenses/:id/assign-customer',
  requireAdmin,
  handle('Assign customer', async (req, res) => {
    const result = await assignCustomerToLicense(req.params.id, req.body || {});
    await audit.record(null, { ...audit.fromReq(req), action: 'license.assign_customer', targetType: 'license', targetId: req.params.id, meta: {} });

    res.json({ status: 'ok', ...result });
  })
);

// ---------------------------------------------------------------------------
// Bulk creation
// ---------------------------------------------------------------------------
router.post(
  '/licenses/bulk',
  requireAdmin,
  largeJson,
  handle('Bulk create licenses', async (req, res) => {
    const body = req.body || {};

    const result = await createBulkLicenses(
      {
        ...body,
        idempotencyKey: req.get('Idempotency-Key') || body.idempotencyKey,
      },
      { createdBy: req.admin && req.admin.username }
    );

    if (!result.replayed) {
      await audit.record(null, { ...audit.fromReq(req), action: 'license.bulk_create', targetType: 'batch', targetId: result.batchId || result.batch_id || null,
        meta: { productId: body.productId, quantity: result.quantity } });
    }

    res.set('Cache-Control', 'no-store');
    res.status(result.replayed ? 200 : 201).json({
      status: result.replayed ? 'replayed' : 'created',
      ...result,
    });
  })
);

// ---------------------------------------------------------------------------
// Export (POST so that a long list of selected ids fits in the body)
// ---------------------------------------------------------------------------
router.post(
  '/export',
  requireAdmin,
  largeJson,
  handle('Export', async (req, res) => {
    const body = req.body || {};
    const format = String(body.format || '').toLowerCase();

    if (!['xlsx', 'csv'].includes(format)) {
      throw new ValidationError('صيغة التصدير يجب أن تكون xlsx أو csv.');
    }

    const scope = body.scope || 'search';
    const filters = body.filters && typeof body.filters === 'object' ? body.filters : {};

    let queryFilters;

    if (scope === 'all') {
      queryFilters = { archived: filters.archived || 'exclude', sort: filters.sort, dir: filters.dir };
    } else if (scope === 'search') {
      queryFilters = { ...filters };
    } else if (scope === 'selected') {
      queryFilters = {
        archived: 'include',
        licenseIds: body.licenseIds || [],
        customerIds: body.customerIds || [],
        sort: filters.sort,
        dir: filters.dir,
      };
    } else if (scope === 'unsold' || scope === 'sold') {
      // Separate exports: unsold keys vs sold licenses. Same optional filters.
      queryFilters = {
        archived: filters.archived || 'exclude',
        productId: filters.productId,
        status: filters.status,
        batchId: filters.batchId,
        paymentStatus: scope === 'sold' ? filters.paymentStatus : undefined,
        saleStatus: scope,
        sort: filters.sort,
        dir: filters.dir,
      };
    } else {
      throw new ValidationError('نطاق التصدير غير صالح (all | search | selected | unsold | sold).');
    }

    const rows = await listRecordsForExport(queryFilters);

    const file = format === 'csv' ? toCsv(rows) : await toXlsx(rows);

    res.set({
      'Content-Type':
        format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportFilename(format, scope === 'unsold' ? 'unsold-keys' : scope === 'sold' ? 'sold-licenses' : 'licenses')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Export-Rows': String(rows.length),
    });

    await audit.record(null, { ...audit.fromReq(req), action: 'export', targetType: 'export', meta: { format, scope, rows: rows.length } });

    res.send(file);
  })
);

module.exports = router;
