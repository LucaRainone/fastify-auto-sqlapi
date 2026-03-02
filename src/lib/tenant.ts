import type { FastifyRequest } from 'fastify';
import type { QueryClient } from './db.js';
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

export function buildTenantWhere(
  db: QueryClient,
  scope: TenantScope,
  tenantIds: TenantId[],
  startIndex: number
): { sql: string; values: TenantId[] } {
  const col = scope.column;
  let qualifier: string;

  if (isIndirect(scope)) {
    const throughTable = scope.through.schema.tableName;
    qualifier = `${db.qi(throughTable)}.${db.qi(col)}`;
  } else {
    qualifier = db.qi(col);
  }

  if (tenantIds.length === 1) {
    return { sql: `${qualifier} = ${db.ph(startIndex)}`, values: [tenantIds[0]] };
  }

  const placeholders = tenantIds.map((_, i) => db.ph(startIndex + i)).join(', ');
  return { sql: `${qualifier} IN (${placeholders})`, values: [...tenantIds] };
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

  const fkPlaceholders = uniqueFKs.map((_, i) => db.ph(i + 1)).join(', ');
  const tenantPlaceholders = tenantIds.map((_, i) => db.ph(uniqueFKs.length + i + 1)).join(', ');

  const sql =
    `SELECT ${db.qi(foreignField)} FROM ${db.qi(throughTable)} ` +
    `WHERE ${db.qi(foreignField)} IN (${fkPlaceholders}) ` +
    `AND ${db.qi(tenantCol)} NOT IN (${tenantPlaceholders})`;

  const result = await db.query(sql, [...uniqueFKs, ...tenantIds]);

  if (result.rows.length > 0) {
    const err = new Error('Access denied: records do not belong to tenant') as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
}

export function stripTenantColumn(
  fields: Record<string, unknown>,
  scope: TenantScope
): void {
  if (isIndirect(scope)) return;
  delete fields[scope.column];
}
