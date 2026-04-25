import type { FastifyRequest } from 'fastify';
import type { QueryClient } from './db.js';
import { ConditionBuilder, type ConditionValue, type ConditionValueOrUndefined } from 'node-condition-builder';
import { httpError } from './errors.js';
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
      throw httpError(403, 'Access denied: tenant value does not match');
    }
    return;
  }

  if (tenantIds.length === 1) {
    record[col] = tenantIds[0];
    return;
  }

  throw httpError(400, 'Ambiguous tenant: specify the tenant value');
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
    throw httpError(403, 'Access denied: records do not belong to tenant');
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

/**
 * Mutates `fields` in-place: removes the tenant column from a SET payload (direct scopes only).
 * No-op for indirect or no scope.
 */
export function stripTenantColumn(
  fields: Record<string, unknown>,
  scope: TenantScope
): void {
  if (isIndirect(scope)) return;
  delete fields[scope.column];
}

/**
 * For insert/bulk-upsert: enforce tenant on records that are about to be written.
 * For direct scopes, mutates each record in-place to inject/validate the tenant column.
 * For indirect scopes, batch-validates the FK values against the tenant scope.
 * Throws 400 (ambiguous tenant) or 403 (mismatch) on violation. No-op when `tenant` is undefined.
 */
export async function enforceTenantOnWrites(
  db: QueryClient,
  tenant: TenantContext | undefined,
  records: Record<string, unknown>[]
): Promise<void> {
  if (!tenant) return;
  if (isIndirect(tenant.scope)) {
    const fkCol = tenant.scope.through.localField;
    await validateTenantFK(db, tenant.scope, tenant.ids, records.map((r) => r[fkCol]));
    return;
  }
  for (const r of records) injectTenantValue(r, tenant.scope, tenant.ids);
}

/**
 * For update: builds the optional `extraCondition` ConditionBuilder for direct tenants.
 * Returns undefined for indirect or no-tenant scenarios — those are handled separately
 * (indirect uses pre-check via `assertTenantOwnership`).
 */
export function buildTenantUpdateExtra(
  tenant: TenantContext | undefined
): ConditionBuilder | undefined {
  if (!tenant || isIndirect(tenant.scope)) return undefined;
  const cb = new ConditionBuilder('AND');
  if (tenant.ids.length === 1) cb.isEqual(tenant.scope.column, tenant.ids[0]);
  else cb.isIn(tenant.scope.column, tenant.ids);
  return cb;
}

/**
 * For update with indirect tenant: pre-check ownership via `SELECT 1 ... INNER JOIN ... LIMIT 1`.
 * Throws 404 if the record either does not exist or does not belong to the tenant.
 * No-op for direct or no-tenant — those are enforced via `extraCondition` in the UPDATE itself.
 */
export async function assertTenantOwnership(
  db: QueryClient,
  tenant: TenantContext | undefined,
  tableName: string,
  pkCol: string,
  pkValue: ConditionValue
): Promise<void> {
  if (!tenant || !isIndirect(tenant.scope)) return;
  const cb = new ConditionBuilder('AND');
  cb.isEqual(`${db.qi(tableName)}.${db.qi(pkCol)}`, pkValue);
  cb.append(buildTenantCondition(db, tenant.scope, tenant.ids));
  const sql = `SELECT 1 FROM ${db.qi(tableName)} ${buildTenantJoin(db, tenant.scope, tableName)} WHERE ${cb.build(1, db.ph)} LIMIT 1`;
  const r = await db.query(sql, cb.getValues());
  if (r.rows.length === 0) {
    throw httpError(404, 'Record not found');
  }
}
