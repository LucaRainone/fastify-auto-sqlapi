import { ConditionBuilder } from 'node-condition-builder';
import { buildTenantCondition, buildTenantJoin } from '../tenant.js';
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
  let where: string;
  let values: unknown[];

  if ('through' in tenant.scope) {
    // Indirect: DELETE ... WHERE pk IN (SELECT pk FROM main INNER JOIN through ...)
    const scope = tenant.scope as TenantScopeIndirect;
    const innerCb = new ConditionBuilder('AND');
    innerCb.isEqual(`${db.qi(tableName)}.${db.qi(pkCol)}`, id);
    innerCb.append(buildTenantCondition(db, scope, tenant.ids));
    const innerWhere = innerCb.build(1, db.ph);
    values = innerCb.getValues();
    const joinSql = buildTenantJoin(db, scope, tableName);
    where = `${db.qi(pkCol)} IN (SELECT ${db.qi(tableName)}.${db.qi(pkCol)} FROM ${db.qi(tableName)} ${joinSql} WHERE ${innerWhere})`;
  } else {
    // Direct: simple AND
    const cb = new ConditionBuilder('AND');
    cb.isEqual(db.qi(pkCol), id);
    cb.append(buildTenantCondition(db, tenant.scope, tenant.ids));
    where = cb.build(1, db.ph);
    values = cb.getValues();
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
