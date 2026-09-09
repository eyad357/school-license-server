'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PADDLE_API_KEY = 'test_api_key';
process.env.PADDLE_WEBHOOK_SECRET = 'test_webhook_secret';
process.env.PADDLE_PRICE_ID = 'pri_01m21s81t3xgv765ngsemfrrgr';

const { createFakePool } = require('./helpers/fakePool');

const pool = require('../src/db/pool');
const fakePool = createFakePool();
pool.query = fakePool.query;
pool.connect = fakePool.connect;

const paddleService = require('../src/services/paddleService');
const paymentService = require('../src/services/paymentService');

const CONFIGURED_PRICE_ID = process.env.PADDLE_PRICE_ID;

function mockPaddleTransactionCreation({ transactionId = 'txn_new' } = {}) {
  const original = paddleService.createTransaction;
  paddleService.createTransaction = async (args) => {
    // Sanity-check every call: only customer/order-reference fields are
    // ever passed in by paymentService.createOrder - price/quantity are
    // never parameters of this function at all.
    assert.equal(Object.keys(args).sort().join(','), 'customerEmail,customerName,orderReference');
    return {
      transactionId,
      checkoutUrl: `https://checkout.paddle.com/pay/${transactionId}`,
      amount: 5,
      currency: 'USD',
    };
  };
  return () => {
    paddleService.createTransaction = original;
  };
}

function mockPaddleStatus(statusResponse) {
  const original = paddleService.getTransactionStatus;
  paddleService.getTransactionStatus = async () => statusResponse;
  return () => {
    paddleService.getTransactionStatus = original;
  };
}

test('createOrder always uses the fixed lifetime/pro/1-device product regardless of caller input', async () => {
  const restore = mockPaddleTransactionCreation({ transactionId: 'txn_fixed_product' });
  try {
    const { orderId, paymentUrl } = await paymentService.createOrder({
      customer: { name: 'Eyad', email: 'eyad@example.com' },
    });

    const row = fakePool.state.payment_orders.find((o) => o.id === orderId);

    assert.equal(row.duration, 'lifetime');
    assert.equal(row.plan, 'pro');
    assert.equal(row.max_devices, 1);
    assert.equal(row.product_id, 'school-accreditation');
    assert.equal(row.provider, 'paddle');
    assert.equal(row.provider_invoice_id, 'txn_fixed_product');
    assert.equal(paymentUrl, 'https://checkout.paddle.com/pay/txn_fixed_product');
  } finally {
    restore();
  }
});

test('a completed transaction matching the configured price+quantity creates exactly one license', async () => {
  const restoreCreate = mockPaddleTransactionCreation({ transactionId: 'txn_success_1' });
  const { orderId } = await paymentService.createOrder({ customer: {} });
  restoreCreate();

  const restoreStatus = mockPaddleStatus({
    transactionId: 'txn_success_1',
    status: 'completed',
    orderReference: null,
    priceIds: [CONFIGURED_PRICE_ID],
    itemCount: 1,
    totalQuantity: 1,
  });

  let result;
  try {
    result = await paymentService.processWebhookPayment('txn_success_1');
  } finally {
    restoreStatus();
  }

  assert.equal(result.status, 'paid');
  assert.ok(result.licenseId);

  const status = await paymentService.getOrderStatus(orderId);
  assert.equal(status.status, 'paid');
  assert.match(status.licenseKey, /^SCHL-/);

  const license = fakePool.state.licenses.find((l) => l.id === result.licenseId);
  assert.equal(license.plan, 'pro');
  assert.equal(license.license_type, 'perpetual');
  assert.equal(license.max_devices, 1);
  assert.equal(license.expires_at, null);
});

test('an uncompleted transaction (ready) creates no license and leaves the order pending', async () => {
  const restoreCreate = mockPaddleTransactionCreation({ transactionId: 'txn_pending_1' });
  const { orderId } = await paymentService.createOrder({ customer: {} });
  restoreCreate();

  const restoreStatus = mockPaddleStatus({
    transactionId: 'txn_pending_1',
    status: 'ready',
    orderReference: null,
    priceIds: [CONFIGURED_PRICE_ID],
    itemCount: 1,
    totalQuantity: 1,
  });

  let result;
  try {
    result = await paymentService.processWebhookPayment('txn_pending_1');
  } finally {
    restoreStatus();
  }

  assert.equal(result.status, 'pending');
  const status = await paymentService.getOrderStatus(orderId);
  assert.equal(status.status, 'pending');
  assert.equal(status.licenseKey, undefined);
});

test('a canceled transaction marks the order failed, no license', async () => {
  const restoreCreate = mockPaddleTransactionCreation({ transactionId: 'txn_canceled_1' });
  const { orderId } = await paymentService.createOrder({ customer: {} });
  restoreCreate();

  const restoreStatus = mockPaddleStatus({
    transactionId: 'txn_canceled_1',
    status: 'canceled',
    orderReference: null,
    priceIds: [CONFIGURED_PRICE_ID],
    itemCount: 1,
    totalQuantity: 1,
  });

  let result;
  try {
    result = await paymentService.processWebhookPayment('txn_canceled_1');
  } finally {
    restoreStatus();
  }

  assert.equal(result.status, 'failed');
  const status = await paymentService.getOrderStatus(orderId);
  assert.equal(status.status, 'failed');
  assert.equal(status.licenseKey, undefined);
});

test('a completed transaction for the wrong price id is rejected, no license', async () => {
  const restoreCreate = mockPaddleTransactionCreation({ transactionId: 'txn_wrong_price' });
  await paymentService.createOrder({ customer: {} });
  restoreCreate();

  const licensesBefore = fakePool.state.licenses.length;

  const restoreStatus = mockPaddleStatus({
    transactionId: 'txn_wrong_price',
    status: 'completed',
    orderReference: null,
    priceIds: ['pri_some_other_price'],
    itemCount: 1,
    totalQuantity: 1,
  });

  let result;
  try {
    result = await paymentService.processWebhookPayment('txn_wrong_price');
  } finally {
    restoreStatus();
  }

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'price_mismatch');
  assert.equal(fakePool.state.licenses.length, licensesBefore);
});

test('a completed transaction with quantity != 1 is rejected, no license', async () => {
  const restoreCreate = mockPaddleTransactionCreation({ transactionId: 'txn_wrong_qty' });
  await paymentService.createOrder({ customer: {} });
  restoreCreate();

  const licensesBefore = fakePool.state.licenses.length;

  const restoreStatus = mockPaddleStatus({
    transactionId: 'txn_wrong_qty',
    status: 'completed',
    orderReference: null,
    priceIds: [CONFIGURED_PRICE_ID],
    itemCount: 1,
    totalQuantity: 3,
  });

  let result;
  try {
    result = await paymentService.processWebhookPayment('txn_wrong_qty');
  } finally {
    restoreStatus();
  }

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'price_mismatch');
  assert.equal(fakePool.state.licenses.length, licensesBefore);
});

test('duplicate webhook delivery for the same transaction creates only one license', async () => {
  const restoreCreate = mockPaddleTransactionCreation({ transactionId: 'txn_dup_1' });
  const { orderId } = await paymentService.createOrder({ customer: {} });
  restoreCreate();

  const restoreStatus = mockPaddleStatus({
    transactionId: 'txn_dup_1',
    status: 'completed',
    orderReference: null,
    priceIds: [CONFIGURED_PRICE_ID],
    itemCount: 1,
    totalQuantity: 1,
  });

  try {
    const first = await paymentService.processWebhookPayment('txn_dup_1');
    const second = await paymentService.processWebhookPayment('txn_dup_1');

    assert.equal(first.status, 'paid');
    assert.equal(second.status, 'paid');
    assert.equal(second.alreadyProcessed, true);
    assert.equal(first.licenseId, second.licenseId);
  } finally {
    restoreStatus();
  }

  const licensesForOrder = fakePool.state.licenses.filter(
    (l) => l.id === fakePool.state.payment_orders.find((o) => o.id === orderId).license_id
  );
  assert.equal(licensesForOrder.length, 1);
});

test('concurrent duplicate webhook deliveries for the same transaction still create only one license', async () => {
  const restoreCreate = mockPaddleTransactionCreation({ transactionId: 'txn_concurrent_1' });
  const { orderId } = await paymentService.createOrder({ customer: {} });
  restoreCreate();

  const restoreStatus = mockPaddleStatus({
    transactionId: 'txn_concurrent_1',
    status: 'completed',
    orderReference: null,
    priceIds: [CONFIGURED_PRICE_ID],
    itemCount: 1,
    totalQuantity: 1,
  });

  let results;
  try {
    results = await Promise.all([
      paymentService.processWebhookPayment('txn_concurrent_1'),
      paymentService.processWebhookPayment('txn_concurrent_1'),
    ]);
  } finally {
    restoreStatus();
  }

  const licenseIds = new Set(results.map((r) => r.licenseId));
  assert.equal(licenseIds.size, 1);

  const order = fakePool.state.payment_orders.find((o) => o.id === orderId);
  const licensesForOrder = fakePool.state.licenses.filter(
    (l) => l.id === order.license_id
  );
  assert.equal(licensesForOrder.length, 1);
});

test('order-status only returns a license key once the order is paid, and never leaks secrets', async () => {
  const restoreCreate = mockPaddleTransactionCreation({ transactionId: 'txn_status_1' });
  const { orderId } = await paymentService.createOrder({ customer: {} });
  restoreCreate();

  const pendingStatus = await paymentService.getOrderStatus(orderId);
  assert.equal(pendingStatus.status, 'pending');
  assert.equal(pendingStatus.licenseKey, undefined);

  const restoreStatus = mockPaddleStatus({
    transactionId: 'txn_status_1',
    status: 'completed',
    orderReference: null,
    priceIds: [CONFIGURED_PRICE_ID],
    itemCount: 1,
    totalQuantity: 1,
  });
  try {
    await paymentService.processWebhookPayment('txn_status_1');
  } finally {
    restoreStatus();
  }

  const paidStatus = await paymentService.getOrderStatus(orderId);
  assert.equal(paidStatus.status, 'paid');
  assert.match(paidStatus.licenseKey, /^SCHL-/);

  const serialized = JSON.stringify(paidStatus).toLowerCase();
  assert.doesNotMatch(serialized, /apikey|api_key|secret|password/);
});

test('findOrderForCallback never creates a license and only reflects the DB status', async () => {
  const restoreCreate = mockPaddleTransactionCreation({ transactionId: 'txn_callback_1' });
  await paymentService.createOrder({ customer: {} });
  restoreCreate();

  const licensesBefore = fakePool.state.licenses.length;

  const beforePayment = await paymentService.findOrderForCallback('txn_callback_1');
  assert.equal(beforePayment.status, 'pending');
  assert.equal(fakePool.state.licenses.length, licensesBefore);
});
