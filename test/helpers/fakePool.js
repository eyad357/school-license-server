'use strict';

// A tiny in-memory stand-in for the `pg` Pool used by paymentService.js and
// adminLicenseService.js. It only understands the exact query shapes those
// two files issue - it is not a general SQL engine.
//
// FOR UPDATE row locking is emulated per-row (keyed by payment_orders.id),
// not by serializing pool.connect() itself - a real pg pool hands out
// independent physical connections, so e.g. adminLicenseService opening
// its own pool.connect() *inside* an outer payment_orders transaction
// (before that outer transaction commits) must not deadlock. Only a
// second SELECT ... FOR UPDATE on the *same order row* should block, and
// only until the holder's COMMIT/ROLLBACK.

function normalize(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function createFakePool() {
  const state = {
    products: [{ product_id: 'school-accreditation' }],
    customers: [],
    licenses: [],
    payment_orders: [],
  };

  let counter = 1;
  const nextId = (prefix) => `${prefix}_${counter++}`;

  // orderId -> tail promise of the lock queue for that row.
  const rowLockQueues = new Map();

  function findOrder(field, value) {
    return state.payment_orders.find((o) => o[field] === value) || null;
  }

  function runNonTransactionalQuery(sql, params = []) {
    return runQuery(sql, params, { acquireLock: null, heldLocks: null });
  }

  async function runQuery(sql, params, ctx) {
    const s = normalize(sql);

    if (s.startsWith('INSERT INTO payment_orders')) {
      const [
        reference,
        name,
        email,
        amount,
        currency,
        duration,
        plan,
        maxDevices,
        productId,
      ] = params;

      const row = {
        id: nextId('order'),
        provider: 'paddle',
        customer_reference: reference,
        customer_name: name,
        customer_email: email,
        amount,
        currency,
        duration,
        plan,
        max_devices: maxDevices,
        product_id: productId,
        status: 'pending',
        provider_invoice_id: null,
        provider_payment_id: null,
        license_id: null,
      };

      state.payment_orders.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (
      s.startsWith("UPDATE payment_orders SET status = 'failed', updated_at")
    ) {
      const [orderId] = params;
      const row = findOrder('id', orderId);
      if (row) row.status = 'failed';
      return { rowCount: row ? 1 : 0 };
    }

    if (s.startsWith('UPDATE payment_orders SET provider_invoice_id')) {
      const [orderId, transactionId, amount, currency] = params;
      const row = findOrder('id', orderId);
      if (row) {
        row.provider_invoice_id = transactionId;
        row.amount = amount;
        row.currency = currency;
      }
      return { rowCount: row ? 1 : 0 };
    }

    if (
      s.startsWith(
        'SELECT * FROM payment_orders WHERE provider_invoice_id = $1'
      )
    ) {
      const [invoiceId] = params;
      const row = await lockMatchingRow(
        ctx,
        (o) => o.provider_invoice_id === invoiceId
      );
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (
      s.startsWith(
        'SELECT * FROM payment_orders WHERE customer_reference = $1'
      )
    ) {
      const [reference] = params;
      const row = await lockMatchingRow(
        ctx,
        (o) => o.customer_reference === reference
      );
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (
      s.startsWith(
        "UPDATE payment_orders SET status = 'failed', provider_payment_id"
      )
    ) {
      const [orderId, paymentId] = params;
      const row = findOrder('id', orderId);
      if (row) {
        row.status = 'failed';
        row.provider_payment_id = row.provider_payment_id || paymentId;
      }
      return { rowCount: row ? 1 : 0 };
    }

    if (s.startsWith("UPDATE payment_orders SET status = 'paid'")) {
      const [orderId, paymentId, licenseId] = params;
      const row = findOrder('id', orderId);
      if (row) {
        row.status = 'paid';
        row.provider_payment_id = paymentId;
        row.license_id = licenseId;
      }
      return { rowCount: row ? 1 : 0 };
    }

    if (s.startsWith('SELECT po.id, po.status, po.license_id')) {
      const [orderId] = params;
      const row = findOrder('id', orderId);
      if (!row) return { rows: [], rowCount: 0 };
      const license = state.licenses.find((l) => l.id === row.license_id);
      return {
        rows: [
          {
            id: row.id,
            status: row.status,
            license_id: row.license_id,
            license_key: license ? license.license_key : null,
          },
        ],
        rowCount: 1,
      };
    }

    if (
      s.startsWith(
        'SELECT id FROM payment_orders WHERE provider_invoice_id = $1'
      )
    ) {
      const [invoiceId] = params;
      const row = findOrder('provider_invoice_id', invoiceId);
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }

    if (s.startsWith('INSERT INTO customers')) {
      const [name, email] = params;
      const row = { id: nextId('cust'), name, email };
      state.customers.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (
      s.startsWith('SELECT product_id FROM products WHERE product_id = $1')
    ) {
      const [productId] = params;
      const found = state.products.find((p) => p.product_id === productId);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (s.startsWith('SELECT id FROM licenses WHERE license_key = $1')) {
      const [key] = params;
      const found = state.licenses.find((l) => l.license_key === key);
      return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
    }

    if (s.startsWith('INSERT INTO licenses')) {
      const [
        licenseKey,
        productId,
        maxDevices,
        expiresAt,
        customerId,
        plan,
        licenseType,
      ] = params;

      const row = {
        id: nextId('lic'),
        license_key: licenseKey,
        product_id: productId,
        status: 'ACTIVE',
        max_devices: maxDevices,
        expires_at: expiresAt,
        customer_id: customerId,
        plan,
        license_type: licenseType,
        created_at: new Date().toISOString(),
      };

      state.licenses.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (s === 'BEGIN') {
      return { rows: [], rowCount: 0 };
    }

    if (s === 'COMMIT' || s === 'ROLLBACK') {
      if (ctx.heldLocks) {
        for (const release of ctx.heldLocks.splice(0)) release();
      }
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`fakePool: unhandled query -> ${s}`);
  }

  // Acquires the per-row lock for whichever row currently matches
  // `matchFn` (mirroring Postgres: SELECT ... FOR UPDATE finds the row,
  // then locks it), then returns a fresh snapshot of it. If this query
  // isn't running inside a transaction (ctx.acquireLock is null - i.e. a
  // plain pool.query call, not client.query), it's just a lock-free read.
  async function lockMatchingRow(ctx, matchFn) {
    const candidate = state.payment_orders.find(matchFn);
    if (!candidate) return null;

    if (ctx.acquireLock) {
      await ctx.acquireLock(candidate.id);
    }

    const row = findOrder('id', candidate.id);
    return row ? { ...row } : null;
  }

  function makeAcquireLock(heldLocks) {
    return function acquireLock(orderId) {
      let release;
      const myHold = new Promise((resolve) => {
        release = resolve;
      });

      const previousTail = rowLockQueues.get(orderId) || Promise.resolve();
      rowLockQueues.set(orderId, previousTail.then(() => myHold));

      heldLocks.push(release);
      return previousTail;
    };
  }

  async function connect() {
    const heldLocks = [];
    const ctx = { acquireLock: makeAcquireLock(heldLocks), heldLocks };

    return {
      query: (sql, params) => runQuery(sql, params, ctx),
      release: () => {
        // Safety net: if a client is released without COMMIT/ROLLBACK
        // (shouldn't happen given how paymentService.js is written),
        // don't leave any lock it took out stuck forever.
        for (const release of heldLocks.splice(0)) release();
      },
    };
  }

  return {
    state,
    query: (sql, params) => runNonTransactionalQuery(sql, params),
    connect,
  };
}

module.exports = { createFakePool };
