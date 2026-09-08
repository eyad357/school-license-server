BEGIN;

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255),
    email VARCHAR(320),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE licenses
ADD COLUMN IF NOT EXISTS customer_id UUID
REFERENCES customers(id)
ON DELETE SET NULL;

ALTER TABLE licenses
ADD COLUMN IF NOT EXISTS plan VARCHAR(50) NOT NULL DEFAULT 'lifetime';

ALTER TABLE licenses
ADD COLUMN IF NOT EXISTS license_type VARCHAR(50) NOT NULL DEFAULT 'perpetual';

CREATE INDEX IF NOT EXISTS idx_licenses_customer
    ON licenses(customer_id);

COMMIT;