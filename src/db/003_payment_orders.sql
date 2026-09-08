-- Adds payment order tracking for the MyFatoorah checkout flow.
-- Purely additive: creates one new table + indexes only. Does NOT alter,
-- drop, or touch licenses / customers / devices / activations / products.
-- Safe to run once against the existing production database.

BEGIN;

CREATE TABLE IF NOT EXISTS payment_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    provider VARCHAR(30) NOT NULL DEFAULT 'myfatoorah',

    -- MyFatoorah's InvoiceId, known right after we create the payment.
    provider_invoice_id VARCHAR(255),

    -- MyFatoorah's PaymentId, known once the webhook / status check fires.
    provider_payment_id VARCHAR(255),

    -- Our own order reference, generated before calling MyFatoorah and sent
    -- as CustomerReference. Used to find the order back if a webhook or the
    -- callback only gives us a reference instead of (or in addition to) the
    -- invoice/payment id.
    customer_reference VARCHAR(100) NOT NULL,

    customer_name VARCHAR(255),
    customer_email VARCHAR(320),

    amount NUMERIC(10, 2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'SAR',

    duration VARCHAR(30) NOT NULL DEFAULT 'lifetime',
    plan VARCHAR(50) NOT NULL DEFAULT 'pro',
    max_devices INTEGER NOT NULL DEFAULT 1,
    product_id VARCHAR(100) NOT NULL DEFAULT 'school-accreditation',

    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    license_id UUID REFERENCES licenses(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT payment_orders_status_check
        CHECK (status IN ('pending', 'paid', 'failed'))
);

-- One order per generated reference.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_customer_reference
    ON payment_orders(customer_reference);

-- One order per MyFatoorah invoice / payment identity (partial indexes
-- because these columns start out NULL and are filled in later).
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_provider_invoice_id
    ON payment_orders(provider_invoice_id)
    WHERE provider_invoice_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_provider_payment_id
    ON payment_orders(provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;

-- A license must never be attached to more than one paid order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_license_id
    ON payment_orders(license_id)
    WHERE license_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_orders_status
    ON payment_orders(status);

COMMIT;
