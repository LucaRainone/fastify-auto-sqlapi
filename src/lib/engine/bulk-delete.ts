import { camelcaseObject } from '../naming.js';
import { escapeIdent } from '../db.js';
import { buildTenantWhere, buildTenantJoin } from '../tenant.js';
import type { BulkDeleteParams, BulkDeleteResult, TenantScopeIndirect } from '../../types.js';

export async function bulkDeleteEngine(params: BulkDeleteParams): Promise<BulkDeleteResult[]> {
  const { db, tableConf, ids, tenant } = params;
  if (!ids.length) return [];

  const pkCol = tableConf.Schema.col(tableConf.primary);
  const tableName = tableConf.Schema.tableName;
  const values: unknown[] = [...ids];
  const idPlaceholders = ids.map((_, i) => `$${i + 1}`).join(', ');

  let where: string;
  if (tenant) {
    const tw = buildTenantWhere(tenant.scope, tenant.ids, values.length + 1);
    values.push(...tw.values);

    if ('through' in tenant.scope) {
      const scope = tenant.scope as TenantScopeIndirect;
      const joinSql = buildTenantJoin(scope, tableName);
      where = `"${escapeIdent(pkCol)}" IN (SELECT "${escapeIdent(tableName)}"."${escapeIdent(pkCol)}" FROM "${escapeIdent(tableName)}" ${joinSql} WHERE "${escapeIdent(tableName)}"."${escapeIdent(pkCol)}" IN (${idPlaceholders}) AND ${tw.sql})`;
    } else {
      where = `"${escapeIdent(pkCol)}" IN (${idPlaceholders}) AND ${tw.sql}`;
    }
  } else {
    where = `"${escapeIdent(pkCol)}" IN (${idPlaceholders})`;
  }

  const result = await db.query(
    `DELETE FROM "${escapeIdent(tableName)}" WHERE ${where} RETURNING *`,
    values
  );

  return result.rows.map((row) => ({
    main: camelcaseObject(row as Record<string, unknown>),
  }));
}
