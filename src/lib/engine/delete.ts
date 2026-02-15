import { camelcaseObject } from '../naming.js';
import { escapeIdent } from '../db.js';
import { buildTenantWhere, buildTenantJoin } from '../tenant.js';
import type { DeleteParams, DeleteResult, DbRecord, TenantScopeIndirect } from '../../types.js';

export async function deleteEngine(params: DeleteParams): Promise<DeleteResult> {
  const { db, tableConf, id, tenant } = params;
  const pkCol = tableConf.Schema.col(tableConf.primary);
  const tableName = tableConf.Schema.tableName;

  if (!tenant) {
    const rows = await db.delete(tableName, { [pkCol]: id } as DbRecord);
    if (rows.length === 0) {
      const err = new Error(`Record not found: ${id}`) as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    return { main: camelcaseObject(rows[0]) };
  }

  // With tenant: use raw query to support tenant filtering
  const values: unknown[] = [id];
  let where: string;

  if ('through' in tenant.scope) {
    // Indirect: DELETE ... WHERE pk IN (SELECT pk FROM main INNER JOIN through ...)
    const scope = tenant.scope as TenantScopeIndirect;
    const tw = buildTenantWhere(scope, tenant.ids, values.length + 1);
    values.push(...tw.values);
    const joinSql = buildTenantJoin(scope, tableName);
    where = `"${escapeIdent(pkCol)}" IN (SELECT "${escapeIdent(tableName)}"."${escapeIdent(pkCol)}" FROM "${escapeIdent(tableName)}" ${joinSql} WHERE "${escapeIdent(tableName)}"."${escapeIdent(pkCol)}" = $1 AND ${tw.sql})`;
  } else {
    // Direct: simple AND
    const tw = buildTenantWhere(tenant.scope, tenant.ids, values.length + 1);
    values.push(...tw.values);
    where = `"${escapeIdent(pkCol)}" = $1 AND ${tw.sql}`;
  }

  const result = await db.query(
    `DELETE FROM "${escapeIdent(tableName)}" WHERE ${where} RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    const err = new Error(`Record not found: ${id}`) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  return { main: camelcaseObject(result.rows[0] as Record<string, unknown>) };
}
