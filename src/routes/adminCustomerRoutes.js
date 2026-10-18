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

const { schoolTypes, schoolStages } = require('../services/schoolOptionsService');
const { importRecords, buildTemplate, MAX_FILE_BYTES } = require('../services/recordImportService');

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
// School profile option lists: school types and school stages (two SEPARATE lists).
// Every route requires an admin token; the UI hiding buttons is not the protection.
//   GET    /school-options               both lists (admin view, includes inactive + usage)
//   GET    /school-types | /school-stages
//   POST   /school-types | /school-stages            { name }
//   PATCH  /school-types/:id | /school-stages/:id    { name?, isActive?, confirm? }
//   DELETE /school-types/:id | /school-stages/:id
// ---------------------------------------------------------------------------
router.get(
  '/school-options',
  requireAdmin,
  handle('List school options', async (_req, res) => {
    const [types, stages] = await Promise.all([schoolTypes.list(), schoolStages.list()]);
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', schoolTypes: types, schoolStages: stages });
  })
);

for (const [path, svc, key, targetType] of [
  ['school-types', schoolTypes, 'schoolType', 'school_type'],
  ['school-stages', schoolStages, 'schoolStage', 'school_stage'],
]) {
  router.get(`/${path}`, requireAdmin, handle(`List ${path}`, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', items: await svc.list() });
  }));

  router.post(`/${path}`, requireAdmin, handle(`Create ${path}`, async (req, res) => {
    const item = await svc.create(req.body || {});
    await audit.record(null, { ...audit.fromReq(req), action: `${targetType}.create`, targetType, targetId: item.id, meta: { name: item.name } });
    res.status(201).json({ status: 'created', [key]: item });
  }));

  router.patch(`/${path}/:id`, requireAdmin, handle(`Update ${path}`, async (req, res) => {
    const before = await svc.get(req.params.id);
    const item = await svc.update(req.params.id, req.body || {});
    await audit.record(null, { ...audit.fromReq(req), action: `${targetType}.update`, targetType, targetId: item.id,
      meta: { from: before.name, to: item.name, isActive: item.is_active, usage: item.usage_count } });
    res.json({ status: 'ok', [key]: item });
  }));

  router.delete(`/${path}/:id`, requireAdmin, handle(`Delete ${path}`, async (req, res) => {
    const removed = await svc.remove(req.params.id);
    await audit.record(null, { ...audit.fromReq(req), action: `${targetType}.delete`, targetType, targetId: removed.id, meta: { name: removed.name } });
    res.json({ status: 'deleted', [key]: removed });
  }));
}

// ---------------------------------------------------------------------------
// Excel import (updates existing records) and its template
// ---------------------------------------------------------------------------
router.get(
  '/records/import-template',
  requireAdmin,
  handle('Import template', async (req, res) => {
    const prefill = ['unsold', 'incomplete'].includes(req.query.prefill) ? req.query.prefill : 'none';
    const file = await buildTemplate({ prefill, productId: req.query.productId || undefined });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportFilename('xlsx', 'import-template')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(file);
  })
);

// Raw .xlsx bytes in the body (Content-Type: application/octet-stream or the xlsx type),
// parsed only AFTER the admin token has been verified. ?dryRun=1 validates without saving,
// ?clearEmpty=1 makes empty cells clear the stored value (default: empty cells change nothing).
router.post(
  '/records/import',
  requireAdmin,
  express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }),
  handle('Import records', async (req, res) => {
    const flag = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());
    const dryRun = flag(req.query.dryRun);
    const result = await importRecords(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), {
      dryRun,
      clearEmpty: flag(req.query.clearEmpty),
      createdBy: req.admin && req.admin.username,
    });
    const { ok, ...payload } = result;

    if (ok && !dryRun) {
      await audit.record(null, { ...audit.fromReq(req), action: 'records.import', targetType: 'import', meta: {
        rows: payload.summary.rows, updated: payload.summary.updated, unchanged: payload.summary.unchanged } });
    }

    res.set('Cache-Control', 'no-store');
    if (!ok) {
      return res.status(422).json({ status: 'invalid', message: 'يوجد أخطاء في الملف. لم يتم حفظ أي بيانات.', ...payload });
    }
    return res.json({ status: dryRun ? 'preview' : 'imported', ...payload });
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
