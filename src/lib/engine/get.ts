import { ConditionBuilder } from 'node-condition-builder';
import { camelcaseObject } from '../naming.js';
import { buildTenantCondition, buildTenantJoin } from '../tenant.js';
import type { GetParams, GetResult, TenantScopeIndirect } from '../../types.js';

export async function getEngine(params: GetParams): Promise<GetResult> {
  const { db, tableConf, id, tenant } = params;
  const pkCol = tableConf.Schema.col(tableConf.primary);

  const cb = new ConditionBuilder('AND');
  cb.isEqual(db.qi(pkCol), id);
  const joins: string[] = [];

  if (tenant) {
    cb.append(buildTenantCondition(db, tenant.scope, tenant.ids));
    if ('through' in tenant.scope) {
      joins.push(buildTenantJoin(db, tenant.scope as TenantScopeIndirect, tableConf.Schema.tableName));
    }
  }

  const where = cb.build(1, db.ph);
  const values = cb.getValues();

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
