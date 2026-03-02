import { ConditionBuilder } from 'node-condition-builder';
import { buildTenantCondition, buildTenantJoin } from '../tenant.js';
import type { BulkDeleteParams, BulkDeleteResult, TenantScopeIndirect } from '../../types.js';

export async function bulkDeleteEngine(params: BulkDeleteParams): Promise<BulkDeleteResult[]> {
  const { db, tableConf, ids, tenant } = params;
  if (!ids.length) return [];

  const pk = tableConf.primary;
  const pkCol = tableConf.Schema.col(pk);
  const tableName = tableConf.Schema.tableName;

  let where: string;
  let values: unknown[];

  if (tenant) {
    if ('through' in tenant.scope) {
      // Indirect: DELETE ... WHERE pk IN (SELECT pk FROM main INNER JOIN through ...)
      const scope = tenant.scope as TenantScopeIndirect;
      const innerCb = new ConditionBuilder('AND');
      innerCb.isIn(`${db.qi(tableName)}.${db.qi(pkCol)}`, ids);
      innerCb.append(buildTenantCondition(db, scope, tenant.ids));
      const innerWhere = innerCb.build(1, db.ph);
      values = innerCb.getValues();
      const joinSql = buildTenantJoin(db, scope, tableName);
      where = `${db.qi(pkCol)} IN (SELECT ${db.qi(tableName)}.${db.qi(pkCol)} FROM ${db.qi(tableName)} ${joinSql} WHERE ${innerWhere})`;
    } else {
      // Direct: simple AND
      const cb = new ConditionBuilder('AND');
      cb.isIn(db.qi(pkCol), ids);
      cb.append(buildTenantCondition(db, tenant.scope, tenant.ids));
      where = cb.build(1, db.ph);
      values = cb.getValues();
    }
  } else {
    const cb = new ConditionBuilder('AND');
    cb.isIn(db.qi(pkCol), ids);
    where = cb.build(1, db.ph);
    values = cb.getValues();
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
