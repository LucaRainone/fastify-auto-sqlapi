/**
 * The four join families, each executed against the rows the main query returned.
 *
 *   joinMustExist  child -> main, 1:N   EXISTS filter on the main query (returns no rows)
 *   joinMultiple   child -> main, 1:N   side query, rows under result.joinMultiple.<alias>
 *   joinGroup      child -> main, 1:N   aggregations under result.joinGroup.<alias>
 *   joinLeft       parent -> main, N:1  real LEFT JOIN on demand + side query for the rows
 */
import { ConditionBuilder, Expression, type ConditionValue } from 'node-condition-builder';
import type { QueryClient } from '../../db.js';
import type { QueryParams } from '../query-params.js';
import { assertReadable, assertFiltersReadable, hasOwnField, ownField } from '../../read-access.js';
import { ALLOWED_SET } from '../../condition-methods.js';
import {
  err400,
  validateSchemaField,
  evaluateComputedField,
  mapRowsToCamelCase,
  buildSelectionColumns,
} from './fields.js';
import {
  appendJoinTenantScope,
  subqueryAlias,
  requireJoin,
  extractJoinRefs,
} from './joins.js';
import { tenantForTable, buildTenantRowGuard } from '../../tenant.js';
import { dispatchConditionMethod, buildJoinRefCondition } from './conditions.js';
import { AGG_FN, aggExpr } from './aggregations.js';
import type {
  AggregationRequest,
  DbTables,
  FilterRecord,
  ITable,
  JoinFetchRequest,
  JoinGroupRequest,
  JoinRefFilter,
  SchemaDefinition,
  SearchCondition,
  TenantContext,
  ComputedFieldFn,
} from '../../../types.js';

// ─── joinLeft: LEFT JOIN clause builder ─────────────────────

interface LeftJoinOnBuild {
  joinClauses: string[];
  values: unknown[];
}

interface LeftJoinFilterBuild {
  whereExtras: string[];
  values: unknown[];
}

/** Everything needed to resolve one joinLeft alias's fields to alias-qualified SQL. */
interface JoinLeftFieldScope {
  db: QueryClient;
  alias: string;
  aliasIdent: string;
  joinSchema: SchemaDefinition;
  computed: Record<string, ComputedFieldFn> | undefined;
}

/**
 * Resolve a joinLeft field to an alias-qualified SQL reference: a schema column, or a
 * computed field's expression. Returns null when the field is neither — the caller decides
 * whether that is a silent skip (filters) or a 400 (conditions).
 *
 * References go through the alias, not the table name, so they hit the LEFT JOIN'd row.
 */
function resolveJoinLeftField(
  field: string,
  scope: JoinLeftFieldScope
): Expression | null {
  const { db, alias, aliasIdent, joinSchema, computed } = scope;
  if (hasOwnField(joinSchema.fields, field)) {
    // Wrapped so this helper has a single return type. A value-less Expression renders
    // verbatim (see renderField), so the emitted SQL is identical to the raw identifier.
    return new Expression(`${aliasIdent}.${db.qi(joinSchema.col(field))}`);
  }
  const fn = ownField(computed, field);
  if (fn) {
    // Bound values are allowed: this ConditionBuilder's SQL lands in the WHERE clause.
    return evaluateComputedField(field, fn, joinSchema, db, alias, '', true);
  }
  return null;
}

/** `joinLeft.filters` — equality only. Unknown keys are ignored, as they always were. */
function applyJoinLeftFilters(
  cb: ConditionBuilder,
  filters: FilterRecord,
  scope: JoinLeftFieldScope
): void {
  for (const [field, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    const ref = resolveJoinLeftField(field, scope);
    if (ref !== null) cb.isEqual(ref, value);
  }
}

/** `joinLeft.conditions` — operator methods. An unknown field is a 400, not a no-op. */
function applyJoinLeftConditions(
  cb: ConditionBuilder,
  conditions: SearchCondition[],
  scope: JoinLeftFieldScope,
  dbTables: DbTables
): void {
  for (const c of conditions) {
    if (!ALLOWED_SET.has(c.method)) {
      err400(`Invalid condition method: ${c.method}`);
    }
    if (hasOwnField(scope.joinSchema.fields, c.field)) {
      assertReadable(dbTables[scope.joinSchema.tableName], c.field);
    } else if (!ownField(scope.computed, c.field)) {
      err400(`Unknown field: ${c.field}`);
    }
    const ref = resolveJoinLeftField(c.field, scope);
    if (ref !== null) dispatchConditionMethod(cb, c.method, ref, c.params ?? []);
  }
}

/**
 * The LEFT JOIN clauses themselves, each carrying the joined table's own tenant scope.
 *
 * The scope belongs in the ON clause, not the WHERE. In the WHERE it would discard main rows
 * whose parent belongs to another tenant, silently turning the LEFT JOIN into an INNER JOIN.
 * In the ON clause a foreign parent simply fails to match and reads as NULL, which closes the
 * oracle: the parent rows are already withheld from the response (`executeJoinLeft` scopes its
 * own side query), so an unscoped join would let a caller filter on values it cannot see and
 * recover them one predicate at a time.
 *
 * Emitted before the WHERE fragments because that is where it lands in the statement — MySQL
 * binds `?` positionally.
 */
export function buildLeftJoinOnClauses(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  aliasesNeedingJoin: Set<string>,
  startIdx: number,
  tenant?: TenantContext
): LeftJoinOnBuild {
  const joinClauses: string[] = [];
  const values: unknown[] = [];
  let currentIdx = startIdx;

  for (const alias of aliasesNeedingJoin) {
    const joinDef = requireJoin(tableConf, alias, true);
    const refs = extractJoinRefs(db, tableConf, joinDef);
    const aliasIdent = db.qi(alias);

    // The guard references the join through its ALIAS: one table may be joined under several
    // aliases, and each predicate must bind to the row this clause produced.
    const guard = buildTenantRowGuard(
      db,
      tenantForTable(tenant, dbTables[joinDef.joinSchema.tableName]),
      alias
    );

    let scoped = '';
    if (guard) {
      scoped = ` AND ${guard.build(currentIdx, db.ph)}`;
      const guardValues = guard.getValues();
      values.push(...guardValues);
      currentIdx += guardValues.length;
    }

    joinClauses.push(
      `LEFT JOIN ${refs.joinTable} AS ${aliasIdent} ON ${aliasIdent}.${refs.fkCol} = ${refs.mainTable}.${refs.mainCol}${scoped}`
    );
  }

  return { joinClauses, values };
}

/** The WHERE fragments a `joinLeft` request's own filters and conditions contribute. */
export function buildLeftJoinFilters(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  aliasesNeedingJoin: Set<string>,
  joinLeft: Record<string, JoinFetchRequest> | undefined,
  startIdx: number
): LeftJoinFilterBuild {
  const whereExtras: string[] = [];
  const values: unknown[] = [];
  let currentIdx = startIdx;

  for (const alias of aliasesNeedingJoin) {
    const joinDef = requireJoin(tableConf, alias, true);
    const { joinSchema } = joinDef;
    const aliasIdent = db.qi(alias);

    const ref = joinLeft?.[alias];
    if (!ref || !(ref.filters || ref.conditions?.length)) continue;

    // extraFilters declared on joinTableConf are not supported for joinLeft (they would
    // require alias-aware handlers); only schema and computed fields apply.
    // `assertJoinFilterKeys` rejects them up front rather than letting them through as a
    // silent no-op, and the generated body schema does not advertise them for unique:true
    // relations.
    const joinTableConf = dbTables[joinSchema.tableName];
    const scope: JoinLeftFieldScope = {
      db,
      alias,
      aliasIdent,
      joinSchema,
      computed: joinTableConf?.computedFields,
    };
    const cb = new ConditionBuilder('AND', db.cbDialect);

    assertFiltersReadable(ref.filters, joinTableConf);
    if (ref.filters) applyJoinLeftFilters(cb, ref.filters, scope);
    if (ref.conditions?.length) applyJoinLeftConditions(cb, ref.conditions, scope, dbTables);

    const sql = cb.build(currentIdx, db.ph);
    const vals = cb.getValues();
    if (sql) {
      whereExtras.push(sql);
      values.push(...vals);
      currentIdx += vals.length;
    }
  }

  return { whereExtras, values };
}

// ─── Row-returning join families (side query per alias) ─────

/**
 * Correlate a join side query to the rows the main query returned (`fk IN (ids)`) and apply
 * the tenant scope, then freeze it into SQL.
 *
 * Placeholders start at 1 because every side query is a statement of its own.
 */
function scopeJoinSideQuery(
  cb: ConditionBuilder,
  db: QueryClient,
  joinSchema: SchemaDefinition,
  joinField: string,
  ids: ConditionValue[],
  joinTableConf: ITable | undefined,
  tenant: TenantContext | undefined
): { where: string; values: unknown[]; tenantJoins: string[] } {
  cb.isIn(`${db.qi(joinSchema.tableName)}.${db.qi(joinSchema.col(joinField))}`, ids);

  const tenantJoins: string[] = [];
  appendJoinTenantScope(db, joinTableConf, tenant, joinSchema.tableName, cb, tenantJoins);

  const where = cb.build(1, db.ph);
  return { where, values: cb.getValues(), tenantJoins };
}

/**
 * Fetch related rows for one join family with a side query: `SELECT … WHERE fk IN (ids)`.
 *
 * `joinMultiple` (1:N children) and `joinLeft` (N:1 parents) run the same query shape and
 * differ in exactly the two flags below.
 */
interface JoinFetchMode {
  /** joinLeft is the N:1 parent direction, which only a `unique: true` relation may serve. */
  requireUnique: boolean;
  /**
   * Whether the request's `filters`/`conditions` are applied to this side query.
   *
   * False for joinLeft: those are applied inline on the main query's LEFT JOIN (see
   * `buildLeftJoinClauses`), and applying them again here would filter the parent rows a
   * second time.
   */
  applyRefCondition: boolean;
}

async function fetchJoinRows(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  mainResults: Record<string, unknown>[],
  requests: Record<string, JoinFetchRequest>,
  mode: JoinFetchMode,
  tenant?: TenantContext
): Promise<Record<string, Record<string, unknown>[]>> {
  const result: Record<string, Record<string, unknown>[]> = {};

  for (const [alias, ref] of Object.entries(requests)) {
    const joinDef = requireJoin(tableConf, alias, mode.requireUnique);
    const { joinSchema, joinField, mainField, selection: defaultSelection } = joinDef;
    const joinTableConf = dbTables[joinSchema.tableName];

    // The selection is resolved before the empty-result bail-out: it is validated against
    // the join schema, and that rejection must not depend on whether the main query
    // matched rows.
    const selection = ref?.selection ?? defaultSelection;
    const columns = buildSelectionColumns(selection, joinSchema, db, joinTableConf, joinDef.fields !== undefined);

    // For joinLeft, mainField on the main table is the FK pointing at joinField (the
    // parent's PK), so the same collect-then-look-up works for both directions.
    const ids = collectIds(mainResults, mainField);
    if (ids.length === 0) {
      result[alias] = [];
      continue;
    }

    const cb = mode.applyRefCondition
      ? buildJoinRefCondition(joinTableConf, joinSchema, ref || {}, db)
      : new ConditionBuilder('AND', db.cbDialect);

    const { where, values, tenantJoins } = scopeJoinSideQuery(
      cb, db, joinSchema, joinField, ids, joinTableConf, tenant
    );

    const rows = await db.select({
      tableName: joinSchema.tableName,
      columns,
      where,
      values,
      joins: tenantJoins.length > 0 ? tenantJoins : undefined,
    });

    result[alias] = mapRowsToCamelCase(rows, joinSchema);
  }

  return result;
}

/** joinMultiple: 1:N children, returned as rows under `result.joinMultiple.<alias>`. */
export function executeJoinMultiple(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  mainResults: Record<string, unknown>[],
  joinMultiple: Record<string, JoinFetchRequest>,
  tenant?: TenantContext
): Promise<Record<string, Record<string, unknown>[]>> {
  return fetchJoinRows(db, dbTables, tableConf, mainResults, joinMultiple, {
    requireUnique: false,
    applyRefCondition: true,
  }, tenant);
}

/** joinLeft: N:1 parents, returned as rows under `result.joinLeft.<alias>`. */
export function executeJoinLeft(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  mainResults: Record<string, unknown>[],
  joinLeft: Record<string, JoinFetchRequest>,
  tenant?: TenantContext
): Promise<Record<string, Record<string, unknown>[]>> {
  return fetchJoinRows(db, dbTables, tableConf, mainResults, joinLeft, {
    requireUnique: true,
    applyRefCondition: false,
  }, tenant);
}

/**
 * Resolve `aggregations.by` to a SQL expression. Accepts:
 *  - a schema field name → quoted column reference
 *  - a computed-field name declared on the join table → its expr (no bound
 *    values supported in this position; reject with 400 if the computed
 *    returns values)
 */
function buildByExpression(
  by: string,
  joinSchema: SchemaDefinition,
  joinTableConf: ITable | undefined,
  db: QueryClient
): string {
  if (typeof by !== 'string') {
    err400(`Invalid 'by' specification: expected a field or computed name`);
  }
  if (hasOwnField(joinSchema.fields, by)) {
    // validateSchemaField also enforces readExclude: GROUP BY on a hidden field
    // would return its distinct values verbatim in `rows[].by`.
    const col = validateSchemaField(by, joinSchema, joinTableConf);
    return `${db.qi(joinSchema.tableName)}.${db.qi(col)}`;
  }
  const fn = ownField(joinTableConf?.computedFields, by);
  if (fn) {
    return evaluateComputedField(
      by, fn, joinSchema, db, undefined,
      `Computed field '${by}' with bound values cannot be used in aggregations.by`,
    ).value;
  }
  err400(`Unknown field: ${by}`);
}

// ─── joinGroup (aggregations) ───────────────────────────────

/**
 * SELECT and GROUP BY fragments for one joinGroup alias.
 *
 * Every field is validated against the join schema here, so an unknown or unreachable one
 * is a 400 regardless of what the data happens to contain.
 */
function buildJoinGroupSelect(
  aggregations: AggregationRequest,
  joinSchema: SchemaDefinition,
  joinTableConf: ITable | undefined,
  db: QueryClient
): { selectParts: string[]; groupByParts: string[] } {
  const selectParts: string[] = [];
  const groupByParts: string[] = [];

  if (aggregations.by) {
    const byExpr = buildByExpression(aggregations.by, joinSchema, joinTableConf, db);
    selectParts.push(`${byExpr} as "by"`);
    groupByParts.push(byExpr);
  }

  const addAgg = (kind: string, fields: string[] | undefined): void => {
    if (!fields) return;
    const fn = AGG_FN[kind];
    for (const f of fields) {
      const col = validateSchemaField(f, joinSchema, joinTableConf);
      const colRef = `${db.qi(joinSchema.tableName)}.${db.qi(col)}`;
      selectParts.push(`${aggExpr(fn, colRef)} as "${kind}_${f}"`);
    }
  };
  addAgg('distinctCount', aggregations.distinctCount);
  addAgg('min', aggregations.min);
  addAgg('max', aggregations.max);
  addAgg('sum', aggregations.sum);
  addAgg('avg', aggregations.avg);
  addAgg('count', aggregations.count);

  return { selectParts, groupByParts };
}

/**
 * Shape aggregation rows into the response: a single row without `by` collapses to
 * `{ fn: { field: value } }`; anything else stays a list under `rows`.
 */
function formatJoinGroupRows(
  rows: Record<string, unknown>[],
  hasBy: boolean
): Record<string, unknown> {
  const formatted: Record<string, unknown> = {};
  if (rows.length === 0) return formatted;

  const row = rows.length === 1 && !hasBy ? rows[0] : rows;
  if (Array.isArray(row)) {
    formatted.rows = row;
    return formatted;
  }

  for (const [key, value] of Object.entries(row)) {
    if (key === 'by') continue;
    const [fn, field] = key.split('_');
    if (!formatted[fn]) formatted[fn] = {};
    (formatted[fn] as Record<string, unknown>)[field] = value;
  }
  return formatted;
}

export async function executeJoinGroup(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  mainResults: Record<string, unknown>[],
  joinGroup: Record<string, JoinGroupRequest>,
  tenant?: TenantContext
): Promise<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = {};

  for (const [alias, groupReq] of Object.entries(joinGroup)) {
    const joinDef = requireJoin(tableConf, alias, false);
    const { joinSchema, joinField, mainField } = joinDef;
    const joinTableConf = dbTables[joinSchema.tableName];

    const ids = collectIds(mainResults, mainField);

    const { aggregations, filters: groupFilters, conditions: groupConditions } = groupReq;
    const { selectParts, groupByParts } = buildJoinGroupSelect(
      aggregations, joinSchema, joinTableConf, db
    );

    // Bail out only here: `by` and every aggregation field have now been validated.
    if (selectParts.length === 0 || ids.length === 0) {
      result[alias] = {};
      continue;
    }

    const groupRef = { filters: groupFilters, conditions: groupConditions };
    const cb = buildJoinRefCondition(joinTableConf, joinSchema, groupRef, db);
    const { where, values, tenantJoins } = scopeJoinSideQuery(
      cb, db, joinSchema, joinField, ids, joinTableConf, tenant
    );

    const groupBy = groupByParts.length > 0 ? `GROUP BY ${groupByParts.join(', ')}` : '';
    const fromJoins = tenantJoins.length > 0 ? ` ${tenantJoins.join(' ')}` : '';
    const sql = `SELECT ${selectParts.join(', ')} FROM ${db.qi(joinSchema.tableName)}${fromJoins} WHERE ${where} ${groupBy}`;

    const queryResult = await db.query(sql, values);

    result[alias] = formatJoinGroupRows(queryResult.rows, Boolean(aggregations.by));
  }

  return result;
}

// ─── ID collection ──────────────────────────────────────────

function collectIds(
  mainResults: Record<string, unknown>[],
  mainField: string | string[]
): ConditionValue[] {
  if (Array.isArray(mainField)) {
    const seen = new Set<string>();
    const ids: ConditionValue[] = [];
    for (const r of mainResults) {
      const key = mainField.map((f) => r[f]).join('|');
      if (!seen.has(key) && mainField.every((f) => r[f] != null)) {
        seen.add(key);
        ids.push(...mainField.map((f) => r[f] as ConditionValue));
      }
    }
    return ids;
  }
  return [...new Set(mainResults.map((r) => r[mainField]).filter((v) => v != null))] as ConditionValue[];
}

// ─── joinMustExist (EXISTS subquery filter on main) ─────────

export function buildJoinMustExistClauses(
  params: QueryParams,
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  joinMustExist: Record<string, JoinRefFilter>,
  tenant?: TenantContext
): string {
  let where = '';

  for (const [alias, ref] of Object.entries(joinMustExist)) {
    const joinDef = requireJoin(tableConf, alias, false);
    const { joinSchema } = joinDef;
    const joinTableConf = dbTables[joinSchema.tableName];
    const refs = extractJoinRefs(db, tableConf, joinDef);

    // The EXISTS FROM is aliased so the correlation to the outer table survives a
    // self-referencing relation; everything inside references the alias.
    const subAlias = subqueryAlias(alias, tableConf);
    const subRef = db.qi(subAlias);

    const filterCondition = buildJoinRefCondition(joinTableConf, joinSchema, ref, db, subAlias);
    const tenantJoins: string[] = [];
    appendJoinTenantScope(db, joinTableConf, tenant, subAlias, filterCondition, tenantJoins);
    const filterWhere = params.emitCondition(filterCondition, db);

    const innerWhere = filterWhere
      ? `${subRef}.${refs.fkCol} = ${refs.mainTable}.${refs.mainCol} AND ${filterWhere}`
      : `${subRef}.${refs.fkCol} = ${refs.mainTable}.${refs.mainCol}`;

    const existsJoins = tenantJoins.length > 0 ? ` ${tenantJoins.join(' ')}` : '';
    where += ` AND EXISTS (SELECT 1 FROM ${refs.joinTable} AS ${subRef}${existsJoins} WHERE ${innerWhere})`;
  }

  return where;
}

