/**
 * Join resolution for the search engine: finding the relation an alias refers to,
 * validating what a request may ask of it, and quoting its identifiers.
 *
 * Relations are *declared* at config time by `buildRelation` (see lib/table-helpers.ts);
 * this module resolves them per request.
 */
import { ConditionBuilder } from 'node-condition-builder';
import type { QueryClient } from '../../db.js';
import { buildTenantCondition, buildTenantJoin } from '../../tenant.js';
import { assertFiltersReadable, assertKnownFilterKeys } from '../../read-access.js';
import { err400 } from './fields.js';
import type {
  DbTables,
  FilterRecord,
  ITable,
  JoinDefinition,
  TenantContext,
} from '../../../types.js';

/**
 * Tenant-scope a join side-query. When the joined table declares its own `tenantScope`,
 * appends the tenant condition to `cb` (direct: `col IN ids`; indirect: condition on the
 * through table) and, for indirect scopes, pushes the INNER JOIN clause into `joins`.
 * No-op without a tenant context (admin) or when the join table is not tenant-scoped.
 *
 * `joinTableRef` is the raw name the join table goes by in the statement: its table name
 * in plain side-queries, or the subquery alias inside an aliased, correlated EXISTS.
 */
export function appendJoinTenantScope(
  db: QueryClient,
  joinTableConf: ITable | undefined,
  tenant: TenantContext | undefined,
  joinTableRef: string,
  cb: ConditionBuilder,
  joins?: string[]
): void {
  const scope = joinTableConf?.tenantScope;
  if (!tenant || !scope) return;
  cb.append(buildTenantCondition(db, scope, tenant.ids, joinTableRef));
  if ('through' in scope) {
    joins?.push(buildTenantJoin(db, scope, joinTableRef));
  }
}

/**
 * Alias for the FROM of a correlated subquery (EXISTS, aggregate). The subquery must not
 * say `FROM <table>` bare: on a self-referencing relation the inner table would shadow the
 * outer one and the correlation would silently compare each row with itself. The request
 * alias is used, suffixed when it would itself collide with the outer table's name.
 */
export function subqueryAlias(alias: string, tableConf: ITable): string {
  return alias === tableConf.Schema.tableName ? `${alias}_sub` : alias;
}

function findJoinByAlias(tableConf: ITable, alias: string): JoinDefinition | undefined {
  return tableConf.allowedReadJoins?.find((j) => j.alias === alias);
}

/**
 * Validate the filter keys of every join reference in a request map.
 *
 * Runs up front, before any query: the executors skip their side-query entirely when the
 * main result set is empty (`ids.length === 0`), so validating there alone would make the
 * same request answer 400 or 200 depending on the data it happens to match.
 *
 * Unknown aliases are left to `requireJoin`, which reports them with its own message.
 */
export function assertJoinFilterKeys(
  dbTables: DbTables,
  tableConf: ITable,
  refs: Record<string, { filters?: FilterRecord }> | undefined,
  allowExtraFilters: boolean
): void {
  if (!refs) return;
  for (const [alias, ref] of Object.entries(refs)) {
    const joinDef = findJoinByAlias(tableConf, alias);
    if (!joinDef) continue;
    const joinTableConf = dbTables[joinDef.joinSchema.tableName];
    const filters = ref?.filters as Record<string, unknown> | undefined;
    assertFiltersReadable(filters, joinTableConf);
    assertKnownFilterKeys(filters, joinDef.joinSchema, joinTableConf, allowExtraFilters);
  }
}

export function requireJoin(
  tableConf: ITable,
  alias: string,
  requireUnique: boolean
): JoinDefinition {
  const joinDef = findJoinByAlias(tableConf, alias);
  if (!joinDef) {
    err400(`Unknown join alias: ${alias}`);
  }
  if (requireUnique && !joinDef.unique) {
    err400(`Join alias '${alias}' is not declared with unique:true; use joinMultiple/joinMustExist/joinGroup instead`);
  }
  if (!requireUnique && joinDef.unique) {
    err400(`Join alias '${alias}' is declared with unique:true; use joinLeft instead`);
  }
  return joinDef;
}

export interface JoinRefs {
  mainColName: string;
  /** db.qi'd column reference on main side (FK or PK) */
  mainCol: string;
  /** db.qi'd table name on main side */
  mainTable: string;
  /** db.qi'd table name on join side */
  joinTable: string;
  /** db.qi'd column reference on join side (FK or PK) */
  fkCol: string;
}

/** Extract quoted identifiers for a join reference. Used by joinMustExist, joinLeft and joinGroup
 * SQL builders to avoid the 4-line FK/PK destructuring boilerplate at every call site. */
export function extractJoinRefs(
  db: QueryClient,
  tableConf: ITable,
  joinDef: JoinDefinition
): JoinRefs {
  const { joinSchema, joinField, mainField } = joinDef;
  const mainColName = Array.isArray(mainField) ? mainField[0] : mainField;
  return {
    mainColName,
    mainCol: db.qi(tableConf.Schema.col(mainColName)),
    mainTable: db.qi(tableConf.Schema.tableName),
    joinTable: db.qi(joinSchema.tableName),
    fkCol: db.qi(joinSchema.col(joinField)),
  };
}
