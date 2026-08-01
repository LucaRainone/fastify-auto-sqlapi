import type { QueryClient } from '../../db.js';
import { ConditionBuilder, Expression, type ConditionValue } from 'node-condition-builder';
import { QueryParams } from '../query-params.js';
import { buildTenantCondition, buildTenantJoin } from '../../tenant.js';
import {
  assertReadable,
  assertFiltersReadable,
  assertKnownFilterKeys,
  readableSelectColumns,
} from '../../read-access.js';
import { primaryAsString } from '../../../types.js';
import {
  validateSchemaField,
  err400,
  resolveFieldRef,
  evaluateComputedField,
  refValues,
  renderRef,
  mapRowsToCamelCase,
  buildSelectionColumns,
} from './fields.js';
import {
  appendJoinTenantScope,
  subqueryAlias,
  assertJoinFilterKeys,
  requireJoin,
  extractJoinRefs,
} from './joins.js';
import type {
  DbTables,
  SearchParams,
  SearchResult,
  SearchCondition,
  PaginationResult,
  JoinGroupRequest,
  AggregationRequest,
  JoinRefFilter,
  JoinFetchRequest,
  FilterRecord,
  ITable,
  SchemaDefinition,
  TenantContext,
  ComputedFieldFn,
} from '../../../types.js';

// ─── Aggregation orderBy / conditions ───────────────────────

interface AggFn { sql: string; distinct: boolean }
const AGG_FN: Record<string, AggFn> = {
  sum:           { sql: 'SUM',   distinct: false },
  min:           { sql: 'MIN',   distinct: false },
  max:           { sql: 'MAX',   distinct: false },
  avg:           { sql: 'AVG',   distinct: false },
  count:         { sql: 'COUNT', distinct: false },
  distinctCount: { sql: 'COUNT', distinct: true  },
};

function aggExpr(fn: AggFn, qualifiedCol: string): string {
  return fn.distinct ? `COUNT(DISTINCT ${qualifiedCol})` : `${fn.sql}(${qualifiedCol})`;
}

/**
 * Correlated aggregate subquery for `<alias>.<fn>.<field>`, as an Expression carrying the
 * values of its optional filter. Markers are `?`, so whoever embeds it — a ConditionBuilder
 * or an ORDER BY list — decides the placeholder positions.
 */
function buildAggOrderExpr(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  alias: string,
  fn: string,
  field: string,
  joinGroup: Record<string, JoinGroupRequest> | undefined
): Expression {
  const aggFn = AGG_FN[fn];
  if (!aggFn) err400(`Invalid aggregation function: ${fn}`);

  const groupReq = joinGroup?.[alias];
  if (!groupReq) err400(`orderBy/conditions reference undeclared joinGroup: ${alias}`);

  const declaredFields = (groupReq.aggregations as Record<string, unknown>)[fn];
  if (!Array.isArray(declaredFields) || !declaredFields.includes(field)) {
    err400(`orderBy/conditions reference undeclared aggregation: ${alias}.${fn}.${field}`);
  }

  const joinDef = requireJoin(tableConf, alias, false);
  const { joinSchema, joinField } = joinDef;

  if (groupReq.aggregations.by && groupReq.aggregations.by !== joinField) {
    err400(`Cannot order by aggregation on joinGroup with 'by' clause on non-FK column: ${alias} (grouped by '${groupReq.aggregations.by}', correlation FK is '${joinField}')`);
  }

  // Pass the join table's conf: without it validateSchemaField skips the readExclude
  // check, and a HAVING-style condition on a hidden field becomes a 400-vs-200 oracle
  // (executeJoinGroup's own validation is skipped when the main result set is empty).
  const fieldCol = validateSchemaField(field, joinSchema, dbTables[joinSchema.tableName]);
  const refs = extractJoinRefs(db, tableConf, joinDef);

  // The subquery FROM is aliased so the correlation to the outer table survives a
  // self-referencing relation; everything inside references the alias.
  const subAlias = subqueryAlias(alias, tableConf);
  const subRef = db.qi(subAlias);

  let filterWhere = '';
  let filterVals: unknown[] = [];
  const joinTableConf = dbTables[joinSchema.tableName];
  if (groupReq.filters || groupReq.conditions?.length) {
    const cb = buildJoinRefCondition(
      joinTableConf,
      joinSchema,
      { filters: groupReq.filters, conditions: groupReq.conditions },
      db,
      subAlias,
    );
    const fragment = cb.toExpression();
    if (fragment.value) {
      filterWhere = ` AND ${fragment.value}`;
      filterVals = [...fragment.values];
    }
  }

  const qualifiedCol = `${subRef}.${db.qi(fieldCol)}`;
  const expr = `COALESCE((SELECT ${aggExpr(aggFn, qualifiedCol)} FROM ${refs.joinTable} AS ${subRef} WHERE ${subRef}.${refs.fkCol} = ${refs.mainTable}.${refs.mainCol}${filterWhere}), 0)`;

  return new Expression(expr, filterVals);
}

// ─── orderBy parsing & validation ───────────────────────────

interface OrderByResult {
  sql: string;
  values: unknown[];
  /** Aliases referenced in 2-part notation (joinLeft) — need a LEFT JOIN. */
  leftJoinAliases: Set<string>;
}

/**
 * Pre-scan `orderBy` for the joinLeft aliases referenced in 2-part notation (`<alias>.<field>`).
 * Needed BEFORE building the LEFT JOIN clauses (which must know their aliases) while the actual
 * orderBy SQL — with its parameter placeholders — is only baked later, once the LEFT JOIN value
 * count is known. Validates each alias against `allowedReadJoins` (throws 400), mirroring
 * `validateOrderBy`; 3-part aggregation entries are ignored (they use joinGroup, not a LEFT JOIN).
 */
function collectOrderByLeftAliases(orderBy: string, tableConf: ITable): Set<string> {
  const aliases = new Set<string>();
  for (const part of orderBy.split(',')) {
    const trimmed = part.trim();
    if (/^(\w+)\.(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i.test(trimmed)) continue; // 3-part aggregation
    const m = /^(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i.exec(trimmed);
    if (m) {
      const alias = m[1];
      requireJoin(tableConf, alias, true);
      aliases.add(alias);
    }
  }
  return aliases;
}

function validateOrderBy(
  orderBy: string,
  tableConf: ITable,
  db: QueryClient,
  dbTables: DbTables,
  joinGroup: Record<string, JoinGroupRequest> | undefined,
  startIdx: number
): OrderByResult {
  const parts = orderBy.split(',');
  const outParts: string[] = [];
  const outValues: unknown[] = [];
  const leftJoinAliases = new Set<string>();
  let currentIdx = startIdx;

  for (const part of parts) {
    const trimmed = part.trim();

    // 3-part: <alias>.<fn>.<field> [ASC|DESC] (aggregation via joinGroup)
    const dotted3 = /^(\w+)\.(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i.exec(trimmed);
    if (dotted3) {
      if (tableConf.distinctResults) {
        err400('Cannot combine distinctResults with aggregation orderBy');
      }
      const [, alias, fn, field, dir] = dotted3;
      const expr = buildAggOrderExpr(db, dbTables, tableConf, alias, fn, field, joinGroup);
      const aggVals = [...expr.values];
      outParts.push(`${renderRef(expr, currentIdx, db)} ${(dir || 'ASC').toUpperCase()}`);
      outValues.push(...aggVals);
      currentIdx += aggVals.length;
      continue;
    }

    // 2-part: <alias>.<field> [ASC|DESC] (joinLeft inline ordering)
    const dotted2 = /^(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i.exec(trimmed);
    if (dotted2) {
      const [, alias, field, dir] = dotted2;
      const joinDef = requireJoin(tableConf, alias, true);
      const col = validateSchemaField(
        field, joinDef.joinSchema, dbTables[joinDef.joinSchema.tableName]
      );
      // Reference the LEFT JOIN'd table via its alias (SQL identifier).
      outParts.push(`${db.qi(alias)}.${db.qi(col)} ${(dir || 'ASC').toUpperCase()}`);
      leftJoinAliases.add(alias);
      continue;
    }

    // 1-part: <field> [ASC|DESC] — schema field or computed
    const plain = /^(\w+)(?:\s+(ASC|DESC))?$/i.exec(trimmed);
    if (!plain) {
      err400(`Invalid orderBy: ${trimmed}`);
    }
    const [, field, dir] = plain;
    const ref = resolveFieldRef(field, tableConf.Schema, tableConf, db);
    // A computed field binds its own values here: ORDER BY is emitted after the WHERE, so
    // its placeholders continue from `currentIdx`.
    const refVals = refValues(ref.expr);
    outParts.push(`${renderRef(ref.expr, currentIdx, db)} ${(dir || 'ASC').toUpperCase()}`);
    outValues.push(...refVals);
    currentIdx += refVals.length;
  }

  return { sql: outParts.join(', '), values: outValues, leftJoinAliases };
}

// ─── joinLeft: LEFT JOIN clause builder ─────────────────────

interface LeftJoinBuild {
  joinClauses: string[];
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
  if (field in joinSchema.fields) {
    // Wrapped so this helper has a single return type. A value-less Expression renders
    // verbatim (see renderField), so the emitted SQL is identical to the raw identifier.
    return new Expression(`${aliasIdent}.${db.qi(joinSchema.col(field))}`);
  }
  const fn = computed?.[field];
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
    if (c.field in scope.joinSchema.fields) {
      assertReadable(dbTables[scope.joinSchema.tableName], c.field);
    } else if (!scope.computed?.[c.field]) {
      err400(`Unknown field: ${c.field}`);
    }
    const ref = resolveJoinLeftField(c.field, scope);
    if (ref !== null) dispatchConditionMethod(cb, c.method, ref, c.params ?? []);
  }
}

function buildLeftJoinClauses(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  aliasesNeedingJoin: Set<string>,
  joinLeft: Record<string, JoinFetchRequest> | undefined,
  startIdx: number
): LeftJoinBuild {
  const joinClauses: string[] = [];
  const whereExtras: string[] = [];
  const values: unknown[] = [];
  let currentIdx = startIdx;

  for (const alias of aliasesNeedingJoin) {
    const joinDef = requireJoin(tableConf, alias, true);
    const { joinSchema } = joinDef;
    const refs = extractJoinRefs(db, tableConf, joinDef);
    const aliasIdent = db.qi(alias);

    joinClauses.push(
      `LEFT JOIN ${refs.joinTable} AS ${aliasIdent} ON ${aliasIdent}.${refs.fkCol} = ${refs.mainTable}.${refs.mainCol}`
    );

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

  return { joinClauses, whereExtras, values };
}

// ─── Main query execution ───────────────────────────────────

/**
 * Converts a configured order (`defaultOrder` or the primary-key fallback) to SQL.
 * Unlike the request `orderBy` (strictly validated by `validateOrderBy`), this is
 * lenient for backward compatibility: tokens matching a camelCase schema field are
 * mapped to their quoted DB column, computed fields (without bound values) expand
 * to their expression, and anything else passes through unchanged as raw SQL.
 */
function convertConfiguredOrder(order: string, tableConf: ITable, db: QueryClient): string {
  return order
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      const match = /^(\w+)(?:\s+(ASC|DESC))?$/i.exec(trimmed);
      if (match) {
        const [, field, dir] = match;
        const suffix = dir ? ` ${dir.toUpperCase()}` : '';
        if (field in tableConf.Schema.fields) {
          return `${db.qi(tableConf.Schema.tableName)}.${db.qi(tableConf.Schema.col(field))}${suffix}`;
        }
        const computed = tableConf.computedFields?.[field];
        if (computed) {
          const ev = evaluateComputedField(
            field, computed, tableConf.Schema, db, undefined,
            `Computed field '${field}' with bound values cannot be used in defaultOrder`,
          );
          return `${ev.value}${suffix}`;
        }
      }
      return trimmed;
    })
    .join(', ');
}

async function executeMainQuery(
  db: QueryClient,
  tableConf: ITable,
  where: string,
  values: unknown[],
  orderBy?: string,
  paginator?: { page: number; itemsPerPage: number },
  extraJoins: string[] = [],
  selectComputed?: string[],
  maxRows?: number
): Promise<Record<string, unknown>[]> {
  const tableName = tableConf.Schema.tableName;
  // Request orderBy arrives already validated and mapped by validateOrderBy;
  // configured fallbacks (defaultOrder / primary key) are converted leniently here.
  const order = orderBy || convertConfiguredOrder(
    tableConf.defaultOrder || primaryAsString(tableConf.primary), tableConf, db
  );

  // With a paginator, the page size governs the LIMIT. Without one, apply `maxRows` (if set) so an
  // unbounded search cannot dump the whole table; a plain integer is a safe, non-injectable LIMIT.
  const limit = paginator
    ? `${paginator.itemsPerPage} OFFSET ${(paginator.page - 1) * paginator.itemsPerPage}`
    : (maxRows != null ? String(maxRows) : null);

  // Base projection: '*' unless the table hides fields via readExclude.
  const readableColumns = readableSelectColumns(tableConf, tableConf.Schema, db);

  // Optional computed projections — bound values, if any, are NOT yet supported
  // here (would require placeholder-aware composition with WHERE values).
  let columns: string | undefined = readableColumns;
  if (selectComputed?.length) {
    const projections = [readableColumns ?? '*'];
    for (const name of selectComputed) {
      const fn = tableConf.computedFields?.[name];
      if (!fn) err400(`Unknown computed field in selectComputed: '${name}'`);
      const out = evaluateComputedField(
        name, fn, tableConf.Schema, db, undefined,
        `Computed field '${name}' with bound values cannot be used in selectComputed`,
      );
      projections.push(`${out.value} AS ${db.qi(name)}`);
    }
    columns = projections.join(', ');
  }

  const rows = await db.select({
    tableName,
    columns,
    where,
    values,
    orderBy: order,
    limit,
    distinct: tableConf.distinctResults,
    joins: extraJoins.length > 0 ? extraJoins : undefined,
  });

  return mapRowsToCamelCase(rows, tableConf.Schema, selectComputed);
}

async function buildPagination(
  db: QueryClient,
  tableConf: ITable,
  where: string,
  values: unknown[],
  paginator: { page: number; itemsPerPage: number },
  extraJoins: string[] = [],
  computeMin?: string,
  computeMax?: string,
  computeSum?: string,
  computeAvg?: string
): Promise<PaginationResult> {
  const tableName = tableConf.Schema.tableName;
  const joinClause = extraJoins.length > 0 ? ' ' + extraJoins.join(' ') : '';

  const countResult = await db.query<{ total: string }>(
    `SELECT COUNT(*) as total FROM ${db.qi(tableName)}${joinClause} WHERE ${where}`,
    values
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const computed: Record<string, Record<string, unknown>> = {};
  const computations = [
    { key: 'min', field: computeMin, fn: 'MIN' },
    { key: 'max', field: computeMax, fn: 'MAX' },
    { key: 'sum', field: computeSum, fn: 'SUM' },
    { key: 'avg', field: computeAvg, fn: 'AVG' },
  ];

  for (const { key, field, fn } of computations) {
    if (field) {
      const ref = resolveFieldRef(field, tableConf.Schema, tableConf, db);
      // The aggregate sits in the SELECT list, before the WHERE values: a computed that
      // binds parameters cannot be placed here.
      if (refValues(ref.expr).length > 0) {
        err400(`Computed field '${field}' with bound values cannot be used in compute${key.charAt(0).toUpperCase() + key.slice(1)}`);
      }
      const result = await db.query<{ value: unknown }>(
        `SELECT ${fn}(${renderRef(ref.expr, 1, db)}) as value FROM ${db.qi(tableName)}${joinClause} WHERE ${where}`,
        values
      );
      computed[key] = { [field]: result.rows[0].value };
    }
  }

  return {
    total,
    pages: Math.ceil(total / paginator.itemsPerPage),
    ...(Object.keys(computed).length > 0 ? { computed } : {}),
    paginator,
  };
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
function executeJoinMultiple(
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
function executeJoinLeft(
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
  if (by in joinSchema.fields) {
    // validateSchemaField also enforces readExclude: GROUP BY on a hidden field
    // would return its distinct values verbatim in `rows[].by`.
    const col = validateSchemaField(by, joinSchema, joinTableConf);
    return `${db.qi(joinSchema.tableName)}.${db.qi(col)}`;
  }
  const fn = joinTableConf?.computedFields?.[by];
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

async function executeJoinGroup(
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

// ─── Conditions (advanced filters) ──────────────────────────

import {
  ALLOWED_SET, SINGLE_VALUE_SET, BETWEEN_SET, IN_SET, NULL_SET,
} from '../../condition-methods.js';

function dispatchConditionMethod(
  cb: ConditionBuilder,
  method: string,
  colOrExpr: string | Expression,
  params: unknown[]
): void {
  if (SINGLE_VALUE_SET.has(method)) {
    (cb[method as keyof ConditionBuilder] as Function)(colOrExpr, params[0]);
  } else if (BETWEEN_SET.has(method)) {
    (cb[method as keyof ConditionBuilder] as Function)(colOrExpr, params[0], params[1]);
  } else if (IN_SET.has(method)) {
    (cb[method as keyof ConditionBuilder] as Function)(colOrExpr, params[0]);
  } else if (NULL_SET.has(method)) {
    (cb[method as keyof ConditionBuilder] as Function)(colOrExpr, true);
  }
}

/**
 * Equality filters targeting the join table's *computed* fields. Plain column filters are
 * already handled by `joinTableConf.filters`, so anything not computed is skipped here.
 */
function applyJoinRefComputedFilters(
  cb: ConditionBuilder,
  filters: FilterRecord,
  joinTableConf: ITable | undefined,
  joinSchema: SchemaDefinition,
  db: QueryClient,
  colQualifier: string
): void {
  const computed = joinTableConf?.computedFields;
  if (!computed) return;

  for (const [name, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    const fn = computed[name];
    if (!fn) continue;
    cb.isEqual(evaluateComputedField(name, fn, joinSchema, db, colQualifier, '', true), value);
  }
}

/** Operator conditions on a join reference, against a schema or a computed field. */
function applyJoinRefConditions(
  cb: ConditionBuilder,
  conditions: SearchCondition[],
  joinTableConf: ITable | undefined,
  joinSchema: SchemaDefinition,
  db: QueryClient,
  colQualifier: string
): void {
  const computed = joinTableConf?.computedFields;

  for (const c of conditions) {
    if (!ALLOWED_SET.has(c.method)) {
      err400(`Invalid condition method: ${c.method}`);
    }
    // Computed fields resolve to an Expression carrying their own bound values, which the
    // ConditionBuilder places together with the compared value.
    const fn = computed?.[c.field];
    const operand = fn
      ? evaluateComputedField(c.field, fn, joinSchema, db, colQualifier, '', true)
      : `${db.qi(colQualifier)}.${db.qi(validateSchemaField(c.field, joinSchema, joinTableConf))}`;
    dispatchConditionMethod(cb, c.method, operand, c.params ?? []);
  }
}

function buildJoinRefCondition(
  joinTableConf: ITable | undefined,
  joinSchema: SchemaDefinition,
  ref: JoinRefFilter,
  db: QueryClient,
  qualifier?: string
): ConditionBuilder {
  assertFiltersReadable(ref.filters, joinTableConf);
  // Filter keys are checked by assertJoinFilterKeys, up front in searchEngine — this side
  // query may never run, so it is not a place a request can be rejected from.

  // Bare table name for plain side-queries; the subquery alias when the condition lands
  // inside an aliased, correlated FROM (there the table name would resolve to the outer query).
  const colQualifier = qualifier ?? joinSchema.tableName;

  const cb = (ref.filters && joinTableConf)
    ? joinTableConf.filters(ref.filters, db.cbDialect, colQualifier)
    : new ConditionBuilder('AND', db.cbDialect);

  if (ref.filters) {
    applyJoinRefComputedFilters(cb, ref.filters, joinTableConf, joinSchema, db, colQualifier);
  }
  if (ref.conditions?.length) {
    applyJoinRefConditions(cb, ref.conditions, joinTableConf, joinSchema, db, colQualifier);
  }

  return cb;
}

/**
 * Apply non-dotted conditions to the main `condition` ConditionBuilder when
 * possible. For schema fields → straight dispatch. For computed fields → return
 * side-channel clauses to be appended to WHERE later (with correct placeholder
 * offsets), since ConditionBuilder cannot bind values for an LHS expression.
 */
function applyConditions(
  condition: ConditionBuilder,
  conditions: SearchCondition[],
  schema: SchemaDefinition,
  tableConf: ITable,
  db: QueryClient
): void {
  for (const c of conditions) {
    // Skip dot-notation fields — those become aggregation conditions processed later
    if (c.field.includes('.')) continue;

    if (!ALLOWED_SET.has(c.method)) {
      err400(`Invalid condition method: ${c.method}`);
    }

    // A computed field resolves to an Expression carrying its own bound values; the
    // ConditionBuilder places them, so no placeholder offset is computed here.
    const ref = resolveFieldRef(c.field, schema, tableConf, db);
    dispatchConditionMethod(condition, c.method, ref.expr, c.params);
  }
}

/**
 * Equality filters targeting computed fields: `filters.<computedName>` becomes
 * `<expr> = <value>` on the same ConditionBuilder used for schema fields, which
 * `tableConf.filters()` has already populated.
 */
function applyComputedFilters(
  condition: ConditionBuilder,
  filters: Record<string, unknown>,
  tableConf: ITable,
  db: QueryClient
): void {
  const computed = tableConf.computedFields;
  if (!computed) return;

  for (const [name, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    if (!computed[name]) continue;
    const expr = evaluateComputedField(name, computed[name], tableConf.Schema, db, undefined, '', true);
    condition.isEqual(expr, value as ConditionValue);
  }
}

function appendAggConditions(
  params: QueryParams,
  conditions: SearchCondition[],
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  joinGroup: Record<string, JoinGroupRequest> | undefined
): string {
  let where = '';

  for (const c of conditions) {
    if (!c.field.includes('.')) continue;

    if (!ALLOWED_SET.has(c.method)) {
      err400(`Invalid condition method: ${c.method}`);
    }

    const parts = c.field.split('.');
    if (parts.length !== 3) {
      err400(`Invalid dotted field in condition: ${c.field} (expected <alias>.<fn>.<field>)`);
    }
    const [alias, fn, field] = parts;

    // The aggregate carries the values of its own filter; passing it as the left-hand side
    // lets the ConditionBuilder place those and the compared value in one step.
    const expr = buildAggOrderExpr(db, dbTables, tableConf, alias, fn, field, joinGroup);
    const tmpCb = new ConditionBuilder('AND', db.cbDialect);
    dispatchConditionMethod(tmpCb, c.method, expr, c.params);
    where += ` AND ${params.emitCondition(tmpCb, db)}`;
  }

  return where;
}

// ─── joinMustExist (EXISTS subquery filter on main) ─────────

function buildJoinMustExistClauses(
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

// ─── searchEngine entrypoint ────────────────────────────────

/**
 * Reject unknown aliases, non-unique aliases used as `joinLeft`, and unsupported join
 * filter keys — all before any query runs, so a 400 never depends on whether the main
 * query happened to return rows.
 *
 * `joinLeft` is the odd one out: its condition is built inline and never runs the target's
 * `extendedCondition`, so `extraFilters` are not accepted there.
 */
function assertJoinRequestsAllowed(dbTables: DbTables, params: SearchParams): void {
  const { tableConf, joinMustExist, joinMultiple, joinGroup, joinLeft } = params;

  if (joinMustExist) for (const a of Object.keys(joinMustExist)) requireJoin(tableConf, a, false);
  if (joinMultiple) for (const a of Object.keys(joinMultiple)) requireJoin(tableConf, a, false);
  if (joinGroup) for (const a of Object.keys(joinGroup)) requireJoin(tableConf, a, false);
  if (joinLeft) for (const a of Object.keys(joinLeft)) requireJoin(tableConf, a, true);

  assertJoinFilterKeys(dbTables, tableConf, joinMustExist, true);
  assertJoinFilterKeys(dbTables, tableConf, joinMultiple, true);
  assertJoinFilterKeys(dbTables, tableConf, joinGroup, true);
  assertJoinFilterKeys(dbTables, tableConf, joinLeft, false);
}

/**
 * The main table's WHERE builder, plus any JOIN the tenant scope needs.
 *
 * Filters and conditions on computed fields go on the same ConditionBuilder: a computed
 * resolves to an Expression carrying its own values, and the builder is what assigns
 * every placeholder index.
 */
function buildMainCondition(params: SearchParams): {
  condition: ConditionBuilder;
  tenantJoins: string[];
} {
  const { db, tableConf, filters, conditions, tenant } = params;

  assertFiltersReadable(filters, tableConf);
  assertKnownFilterKeys(filters, tableConf.Schema, tableConf);
  const condition = tableConf.filters(filters || {}, db.cbDialect);

  if (filters && tableConf.computedFields) {
    applyComputedFilters(condition, filters, tableConf, db);
  }
  if (conditions?.length) {
    applyConditions(condition, conditions, tableConf.Schema, tableConf, db);
  }

  const tenantJoins: string[] = [];
  if (tenant) {
    condition.append(buildTenantCondition(db, tenant.scope, tenant.ids, tableConf.Schema.tableName));
    if ('through' in tenant.scope) {
      tenantJoins.push(buildTenantJoin(db, tenant.scope, tableConf.Schema.tableName));
    }
  }

  return { condition, tenantJoins };
}

/**
 * joinLeft aliases that need a real LEFT JOIN on the main query: those referenced by a
 * 2-part `orderBy`, plus those the request filters or puts conditions on.
 */
function collectLeftJoinAliases(params: SearchParams): Set<string> {
  const { orderBy, joinLeft, tableConf } = params;
  const aliases = new Set<string>();

  if (orderBy) {
    for (const a of collectOrderByLeftAliases(orderBy, tableConf)) aliases.add(a);
  }
  if (joinLeft) {
    for (const [alias, ref] of Object.entries(joinLeft)) {
      if (ref?.filters || ref?.conditions?.length) aliases.add(alias);
    }
  }
  return aliases;
}

/**
 * Run the side queries for the join families that return rows of their own, and hang each
 * one off `result`. These run after the main query because they are correlated to the rows
 * it returned.
 */
async function attachJoinResults(
  result: SearchResult,
  dbTables: DbTables,
  params: SearchParams,
  main: SearchResult['main']
): Promise<void> {
  const { db, tableConf, joinMultiple, joinLeft, joinGroup, tenant } = params;

  if (joinMultiple && Object.keys(joinMultiple).length > 0) {
    result.joinMultiple = await executeJoinMultiple(db, dbTables, tableConf, main, joinMultiple, tenant);
  }
  if (joinLeft && Object.keys(joinLeft).length > 0) {
    result.joinLeft = await executeJoinLeft(db, dbTables, tableConf, main, joinLeft, tenant);
  }
  if (joinGroup && Object.keys(joinGroup).length > 0) {
    result.joinGroup = await executeJoinGroup(db, dbTables, tableConf, main, joinGroup, tenant);
  }
}

export async function searchEngine(
  dbTables: DbTables,
  params: SearchParams
): Promise<SearchResult> {
  const {
    db, tableConf, conditions,
    joinMustExist, joinGroup, joinLeft,
    orderBy, paginator,
    computeMin, computeMax, computeSum, computeAvg, tenant,
  } = params;

  assertJoinRequestsAllowed(dbTables, params);

  const { condition, tenantJoins } = buildMainCondition(params);

  // From here the statement is assembled fragment by fragment. `bound` owns the values and
  // hands each fragment the placeholder index it must start from, so no offset is computed
  // at any call site. Fragments must be emitted in the order their placeholders appear in
  // the final SQL — MySQL binds `?` positionally.
  const bound = new QueryParams();
  let where = bound.emitCondition(condition, db);

  // joinMustExist (EXISTS)
  if (joinMustExist && Object.keys(joinMustExist).length > 0) {
    where += buildJoinMustExistClauses(bound, db, dbTables, tableConf, joinMustExist, tenant);
  }

  // Aggregation conditions (HAVING-style)
  if (conditions?.length && conditions.some((c) => c.field.includes('.'))) {
    where += appendAggConditions(bound, conditions, db, dbTables, tableConf, joinGroup);
  }

  const aliasesNeedingLeftJoin = collectLeftJoinAliases(params);

  // LEFT JOIN clauses + extra WHERE for filtered parents.
  const extraJoinClauses: string[] = [...tenantJoins];
  if (aliasesNeedingLeftJoin.size > 0) {
    const lj = bound.emit((startIndex) =>
      buildLeftJoinClauses(db, dbTables, tableConf, aliasesNeedingLeftJoin, joinLeft, startIndex)
    );
    extraJoinClauses.push(...lj.joinClauses);
    for (const w of lj.whereExtras) where += ` AND ${w}`;
  }

  // The pagination COUNT and the compute* queries reuse the WHERE and its joins but drop the
  // ORDER BY, so they bind everything up to this point and nothing after it.
  const whereAndJoinValues = bound.snapshot();

  // ORDER BY is emitted last, so an aggregation-orderBy numbers its placeholders past the
  // WHERE and LEFT JOIN values.
  let safeOrderBy: string | undefined;
  if (orderBy) {
    safeOrderBy = bound.emit((startIndex) =>
      validateOrderBy(orderBy, tableConf, db, dbTables, joinGroup, startIndex)
    ).sql;
  }

  const mainValues = bound.snapshot();

  const main = await executeMainQuery(
    db, tableConf, where, mainValues, safeOrderBy, paginator, extraJoinClauses, params.selectComputed, params.maxRows
  );

  let pagination: PaginationResult | undefined;
  if (paginator) {
    pagination = await buildPagination(
      db, tableConf, where, whereAndJoinValues, paginator, extraJoinClauses,
      computeMin, computeMax, computeSum, computeAvg
    );
  }

  const result: SearchResult = { main };

  await attachJoinResults(result, dbTables, params, main);

  if (pagination) {
    result.pagination = pagination;
  }

  return result;
}
