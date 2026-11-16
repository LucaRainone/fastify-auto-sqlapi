import { ConditionBuilder, type ConditionValue } from 'node-condition-builder';
import { buildTenantRowGuard, assertTenantOwnsAll } from '../../tenant.js';
import { buildKeyMatch } from '../../db.js';
import { httpError } from '../../errors.js';
import type { BulkDeleteParams, BulkDeleteResult, PrimaryKeyValue } from '../../../types.js';

/**
 * Delete rows by primary key. A single-column key takes the values themselves; a composite key
 * takes one object per row naming every key field, and each row is matched on all of its key
 * columns together — never on one column alone, which would reach every row sharing it.
 */
export async function bulkDeleteEngine(params: BulkDeleteParams): Promise<BulkDeleteResult[]> {
  const { db, tableConf, ids, tenant, request } = params;
  const pkFields = Array.isArray(tableConf.primary) ? tableConf.primary : [tableConf.primary];
  const keys = keyValues(ids, pkFields);
  if (!keys.length) return [];

  const pkCols = pkFields.map((f) => tableConf.schema.col(f));
  const tableName = tableConf.schema.tableName;
  const single = pkFields.length === 1;
  /** A deleted row's key, as the response and `afterBulkDelete` name it. */
  const keyOf = (values: unknown[]): Record<string, unknown> =>
    Object.fromEntries(pkFields.map((f, i) => [f, values[i]]));

  if (tableConf.beforeBulkDelete) {
    // Enforce tenant ownership of every id before the hook (single batched SELECT), so it
    // never runs for rows the tenant cannot access. Called once with all ids — no loop.
    await assertTenantOwnsAll(db, tenant, tableName, pkCols, keys);
    await tableConf.beforeBulkDelete({ db, req: request, ids });
  }

  // The keys, and the tenant's guard when the table is scoped: a row the caller does not own
  // is not deleted, and is left out of the answer like a missing one.
  const keyMatch = buildKeyMatch(db, pkCols.map((c) => db.qi(c)), keys);
  const guard = buildTenantRowGuard(db, tenant, tableName);
  const condition = guard
    ? new ConditionBuilder('AND', db.cbDialect).append(keyMatch).append(guard)
    : keyMatch;
  const where = condition.build(1, db.ph);
  const values = condition.getValues();

  const quotedPkCols = pkCols.map((c) => db.qi(c)).join(', ');
  let results: BulkDeleteResult[];

  if (db.supportsReturning) {
    const result = await db.query(
      `DELETE FROM ${db.qi(tableName)} WHERE ${where}${db.returningPk(quotedPkCols)}`,
      values
    );

    // Happy path: everything requested was deleted
    if (result.affectedRows === keys.length) {
      results = keys.map((k) => ({ main: keyOf(k) }));
    } else {
      // Partial delete: RETURNING tells exactly which rows went away
      results = result.rows.map((r) => ({ main: keyOf(pkCols.map((c) => r[c])) }));
    }
  } else {
    // No RETURNING (mysql): affectedRows alone cannot tell WHICH ids were deleted on a
    // partial match, so look up the rows visible through the same WHERE before deleting.
    const keyList = single ? `${quotedPkCols} AS pk` : quotedPkCols;
    const existing = await db.query(
      `SELECT ${keyList} FROM ${db.qi(tableName)} WHERE ${where}`,
      values
    );

    await db.query(
      `DELETE FROM ${db.qi(tableName)} WHERE ${where}`,
      values
    );

    results = existing.rows.map((r) => ({ main: keyOf(single ? [r.pk] : pkCols.map((c) => r[c])) }));
  }

  // Called once with the ACTUALLY deleted ids (possibly a subset of the requested ones)
  if (tableConf.afterBulkDelete && results.length > 0) {
    const deletedIds = results.map((r) => (single ? r.main[pkFields[0]] : r.main) as PrimaryKeyValue);
    await tableConf.afterBulkDelete({ db, req: request, ids: deletedIds });
  }

  return results;
}

/**
 * One value per key column for each id, in `pkFields` order. The HTTP body schema already
 * enforces this shape; `sqlApi` runs no body schema, so it is checked here too, as a 400 at the
 * same paths: an object for a single-column key, or a composite id that is not an object, is a
 * `type` at `ids.<i>`; a missing key field a `required`, a field outside the key an
 * `additionalProperties` at `ids.<i>.<field>`.
 */
function keyValues(ids: PrimaryKeyValue[], pkFields: string[]): ConditionValue[][] {
  return ids.map((id, i) => {
    const isObject = id !== null && typeof id === 'object' && !Array.isArray(id);
    if (pkFields.length === 1) {
      if (isObject) throw httpError(400, `ids.${i}: a single-column key takes its value, not an object`, { code: 'type', path: `ids.${i}` });
      return [id as ConditionValue];
    }
    if (!isObject) {
      throw httpError(400, `ids.${i}: a composite key takes an object naming ${pkFields.join(', ')}`, { code: 'type', path: `ids.${i}` });
    }
    const key = id as Record<string, unknown>;
    const extra = Object.keys(key).find((f) => !pkFields.includes(f));
    if (extra !== undefined) {
      throw httpError(400, `ids.${i}.${extra} is not a primary key field`, { code: 'additionalProperties', path: `ids.${i}.${extra}` });
    }
    const missing = pkFields.find((f) => key[f] == null);
    if (missing !== undefined) {
      throw httpError(400, `ids.${i}.${missing} is required`, { code: 'required', path: `ids.${i}.${missing}` });
    }
    return pkFields.map((f) => key[f] as ConditionValue);
  });
}
