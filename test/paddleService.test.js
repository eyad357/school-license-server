'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.PADDLE_API_KEY = 'test_api_key';
process.env.PADDLE_WEBHOOK_SECRET = 'test_webhook_secret';
process.env.PADDLE_PRICE_ID = 'pri_01m21s81t3xgv765ngsemfrrgr';

const paddle = require('../src/services/paddleService');

function sign(rawBody, ts, secret) {
  const h1 = crypto
    .createHmac('sha256', secret)
    .update(`${ts}:${rawBody}`)
    .digest('hex');
  return `ts=${ts};h1=${h1}`;
}

test('verifyWebhookSignature accepts a correctly signed body', () => {
  const rawBody = Buffer.from(JSON.stringify({ event_type: 'transaction.completed' }));
  const ts = Math.floor(Date.now() / 1000);
  const header = sign(rawBody.toString('utf8'), ts, process.env.PADDLE_WEBHOOK_SECRET);

  assert.equal(paddle.verifyWebhookSignature(rawBody, header), true);
});

test('verifyWebhookSignature rejects a tampered body', () => {
  const rawBody = Buffer.from(JSON.stringify({ event_type: 'transaction.completed' }));
  const ts = Math.floor(Date.now() / 1000);
  const header = sign(rawBody.toString('utf8'), ts, process.env.PADDLE_WEBHOOK_SECRET);

  const tamperedBody = Buffer.from(JSON.stringify({ event_type: 'transaction.paid' }));

  assert.equal(paddle.verifyWebhookSignature(tamperedBody, header), false);
});

test('verifyWebhookSignature rejects wrong secret', () => {
  const rawBody = Buffer.from(JSON.stringify({ event_type: 'transaction.completed' }));
  const ts = Math.floor(Date.now() / 1000);
  const header = sign(rawBody.toString('utf8'), ts, 'not-the-real-secret');

  assert.equal(paddle.verifyWebhookSignature(rawBody, header), false);
});

test('verifyWebhookSignature rejects malformed / missing header', () => {
  const rawBody = Buffer.from('{}');

  assert.equal(paddle.verifyWebhookSignature(rawBody, undefined), false);
  assert.equal(paddle.verifyWebhookSignature(rawBody, ''), false);
  assert.equal(paddle.verifyWebhookSignature(rawBody, 'not-a-valid-header'), false);
  assert.equal(paddle.verifyWebhookSignature(rawBody, 'ts=123;h1='), false);
  assert.equal(paddle.verifyWebhookSignature(Buffer.alloc(0), 'ts=123;h1=abcd'), false);
});

test('createTransaction always sends the configured price id and quantity 1, regardless of what is passed in', async (t) => {
  let capturedUrl;
  let capturedBody;

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);

    return {
      ok: true,
      json: async () => ({
        data: {
          id: 'txn_123',
          checkout: { url: 'https://checkout.paddle.com/pay/txn_123' },
          currency_code: 'USD',
          details: { totals: { total: '500' } },
        },
      }),
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await paddle.createTransaction({
    customerName: 'Eyad',
    customerEmail: 'eyad@example.com',
    orderReference: 'ord_abc123',
    // Even if a caller tried to smuggle these in, createTransaction's
    // signature doesn't accept them, so there's nothing to strip - this
    // just documents that extra fields are inert.
    priceId: 'pri_attacker_supplied',
    quantity: 99,
  });

  assert.equal(capturedUrl, 'https://api.paddle.com/transactions');
  assert.equal(capturedBody.items.length, 1);
  assert.equal(capturedBody.items[0].price_id, process.env.PADDLE_PRICE_ID);
  assert.equal(capturedBody.items[0].quantity, 1);
  assert.equal(capturedBody.collection_mode, 'automatic');
  assert.equal(capturedBody.custom_data.order_reference, 'ord_abc123');

  assert.equal(result.transactionId, 'txn_123');
  assert.equal(result.checkoutUrl, 'https://checkout.paddle.com/pay/txn_123');
  assert.equal(result.amount, 5);
  assert.equal(result.currency, 'USD');
});

test('createTransaction throws if Paddle omits checkout.url (no default payment link configured)', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { id: 'txn_456' } }),
  });
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(
    () =>
      paddle.createTransaction({
        orderReference: 'ord_xyz',
      }),
    /checkout URL/
  );
});

test('getTransactionStatus reports price ids, quantity, status and order reference from Paddle, not the caller', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.equal(url, 'https://api.paddle.com/transactions/txn_789');
    return {
      ok: true,
      json: async () => ({
        data: {
          id: 'txn_789',
          status: 'Completed',
          custom_data: { order_reference: 'ord_ref_1' },
          items: [{ price_id: process.env.PADDLE_PRICE_ID, quantity: 1 }],
        },
      }),
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const status = await paddle.getTransactionStatus('txn_789');

  assert.equal(status.status, 'completed');
  assert.deepEqual(status.priceIds, [process.env.PADDLE_PRICE_ID]);
  assert.equal(status.totalQuantity, 1);
  assert.equal(status.itemCount, 1);
  assert.equal(status.orderReference, 'ord_ref_1');
});
