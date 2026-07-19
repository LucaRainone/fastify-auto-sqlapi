import { ConditionBuilder } from 'node-condition-builder';
import { camelcaseObject } from '../../naming.js';
import { buildTenantCondition, buildTenantJoin } from '../../tenant.js';
import { httpError } from '../../errors.js';
import { readableSelectColumns } from '../../read-access.js';
import { primaryAsString } from '../../../types.js';
import type { GetParams, GetResult, TenantScopeIndirect } from '../../../types.js';

export async function getEngine(params: GetParams): Promise<GetResult> {
  const { db, tableConf, id, tenant } = params;
  const pkCol = tableConf.Schema.col(primaryAsString(tableConf.primary));

  const cb = new ConditionBuilder('AND', db.cbDialect);
  // Table-qualified: the tenant scope may add a through-join, and a bare PK column
  // shared with the through table would be ambiguous.
  cb.isEqual(`${db.qi(tableConf.Schema.tableName)}.${db.qi(pkCol)}`, id);
  const joins: string[] = [];

  if (tenant) {
    cb.append(buildTenantCondition(db, tenant.scope, tenant.ids, tableConf.Schema.tableName));
    if ('through' in tenant.scope) {
      joins.push(buildTenantJoin(db, tenant.scope as TenantScopeIndirect, tableConf.Schema.tableName));
    }
  }

  const where = cb.build(1, db.ph);
  const values = cb.getValues();

  const rows = await db.select({
    tableName: tableConf.Schema.tableName,
    columns: readableSelectColumns(tableConf, tableConf.Schema, db),
    where,
    values,
    limit: '1',
    joins: joins.length > 0 ? joins : undefined,
  });

  if (rows.length === 0) throw httpError(404, `Record not found: ${id}`);

  return { main: camelcaseObject(rows[0] as Record<string, unknown>, tableConf.Schema) };
}
