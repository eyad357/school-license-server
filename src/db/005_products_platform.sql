-- 005_products_platform.sql
--
-- ADDITIVE and NON-DESTRUCTIVE migration (multi-product platform).
-- It never drops, truncates, deletes or retypes anything and does NOT touch
-- licenses / devices / activations / customers rows.
--
-- What it adds to the existing "products" table (the table, its product_id
-- column and the licenses.product_id foreign key already exist and are reused):
--   * products.description  - free text shown in the admin panel
--   * products.status       - 'active' | 'disabled' (administrative switch)
--   * products.updated_at
--   * a guard trigger that makes products.product_id IMMUTABLE once created
--     (changing it would orphan / break existing licenses)
--
-- Old server code keeps working against the new schema: it only reads
-- products.product_id and never lists the new columns.
-- To roll back the code, nothing needs to be undone in the database.
--
-- HOW TO RUN: inside ONE transaction. Use scripts/migrate.js (recommended):
--     node scripts/migrate.js --plan  src/db/005_products_platform.sql   (dry run, rolls back)
--     node scripts/migrate.js --apply src/db/005_products_platform.sql
-- Safe to run more than once.

ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_status_check'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_status_check CHECK (status IN ('active', 'disabled'));
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION products_guard_product_id() RETURNS trigger AS $$
BEGIN
  IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    RAISE EXCEPTION 'products.product_id is immutable (existing licenses reference it)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_products_guard_product_id') THEN
    CREATE TRIGGER trg_products_guard_product_id
      BEFORE UPDATE OF product_id ON products
      FOR EACH ROW EXECUTE FUNCTION products_guard_product_id();
  END IF;
END
$$;

-- Friendly display name for the product that already exists in production is
-- NOT changed here (it would modify existing data). Rename it from the admin
-- panel if you want to.
