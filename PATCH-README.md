# Patch: Migration 007 — `column "sale_price" does not exist`

## Root cause
`sale_price` is the correct column name. It is created by `src/db/004_customer_management.sql`
and used everywhere in the code. Migration 007's back-fill reads `sale_price`, so it failed on a
database where **004 had not been applied** (reproduced on a DB built from schema + 002 + 003 only).
The runner only checked that `customers` exists, so the error was misleading.

## What changed
- `src/db/007_sale_status.sql`: added a read-only prerequisite check (customers must have the
  004 columns). If missing, it fails with a clear message listing the required order. Nothing
  else changed: no column renamed, nothing invented, same constraints/back-fill.
- `test/db/migration-007.test.js`: new regression test (007 without 004 -> clear error, rolled
  back, data unchanged; after 004-006 -> 007 succeeds).

## Tests (local disposable PostgreSQL 16, never production)
- `npm test`: 45/45 pass. `npm run test:db`: 96/96 pass.
- CLI on a test DB: 007 `--plan` without 004 -> clear error; 004, 005, 006 `--apply` OK;
  007 `--plan` rolled back; 007 `--apply` OK; second `--apply` OK (idempotent). Old named
  customer -> sold, empty -> unsold, payment_status stays NULL.

## Files in this archive
- PATCH-README.md
- src/db/007_sale_status.sql
- test/db/migration-007.test.js

## IMPORTANT for your real database
Your server DB must get the migrations in order. If 004 was never applied there, apply them
in this order (each is its own transaction; use --plan first):
    node scripts/migrate.js --plan  src/db/004_customer_management.sql
    node scripts/migrate.js --apply src/db/004_customer_management.sql
    (same for 005_products_platform.sql, 006_events_audit.sql, 007_sale_status.sql)
Back up the database before any --apply.
