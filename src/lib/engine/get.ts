import { camelcaseObject } from '../naming.js';
import { buildTenantWhere, buildTenantJoin } from '../tenant.js';
import type { GetParams, GetResult, TenantScopeIndirect } from '../../types.js';

export async function getEngine(params: GetParams): Promise<GetResult> {
  const { db, tableConf, id, tenant } = params;
  const pkCol = tableConf.Schema.col(tableConf.primary);

  const values: unknown[] = [id];
  let where = `${db.qi(pkCol)} = ${db.ph(1)}`;
  const joins: string[] = [];

  if (tenant) {
    const tw = buildTenantWhere(db, tenant.scope, tenant.ids, values.length + 1);
    where += ` AND ${tw.sql}`;
    values.push(...tw.values);
    if ('through' in tenant.scope) {
      joins.push(buildTenantJoin(db, tenant.scope as TenantScopeIndirect, tableConf.Schema.tableName));
    }
  }

  const rows = await db.select({
    tableName: tableConf.Schema.tableName,
    where,
    values,
    limit: '1',
    joins: joins.length > 0 ? joins : undefined,
  });

  if (rows.length === 0) {
    const err = new Error(`Record not found: ${id}`) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  return { main: camelcaseObject(rows[0] as Record<string, unknown>) };
}
