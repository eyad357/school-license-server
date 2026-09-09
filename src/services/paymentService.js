'use strict';

const crypto = require('crypto');
const pool = require('../db/pool');
const paddle = require('./paddleService');
const { createCustomerAndLicense } = require('./adminLicenseService');
const { PRODUCT_ID } = require('./licenseService');

// Everything the public purchase flow sells. These are constants, never
// request input - the request body may only ever contribute customer
// contact info (see paymentRoutes.js). The Paddle price itself (which
// already encodes the $ amount) is configured server-side via
// PADDLE_PRICE_ID and is never overridable by the client either.
const DURATION = 'lifetime';
const PLAN = 'pro';
const MAX_DEVICES = 1;
const DEFAULT_CURRENCY = 'USD';

// Paddle transaction statuses. `completed`/`paid` mean the payment went
// through; `canceled`/`past_due` are terminal failures; everything else
// (draft, ready, billed, ...) is still in progress and waits for a future
// webhook delivery.
const SUCCESS_STATUSES = new Set(['completed', 'paid']);
const TERMINAL_FAILURE_STATUSES = new Set(['canceled', 'past_due']);

function generateOrderReference() {
  return `ord_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Creates a payment order + Paddle transaction for the fixed
 * lifetime/pro/1-device product. The only caller-supplied data used is the
 * customer's name/email - duration, plan and maxDevices are always the
 * server-side constants above, and the Paddle price is always
 * PADDLE_PRICE_ID (enforced inside paddleService.createTransaction, which
 * takes no price argument at all).
 */
async function createOrder({ customer = {} } = {}) {
  const name = customer.name
    ? String(customer.name).trim().slice(0, 255) || null
    : null;
  const email = customer.email
    ? String(customer.email).trim().slice(0, 320) || null
    : null;

  const reference = generateOrderReference();

  // Fail fast, before touching the DB, if Paddle isn't configured.
  paddle.getPriceId();

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
    VALUES ('paddle', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
    RETURNING id
    `,
    [
      reference,
      name,
      email,
      0,
      DEFAULT_CURRENCY,
      DURATION,
      PLAN,
      MAX_DEVICES,
      PRODUCT_ID,
    ]
  );

  const orderId = insertResult.rows[0].id;

  let transactionId;
  let paymentUrl;
  let amount = 0;
  let currency = DEFAULT_CURRENCY;

  try {
    const transaction = await paddle.createTransaction({
      customerName: name,
      customerEmail: email,
      orderReference: reference,
    });

    transactionId = transaction.transactionId;
    paymentUrl = transaction.checkoutUrl;

    if (transaction.amount != null) {
      amount = transaction.amount;
    }

    if (transaction.currency) {
      currency = transaction.currency;
    }
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
    SET provider_invoice_id = $2,
        amount = $3,
        currency = $4,
        updated_at = NOW()
    WHERE id = $1
    `,
    [orderId, transactionId, amount, currency]
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
 * Confirms a payment with Paddle and, on first confirmation only, creates
 * the license. Safe to call repeatedly with the same transactionId -
 * webhook retries, duplicate webhook deliveries, and two concurrent
 * requests for the same transaction all converge on exactly one license.
 *
 * The row-level `FOR UPDATE` lock on the order is what makes concurrent
 * calls safe: the second caller blocks until the first transaction
 * commits, then observes status = 'paid' and returns without creating
 * anything.
 */
async function processWebhookPayment(transactionId) {
  // Ask Paddle directly - never trust the webhook payload's own
  // status/price/quantity fields.
  const status = await paddle.getTransactionStatus(transactionId);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let order = await lockOrderByInvoiceId(client, status.transactionId);

    if (!order && status.orderReference) {
      order = await lockOrderByReference(client, status.orderReference);
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

    if (!SUCCESS_STATUSES.has(status.status)) {
      if (TERMINAL_FAILURE_STATUSES.has(status.status)) {
        await client.query(
          `
          UPDATE payment_orders
          SET status = 'failed',
              provider_payment_id = COALESCE($2, provider_payment_id),
              updated_at = NOW()
          WHERE id = $1
          `,
          [order.id, status.transactionId]
        );

        await client.query('COMMIT');
        return { handled: true, orderId: order.id, status: 'failed' };
      }

      // Still draft/ready/billed/pending (or an unrecognized in-progress
      // state) - leave as is and wait for a future webhook delivery.
      await client.query('COMMIT');
      return { handled: true, orderId: order.id, status: 'pending' };
    }

    // Confirm this transaction is exactly the one configured Paddle price,
    // quantity 1 - never trust the webhook payload for this, and never
    // trust anything the client might have submitted at order-creation
    // time either (nothing price-related was ever accepted from it).
    const configuredPriceId = paddle.getPriceId();
    const priceMatches =
      status.itemCount === 1 && status.priceIds[0] === configuredPriceId;
    const quantityMatches = status.totalQuantity === 1;

    if (!priceMatches || !quantityMatches) {
      await client.query(
        `
        UPDATE payment_orders
        SET status = 'failed',
            provider_payment_id = COALESCE($2, provider_payment_id),
            updated_at = NOW()
        WHERE id = $1
        `,
        [order.id, status.transactionId]
      );

      await client.query('COMMIT');
      return {
        handled: true,
        orderId: order.id,
        status: 'failed',
        reason: 'price_mismatch',
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
      [order.id, status.transactionId, license.id]
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
 * Used by the public callback page only. The Paddle transaction id was
 * already stored as `provider_invoice_id` when the order was created, so
 * this is a plain local lookup - no Paddle API call, and definitely no
 * license creation. The callback never creates a license and never trusts
 * the redirect alone as proof of payment; the webhook + server-side
 * verification in processWebhookPayment is the source of truth.
 */
async function findOrderForCallback(transactionId) {
  const result = await pool.query(
    `SELECT id FROM payment_orders WHERE provider_invoice_id = $1`,
    [transactionId]
  );

  const orderId = result.rows[0] ? result.rows[0].id : null;

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
};
