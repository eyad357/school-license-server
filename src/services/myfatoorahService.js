'use strict';

const crypto = require('crypto');

const MYFATOORAH_BASE_URL =
  process.env.MYFATOORAH_BASE_URL || 'https://api-eg.myfatoorah.com';

function getApiKey() {
  const key = process.env.MYFATOORAH_API_KEY;

  if (!key) {
    throw new Error('MYFATOORAH_API_KEY is not configured.');
  }

  return key;
}

function getWebhookSecret() {
  const secret = process.env.MYFATOORAH_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error('MYFATOORAH_WEBHOOK_SECRET is not configured.');
  }

  return secret;
}

async function mfRequest(path, { method = 'GET', body } = {}) {
  let response;

  try {
    response = await fetch(`${MYFATOORAH_BASE_URL}${path}`, {
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
    throw new Error(`MyFatoorah request failed: ${error.message}`);
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch (_error) {
    // fall through - payload stays null, handled below
  }

  if (!response.ok) {
    const apiMessage =
      (payload && (payload.Message || payload.message)) || 'Unknown error';

    throw new Error(
      `MyFatoorah request failed (${response.status}): ${apiMessage}`
    );
  }

  if (!payload) {
    throw new Error('MyFatoorah returned a non-JSON response.');
  }

  return payload;
}

/**
 * Creates a MyFatoorah payment (invoice) and returns its invoice id and
 * hosted payment URL.
 *
 * Callers must only ever pass amount/currency/customer fields that were
 * computed server-side (see paymentService.js) - this function has no
 * knowledge of what a "correct" price is and will happily create a payment
 * for whatever amount it is given, so the caller is the enforcement point.
 */
async function createPayment({
  amount,
  currency = 'SAR',
  customerName,
  customerEmail,
  customerReference,
  callbackUrl,
  errorUrl,
}) {
  if (!customerReference) {
    throw new Error('customerReference is required.');
  }

  const payload = await mfRequest('/v3/payments', {
    method: 'POST',
    body: {
      NotificationOption: 'LINK',
      CustomerName: customerName || undefined,
      CustomerEmail: customerEmail || undefined,
      CustomerReference: customerReference,
      InvoiceValue: amount,
      DisplayCurrencyIso: currency,
      CallBackUrl: callbackUrl,
      ErrorUrl: errorUrl,
    },
  });

  const data = payload.Data || payload;
  const invoiceId = data.InvoiceId ?? data.InvoiceID;
  const paymentUrl = data.InvoiceURL ?? data.PaymentURL;

  if (!invoiceId || !paymentUrl) {
    throw new Error(
      'MyFatoorah did not return an invoice id / payment URL.'
    );
  }

  return {
    invoiceId: String(invoiceId),
    paymentUrl: String(paymentUrl),
  };
}

/**
 * Retrieves the authoritative status of a payment directly from MyFatoorah.
 * This must be called and checked before a license is ever created - the
 * webhook payload itself is never trusted for status/amount/currency.
 */
async function getPaymentStatus(paymentId) {
  const payload = await mfRequest(
    `/v3/payments/${encodeURIComponent(paymentId)}`
  );

  const data = payload.Data || payload;
  const latestTransaction =
    (Array.isArray(data.InvoiceTransactions) &&
      data.InvoiceTransactions[data.InvoiceTransactions.length - 1]) ||
    null;

  return {
    invoiceId: data.InvoiceId != null ? String(data.InvoiceId) : null,
    paymentId:
      (latestTransaction && latestTransaction.PaymentId != null
        ? String(latestTransaction.PaymentId)
        : null) || String(paymentId),
    invoiceStatus:
      data.InvoiceStatus ||
      (latestTransaction && latestTransaction.TransactionStatus) ||
      null,
    customerReference: data.CustomerReference || null,
    amount: data.InvoiceValue != null ? Number(data.InvoiceValue) : null,
    currency: data.InvoiceDisplayCurrency || data.DisplayCurrencyIso || null,
  };
}

/**
 * Verifies the `myfatoorah-signature` header against the raw webhook body
 * using HMAC-SHA256 with the shared webhook secret, compared in constant
 * time. Returns false (never throws) on any malformed input so callers can
 * treat every failure mode as "reject the webhook".
 *
 * NOTE: confirm MyFatoorah's current V2 webhook signing spec (which fields
 * are signed / raw body vs a field subset) in your MyFatoorah dashboard
 * before go-live and adjust the digest input here if it differs - the
 * HMAC-SHA256 + constant-time-compare structure is correct regardless.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !rawBody || !rawBody.length) {
    return false;
  }

  let secret;

  try {
    secret = getWebhookSecret();
  } catch (_error) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(String(signatureHeader));

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

module.exports = {
  createPayment,
  getPaymentStatus,
  verifyWebhookSignature,
};
