import type { QueryClient } from '../../db.js';
import { ConditionBuilder, type ConditionValue } from 'node-condition-builder';
import { camelcaseObject } from '../../naming.js';
import { buildTenantCondition, buildTenantJoin } from '../../tenant.js';
import { primaryAsString } from '../../../types.js';
import type {
  DbTables,
  FilterRecord,
  SearchParams,
  SearchResult,
  SearchCondition,
  ConditionMethod,
  PaginationResult,
  JoinDefinition,
  JoinGroupRequest,
  JoinRefFilter,
  ITable,
  SchemaDefinition,
  TenantScopeIndirect,
} from '../../../types.js';

function validateSchemaField(field: string, schema: SchemaDefinition): string {
  if (!(field in schema.fields)) {
    const err = new Error(`Unknown field: ${field}`) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return schema.col(field);
}

const AGG_FN_SQL: Record<string, string> = {
  sum: 'SUM',
  min: 'MIN',
  max: 'MAX',
  avg: 'AVG',
  count: 'COUNT',
  distinctCount: 'COUNT DISTINCT', // marker, handled specially
};

function buildAggOrderExpr(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  joinTableName: string,
  fn: string,
  field: string,
  joinGroups: Record<string, JoinGroupRequest> | undefined,
  startIdx: number
): { expr: string; values: unknown[] } {
  const err400 = (msg: string): never => {
    const e = new Error(msg) as Error & { statusCode: number };
    e.statusCode = 400;
    throw e;
  };

  // Whitelist fn
  if (!(fn in AGG_FN_SQL)) {
    err400(`Invalid aggregation function: ${fn}`);
  }

  // Require joinGroups declaration for the referenced table + fn + field
  const groupReq = joinGroups?.[joinTableName];
  if (!groupReq) {
    err400(`orderBy references undeclared joinGroup: ${joinTableName}`);
  }
  const declaredFields = (groupReq!.aggregations as Record<string, unknown>)[fn];
  if (!Array.isArray(declaredFields) || !declaredFields.includes(field)) {
    err400(`orderBy references undeclared aggregation: ${joinTableName}.${fn}.${field}`);
  }

  // Resolve join definition
  const joinDef = tableConf.allowedReadJoins?.find(
    ([js]) => js.tableName === joinTableName
  );
  if (!joinDef) {
    err400(`Unknown join table in orderBy: ${joinTableName}`);
  }
  const [joinSchema, joinField, mainField] = joinDef!;

  // If joinGroup has `by`, only accept it when `by` is the correlation FK (joinField).
  // In that case each main row corresponds to exactly one group, so the scalar
  // subquery is semantically equivalent to no-by. Any other `by` produces multiple
  // groups per main row → not a single scalar, reject.
  if (groupReq!.aggregations.by && groupReq!.aggregations.by !== joinField) {
    err400(`Cannot order by aggregation on joinGroup with 'by' clause on non-FK column: ${joinTableName} (grouped by '${groupReq!.aggregations.by}', correlation FK is '${joinField}')`);
  }

  // Validate field exists on join schema
  const fieldCol = validateSchemaField(field, joinSchema);

  // Build correlation: joinTable.fk = mainTable.main_pk
  const mainColName = Array.isArray(mainField) ? mainField[0] : mainField;
  const mainCol = db.qi(tableConf.Schema.col(mainColName));
  const mainTable = db.qi(tableConf.Schema.tableName);
  const joinTable = db.qi(joinSchema.tableName);
  const fkCol = db.qi(joinSchema.col(joinField));

  // Rebuild joinGroup filters + conditions with correct placeholder offset
  let filterWhere = '';
  let filterVals: unknown[] = [];
  const joinTableConf = dbTables[joinTableName];
  if ((groupReq!.filters || groupReq!.conditions?.length) && joinSchema) {
    const cb = buildJoinRefCondition(
      joinTableConf,
      joinSchema,
      { filters: groupReq!.filters, conditions: groupReq!.conditions },
      db
    );
    const built = cb.build(startIdx, db.ph);
    if (built) {
      filterWhere = ` AND ${built}`;
      filterVals = cb.getValues();
    }
  }

  // Generate SQL expression
  const qField = db.qi(fieldCol);
  const fnSql = AGG_FN_SQL[fn];
  const aggExpr = fnSql === 'COUNT DISTINCT'
    ? `COUNT(DISTINCT ${joinTable}.${qField})`
    : `${fnSql}(${joinTable}.${qField})`;

  // COALESCE with 0 so main rows without matching joined records get a sortable
  // numeric value instead of NULL. Works on all dialects (PG/MySQL/MariaDB) and
  // keeps "no data" at the bottom on DESC (top-N queries), and at the top on ASC.
  const expr = `COALESCE((SELECT ${aggExpr} FROM ${joinTable} WHERE ${joinTable}.${fkCol} = ${mainTable}.${mainCol}${filterWhere}), 0)`;

  return { expr, values: filterVals };
}

function validateOrderBy(
  orderBy: string,
  tableConf: ITable,
  db: QueryClient,
  dbTables: DbTables,
  joinGroups: Record<string, JoinGroupRequest> | undefined,
  startIdx: number
): { sql: string; values: unknown[] } {
  const parts = orderBy.split(',');
  const outParts: string[] = [];
  const outValues: unknown[] = [];
  let currentIdx = startIdx;

  for (const part of parts) {
    const trimmed = part.trim();

    // Dotted notation: <joinTable>.<fn>.<field> [ASC|DESC]
    const dottedMatch = trimmed.match(/^(\w+)\.(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i);
    if (dottedMatch) {
      if (tableConf.distinctResults) {
        const err = new Error('Cannot combine distinctResults with aggregation orderBy') as Error & { statusCode: number };
        err.statusCode = 400;
        throw err;
      }
      const [, joinTableName, fn, field, dir] = dottedMatch;
      const { expr, values } = buildAggOrderExpr(
        db, dbTables, tableConf, joinTableName, fn, field, joinGroups, currentIdx
      );
      outParts.push(`${expr} ${(dir || 'ASC').toUpperCase()}`);
      outValues.push(...values);
      currentIdx += values.length;
      continue;
    }

    // Plain field: <field> [ASC|DESC]
    const plainMatch = trimmed.match(/^(\w+)(?:\s+(ASC|DESC))?$/i);
    if (!plainMatch) {
      const err = new Error(`Invalid orderBy: ${trimmed}`) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
    const [, field, dir] = plainMatch;
    const col = validateSchemaField(field, tableConf.Schema);
    outParts.push(`${db.qi(col)} ${(dir || 'ASC').toUpperCase()}`);
  }

  return { sql: outParts.join(', '), values: outValues };
}

async function executeMainQuery(
  db: QueryClient,
  tableConf: ITable,
  where: string,
  values: unknown[],
  orderBy?: string,
  paginator?: { page: number; itemsPerPage: number },
  extraJoins: string[] = []
): Promise<Record<string, unknown>[]> {
  const tableName = tableConf.Schema.tableName;
  const order = orderBy || tableConf.defaultOrder || primaryAsString(tableConf.primary);

  const limit = paginator
    ? `${paginator.itemsPerPage} OFFSET ${(paginator.page - 1) * paginator.itemsPerPage}`
    : null;

  const rows = await db.select({
    tableName,
    where,
    values,
    orderBy: order,
    limit,
    distinct: tableConf.distinctResults,
    joins: extraJoins.length > 0 ? extraJoins : undefined,
  });

  return rows.map((r) => camelcaseObject(r as Record<string, unknown>, tableConf.Schema));
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
      const col = validateSchemaField(field, tableConf.Schema);
      const result = await db.query<{ value: unknown }>(
        `SELECT ${fn}(${db.qi(col)}) as value FROM ${db.qi(tableName)}${joinClause} WHERE ${where}`,
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

function findJoinDefinition(
  tableConf: ITable,
  joinTableName: string
): JoinDefinition | undefined {
  return tableConf.allowedReadJoins?.find(
    ([joinSchema]) => joinSchema.tableName === joinTableName
  );
}

async function executeVirtualJoins(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  mainResults: Record<string, unknown>[],
  joins: Record<string, JoinRefFilter>
): Promise<Record<string, Record<string, unknown>[]>> {
  const result: Record<string, Record<string, unknown>[]> = {};

  for (const [joinTableName, joinRef] of Object.entries(joins)) {
    const joinDef = findJoinDefinition(tableConf, joinTableName);
    if (!joinDef) continue;

    const [joinSchema, joinField, mainField, selection] = joinDef;
    const joinTableConf = dbTables[joinTableName];

    // Collect IDs from main results
    const ids = collectIds(mainResults, mainField);
    if (ids.length === 0) {
      result[joinTableName] = [];
      continue;
    }

    // Build join filters (equality) + rich conditions
    const cb = buildJoinRefCondition(joinTableConf, joinSchema, joinRef || {}, db);
    const fkCol = joinSchema.col(joinField);
    cb.isIn(db.qi(fkCol), ids);
    const where = cb.build(1, db.ph);
    const values = cb.getValues();

    // selection is a comma-separated list of field names (camelCase API names).
    // Resolve each to its DB column via schema.col() and quote it.
    const columns = selection === '*'
      ? '*'
      : selection.split(',').map((c) => {
          const field = c.trim();
          return db.qi(joinSchema.col(field));
        }).join(', ');
    const rows = await db.select({
      tableName: joinSchema.tableName,
      columns,
      where,
      values,
    });

    result[joinTableName] = rows.map((r) => camelcaseObject(r as Record<string, unknown>, joinSchema));
  }

  return result;
}

async function executeJoinGroups(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  mainResults: Record<string, unknown>[],
  joinGroups: Record<string, JoinGroupRequest>
): Promise<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = {};

  for (const [joinTableName, groupReq] of Object.entries(joinGroups)) {
    const joinDef = findJoinDefinition(tableConf, joinTableName);
    if (!joinDef) continue;

    const [joinSchema, joinField, mainField] = joinDef;

    const ids = collectIds(mainResults, mainField);
    if (ids.length === 0) {
      result[joinTableName] = {};
      continue;
    }

    const { aggregations, filters: groupFilters, conditions: groupConditions } = groupReq;
    const selectParts: string[] = [];
    const groupByParts: string[] = [];

    if (aggregations.by) {
      const byCol = validateSchemaField(aggregations.by, joinSchema);
      selectParts.push(`${db.qi(byCol)} as "by"`);
      groupByParts.push(db.qi(byCol));
    }

    if (aggregations.distinctCount) {
      for (const f of aggregations.distinctCount) {
        const col = validateSchemaField(f, joinSchema);
        selectParts.push(`COUNT(DISTINCT ${db.qi(col)}) as "distinctCount_${f}"`);
      }
    }
    if (aggregations.min) {
      for (const f of aggregations.min) {
        const col = validateSchemaField(f, joinSchema);
        selectParts.push(`MIN(${db.qi(col)}) as "min_${f}"`);
      }
    }
    if (aggregations.max) {
      for (const f of aggregations.max) {
        const col = validateSchemaField(f, joinSchema);
        selectParts.push(`MAX(${db.qi(col)}) as "max_${f}"`);
      }
    }
    if (aggregations.sum) {
      for (const f of aggregations.sum) {
        const col = validateSchemaField(f, joinSchema);
        selectParts.push(`SUM(${db.qi(col)}) as "sum_${f}"`);
      }
    }
    if (aggregations.avg) {
      for (const f of aggregations.avg) {
        const col = validateSchemaField(f, joinSchema);
        selectParts.push(`AVG(${db.qi(col)}) as "avg_${f}"`);
      }
    }
    if (aggregations.count) {
      for (const f of aggregations.count) {
        const col = validateSchemaField(f, joinSchema);
        selectParts.push(`COUNT(${db.qi(col)}) as "count_${f}"`);
      }
    }

    if (selectParts.length === 0) {
      result[joinTableName] = {};
      continue;
    }

    // Build WHERE clause: equality filters + rich conditions
    const joinTableConf = dbTables[joinTableName];
    const cb = buildJoinRefCondition(
      joinTableConf,
      joinSchema,
      { filters: groupFilters, conditions: groupConditions },
      db
    );
    const fkCol = joinSchema.col(joinField);
    cb.isIn(db.qi(fkCol), ids);
    const where = cb.build(1, db.ph);
    const values = cb.getValues();

    const groupBy = groupByParts.length > 0 ? `GROUP BY ${groupByParts.join(', ')}` : '';
    const sql = `SELECT ${selectParts.join(', ')} FROM ${db.qi(joinSchema.tableName)} WHERE ${where} ${groupBy}`;

    const queryResult = await db.query(sql, values);
    const rows = queryResult.rows;

    // Format: { distinctCount: {field: value}, min: {field: value}, ... }
    const formatted: Record<string, unknown> = {};
    if (rows.length > 0) {
      const row = rows.length === 1 && !aggregations.by ? rows[0] : rows;
      if (Array.isArray(row)) {
        formatted.rows = row;
      } else {
        for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
          if (key === 'by') continue;
          const [fn, field] = key.split('_');
          if (!formatted[fn]) formatted[fn] = {};
          (formatted[fn] as Record<string, unknown>)[field] = value;
        }
      }
    }

    result[joinTableName] = formatted;
  }

  return result;
}

function collectIds(
  mainResults: Record<string, unknown>[],
  mainField: string | string[]
): ConditionValue[] {
  if (Array.isArray(mainField)) {
    // Composite key: collect tuples
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

  const unique = [...new Set(mainResults.map((r) => r[mainField]).filter((v) => v != null))] as ConditionValue[];
  return unique;
}

// ─── Conditions (advanced filters) ──────────────────────────

import {
  ALLOWED_SET, SINGLE_VALUE_SET, BETWEEN_SET, IN_SET, NULL_SET,
} from '../../condition-methods.js';

function dispatchConditionMethod(
  cb: ConditionBuilder,
  method: string,
  colOrExpr: string,
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
 * Build a ConditionBuilder that applies both equality filters and rich conditions
 * to a join schema. Used by joinFilters (EXISTS), virtual joins data fetching,
 * and joinGroups (aggregation WHERE + orderBy scalar subquery).
 */
function buildJoinRefCondition(
  joinTableConf: ITable | undefined,
  joinSchema: SchemaDefinition,
  ref: JoinRefFilter,
  db: QueryClient
): ConditionBuilder {
  const cb = (ref.filters && joinTableConf)
    ? joinTableConf.filters(ref.filters)
    : new ConditionBuilder('AND');

  if (ref.conditions?.length) {
    for (const c of ref.conditions) {
      if (!ALLOWED_SET.has(c.method)) {
        const err = new Error(`Invalid condition method: ${c.method}`) as Error & { statusCode: number };
        err.statusCode = 400;
        throw err;
      }
      const col = db.qi(validateSchemaField(c.field, joinSchema));
      dispatchConditionMethod(cb, c.method, col, (c.params as unknown[]) ?? []);
    }
  }

  return cb;
}

function applyConditions(
  condition: ConditionBuilder,
  conditions: SearchCondition[],
  schema: SchemaDefinition,
  db: QueryClient
): void {
  for (const c of conditions) {
    // Skip dot-notation fields — those become aggregation conditions processed later
    if (c.field.includes('.')) continue;

    // Validate method — whitelist only, blocks prototype poisoning
    if (!ALLOWED_SET.has(c.method)) {
      const err = new Error(`Invalid condition method: ${c.method}`) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    const col = db.qi(validateSchemaField(c.field, schema));
    dispatchConditionMethod(condition, c.method, col, c.params as unknown[]);
  }
}

/**
 * Append aggregation-based conditions (HAVING-style) to the main WHERE clause.
 * For each condition with a dotted field like `session.count.id`, builds a
 * correlated scalar subquery (reusing buildAggOrderExpr) and uses it as the
 * left-hand side of a ConditionBuilder method.
 *
 * Runs after the base WHERE / joinFilters are built so placeholder offsets
 * are correct.
 */
function appendAggConditions(
  currentWhere: string,
  currentValues: unknown[],
  conditions: SearchCondition[],
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  joinGroups: Record<string, JoinGroupRequest> | undefined
): { where: string; values: unknown[] } {
  let where = currentWhere;
  let values = [...currentValues];

  for (const c of conditions) {
    if (!c.field.includes('.')) continue;

    if (!ALLOWED_SET.has(c.method)) {
      const err = new Error(`Invalid condition method: ${c.method}`) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    const parts = c.field.split('.');
    if (parts.length !== 3) {
      const err = new Error(`Invalid dotted field in condition: ${c.field} (expected <joinTable>.<fn>.<field>)`) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
    const [joinTableName, fn, field] = parts;

    // Build the scalar subquery; values for its filters are appended to the main values array.
    const { expr, values: exprValues } = buildAggOrderExpr(
      db, dbTables, tableConf, joinTableName, fn, field, joinGroups, values.length + 1
    );
    values = [...values, ...exprValues];

    // Use a temporary ConditionBuilder to generate "<expr> <op> <placeholder>" with
    // the correct placeholder offset, then merge it back into the main values.
    const tmpCb = new ConditionBuilder('AND');
    dispatchConditionMethod(tmpCb, c.method, expr, c.params as unknown[]);
    const startIdx = values.length + 1;
    const clause = tmpCb.build(startIdx, db.ph);
    where += ` AND ${clause}`;
    values.push(...tmpCb.getValues());
  }

  return { where, values };
}

// ─── Join filters (EXISTS subquery) ─────────────────────────

function buildJoinFiltersExists(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  joinFilters: Record<string, JoinRefFilter>,
  currentWhere: string,
  currentValues: unknown[]
): { where: string; values: unknown[] } {
  let where = currentWhere;
  const values = [...currentValues];

  for (const [joinTableName, ref] of Object.entries(joinFilters)) {
    const joinDef = findJoinDefinition(tableConf, joinTableName);
    if (!joinDef) continue;

    const [joinSchema, joinField, mainField] = joinDef;
    const joinTableConf = dbTables[joinTableName];

    const filterCondition = buildJoinRefCondition(joinTableConf, joinSchema, ref, db);
    const startIdx = values.length + 1;
    const filterWhere = filterCondition.build(startIdx, db.ph);
    const filterVals = filterCondition.getValues();

    const fkCol = db.qi(joinSchema.col(joinField));
    const mainColName = Array.isArray(mainField) ? mainField[0] : mainField;
    const mainCol = db.qi(tableConf.Schema.col(mainColName));
    const mainTable = db.qi(tableConf.Schema.tableName);

    // If there are no inner conditions, just the correlation suffices.
    const innerWhere = filterWhere
      ? `${fkCol} = ${mainTable}.${mainCol} AND ${filterWhere}`
      : `${fkCol} = ${mainTable}.${mainCol}`;

    where += ` AND EXISTS (SELECT 1 FROM ${db.qi(joinSchema.tableName)} WHERE ${innerWhere})`;
    values.push(...filterVals);
  }

  return { where, values };
}

export async function searchEngine(
  dbTables: DbTables,
  params: SearchParams
): Promise<SearchResult> {
  const { db, tableConf, filters, conditions, joinFilters, joins, joinGroups, orderBy, paginator, computeMin, computeMax, computeSum, computeAvg, tenant } = params;

  // Build main condition
  const condition = tableConf.filters(filters || {});

  // Advanced conditions
  if (conditions?.length) {
    applyConditions(condition, conditions, tableConf.Schema, db);
  }

  // Tenant filtering
  const tenantJoins: string[] = [];
  if (tenant) {
    condition.append(buildTenantCondition(db, tenant.scope, tenant.ids));
    if ('through' in tenant.scope) {
      tenantJoins.push(buildTenantJoin(db, tenant.scope as TenantScopeIndirect, tableConf.Schema.tableName));
    }
  }

  let where = condition.build(1, db.ph);
  let values: unknown[] = [...condition.getValues()];

  // Join filters: add EXISTS subqueries
  if (joinFilters && Object.keys(joinFilters).length > 0) {
    ({ where, values } = buildJoinFiltersExists(db, dbTables, tableConf, joinFilters, where, values));
  }

  // Aggregation conditions (HAVING-style): dotted fields in `conditions` are
  // translated into scalar subqueries using the joinGroup aggregation.
  if (conditions?.length) {
    const hasAggConditions = conditions.some((c) => c.field.includes('.'));
    if (hasAggConditions) {
      ({ where, values } = appendAggConditions(where, values, conditions, db, dbTables, tableConf, joinGroups));
    }
  }

  // Validate and sanitize orderBy (user input -> SQL identifier)
  // Note: orderBy aggregation values are kept separate from WHERE values,
  // so that buildPagination (which doesn't use ORDER BY) only binds WHERE params.
  let safeOrderBy: string | undefined;
  let orderByValues: unknown[] = [];
  if (orderBy) {
    const obResult = validateOrderBy(orderBy, tableConf, db, dbTables, joinGroups, values.length + 1);
    safeOrderBy = obResult.sql;
    orderByValues = obResult.values;
  }

  // Main query: bind WHERE values + orderBy aggregation values
  const mainValues = [...values, ...orderByValues];
  const main = await executeMainQuery(db, tableConf, where, mainValues, safeOrderBy, paginator, tenantJoins);

  // Pagination: bind only WHERE values (COUNT/compute queries don't use ORDER BY)
  let pagination: PaginationResult | undefined;
  if (paginator) {
    pagination = await buildPagination(db, tableConf, where, values, paginator, tenantJoins, computeMin, computeMax, computeSum, computeAvg);
  }

  // Virtual joins (only if requested)
  const result: SearchResult = { main };

  if (joins && Object.keys(joins).length > 0) {
    result.joins = await executeVirtualJoins(db, dbTables, tableConf, main, joins);
  }

  // Join groups (only if requested)
  if (joinGroups && Object.keys(joinGroups).length > 0) {
    result.joinGroups = await executeJoinGroups(db, dbTables, tableConf, main, joinGroups);
  }

  if (pagination) {
    result.pagination = pagination;
  }

  return result;
}
