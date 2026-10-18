-- 008_school_profile.sql
--
-- ADDITIVE and NON-DESTRUCTIVE migration (school profile on the sale record).
-- It never drops, truncates, deletes or retypes anything and does NOT touch
-- licenses / devices / activations / products rows or any activation logic.
--
-- What it adds:
--   * school_types   - admin-managed list (default: حكومي، أهلي، رياض الأطفال، تربية خاصة)
--   * school_stages  - admin-managed list, SEPARATE from school_types
--                      (default: رياض الأطفال، ابتدائي، متوسط، ثانوي، تربية خاصة)
--   * customers.city             VARCHAR(100) NULL
--   * customers.school_type_id   BIGINT NULL -> school_types.id (ON DELETE RESTRICT)
--   * customers.school_stage_id  BIGINT NULL -> school_stages.id (ON DELETE RESTRICT)
--
-- Records link to an option by its stable numeric id, never by its name, so renaming an
-- option keeps every record attached to it. All three new columns are optional: existing rows
-- simply have NULL there. Old server code ignores the new columns, so no rollback of the
-- database is needed to roll back the code.
--
-- The default options are inserted ONLY when the table is created by this migration (the
-- DO block below). Re-running the migration never re-inserts a default the admin renamed
-- or removed, and never overwrites admin edits.
--
-- HOW TO RUN: inside ONE transaction. Use scripts/migrate.js (recommended):
--     node scripts/migrate.js --plan  src/db/008_school_profile.sql   (dry run, rolls back)
--     node scripts/migrate.js --apply src/db/008_school_profile.sql
-- Safe to run more than once.

LOCK TABLE customers IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass('public.school_types') IS NULL THEN
    CREATE TABLE school_types (
      id          BIGSERIAL PRIMARY KEY,
      name        VARCHAR(100) NOT NULL,
      name_key    VARCHAR(100) NOT NULL,
      is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
      sort_order  INTEGER      NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT school_types_name_not_blank CHECK (btrim(name) <> '' AND btrim(name_key) <> '')
    );
    CREATE UNIQUE INDEX school_types_name_key_uq ON school_types (name_key);

    INSERT INTO school_types (name, name_key, sort_order) VALUES
      ('حكومي', 'حكومي', 1),
      ('أهلي', 'اهلي', 2),
      ('رياض الأطفال', 'رياض الاطفال', 3),
      ('تربية خاصة', 'تربية خاصة', 4);
  END IF;

  IF to_regclass('public.school_stages') IS NULL THEN
    CREATE TABLE school_stages (
      id          BIGSERIAL PRIMARY KEY,
      name        VARCHAR(100) NOT NULL,
      name_key    VARCHAR(100) NOT NULL,
      is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
      sort_order  INTEGER      NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT school_stages_name_not_blank CHECK (btrim(name) <> '' AND btrim(name_key) <> '')
    );
    CREATE UNIQUE INDEX school_stages_name_key_uq ON school_stages (name_key);

    INSERT INTO school_stages (name, name_key, sort_order) VALUES
      ('رياض الأطفال', 'رياض الاطفال', 1),
      ('ابتدائي', 'ابتدائي', 2),
      ('متوسط', 'متوسط', 3),
      ('ثانوي', 'ثانوي', 4),
      ('تربية خاصة', 'تربية خاصة', 5);
  END IF;
END
$$;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS school_type_id BIGINT REFERENCES school_types (id) ON DELETE RESTRICT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS school_stage_id BIGINT REFERENCES school_stages (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_customers_school_type ON customers (school_type_id);
CREATE INDEX IF NOT EXISTS idx_customers_school_stage ON customers (school_stage_id);
