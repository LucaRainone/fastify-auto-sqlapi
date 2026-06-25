import { ConditionBuilder, type ConditionValue } from 'node-condition-builder';
import type { FastifyRequest } from 'fastify';
import { buildTenantDeleteWhere, assertTenantOwnsAll } from '../../tenant.js';
import { primaryAsString } from '../../../types.js';
import type { BulkDeleteParams, BulkDeleteResult } from '../../../types.js';

export async function bulkDeleteEngine(params: BulkDeleteParams): Promise<BulkDeleteResult[]> {
  const { db, tableConf, ids, tenant, request } = params;
  if (!ids.length) return [];

  const pk = primaryAsString(tableConf.primary);
  const pkCol = tableConf.Schema.col(pk);
  const tableName = tableConf.Schema.tableName;

  if (tableConf.beforeBulkDelete) {
    // Enforce tenant ownership of every id before the hook (single batched SELECT), so it
    // never runs for rows the tenant cannot access. Called once with all ids — no loop.
    await assertTenantOwnsAll(db, tenant, tableName, pkCol, ids as ConditionValue[]);
    await tableConf.beforeBulkDelete(db, request as FastifyRequest, ids);
  }

  let where: string;
  let values: unknown[];

  if (tenant) {
    ({ where, values } = buildTenantDeleteWhere(db, tableName, pkCol, ids, tenant));
  } else {
    const cb = new ConditionBuilder('AND', db.cbDialect);
    cb.isIn(db.qi(pkCol), ids);
    where = cb.build(1, db.ph);
    values = cb.getValues();
  }

  let results: BulkDeleteResult[];

  if (db.supportsReturning) {
    const result = await db.query(
      `DELETE FROM ${db.qi(tableName)} WHERE ${where}${db.returningPk(db.qi(pkCol))}`,
      values
    );

    // Happy path: everything requested was deleted
    if (result.affectedRows === ids.length) {
      results = ids.map((id) => ({ main: { [pk]: id } }));
    } else {
      // Partial delete: RETURNING tells exactly which rows went away
      results = result.rows.map((r) => ({ main: { [pk]: (r as Record<string, unknown>)[pkCol] } }));
    }
  } else {
    // No RETURNING (mysql): affectedRows alone cannot tell WHICH ids were deleted on a
    // partial match, so look up the rows visible through the same WHERE before deleting.
    const existing = await db.query<{ pk: unknown }>(
      `SELECT ${db.qi(pkCol)} AS pk FROM ${db.qi(tableName)} WHERE ${where}`,
      values
    );

    await db.query(
      `DELETE FROM ${db.qi(tableName)} WHERE ${where}`,
      values
    );

    results = existing.rows.map((r) => ({ main: { [pk]: r.pk } }));
  }

  // Called once with the ACTUALLY deleted ids (possibly a subset of the requested ones)
  if (tableConf.afterBulkDelete && results.length > 0) {
    const deletedIds = results.map((r) => r.main[pk] as string | number);
    await tableConf.afterBulkDelete(db, request as FastifyRequest, deletedIds);
  }

  return results;
}
