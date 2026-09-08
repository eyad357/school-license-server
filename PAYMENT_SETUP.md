# MyFatoorah Payment Feature — Setup

This document covers the new public purchase flow only. It does not change
anything about the existing license validation/activation contract or the
Admin Dashboard.

## 1. New environment variables

Add these on Railway (and in your local `.env`, which is already
git-ignored — never commit real values):

```
LIFETIME_PRICE_SAR=10
MYFATOORAH_API_KEY=<your MyFatoorah API key>
MYFATOORAH_WEBHOOK_SECRET=<your MyFatoorah webhook secret>

# Optional - defaults shown
MYFATOORAH_BASE_URL=https://api-eg.myfatoorah.com
PUBLIC_BASE_URL=https://school-license-server-production.up.railway.app
```

- `LIFETIME_PRICE_SAR` — the ONLY price the public checkout will ever
  charge. Change this single value to move from the 10 SAR test price to
  the real production price; no code change is required.
- `MYFATOORAH_API_KEY` / `MYFATOORAH_WEBHOOK_SECRET` — never logged, never
  sent to the client, never committed. Only read from `process.env` inside
  `src/services/myfatoorahService.js`.
- `PUBLIC_BASE_URL` — used to build the callback/error URLs passed to
  MyFatoorah. Defaults to the current production URL if unset.

## 2. Database migration

Run once against the production database:

```
src/db/003_payment_orders.sql
```

This only **creates** a new `payment_orders` table plus indexes. It does
not alter, drop, or touch `licenses`, `customers`, `devices`,
`activations`, or `products`. Safe to run more than once (all statements
use `IF NOT EXISTS`).

## 3. MyFatoorah webhook configuration

In the MyFatoorah dashboard, configure the **V2 webhook** for the
`PAYMENT_STATUS_CHANGED` event to point at:

```
POST https://school-license-server-production.up.railway.app/api/v1/payments/myfatoorah/webhook
```

## 4. Endpoints added

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/payments/create` | none (rate-limited) | Starts a checkout for the fixed lifetime/pro/1-device product. Body: `{ customer: { name, email } }` only. |
| POST | `/api/v1/payments/myfatoorah/webhook` | MyFatoorah signature | Receives `PAYMENT_STATUS_CHANGED` events; verifies the payment with MyFatoorah before creating a license. |
| GET | `/api/v1/payments/orders/:id` | none | Returns `pending` / `paid` / `failed`, and the license key once paid. |
| GET | `/api/v1/payments/callback` | none | Public "payment received / processing" page customers land on after paying. Never creates a license itself. |

## 5. Flow

1. Customer calls `POST /create` with just their name/email.
2. Server creates a `payment_orders` row (`status = pending`) and calls
   MyFatoorah `POST /v3/payments` with `InvoiceValue = LIFETIME_PRICE_SAR`,
   `NotificationOption = LINK`, and a unique `CustomerReference`. Returns
   the hosted payment URL to the customer.
3. Customer pays. MyFatoorah redirects them to `/api/v1/payments/callback`
   and (independently) sends a `PAYMENT_STATUS_CHANGED` webhook.
4. The webhook handler verifies the `myfatoorah-signature` header (HMAC
   over the raw body, constant-time compare), then calls MyFatoorah
   `GET /v3/payments/{paymentId}` to get the authoritative status/amount —
   the webhook payload's own amount/currency/status are never trusted.
5. If MyFatoorah confirms success **and** the amount/currency match the
   order we created, the server calls the existing
   `createCustomerAndLicense()` with `duration: 'lifetime'`, `plan: 'pro'`,
   `maxDevices: 1` — no second license generator was introduced.
6. The order row is updated to `paid` with the resulting `license_id`, all
   inside one row-locked transaction, so retried/duplicate/concurrent
   webhook deliveries for the same payment never create a second license.

## 6. Security controls

- The client can only ever supply `customer.name` / `customer.email`.
  Price, duration, plan, maxDevices, licenseType, and expiresAt are fixed
  server-side constants and are never read from the request body.
- `MYFATOORAH_API_KEY` / `MYFATOORAH_WEBHOOK_SECRET` are read only from
  `process.env`, only inside `myfatoorahService.js`, and are never logged,
  returned to a client, or written to any file.
- The webhook route verifies the `myfatoorah-signature` header via
  HMAC-SHA256 + `crypto.timingSafeEqual` before touching the payload.
- `/api/v1/payments/create` has its own tighter rate limiter (in addition
  to the existing global `/api/` limiter) and does **not** use the admin
  JWT middleware.
- `GET /orders/:id` and the callback page never return database
  credentials, the admin JWT, or MyFatoorah secrets.

## 7. Known limitation to be aware of

License creation (inside `createCustomerAndLicense()`) runs in its own,
separate database transaction from the order-status update that follows
it, because the ticket asked not to modify `adminLicenseService.js`. The
row lock on the order prevents two webhook deliveries from racing each
other, but there is a narrow window between "license created" and "order
marked paid" where a server crash could leave an orphaned license not yet
linked to its order. This is an acceptable, standard trade-off for this
scope; if it ever needs to be fully atomic, `createCustomerAndLicense`
would need to accept an existing client/transaction instead of opening its
own.

## 8. Tests

```
node --test test/*.test.js
```

Covers: server-side price/duration/plan/maxDevices enforcement, request
body field-stripping, MyFatoorah payment-URL generation (mocked),
signature rejection/acceptance, payment verification before license
creation, no-license-on-failed/pending, single-license-on-success,
duplicate and concurrent webhook idempotency, and that order-status
responses never leak secrets.

These are unit/integration tests against an in-memory fake for Postgres
and a mocked MyFatoorah client — this sandbox has no network access to
MyFatoorah's API and no live Postgres instance, so a final pass against
the real MyFatoorah **test/sandbox** credentials and a staging database is
still recommended before flipping this on in production.
