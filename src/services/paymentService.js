'use strict';

const crypto = require('crypto');
const pool = require('../db/pool');
const myfatoorah = require('./myfatoorahService');
const { createCustomerAndLicense } = require('./adminLicenseService');
const { PRODUCT_ID } = require('./licenseService');

// Everything the public purchase flow sells. These are constants, never
// request input - the request body may only ever contribute customer
// contact info (see paymentRoutes.js).
const CURRENCY = 'SAR';
const DURATION = 'lifetime';
const PLAN = 'pro';
const MAX_DEVICES = 1;

const SUCCESS_STATUSES = new Set(['PAID', 'SUCCESS', 'SUCCESSFUL']);
const TERMINAL_FAILURE_STATUSES = new Set([
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'CANCELED',
]);

function getLifetimePrice() {
  const raw = process.env.LIFETIME_PRICE_SAR;
  const price = Number(raw);

  if (!raw || !Number.isFinite(price) || price <= 0) {
    throw new Error('LIFETIME_PRICE_SAR is not configured correctly.');
  }

  return price;
}

function getPublicBaseUrl() {
  return (
    process.env.PUBLIC_BASE_URL ||
    'https://school-license-server-production.up.railway.app'
  );
}

function generateOrderReference() {
  return `ord_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Creates a payment order + MyFatoorah invoice for the fixed
 * lifetime/pro/1-device product. The only caller-supplied data used is the
 * customer's name/email - price, duration, plan and maxDevices are always
 * the server-side constants above.
 */
async function createOrder({ customer = {} } = {}) {
  const name = customer.name
    ? String(customer.name).trim().slice(0, 255) || null
    : null;
  const email = customer.email
    ? String(customer.email).trim().slice(0, 320) || null
    : null;

  const amount = getLifetimePrice();
  const reference = generateOrderReference();
  const baseUrl = getPublicBaseUrl();

  const insertResult = await pool.query(
    `
    INSERT INTO payment_orders (
      provider,
      customer_reference,
      customer_name,
      customer_email,
      amount,
      currency,
      duration,
      plan,
      max_devices,
      product_id,
      status
    )
    VALUES ('myfatoorah', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
    RETURNING id
    `,
    [
      reference,
      name,
      email,
      amount,
      CURRENCY,
      DURATION,
      PLAN,
      MAX_DEVICES,
      PRODUCT_ID,
    ]
  );

  const orderId = insertResult.rows[0].id;

  let invoiceId;
  let paymentUrl;

  try {
    const payment = await myfatoorah.createPayment({
      amount,
      currency: CURRENCY,
      customerName: name,
      customerEmail: email,
      customerReference: reference,
      callbackUrl: `${baseUrl}/api/v1/payments/callback`,
      errorUrl: `${baseUrl}/api/v1/payments/callback`,
    });

    invoiceId = payment.invoiceId;
    paymentUrl = payment.paymentUrl;
  } catch (error) {
    await pool.query(
      `
      UPDATE payment_orders
      SET status = 'failed', updated_at = NOW()
      WHERE id = $1
      `,
      [orderId]
    );

    throw error;
  }

  await pool.query(
    `
    UPDATE payment_orders
    SET provider_invoice_id = $2, updated_at = NOW()
    WHERE id = $1
    `,
    [orderId, invoiceId]
  );

  return { orderId, paymentUrl };
}

async function lockOrderByInvoiceId(client, invoiceId) {
  const result = await client.query(
    `
    SELECT *
    FROM payment_orders
    WHERE provider_invoice_id = $1
    FOR UPDATE
    `,
    [invoiceId]
  );

  return result.rows[0] || null;
}

async function lockOrderByReference(client, reference) {
  const result = await client.query(
    `
    SELECT *
    FROM payment_orders
    WHERE customer_reference = $1
    FOR UPDATE
    `,
    [reference]
  );

  return result.rows[0] || null;
}

/**
 * Confirms a payment with MyFatoorah and, on first confirmation only,
 * creates the license. Safe to call repeatedly with the same paymentId -
 * webhook retries, duplicate webhook deliveries, and two concurrent
 * requests for the same payment all converge on exactly one license.
 *
 * The row-level `FOR UPDATE` lock on the order is what makes concurrent
 * calls safe: the second caller blocks until the first transaction commits,
 * then observes status = 'paid' and returns without creating anything.
 */
async function processWebhookPayment(paymentId) {
  // Ask MyFatoorah directly - never trust the webhook payload's own
  // amount/currency/status fields.
  const status = await myfatoorah.getPaymentStatus(paymentId);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let order = null;

    if (status.invoiceId) {
      order = await lockOrderByInvoiceId(client, status.invoiceId);
    }

    if (!order && status.customerReference) {
      order = await lockOrderByReference(client, status.customerReference);
    }

    if (!order) {
      await client.query('ROLLBACK');
      return { handled: false, reason: 'order_not_found' };
    }

    // Idempotent no-op: this order was already finalized by an earlier
    // webhook delivery.
    if (order.status === 'paid' || order.status === 'failed') {
      await client.query('COMMIT');
      return {
        handled: true,
        orderId: order.id,
        status: order.status,
        licenseId: order.license_id,
        alreadyProcessed: true,
      };
    }

    const invoiceStatus = String(status.invoiceStatus || '').toUpperCase();

    if (!SUCCESS_STATUSES.has(invoiceStatus)) {
      if (TERMINAL_FAILURE_STATUSES.has(invoiceStatus)) {
        await client.query(
          `
          UPDATE payment_orders
          SET status = 'failed',
              provider_payment_id = COALESCE($2, provider_payment_id),
              updated_at = NOW()
          WHERE id = $1
          `,
          [order.id, status.paymentId]
        );

        await client.query('COMMIT');
        return { handled: true, orderId: order.id, status: 'failed' };
      }

      // Still pending (or an unrecognized in-progress state) - leave as is
      // and wait for a future webhook delivery.
      await client.query('COMMIT');
      return { handled: true, orderId: order.id, status: 'pending' };
    }

    // Confirm the amount/currency MyFatoorah reports match what we quoted
    // at order-creation time. Never trust the webhook payload for these.
    const amountMatches =
      status.amount == null || Number(status.amount) === Number(order.amount);
    const currencyMatches =
      !status.currency ||
      status.currency.toUpperCase() === String(order.currency).toUpperCase();

    if (!amountMatches || !currencyMatches) {
      await client.query(
        `
        UPDATE payment_orders
        SET status = 'failed',
            provider_payment_id = COALESCE($2, provider_payment_id),
            updated_at = NOW()
        WHERE id = $1
        `,
        [order.id, status.paymentId]
      );

      await client.query('COMMIT');
      return {
        handled: true,
        orderId: order.id,
        status: 'failed',
        reason: 'amount_mismatch',
      };
    }

    // Use the existing, single license generator - never a second one -
    // with only the server-side values recorded on the order.
    const { license } = await createCustomerAndLicense({
      customer: { name: order.customer_name, email: order.customer_email },
      productId: order.product_id,
      maxDevices: order.max_devices,
      duration: order.duration,
      plan: order.plan,
    });

    await client.query(
      `
      UPDATE payment_orders
      SET status = 'paid',
          provider_payment_id = $2,
          license_id = $3,
          updated_at = NOW()
      WHERE id = $1
      `,
      [order.id, status.paymentId, license.id]
    );

    await client.query('COMMIT');

    return {
      handled: true,
      orderId: order.id,
      status: 'paid',
      licenseId: license.id,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getOrderStatus(orderId) {
  const result = await pool.query(
    `
    SELECT
      po.id,
      po.status,
      po.license_id,
      l.license_key
    FROM payment_orders po
    LEFT JOIN licenses l ON l.id = po.license_id
    WHERE po.id = $1
    `,
    [orderId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];

  return {
    orderId: row.id,
    status: row.status,
    licenseKey: row.status === 'paid' ? row.license_key : undefined,
  };
}

/**
 * Used by the public callback page only. Looks the order up via MyFatoorah
 * (by paymentId) purely to find which of OUR orders this is, then returns
 * OUR database's own status - the callback never creates a license and
 * never trusts MyFatoorah's response as proof of payment.
 */
async function findOrderForCallback(paymentId) {
  const status = await myfatoorah.getPaymentStatus(paymentId);

  let orderId = null;

  if (status.invoiceId) {
    const result = await pool.query(
      `SELECT id FROM payment_orders WHERE provider_invoice_id = $1`,
      [status.invoiceId]
    );
    orderId = result.rows[0] ? result.rows[0].id : null;
  }

  if (!orderId && status.customerReference) {
    const result = await pool.query(
      `SELECT id FROM payment_orders WHERE customer_reference = $1`,
      [status.customerReference]
    );
    orderId = result.rows[0] ? result.rows[0].id : null;
  }

  if (!orderId) {
    return null;
  }

  return getOrderStatus(orderId);
}

module.exports = {
  createOrder,
  processWebhookPayment,
  getOrderStatus,
  findOrderForCallback,
  // exported for tests
  getLifetimePrice,
};
