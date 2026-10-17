-- 007_sale_status.sql
--
-- ADDITIVE and NON-DESTRUCTIVE migration. It never drops, truncates, deletes or
-- retypes anything and does NOT touch licenses / devices / activations / products.
--
-- Purpose: licenses are now created in bulk WITHOUT customer names ("unsold"
-- keys). The existing `customers` table is kept as the per-license sale record
-- (customer_number, name, price, currency, sold_at, notes). This migration adds
-- the missing, separate statuses:
--   * customers.sale_status     'unsold' | 'sold'        (NOT NULL, default 'unsold')
--   * customers.payment_status  'unpaid' | 'paid' | 'partial' | NULL (NULL = not recorded)
--   * customers.phone           optional contact number
--
-- Existing rows are back-filled conservatively: a record that already carries a
-- name, a price or a sale date is marked 'sold'; everything else 'unsold'.
-- payment_status is NOT invented for existing rows (stays NULL).
--
-- Requires 004 -> 005 -> 006 to be applied first (checked below).
--
-- Run it in ONE transaction (scripts/migrate.js does; or
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f src/db/007_sale_status.sql).
-- Safe to run more than once.

-- Prerequisite check. The back-fill below reads customers.sale_price / sold_at /
-- name, which are created by 004_customer_management.sql. If 004 (and 005, 006)
-- were not applied to this database, stop with a clear message instead of the
-- misleading 'column "sale_price" does not exist'. Reads the catalog only.
DO $$
DECLARE
    missing TEXT;
BEGIN
    SELECT string_agg(c, ', ' ORDER BY c) INTO missing
    FROM unnest(ARRAY['customer_number', 'sale_price', 'currency', 'sold_at', 'notes', 'archived_at']) AS c
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'customers' AND column_name = c
    );

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION
            '007 needs migration 004 first: customers is missing column(s) %. Apply in order: 004_customer_management.sql, 005_products_platform.sql, 006_events_audit.sql, then 007_sale_status.sql.',
            missing;
    END IF;
END
$$;

LOCK TABLE customers IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS sale_status VARCHAR(10) NOT NULL DEFAULT 'unsold';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_status VARCHAR(10);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone VARCHAR(40);

-- One-time back-fill. Only rows still 'unsold' that already hold sale data.
UPDATE customers
SET sale_status = 'sold'
WHERE sale_status = 'unsold'
  AND (
    (name IS NOT NULL AND btrim(name) <> '')
    OR sale_price IS NOT NULL
    OR sold_at IS NOT NULL
  );

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_sale_status_valid') THEN
        ALTER TABLE customers
            ADD CONSTRAINT customers_sale_status_valid CHECK (sale_status IN ('unsold', 'sold'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_payment_status_valid') THEN
        ALTER TABLE customers
            ADD CONSTRAINT customers_payment_status_valid
            CHECK (payment_status IS NULL OR payment_status IN ('unpaid', 'paid', 'partial'));
    END IF;

    -- An unsold key cannot be paid for.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_unsold_not_paid') THEN
        ALTER TABLE customers
            ADD CONSTRAINT customers_unsold_not_paid
            CHECK (sale_status = 'sold' OR payment_status IS NULL OR payment_status = 'unpaid');
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_customers_sale_status ON customers (sale_status);
