'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const {
  createOrder,
  getOrderStatus,
  processWebhookPayment,
  findOrderForCallback,
} = require('../services/paymentService');
const { verifyWebhookSignature } = require('../services/myfatoorahService');

const router = express.Router();

// Narrower than the global /api/ limiter - this endpoint has no auth at
// all, so it needs its own tighter cap against abuse.
const createLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'rate_limited',
    message: 'Too many requests. Please try again later.',
  },
});

router.post('/create', createLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const customer =
      body.customer && typeof body.customer === 'object' ? body.customer : {};

    // Only customer.name / customer.email are ever read from the request.
    // price / duration / plan / maxDevices / licenseType / expiresAt are
    // never read from req.body anywhere in this handler - they are fixed
    // server-side constants inside paymentService.createOrder.
    const { orderId, paymentUrl } = await createOrder({
      customer: {
        name: typeof customer.name === 'string' ? customer.name : undefined,
        email:
          typeof customer.email === 'string' ? customer.email : undefined,
      },
    });

    return res.status(201).json({
      status: 'ok',
      orderId,
      paymentUrl,
    });
  } catch (error) {
    console.error('Payment creation error:', error.message);

    return res.status(500).json({
      status: 'server_error',
      message: 'Unable to start payment. Please try again later.',
    });
  }
});

router.post('/myfatoorah/webhook', async (req, res) => {
  try {
    const signatureHeader = req.headers['myfatoorah-signature'];
    const rawBody = req.rawBody;

    if (!verifyWebhookSignature(rawBody, signatureHeader)) {
      console.error('Payment webhook rejected: invalid signature.');
      return res.status(401).json({ status: 'unauthorized' });
    }

    const event = req.body || {};

    const paymentId =
      (event.Data && (event.Data.PaymentId ?? event.Data.paymentId)) ??
      event.PaymentId ??
      event.paymentId;

    if (!paymentId) {
      // Nothing actionable in this event (e.g. a different EventType) -
      // acknowledge so MyFatoorah doesn't keep retrying it.
      return res.status(200).json({ status: 'ignored' });
    }

    const result = await processWebhookPayment(String(paymentId));

    return res.status(200).json({ status: 'ok', ...result });
  } catch (error) {
    console.error('Payment webhook error:', error.message);

    // Generic response only - this is a public endpoint.
    return res.status(500).json({ status: 'server_error' });
  }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const order = await getOrderStatus(req.params.id);

    if (!order) {
      return res.status(404).json({ status: 'not_found' });
    }

    return res.json({
      status: 'ok',
      orderId: order.orderId,
      paymentStatus: order.status,
      licenseKey: order.licenseKey,
    });
  } catch (error) {
    console.error('Order status error:', error.message);

    return res.status(500).json({ status: 'server_error' });
  }
});

router.get('/callback', async (req, res) => {
  const paymentId = req.query.paymentId || req.query.PaymentId;

  res.set('Content-Type', 'text/html; charset=utf-8');

  if (!paymentId) {
    return res.status(200).send(renderCallbackPage('pending', null));
  }

  try {
    const order = await findOrderForCallback(String(paymentId));

    if (!order) {
      return res.status(200).send(renderCallbackPage('pending', null));
    }

    return res.status(200).send(renderCallbackPage(order.status, order.licenseKey));
  } catch (error) {
    console.error('Payment callback error:', error.message);
    return res.status(200).send(renderCallbackPage('pending', null));
  }
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[char];
  });
}

function renderCallbackPage(status, licenseKey) {
  let message = 'Payment received. Please wait a moment while we confirm it.';

  if (status === 'paid') {
    message = `Payment confirmed. Your license key: ${escapeHtml(licenseKey || '')}`;
  } else if (status === 'failed') {
    message = 'Payment could not be completed.';
  }

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Payment status</title>
  </head>
  <body>
    <p>${message}</p>
  </body>
</html>`;
}

module.exports = router;
