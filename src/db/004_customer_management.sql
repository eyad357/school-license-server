-- 004_customer_management.sql
--
-- ADDITIVE and NON-DESTRUCTIVE migration. It never drops, truncates, deletes
-- or retypes anything. It does NOT touch licenses / devices / activations /
-- products / payment_orders at all.
--
-- What it adds:
--   * customers.customer_number  - permanent, unique, human-facing number
--   * customers.sale_price / currency / sold_at / notes / archived_at
--   * customer_number_counter + next_customer_number() / allocate_customer_numbers(n)
--   * license_batches            - idempotency record for bulk license creation
--
-- HOW TO RUN: it must run inside ONE transaction, so that a failure leaves the
-- database exactly as it was. Use scripts/migrate.js (recommended; it also
-- verifies that licenses/devices/activations are unchanged before COMMIT), or:
--     psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f src/db/004_customer_management.sql
-- Safe to run more than once (every statement is idempotent).

-- Briefly block concurrent writes to customers so the one-time numbering of
-- existing rows cannot interleave with inserts from the running app.
LOCK TABLE customers IN SHARE ROW EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- 1. Gap-free, never-reused counter for customer numbers.
--    The counter row is locked until the surrounding transaction ends, so
--    concurrent transactions are serialised and a rolled-back transaction does
--    not consume a number. The counter only ever grows, so a number that was
--    committed once is never handed out again - even if the customer row is
--    later archived or deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_number_counter (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_number BIGINT NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);

INSERT INTO customer_number_counter (id, last_number)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- Reserve one number.
CREATE OR REPLACE FUNCTION next_customer_number()
RETURNS BIGINT
LANGUAGE sql
AS $$
    UPDATE customer_number_counter
    SET last_number = last_number + 1
    WHERE id = 1
    RETURNING last_number;
$$;

-- Reserve a block of n consecutive numbers; returns the FIRST one.
CREATE OR REPLACE FUNCTION allocate_customer_numbers(n INTEGER)
RETURNS BIGINT
LANGUAGE sql
AS $$
    UPDATE customer_number_counter
    SET last_number = last_number + n
    WHERE id = 1 AND n >= 1
    RETURNING last_number - n + 1;
$$;

-- ---------------------------------------------------------------------------
-- 2. New nullable columns on customers (metadata-only, no table rewrite).
--    No value is invented for existing rows: price/currency/date/notes stay NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_number BIGINT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12, 2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS currency VARCHAR(3);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS sold_at DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 3. One-time, deterministic numbering of EXISTING customers.
--    Order: created_at, then id. No ROW_NUMBER(), no random numbers. Rows that
--    already have a number are never renumbered, so re-running does nothing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT id
        FROM customers
        WHERE customer_number IS NULL
        ORDER BY created_at ASC, id ASC
    LOOP
        UPDATE customers
        SET customer_number = next_customer_number()
        WHERE id = r.id;
    END LOOP;
END
$$;

-- If numbers already existed beyond the counter (e.g. a manual edit), keep the
-- counter ahead of them so a number can never be issued twice.
UPDATE customer_number_counter
SET last_number = GREATEST(
        last_number,
        COALESCE((SELECT MAX(customer_number) FROM customers), 0)
    )
WHERE id = 1;

-- ---------------------------------------------------------------------------
-- 4. From now on every new customer row gets a number automatically - including
--    rows inserted by the EXISTING code paths (createCustomerAndLicense, the
--    payment flow), which do not know about this column.
-- ---------------------------------------------------------------------------
ALTER TABLE customers ALTER COLUMN customer_number SET DEFAULT next_customer_number();
ALTER TABLE customers ALTER COLUMN customer_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_customer_number
    ON customers (customer_number);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_customer_number_positive') THEN
        ALTER TABLE customers
            ADD CONSTRAINT customers_customer_number_positive CHECK (customer_number > 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_sale_price_non_negative') THEN
        ALTER TABLE customers
            ADD CONSTRAINT customers_sale_price_non_negative CHECK (sale_price IS NULL OR sale_price >= 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_currency_format') THEN
        ALTER TABLE customers
            ADD CONSTRAINT customers_currency_format CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
    END IF;
END
$$;

-- The number is permanent: refuse any later attempt to change it.
CREATE OR REPLACE FUNCTION customers_protect_customer_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.customer_number IS NOT NULL
       AND NEW.customer_number IS DISTINCT FROM OLD.customer_number THEN
        RAISE EXCEPTION 'customer_number is immutable (customer %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_customers_protect_customer_number') THEN
        CREATE TRIGGER trg_customers_protect_customer_number
            BEFORE UPDATE ON customers
            FOR EACH ROW
            EXECUTE FUNCTION customers_protect_customer_number();
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_customers_archived_at
    ON customers (archived_at);

-- ---------------------------------------------------------------------------
-- 5. Idempotency record for bulk license creation (double click / re-submit).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS license_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(100) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
    created_by VARCHAR(100),
    license_ids UUID[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_license_batches_idempotency_key
    ON license_batches (idempotency_key);
