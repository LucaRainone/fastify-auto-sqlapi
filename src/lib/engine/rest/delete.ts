import type { FastifyRequest } from 'fastify';
import type { ConditionValue } from 'node-condition-builder';
import { buildTenantDeleteWhere, assertTenantOwnsAll } from '../../tenant.js';
import { httpError } from '../../errors.js';
import { primaryAsString } from '../../../types.js';
import type { DeleteParams, DeleteResult, DbRecord } from '../../../types.js';

export async function deleteEngine(params: DeleteParams): Promise<DeleteResult> {
  const { db, tableConf, id, tenant, request } = params;
  const pk = primaryAsString(tableConf.primary);
  const pkCol = tableConf.Schema.col(pk);
  const tableName = tableConf.Schema.tableName;

  if (tableConf.beforeDelete) {
    // Enforce tenant ownership before the hook so it never runs for rows the tenant
    // cannot access. (When no hook is defined, the tenant-scoped DELETE below already
    // prevents deleting non-owned rows, so the extra SELECT is skipped.)
    await assertTenantOwnsAll(db, tenant, tableName, pkCol, [id as ConditionValue]);
    await tableConf.beforeDelete(db, request as FastifyRequest, id);
  }

  if (!tenant) {
    const affectedRows = await db.delete(tableName, { [pkCol]: id } as DbRecord);
    if (affectedRows === 0) throw httpError(404, `Record not found: ${id}`);
  } else {
    const { where, values } = buildTenantDeleteWhere(db, tableName, pkCol, id, tenant);

    const result = await db.query(
      `DELETE FROM ${db.qi(tableName)} WHERE ${where}`,
      values
    );

    if (result.affectedRows === 0) throw httpError(404, `Record not found: ${id}`);
  }

  if (tableConf.afterDelete) {
    await tableConf.afterDelete(db, request as FastifyRequest, id);
  }

  return { main: { [pk]: id } };
}
