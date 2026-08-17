import type { FastifyRequest } from 'fastify';
import type { QueryClient } from './db.js';
import { ConditionBuilder, type ConditionValue, type ConditionValueOrUndefined } from 'node-condition-builder';
import { httpError } from './errors.js';
import type {
  DbTables,
  ITable,
  SqlApiPluginOptions,
  TenantId,
  TenantScope,
  TenantScopeDirect,
  TenantScopeIndirect,
  TenantScopeAnyOf,
  TenantContext,
} from '../types.js';

function isIndirect(scope: TenantScope): scope is TenantScopeIndirect {
  return 'through' in scope;
}

function isAnyOf(scope: TenantScope): scope is TenantScopeAnyOf {
  return 'anyOf' in scope;
}

/**
 * The tenant columns living on the scoped table itself, in declaration order: one for a direct
 * scope, several for an `anyOf` one. Never called for an indirect scope, whose column belongs to
 * the through table.
 */
function ownColumns(scope: TenantScope): string[] {
  return isAnyOf(scope) ? scope.anyOf : [scope.column];
}

/**
 * Whether this request could touch a scoped row at all: the addressed table is scoped, or one of
 * the tables it can reach through a declared relation is.
 *
 * Relations are what makes the second case necessary — a relation is a read grant on its target
 * and a write join a write grant, so a deliberately public host must still carry its neighbours'
 * scopes into the joins and secondaries it drives. One level is the whole reach: joins resolve
 * from the addressed table's own `allowedReadJoins`/`allowedWriteJoins` and never chain further.
 *
 * When nothing scoped is in reach, `getTenantId` is not called at all — a request that cannot
 * read or write a scoped row should not pay for resolving a tenant, and consumer code that
 * assumes an authenticated request should not run on routes that never needed one.
 */
function scopeInReach(tableConf: ITable, dbTables: DbTables | undefined): boolean {
  if (tableConf.tenantScope) return true;
  if (!dbTables) return false;

  const relations = [...(tableConf.allowedReadJoins ?? []), ...(tableConf.allowedWriteJoins ?? [])];
  return relations.some((join) => dbTables[join.joinSchema.tableName]?.tenantScope !== undefined);
}

export async function resolveTenant(
  options: SqlApiPluginOptions,
  tableConf: ITable,
  request: FastifyRequest
): Promise<TenantContext | undefined> {
  if (!options.getTenantId) return undefined;
  if (!scopeInReach(tableConf, options.DbTables)) return undefined;

  const raw = await options.getTenantId(request);
  if (raw == null) return undefined; // admin

  const ids: TenantId[] = Array.isArray(raw) ? raw : [raw];
  // `scope` stays undefined for an unscoped host: the ids still travel, so the tables it reaches
  // enforce their own scopes, while the host itself keeps no filter.
  return { ids, scope: tableConf.tenantScope };
}

/**
 * The read predicate for a scope, as a fragment every caller appends to its own WHERE.
 *
 * An `anyOf` scope returns an OR-mode builder — the row is visible when any listed column holds
 * a tenant id — and every caller appends it, so the group keeps its own parentheses. A NULL
 * column simply fails to match, which is the wanted behaviour: the other party still decides.
 */
export function buildTenantCondition(
  db: QueryClient,
  scope: TenantScope,
  tenantIds: TenantId[],
  ownTable: string
): ConditionBuilder {
  if (isIndirect(scope)) {
    const throughTable = scope.through.schema.tableName;
    const cb = new ConditionBuilder('AND', db.cbDialect);
    cb.isIn(`${db.qi(throughTable)}.${db.qi(scope.column)}`, tenantIds);
    return cb;
  }

  // Qualify with the table the scope columns live on: the statement may carry
  // joins, and a bare column shared with a joined table would be ambiguous.
  const cols = ownColumns(scope);
  const cb = new ConditionBuilder(cols.length > 1 ? 'OR' : 'AND', db.cbDialect);
  for (const col of cols) {
    cb.isIn(`${db.qi(ownTable)}.${db.qi(col)}`, tenantIds);
  }
  return cb;
}

/**
 * Re-target a tenant context onto a related table: the caller's tenant ids paired with that
 * table's OWN scope. A child table declares its own `tenantScope`, which may differ in shape
 * from the main table's, so a write to it must be checked against its own column/through-FK.
 *
 * Returns undefined for the two cases that must stay unscoped — no tenant context (admin) and
 * a table that declares no scope — mirroring `appendJoinTenantScope` on the read side.
 */
export function tenantForTable(
  tenant: TenantContext | undefined,
  tableConf: ITable | undefined
): TenantContext | undefined {
  const scope = tableConf?.tenantScope;
  if (!tenant || !scope) return undefined;
  return { ids: tenant.ids, scope };
}

/**
 * Tenant guard as a self-contained boolean fragment, for the positions where the scope cannot
 * be expressed as an extra INNER JOIN: a child DELETE, a LEFT JOIN's ON clause, and the
 * correlated subquery of an aggregation. A direct scope compares the table's own column; an
 * indirect one tests the through table with a correlated EXISTS rather than a join.
 *
 * `tableRef` is the name the scoped rows go by in that statement — the table name in a DELETE,
 * the join alias in an ON clause, the subquery alias inside a correlated SELECT. Returns
 * undefined without a tenant context (admin) or when the table carries no scope.
 */
export function buildTenantRowGuard(
  db: QueryClient,
  tenant: TenantContext | undefined,
  tableRef: string
): ConditionBuilder | undefined {
  const scope = tenant?.scope;
  if (!tenant || !scope) return undefined;

  const cb = new ConditionBuilder('AND', db.cbDialect);
  if (!isIndirect(scope)) {
    cb.append(buildTenantCondition(db, scope, tenant.ids, tableRef));
    return cb;
  }

  const { through, column } = scope;
  const throughRef = db.qi(through.schema.tableName);
  const markers = tenant.ids.map(() => '?').join(', ');
  cb.raw(
    `EXISTS (SELECT 1 FROM ${throughRef} WHERE ` +
      `${throughRef}.${db.qi(through.foreignField)} = ${db.qi(tableRef)}.${db.qi(through.localField)} AND ` +
      `${throughRef}.${db.qi(column)} IN (${markers}))`,
    tenant.ids
  );
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

/**
 * The insert-side rule for an `anyOf` scope: the payload must anchor the row itself.
 *
 * Nothing is auto-injected — with several owner columns the plugin cannot know which party the
 * caller is meant to be, and guessing would either invent a relationship or refuse a legitimate
 * one. So the record must name at least one listed column, and at least one of the named ones
 * must hold a tenant id. The *other* parties are deliberately left alone: a swap request points
 * at a colleague by definition, and requiring every listed column to match would make the shape
 * unusable.
 *
 * @testonly Exported only so unit tests can exercise it directly.
 */
export function assertTenantAnchor(
  record: Record<string, unknown>,
  scope: TenantScopeAnyOf,
  tenantIds: TenantId[]
): void {
  const present = scope.anyOf.filter((col) => record[col] != null);

  if (!present.length) {
    throw httpError(
      400,
      `Missing tenant anchor: one of ${scope.anyOf.join(', ')} must be set`
    );
  }
  if (!present.some((col) => tenantIds.includes(record[col] as TenantId))) {
    throw httpError(403, 'Access denied: tenant value does not match');
  }
}

/** Writes the tenant value into a record according to its scope.
 * @testonly Exported only so unit tests can exercise it directly.
 */
export function injectTenantValue(
  record: Record<string, unknown>,
  scope: TenantScopeDirect | TenantScopeIndirect,
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

/** Checks that an indirect-scope FK really belongs to the tenant.
 * @testonly Exported only so unit tests can exercise it directly.
 */
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

  const cb = new ConditionBuilder('AND', db.cbDialect);
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
 * Handles both direct (simple AND) and indirect (subquery via JOIN) scopes; a tenant whose
 * addressed table declares no scope yields the plain primary-key clause.
 */
export function buildTenantDeleteWhere(
  db: QueryClient,
  tableName: string,
  pkCol: string,
  pkValue: ConditionValueOrUndefined | ConditionValue[],
  tenant: TenantContext
): { where: string; values: unknown[] } {
  const scope = tenant.scope;

  if (scope && isIndirect(scope)) {
    const innerCb = new ConditionBuilder('AND', db.cbDialect);
    innerCb.isIn(`${db.qi(tableName)}.${db.qi(pkCol)}`, (Array.isArray(pkValue) ? pkValue : [pkValue]) as ConditionValue[]);
    innerCb.append(buildTenantCondition(db, scope, tenant.ids, tableName));
    const innerWhere = innerCb.build(1, db.ph);
    const values = innerCb.getValues();
    const joinSql = buildTenantJoin(db, scope, tableName);
    const where = `${db.qi(pkCol)} IN (SELECT ${db.qi(tableName)}.${db.qi(pkCol)} FROM ${db.qi(tableName)} ${joinSql} WHERE ${innerWhere})`;
    return { where, values };
  }

  const cb = new ConditionBuilder('AND', db.cbDialect);
  if (Array.isArray(pkValue)) {
    cb.isIn(db.qi(pkCol), pkValue);
  } else {
    cb.isEqual(db.qi(pkCol), pkValue);
  }
  if (scope) cb.append(buildTenantCondition(db, scope, tenant.ids, tableName));
  const where = cb.build(1, db.ph);
  const values = cb.getValues();
  return { where, values };
}

/**
 * Guard the conflict target of an UPSERT (INSERT … ON CONFLICT / ON DUPLICATE KEY) on a
 * tenant-scoped table. Without this, an upsert whose conflict key matches a row owned by
 * ANOTHER tenant would silently UPDATE (and, for direct scopes, re-assign) that row, because
 * the conflict is matched by the unique key alone — the tenant is never part of the ON CONFLICT
 * predicate. This pre-checks that no existing row matching the incoming conflict keys belongs to
 * a different tenant, throwing 403 if one does. No-op when `tenant` is undefined.
 *
 * `conflictCols` and the keys of each record are DB column names (snake_case). Records missing
 * any conflict column are skipped (they can only INSERT, never hit a conflict).
 */
export async function assertTenantOwnsConflicts(
  db: QueryClient,
  tenant: TenantContext | undefined,
  tableName: string,
  conflictCols: string[],
  records: Record<string, unknown>[]
): Promise<void> {
  const scope = tenant?.scope;
  if (!tenant || !scope || !conflictCols.length) return;

  // Collect distinct, fully-specified conflict-key tuples.
  const tuples: unknown[][] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (conflictCols.some((c) => r[c] == null)) continue;
    const tuple = conflictCols.map((c) => r[c]);
    const key = tuple.map((v) => String(v)).join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    tuples.push(tuple);
  }
  if (!tuples.length) return;

  const qTable = db.qi(tableName);
  const values: unknown[] = [];

  // Conflict-match clause: `col IN (...)` for a single key, OR-of-AND tuples for composite keys.
  let matchSql: string;
  if (conflictCols.length === 1) {
    const col = `${qTable}.${db.qi(conflictCols[0])}`;
    const phs = tuples.map((t) => {
      values.push(t[0]);
      return db.ph(values.length);
    });
    matchSql = `${col} IN (${phs.join(', ')})`;
  } else {
    const groups = tuples.map((t) => {
      const parts = conflictCols.map((c, i) => {
        values.push(t[i]);
        return `${qTable}.${db.qi(c)} = ${db.ph(values.length)}`;
      });
      return `(${parts.join(' AND ')})`;
    });
    matchSql = `(${groups.join(' OR ')})`;
  }

  // Tenant-mismatch clause: rows whose tenant is NOT one the caller owns.
  let joinSql = '';
  let tenantCols: string[];
  if (isIndirect(scope)) {
    joinSql = ` ${buildTenantJoin(db, scope, tableName)}`;
    tenantCols = [`${db.qi(scope.through.schema.tableName)}.${db.qi(scope.column)}`];
  } else {
    tenantCols = ownColumns(scope).map((c) => `${qTable}.${db.qi(c)}`);
  }
  const inClause = (col: string): string => {
    const phs = tenant.ids.map((id) => {
      values.push(id);
      return db.ph(values.length);
    });
    return `${col} IN (${phs.join(', ')})`;
  };

  let mismatchSql: string;
  if (tenantCols.length === 1) {
    mismatchSql = `${tenantCols[0]} NOT IN (${tenant.ids.map((id) => {
      values.push(id);
      return db.ph(values.length);
    }).join(', ')})`;
  } else {
    // A NULL party makes `IN` return NULL, and `NOT NULL` is not TRUE — a plain negation would
    // let a row with one party NULL and the other owned by a stranger pass the probe unflagged.
    // COALESCE turns "unknown" into "not visible to me", which is what the read side already
    // does implicitly by never matching a NULL.
    mismatchSql = `NOT COALESCE(${tenantCols.map(inClause).join(' OR ')}, FALSE)`;
  }

  const sql = `SELECT 1 FROM ${qTable}${joinSql} WHERE ${matchSql} AND ${mismatchSql} LIMIT 1`;
  const r = await db.query(sql, values);
  if (r.rows.length > 0) {
    throw httpError(403, 'Access denied: upsert conflict target belongs to another tenant');
  }
}

/**
 * For an UPDATE on an indirect-tenant table: the record's ownership is verified against its
 * CURRENT through-FK (`assertTenantOwnership`), but if the payload also changes that FK
 * (`through.localField`), the NEW value must be re-validated — otherwise a caller could move
 * their own record into another tenant's scope. Validates the new FK value against the tenant,
 * throwing 403 on mismatch. No-op for direct/no-tenant or when the FK is not being changed.
 *
 * `updateFields` keys are DB column names (snake_case), matching `through.localField`.
 */
export async function enforceTenantFKOnUpdate(
  db: QueryClient,
  tenant: TenantContext | undefined,
  updateFields: Record<string, unknown>
): Promise<void> {
  if (!tenant?.scope || !isIndirect(tenant.scope)) return;
  const scope = tenant.scope;
  const localCol = scope.through.localField;
  if (!(localCol in updateFields)) return;
  const newValue = updateFields[localCol];
  if (newValue == null) return;
  await validateTenantFK(db, scope, tenant.ids, [newValue]);
}

/**
 * Mutates `fields` in-place: removes the tenant columns from a SET payload (scopes whose columns
 * live on the table itself). An `anyOf` scope drops *every* listed column — neither party can be
 * reassigned, the same spirit as "a tenant cannot move its own row". No-op for indirect scopes.
 */
export function stripTenantColumn(
  fields: Record<string, unknown>,
  scope: TenantScope
): void {
  if (isIndirect(scope)) return;
  for (const col of ownColumns(scope)) delete fields[col];
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
  const scope = tenant?.scope;
  if (!tenant || !scope) return;
  if (isIndirect(scope)) {
    const fkCol = scope.through.localField;
    await validateTenantFK(db, scope, tenant.ids, records.map((r) => r[fkCol]));
    return;
  }
  if (isAnyOf(scope)) {
    for (const r of records) assertTenantAnchor(r, scope, tenant.ids);
    return;
  }
  for (const r of records) injectTenantValue(r, scope, tenant.ids);
}

/**
 * Columns an UPSERT must leave alone when it lands on an existing row.
 *
 * `stripTenantColumn` does this for a plain UPDATE, but an upsert's payload doubles as the
 * INSERT branch, where the owner columns are exactly what anchors a new row — they cannot simply
 * be dropped. So they are excluded from the `DO UPDATE SET` instead: state which party you are
 * to create the row, and that statement is ignored when the row already exists.
 *
 * Only `anyOf` scopes need this. A direct scope injects the caller's own tenant, so writing it
 * back onto a row the conflict guard already proved theirs is a no-op; an indirect one keeps its
 * owner on another table entirely.
 */
export function tenantImmutableColumns(tenant: TenantContext | undefined): string[] {
  if (!tenant?.scope || !isAnyOf(tenant.scope)) return [];
  return tenant.scope.anyOf;
}

/**
 * For update: builds the optional `extraCondition` ConditionBuilder for direct tenants.
 * Returns undefined for indirect or no-tenant scenarios — those are handled separately
 * (indirect uses pre-check via `assertTenantOwnership`).
 */
export function buildTenantUpdateExtra(
  db: QueryClient,
  tenant: TenantContext | undefined
): ConditionBuilder | undefined {
  const scope = tenant?.scope;
  if (!scope || isIndirect(scope)) return undefined;
  const cols = ownColumns(scope);
  const cb = new ConditionBuilder(cols.length > 1 ? 'OR' : 'AND', db.cbDialect);
  for (const col of cols) {
    if (tenant.ids.length === 1) cb.isEqual(col, tenant.ids[0]);
    else cb.isIn(col, tenant.ids);
  }
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
  pkCol: string | string[],
  pkValue: ConditionValue | ConditionValue[]
): Promise<void> {
  if (!tenant?.scope || !isIndirect(tenant.scope)) return;
  const scope = tenant.scope;
  const cb = new ConditionBuilder('AND', db.cbDialect);
  const cols = Array.isArray(pkCol) ? pkCol : [pkCol];
  const vals = Array.isArray(pkValue) ? pkValue : [pkValue];
  cols.forEach((c, i) => cb.isEqual(`${db.qi(tableName)}.${db.qi(c)}`, vals[i]));
  cb.append(buildTenantCondition(db, scope, tenant.ids, tableName));
  const sql = `SELECT 1 FROM ${db.qi(tableName)} ${buildTenantJoin(db, scope, tableName)} WHERE ${cb.build(1, db.ph)} LIMIT 1`;
  const r = await db.query(sql, cb.getValues());
  if (r.rows.length === 0) {
    throw httpError(404, 'Record not found');
  }
}

/**
 * Assert that EVERY pk in `ids` exists and belongs to the tenant, for both direct and indirect
 * scopes. Throws 404 if any id is missing or not owned. No-op when `tenant` is undefined or `ids`
 * is empty. Used by the delete engines to enforce tenant ownership BEFORE running a `beforeDelete`/
 * `beforeBulkDelete` hook, so user code never runs against rows the caller cannot access.
 */
export async function assertTenantOwnsAll(
  db: QueryClient,
  tenant: TenantContext | undefined,
  tableName: string,
  pkCol: string,
  ids: ConditionValue[]
): Promise<void> {
  const scope = tenant?.scope;
  if (!tenant || !scope || !ids.length) return;

  const qualifiedPk = `${db.qi(tableName)}.${db.qi(pkCol)}`;
  const cb = new ConditionBuilder('AND', db.cbDialect);
  cb.isIn(qualifiedPk, ids);
  cb.append(buildTenantCondition(db, scope, tenant.ids, tableName));

  const join = isIndirect(scope) ? ` ${buildTenantJoin(db, scope, tableName)}` : '';
  const sql = `SELECT DISTINCT ${qualifiedPk} AS pk FROM ${db.qi(tableName)}${join} WHERE ${cb.build(1, db.ph)}`;
  const r = await db.query<{ pk: unknown }>(sql, cb.getValues());

  const uniqueRequested = new Set(ids.map((v) => String(v))).size;
  if (r.rows.length < uniqueRequested) {
    throw httpError(404, 'Record not found');
  }
}
