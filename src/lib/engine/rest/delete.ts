import { buildTenantDeleteWhere } from '../../tenant.js';
import { primaryAsString } from '../../../types.js';
import type { DeleteParams, DeleteResult, DbRecord } from '../../../types.js';

export async function deleteEngine(params: DeleteParams): Promise<DeleteResult> {
  const { db, tableConf, id, tenant } = params;
  const pk = primaryAsString(tableConf.primary);
  const pkCol = tableConf.Schema.col(pk);
  const tableName = tableConf.Schema.tableName;

  if (!tenant) {
    const affectedRows = await db.delete(tableName, { [pkCol]: id } as DbRecord);
    if (affectedRows === 0) {
      const err = new Error(`Record not found: ${id}`) as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    return { main: { [pk]: id } };
  }

  const { where, values } = buildTenantDeleteWhere(db, tableName, pkCol, id, tenant);

  const result = await db.query(
    `DELETE FROM ${db.qi(tableName)} WHERE ${where}`,
    values
  );

  if (result.affectedRows === 0) {
    const err = new Error(`Record not found: ${id}`) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  return { main: { [pk]: id } };
}
