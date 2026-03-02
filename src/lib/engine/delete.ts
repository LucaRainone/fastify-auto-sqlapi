import { buildTenantWhere, buildTenantJoin } from '../tenant.js';
import type { DeleteParams, DeleteResult, DbRecord, TenantScopeIndirect } from '../../types.js';

export async function deleteEngine(params: DeleteParams): Promise<DeleteResult> {
  const { db, tableConf, id, tenant } = params;
  const pk = tableConf.primary;
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

  // With tenant: use raw query to support tenant filtering
  const values: unknown[] = [id];
  let where: string;

  if ('through' in tenant.scope) {
    // Indirect: DELETE ... WHERE pk IN (SELECT pk FROM main INNER JOIN through ...)
    const scope = tenant.scope as TenantScopeIndirect;
    const tw = buildTenantWhere(db, scope, tenant.ids, values.length + 1);
    values.push(...tw.values);
    const joinSql = buildTenantJoin(db, scope, tableName);
    where = `${db.qi(pkCol)} IN (SELECT ${db.qi(tableName)}.${db.qi(pkCol)} FROM ${db.qi(tableName)} ${joinSql} WHERE ${db.qi(tableName)}.${db.qi(pkCol)} = ${db.ph(1)} AND ${tw.sql})`;
  } else {
    // Direct: simple AND
    const tw = buildTenantWhere(db, tenant.scope, tenant.ids, values.length + 1);
    values.push(...tw.values);
    where = `${db.qi(pkCol)} = ${db.ph(1)} AND ${tw.sql}`;
  }

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
