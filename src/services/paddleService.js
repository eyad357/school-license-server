'use strict';

const crypto = require('crypto');

const PADDLE_BASE_URL =
  process.env.PADDLE_API_BASE_URL || 'https://api.paddle.com';

// Paddle-Signature header format: "ts=<unix_timestamp>;h1=<hex hmac>".
const SIGNATURE_HEADER_RE = /^ts=(\d+);h1=([a-f0-9]+)$/i;

function getApiKey() {
  const key = process.env.PADDLE_API_KEY;

  if (!key) {
    throw new Error('PADDLE_API_KEY is not configured.');
  }

  return key;
}

function getWebhookSecret() {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error('PADDLE_WEBHOOK_SECRET is not configured.');
  }

  return secret;
}

/**
 * The ONE price this server will ever sell through the public purchase
 * flow. Never caller-controlled - always read from the environment.
 */
function getPriceId() {
  const priceId = process.env.PADDLE_PRICE_ID;

  if (!priceId) {
    throw new Error('PADDLE_PRICE_ID is not configured.');
  }

  return priceId;
}

async function paddleRequest(path, { method = 'GET', body } = {}) {
  let response;

  try {
    response = await fetch(`${PADDLE_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    // Never include headers/body (which carry the API key) in the thrown
    // error or in any log line.
    throw new Error(`Paddle request failed: ${error.message}`);
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch (_error) {
    // fall through - payload stays null, handled below
  }

  if (!response.ok) {
    const apiMessage =
      (payload && payload.error && (payload.error.detail || payload.error.code)) ||
      'Unknown error';

    throw new Error(`Paddle request failed (${response.status}): ${apiMessage}`);
  }

  if (!payload) {
    throw new Error('Paddle returned a non-JSON response.');
  }

  return payload;
}

function extractAmountAndCurrency(data) {
  const currency = data.currency_code || null;
  const totals = data.details && data.details.totals;

  let amount = null;

  if (totals && totals.total != null) {
    const rawTotal = Number(totals.total);

    // Paddle reports totals in the currency's lowest denomination (e.g.
    // cents for USD). This is informational only - never used to enforce
    // anything, so a parsing miss here just falls back to null.
    if (Number.isFinite(rawTotal)) {
      amount = rawTotal / 100;
    }
  }

  return { amount, currency };
}

/**
 * Creates a Paddle transaction for exactly the configured price
 * (PADDLE_PRICE_ID, quantity 1, automatic collection) and returns its
 * transaction id + hosted checkout URL.
 *
 * Callers must only ever pass customer contact info and our own order
 * reference (see paymentService.js) - the price/priceId/quantity are never
 * caller-controlled; this function always uses the server-side configured
 * price and quantity 1.
 */
async function createTransaction({
  customerName,
  customerEmail,
  orderReference,
} = {}) {
  if (!orderReference) {
    throw new Error('orderReference is required.');
  }

  const priceId = getPriceId();

  const body = {
    items: [{ price_id: priceId, quantity: 1 }],
    collection_mode: 'automatic',
    custom_data: { order_reference: orderReference },
  };

  if (customerEmail) {
    body.customer = {
      email: customerEmail,
      name: customerName || undefined,
    };
  }

  const payload = await paddleRequest('/transactions', {
    method: 'POST',
    body,
  });

  const data = payload.data || payload;
  const transactionId = data.id;
  const checkoutUrl = data.checkout && data.checkout.url;

  if (!transactionId || !checkoutUrl) {
    throw new Error(
      'Paddle did not return a transaction id / checkout URL. Make sure a ' +
        'default payment link is configured for this Paddle account ' +
        '(required for automatically-collected transactions to include ' +
        'checkout.url).'
    );
  }

  const { amount, currency } = extractAmountAndCurrency(data);

  return {
    transactionId: String(transactionId),
    checkoutUrl: String(checkoutUrl),
    amount,
    currency,
  };
}

/**
 * Retrieves the authoritative status of a transaction directly from
 * Paddle. This must be called and checked before a license is ever
 * created - the webhook payload itself is never trusted for
 * status/price/quantity.
 */
async function getTransactionStatus(transactionId) {
  const payload = await paddleRequest(
    `/transactions/${encodeURIComponent(transactionId)}`
  );

  const data = payload.data || payload;
  const items = Array.isArray(data.items) ? data.items : [];

  // Paddle may echo back either `price_id` directly or a nested
  // `price.id`, depending on API version / `include` params.
  const priceIds = items
    .map((item) => item.price_id || (item.price && item.price.id))
    .filter(Boolean);

  const totalQuantity = items.reduce((sum, item) => {
    const qty = Number(item.quantity);
    return sum + (Number.isFinite(qty) ? qty : 0);
  }, 0);

  return {
    transactionId: data.id != null ? String(data.id) : String(transactionId),
    status: data.status ? String(data.status).toLowerCase() : null,
    orderReference:
      (data.custom_data && data.custom_data.order_reference) || null,
    priceIds,
    itemCount: items.length,
    totalQuantity,
  };
}

/**
 * Verifies the `Paddle-Signature` header (`ts=<unix>;h1=<hex hmac>`)
 * against the raw webhook body. The signed payload is `${ts}:${rawBody}`,
 * HMAC-SHA256, compared in constant time. Returns false (never throws) on
 * any malformed input so callers can treat every failure mode as "reject
 * the webhook".
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !rawBody || !rawBody.length) {
    return false;
  }

  const match = SIGNATURE_HEADER_RE.exec(String(signatureHeader).trim());

  if (!match) {
    return false;
  }

  const [, ts, h1] = match;

  let secret;

  try {
    secret = getWebhookSecret();
  } catch (_error) {
    return false;
  }

  const signedPayload = `${ts}:${rawBody.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  const expectedBuf = Buffer.from(expected.toLowerCase(), 'utf8');
  const providedBuf = Buffer.from(h1.toLowerCase(), 'utf8');

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

module.exports = {
  createTransaction,
  getTransactionStatus,
  verifyWebhookSignature,
  getPriceId,
};
