import type { FastifyRequest } from 'fastify';
import type { QueryClient } from './db.js';
import { ConditionBuilder, type ConditionValue, type ConditionValueOrUndefined } from 'node-condition-builder';
import type {
  ITable,
  SqlApiPluginOptions,
  TenantId,
  TenantScope,
  TenantScopeIndirect,
  TenantContext,
} from '../types.js';

function isIndirect(scope: TenantScope): scope is TenantScopeIndirect {
  return 'through' in scope;
}

export async function resolveTenant(
  options: SqlApiPluginOptions,
  tableConf: ITable,
  request: FastifyRequest
): Promise<TenantContext | undefined> {
  if (!options.getTenantId) return undefined;
  if (!tableConf.tenantScope) return undefined;

  const raw = await options.getTenantId(request);
  if (raw == null) return undefined; // admin

  const ids: TenantId[] = Array.isArray(raw) ? raw : [raw];
  return { ids, scope: tableConf.tenantScope };
}

export function buildTenantCondition(
  db: QueryClient,
  scope: TenantScope,
  tenantIds: TenantId[]
): ConditionBuilder {
  const col = scope.column;
  let qualifier: string;

  if (isIndirect(scope)) {
    const throughTable = scope.through.schema.tableName;
    qualifier = `${db.qi(throughTable)}.${db.qi(col)}`;
  } else {
    qualifier = db.qi(col);
  }

  const cb = new ConditionBuilder('AND');
  cb.isIn(qualifier, tenantIds);
  return cb;
}

export function buildTenantJoin(
  db: QueryClient,
  scope: TenantScopeIndirect,
  mainTableName: string
): string {
  const throughTable = scope.through.schema.tableName;
  const localField = scope.through.localField;
  const foreignField = scope.through.foreignField;

  return `INNER JOIN ${db.qi(throughTable)} ON ${db.qi(mainTableName)}.${db.qi(localField)} = ${db.qi(throughTable)}.${db.qi(foreignField)}`;
}

export function injectTenantValue(
  record: Record<string, unknown>,
  scope: TenantScope,
  tenantIds: TenantId[]
): void {
  if (isIndirect(scope)) return;

  const col = scope.column;
  if (col in record) {
    if (!tenantIds.includes(record[col] as TenantId)) {
      const err = new Error('Access denied: tenant value does not match') as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }
    return;
  }

  if (tenantIds.length === 1) {
    record[col] = tenantIds[0];
    return;
  }

  const err = new Error('Ambiguous tenant: specify the tenant value') as Error & { statusCode: number };
  err.statusCode = 400;
  throw err;
}

export async function validateTenantFK(
  db: QueryClient,
  scope: TenantScopeIndirect,
  tenantIds: TenantId[],
  fkValues: unknown[]
): Promise<void> {
  if (!fkValues.length) return;

  const uniqueFKs = [...new Set(fkValues.filter((v) => v != null))];
  if (!uniqueFKs.length) return;

  const throughTable = scope.through.schema.tableName;
  const foreignField = scope.through.foreignField;
  const tenantCol = scope.column;

  const cb = new ConditionBuilder('AND');
  cb.isIn(db.qi(foreignField), uniqueFKs as ConditionValue[]);
  cb.isNotIn(db.qi(tenantCol), tenantIds);
  const where = cb.build(1, db.ph);
  const values = cb.getValues();

  const sql =
    `SELECT ${db.qi(foreignField)} FROM ${db.qi(throughTable)} ` +
    `WHERE ${where}`;

  const result = await db.query(sql, values);

  if (result.rows.length > 0) {
    const err = new Error('Access denied: records do not belong to tenant') as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
}

/**
 * Build WHERE clause for DELETE with tenant filtering.
 * Handles both direct (simple AND) and indirect (subquery via JOIN) scopes.
 */
export function buildTenantDeleteWhere(
  db: QueryClient,
  tableName: string,
  pkCol: string,
  pkValue: ConditionValueOrUndefined | ConditionValue[],
  tenant: TenantContext
): { where: string; values: unknown[] } {
  if (isIndirect(tenant.scope)) {
    const innerCb = new ConditionBuilder('AND');
    innerCb.isIn(`${db.qi(tableName)}.${db.qi(pkCol)}`, (Array.isArray(pkValue) ? pkValue : [pkValue]) as ConditionValue[]);
    innerCb.append(buildTenantCondition(db, tenant.scope, tenant.ids));
    const innerWhere = innerCb.build(1, db.ph);
    const values = innerCb.getValues();
    const joinSql = buildTenantJoin(db, tenant.scope, tableName);
    const where = `${db.qi(pkCol)} IN (SELECT ${db.qi(tableName)}.${db.qi(pkCol)} FROM ${db.qi(tableName)} ${joinSql} WHERE ${innerWhere})`;
    return { where, values };
  }

  const cb = new ConditionBuilder('AND');
  if (Array.isArray(pkValue)) {
    cb.isIn(db.qi(pkCol), pkValue);
  } else {
    cb.isEqual(db.qi(pkCol), pkValue);
  }
  cb.append(buildTenantCondition(db, tenant.scope, tenant.ids));
  const where = cb.build(1, db.ph);
  const values = cb.getValues();
  return { where, values };
}

export function stripTenantColumn(
  fields: Record<string, unknown>,
  scope: TenantScope
): void {
  if (isIndirect(scope)) return;
  delete fields[scope.column];
}
