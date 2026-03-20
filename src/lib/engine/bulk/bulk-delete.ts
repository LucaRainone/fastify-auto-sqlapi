import { ConditionBuilder } from 'node-condition-builder';
import { buildTenantDeleteWhere } from '../../tenant.js';
import { primaryAsString } from '../../../types.js';
import type { BulkDeleteParams, BulkDeleteResult } from '../../../types.js';

export async function bulkDeleteEngine(params: BulkDeleteParams): Promise<BulkDeleteResult[]> {
  const { db, tableConf, ids, tenant } = params;
  if (!ids.length) return [];

  const pk = primaryAsString(tableConf.primary);
  const pkCol = tableConf.Schema.col(pk);
  const tableName = tableConf.Schema.tableName;

  let where: string;
  let values: unknown[];

  if (tenant) {
    ({ where, values } = buildTenantDeleteWhere(db, tableName, pkCol, ids, tenant));
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
  if (result.affectedRows === ids.length) {
    return ids.map((id) => ({ main: { [pk]: id } }));
  }

  // Partial delete: best effort (no RETURNING on MySQL)
  const deletedCount = result.affectedRows;
  return ids.slice(0, deletedCount).map((id) => ({ main: { [pk]: id } }));
}
