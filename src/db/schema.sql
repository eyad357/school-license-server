CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS licenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    license_key VARCHAR(255) NOT NULL UNIQUE,
    product_id VARCHAR(100) NOT NULL REFERENCES products(product_id),
    status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    max_devices INTEGER NOT NULL DEFAULT 1,
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT licenses_status_check
        CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED'))
);

CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deactivated_at TIMESTAMPTZ NULL,

);

CREATE UNIQUE INDEX IF NOT EXISTS idx_activations_one_active_per_device
ON activations (license_id, device_id)
WHERE deactivated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_licenses_product
    ON licenses(product_id);

CREATE INDEX IF NOT EXISTS idx_licenses_status
    ON licenses(status);

CREATE INDEX IF NOT EXISTS idx_activations_license
    ON activations(license_id);

CREATE INDEX IF NOT EXISTS idx_activations_device
    ON activations(device_id);

INSERT INTO products (product_id, name)
VALUES ('school-accreditation', 'Accreditation Pro')
ON CONFLICT (product_id) DO NOTHING;