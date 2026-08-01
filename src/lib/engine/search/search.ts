import type { QueryClient } from '../../db.js';
import { ConditionBuilder } from 'node-condition-builder';
import { QueryParams } from '../query-params.js';
import { buildTenantCondition, buildTenantJoin } from '../../tenant.js';
import {
  assertFiltersReadable,
  assertKnownFilterKeys,
  readableSelectColumns,
  ownField,
} from '../../read-access.js';
import { MAX_CONDITIONS, MAX_ORDER_BY_PARTS } from '../../condition-methods.js';
import { primaryAsString } from '../../../types.js';
import {
  err400,
  resolveFieldRef,
  evaluateComputedField,
  refValues,
  renderRef,
  mapRowsToCamelCase,
} from './fields.js';
import { assertJoinFilterKeys, requireJoin } from './joins.js';
import { collectOrderByLeftAliases, validateOrderBy, convertConfiguredOrder } from './order-by.js';
import { applyConditions, applyComputedFilters } from './conditions.js';
import { appendAggConditions } from './aggregations.js';
import {
  buildLeftJoinOnClauses,
  buildLeftJoinFilters,
  executeJoinMultiple,
  executeJoinLeft,
  executeJoinGroup,
  buildJoinMustExistClauses,
} from './join-families.js';
import type {
  DbTables,
  SearchParams,
  SearchResult,
  PaginationResult,
  ITable,
} from '../../../types.js';

/**
 * Guard the request shapes that reach SQL as text rather than as bound values.
 *
 * `paginator` is rendered straight into LIMIT/OFFSET: `Paginator` is a compile-time type only,
 * and `sqlApi.search()` is a documented public API a consumer may hand an unvalidated
 * querystring, so the integer check has to exist at runtime.
 *
 * The complexity caps are also declared by the request schemas; these are the backstop that
 * covers programmatic callers, which no schema validates.
 */
function assertRequestWithinLimits(params: SearchParams): void {
  const { paginator, conditions, orderBy } = params;

  if (paginator) {
    for (const key of ['page', 'itemsPerPage'] as const) {
      const value: unknown = paginator[key];
      if (!Number.isInteger(value) || (value as number) < 1) {
        err400(`Invalid paginator: '${key}' must be an integer >= 1`);
      }
    }
  }

  if (conditions && conditions.length > MAX_CONDITIONS) {
    err400(`Too many conditions: ${conditions.length} (max ${MAX_CONDITIONS})`);
  }

  if (orderBy && orderBy.split(',').length > MAX_ORDER_BY_PARTS) {
    err400(`Too many orderBy parts: max ${MAX_ORDER_BY_PARTS}`);
  }
}

// ─── Main query execution ───────────────────────────────────

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
      const fn = ownField(tableConf.computedFields, name);
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

  assertRequestWithinLimits(params);
  assertJoinRequestsAllowed(dbTables, params);

  const { condition, tenantJoins } = buildMainCondition(params);
  const aliasesNeedingLeftJoin = collectLeftJoinAliases(params);

  // From here the statement is assembled fragment by fragment. `bound` owns the values and
  // hands each fragment the placeholder index it must start from, so no offset is computed
  // at any call site. Fragments must be emitted in the order their placeholders appear in
  // the final SQL — MySQL binds `?` positionally.
  const bound = new QueryParams();

  // LEFT JOIN clauses come first: they sit before the WHERE in the statement, and their ON
  // clause carries the joined table's tenant scope.
  const extraJoinClauses: string[] = [...tenantJoins];
  if (aliasesNeedingLeftJoin.size > 0) {
    const on = bound.emit((startIndex) =>
      buildLeftJoinOnClauses(db, dbTables, tableConf, aliasesNeedingLeftJoin, startIndex, tenant)
    );
    extraJoinClauses.push(...on.joinClauses);
  }

  let where = bound.emitCondition(condition, db);

  // joinMustExist (EXISTS)
  if (joinMustExist && Object.keys(joinMustExist).length > 0) {
    where += buildJoinMustExistClauses(bound, db, dbTables, tableConf, joinMustExist, tenant);
  }

  // Aggregation conditions (HAVING-style)
  if (conditions?.length && conditions.some((c) => c.field.includes('.'))) {
    where += appendAggConditions(bound, conditions, db, dbTables, tableConf, joinGroup, tenant);
  }

  // Extra WHERE for the parents the request filters on.
  if (aliasesNeedingLeftJoin.size > 0) {
    const lj = bound.emit((startIndex) =>
      buildLeftJoinFilters(db, dbTables, tableConf, aliasesNeedingLeftJoin, joinLeft, startIndex)
    );
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
      validateOrderBy(orderBy, tableConf, db, dbTables, joinGroup, startIndex, tenant)
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
