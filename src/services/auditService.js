'use strict';

// Audit trail for sensitive admin actions (table admin_audit_log, migration 006).
// Never stores secrets: license keys are masked, passwords/tokens are never passed in.

const pool = require('../db/pool');

function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 10) return s ? '…' : '';
  return `${s.slice(0, 7)}…${s.slice(-4)}`;
}

function adminName(req) {
  return String((req && req.admin && (req.admin.username || req.admin.sub)) || 'admin').slice(0, 100);
}

/**
 * Writes one audit row. `db` may be the pool or a transaction client (so the row is
 * committed atomically with the change). Failures are logged and swallowed ONLY when
 * `strict` is false (best-effort mode used for non-transactional call sites).
 */
async function record(db, { admin = 'admin', action, targetType, targetId = null, meta = {}, ip = null }, { strict = false } = {}) {
  try {
    await (db || pool).query(
      `INSERT INTO admin_audit_log (admin_user, action, target_type, target_id, meta, ip)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [String(admin).slice(0, 100), action, targetType, targetId === null ? null : String(targetId), JSON.stringify(meta || {}), ip]
    );
  } catch (error) {
    if (strict) throw error;
    console.error('Audit log write failed:', error.message);
  }
}

const fromReq = (req) => ({ admin: adminName(req), ip: (req && req.ip) || null });

module.exports = { record, maskKey, adminName, fromReq };
