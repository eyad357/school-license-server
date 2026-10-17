-- 006_events_audit.sql
--
-- ADDITIVE and NON-DESTRUCTIVE (run it with scripts/migrate.js, which runs it in
-- one transaction, fingerprints licenses/devices/activations/products before and
-- after, and refuses DROP/TRUNCATE/DELETE). It does not touch any existing row.
--
-- 1. license_events  - transactional OUTBOX for the push channel. A row is written
--    in the SAME transaction as the license change it describes (revoke, reactivate,
--    device reset, edit, delete), so a change can never be committed without its
--    event, nor an event exist for a rolled-back change. The event carries NO
--    secrets (no license key, no device id): only the license's internal id, the
--    program id and an event type. license_id has no foreign key on purpose, so
--    the "deleted" event survives the deletion of the license it describes.
-- 2. admin_audit_log - who changed what and when (sensitive admin actions). License
--    keys are stored masked only (e.g. SCHL-AB…EF12); passwords/tokens never.

CREATE TABLE IF NOT EXISTS license_events (
    id          BIGSERIAL PRIMARY KEY,
    license_id  UUID         NOT NULL,
    product_id  VARCHAR(100) NOT NULL,
    type        VARCHAR(40)  NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT license_events_type_check
        CHECK (type IN ('license.revoked', 'license.reactivated', 'license.updated',
                        'license.device_reset', 'license.deleted'))
);

CREATE INDEX IF NOT EXISTS idx_license_events_license ON license_events (license_id, id);
CREATE INDEX IF NOT EXISTS idx_license_events_created ON license_events (created_at);

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id           BIGSERIAL PRIMARY KEY,
    at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    admin_user   VARCHAR(100) NOT NULL,
    action       VARCHAR(60)  NOT NULL,
    target_type  VARCHAR(40)  NOT NULL,
    target_id    VARCHAR(100) NULL,
    meta         JSONB        NOT NULL DEFAULT '{}'::jsonb,
    ip           VARCHAR(64)  NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log (target_type, target_id);
