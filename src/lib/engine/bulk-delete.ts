import { buildTenantWhere, buildTenantJoin } from '../tenant.js';
import type { BulkDeleteParams, BulkDeleteResult, TenantScopeIndirect } from '../../types.js';

export async function bulkDeleteEngine(params: BulkDeleteParams): Promise<BulkDeleteResult[]> {
  const { db, tableConf, ids, tenant } = params;
  if (!ids.length) return [];

  const pk = tableConf.primary;
  const pkCol = tableConf.Schema.col(pk);
  const tableName = tableConf.Schema.tableName;
  const values: unknown[] = [...ids];
  const idPlaceholders = ids.map((_, i) => db.ph(i + 1)).join(', ');

  let where: string;
  if (tenant) {
    const tw = buildTenantWhere(db, tenant.scope, tenant.ids, values.length + 1);
    values.push(...tw.values);

    if ('through' in tenant.scope) {
      const scope = tenant.scope as TenantScopeIndirect;
      const joinSql = buildTenantJoin(db, scope, tableName);
      where = `${db.qi(pkCol)} IN (SELECT ${db.qi(tableName)}.${db.qi(pkCol)} FROM ${db.qi(tableName)} ${joinSql} WHERE ${db.qi(tableName)}.${db.qi(pkCol)} IN (${idPlaceholders}) AND ${tw.sql})`;
    } else {
      where = `${db.qi(pkCol)} IN (${idPlaceholders}) AND ${tw.sql}`;
    }
  } else {
    where = `${db.qi(pkCol)} IN (${idPlaceholders})`;
  }

  const result = await db.query(
    `DELETE FROM ${db.qi(tableName)} WHERE ${where}`,
    values
  );

  // Return PK-only for each deleted record
  // We don't know exactly which ids were deleted on MySQL (no RETURNING),
  // so we return the requested ids if affectedRows matches, otherwise just count
  if (result.affectedRows === ids.length) {
    return ids.map((id) => ({ main: { [pk]: id } }));
  }

  // Partial delete: return affectedRows count of items from the requested ids
  // Since we can't determine exactly which ones were deleted without RETURNING,
  // return the first N ids (best effort)
  const deletedCount = result.affectedRows;
  return ids.slice(0, deletedCount).map((id) => ({ main: { [pk]: id } }));
}
