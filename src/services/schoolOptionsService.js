'use strict';

// Admin-managed option lists for the school profile: school types (حكومي / أهلي / ...)
// and school stages (ابتدائي / متوسط / ...). Two SEPARATE lists, one table each, with
// identical behaviour, so both are produced by the same factory.
//
// Rules:
//   * records link to an option by its numeric id, never by name => renaming never breaks links;
//   * names are unique after normalisation (spaces, Arabic diacritics/tatweel, alef/yaa forms, case);
//   * an option used by records can be renamed only with confirm=true, and can never be deleted
//     (409 in_use) - deactivate it instead: it then disappears from the pickers but old records keep it;
//   * nothing here touches licenses, devices or activations.

const pool = require('../db/pool');
const { ValidationError } = require('../lib/validation');
const { NotFoundError, ConflictError } = require('../lib/errors');

const MAX_NAME = 100;
const MAX_OPTIONS = 200;

const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏​-‍﻿]/g;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Display form: NFC, control/bidi characters removed, whitespace collapsed. */
function cleanOptionName(value, field = 'الاسم') {
  if (value === undefined || value === null) throw new ValidationError(`${field} مطلوب.`);
  if (typeof value !== 'string') throw new ValidationError(`${field} يجب أن يكون نصًا.`);
  const text = value.normalize('NFC').replace(BIDI_CONTROLS, '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new ValidationError(`${field} مطلوب ولا يمكن أن يكون فارغًا.`);
  if ([...text].length > MAX_NAME) throw new ValidationError(`${field} طويل جدًا (الحد الأقصى ${MAX_NAME} حرفًا).`);
  if (!/[\p{L}\p{N}]/u.test(text)) throw new ValidationError(`${field} غير صالح: يجب أن يحتوي على حروف أو أرقام.`);
  return text;
}

/** Comparison key: "أهلي", " اهلي ", "أَهْلِي" and "ـأهلي" are the same option. */
function optionKey(name) {
  return String(name)
    .normalize('NFKC')
    .replace(BIDI_CONTROLS, '')
    .replace(/[ً-ٰٟـ]/g, '') // tashkeel + tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseOptionId(value, field = 'المعرّف') {
  const n = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 1) throw new ValidationError(`${field} غير صالح.`);
  return n;
}

function makeService({ table, label, labelDef }) {
  // table is a fixed internal constant (never user input).
  const FK = table === 'school_types' ? 'school_type_id' : 'school_stage_id';

  const SELECT = `
    SELECT o.id::int AS id, o.name, o.is_active, o.sort_order, o.created_at, o.updated_at,
           (SELECT COUNT(*)::int FROM customers c WHERE c.${FK} = o.id) AS usage_count
      FROM ${table} o`;

  async function list(db = pool, { activeOnly = false } = {}) {
    const r = await db.query(`${SELECT} ${activeOnly ? 'WHERE o.is_active' : ''} ORDER BY o.sort_order ASC, o.id ASC`);
    return r.rows;
  }

  async function get(id, db = pool) {
    const r = await db.query(`${SELECT} WHERE o.id = $1`, [parseOptionId(id)]);
    if (r.rowCount === 0) throw new NotFoundError(`${labelDef} غير موجود.`);
    return r.rows[0];
  }

  async function create(input = {}, db = pool) {
    const name = cleanOptionName(input.name, label);
    const key = optionKey(name);
    const count = await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    if (count.rows[0].n >= MAX_OPTIONS) throw new ValidationError(`بلغت الحد الأقصى لعدد الخيارات (${MAX_OPTIONS}).`);
    try {
      const r = await db.query(
        `INSERT INTO ${table} (name, name_key, sort_order)
         VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) FROM ${table}), 0) + 1)
         RETURNING id`,
        [name, key]
      );
      return get(r.rows[0].id, db);
    } catch (error) {
      if (error.code === '23505') throw new ConflictError(`${label} "${name}" موجود بالفعل.`, 'duplicate');
      throw error;
    }
  }

  /**
   * Rename and/or (de)activate. Renaming an option that records already use changes what those
   * records display, so it needs `confirm: true` (the admin UI asks first). 409 confirmation_required
   * otherwise, carrying the usage count in the message.
   */
  async function update(id, input = {}, db = pool) {
    const optionId = parseOptionId(id);
    const current = await get(optionId, db);
    const sets = [];
    const params = [optionId];
    const push = (v) => { params.push(v); return `$${params.length}`; };

    if (input.name !== undefined) {
      const name = cleanOptionName(input.name, label);
      if (name !== current.name) {
        if (current.usage_count > 0 && input.confirm !== true) {
          throw new ConflictError(
            `${labelDef} "${current.name}" مستخدم في ${current.usage_count} سجل. تغيير اسمه سيظهر في كل هذه السجلات. أكّد التعديل للمتابعة.`,
            'confirmation_required'
          );
        }
        sets.push(`name = ${push(name)}`, `name_key = ${push(optionKey(name))}`);
      }
    }

    if (input.isActive !== undefined) {
      if (typeof input.isActive !== 'boolean') throw new ValidationError('حالة التفعيل يجب أن تكون true أو false.');
      sets.push(`is_active = ${push(input.isActive)}`);
    }

    if (input.name === undefined && input.isActive === undefined) throw new ValidationError('لا توجد حقول للتعديل.');
    if (sets.length === 0) return current;

    sets.push('updated_at = NOW()');
    try {
      await db.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1`, params);
    } catch (error) {
      if (error.code === '23505') throw new ConflictError(`${label} بهذا الاسم موجود بالفعل.`, 'duplicate');
      throw error;
    }
    return get(optionId, db);
  }

  async function remove(id, db = pool) {
    const optionId = parseOptionId(id);
    const current = await get(optionId, db);
    if (current.usage_count > 0) {
      throw new ConflictError(
        `لا يمكن حذف "${current.name}" لأنه مرتبط بـ ${current.usage_count} سجل. عطّله بدل حذفه، أو غيّر قيمة تلك السجلات أولًا.`,
        'in_use'
      );
    }
    try {
      await db.query(`DELETE FROM ${table} WHERE id = $1`, [optionId]);
    } catch (error) {
      // 23503: a record started using it between the check and the delete (FK RESTRICT).
      if (error.code === '23503') throw new ConflictError(`لا يمكن حذف "${current.name}" لأنه أصبح مرتبطًا بسجلات.`, 'in_use');
      throw error;
    }
    return current;
  }

  /**
   * Resolve a value coming from a record form / API (id) to a usable option id or null.
   * `allowId` lets an unchanged, now-inactive option stay on a record that already has it.
   */
  async function resolveId(value, db = pool, { allowId = null, field = label } = {}) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const optionId = parseOptionId(value, field);
    const r = await db.query(`SELECT is_active FROM ${table} WHERE id = $1`, [optionId]);
    if (r.rowCount === 0) throw new ValidationError(`${field} المحدد غير موجود.`);
    if (!r.rows[0].is_active && optionId !== allowId) throw new ValidationError(`${field} المحدد معطّل ولا يمكن اختياره.`);
    return optionId;
  }

  /** Name -> id lookup among ACTIVE options (Excel import). Returns Map(key -> id). */
  async function activeKeyMap(db = pool) {
    const r = await db.query(`SELECT id::int AS id, name FROM ${table} WHERE is_active`);
    return new Map(r.rows.map((row) => [optionKey(row.name), row.id]));
  }

  return { table, list, get, create, update, remove, resolveId, activeKeyMap };
}

const schoolTypes = makeService({ table: 'school_types', label: 'نوع المدرسة', labelDef: 'نوع المدرسة' });
const schoolStages = makeService({ table: 'school_stages', label: 'المرحلة الدراسية', labelDef: 'المرحلة الدراسية' });

module.exports = { MAX_NAME, cleanOptionName, optionKey, parseOptionId, schoolTypes, schoolStages };
