import type { QueryClient } from '../../db.js';
import { ConditionBuilder, type ConditionValue } from 'node-condition-builder';
import { camelcaseObject } from '../../naming.js';
import { buildTenantCondition, buildTenantJoin } from '../../tenant.js';
import { primaryAsString } from '../../../types.js';
import type {
  DbTables,
  SearchParams,
  SearchResult,
  SearchCondition,
  PaginationResult,
  JoinDefinition,
  JoinGroupRequest,
  JoinRefFilter,
  JoinFetchRequest,
  ITable,
  SchemaDefinition,
  TenantScopeIndirect,
} from '../../../types.js';

// ─── Schema field validation ────────────────────────────────

function validateSchemaField(field: string, schema: SchemaDefinition): string {
  if (!(field in schema.fields)) {
    const err = new Error(`Unknown field: ${field}`) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return schema.col(field);
}

function err400(msg: string): never {
  const e = new Error(msg) as Error & { statusCode: number };
  e.statusCode = 400;
  throw e;
}

// ─── Join lookup ────────────────────────────────────────────

function findJoinByAlias(tableConf: ITable, alias: string): JoinDefinition | undefined {
  return tableConf.allowedReadJoins?.find((j) => j.alias === alias);
}

function requireJoin(tableConf: ITable, alias: string, requireUnique: boolean): JoinDefinition {
  const joinDef = findJoinByAlias(tableConf, alias);
  if (!joinDef) {
    err400(`Unknown join alias: ${alias}`);
  }
  if (requireUnique && !joinDef!.unique) {
    err400(`Join alias '${alias}' is not declared with unique:true; use joinMultiple/joinMustExist/joinGroup instead`);
  }
  if (!requireUnique && joinDef!.unique) {
    err400(`Join alias '${alias}' is declared with unique:true; use joinLeft instead`);
  }
  return joinDef!;
}

// ─── Aggregation orderBy / conditions ───────────────────────

const AGG_FN_SQL: Record<string, string> = {
  sum: 'SUM',
  min: 'MIN',
  max: 'MAX',
  avg: 'AVG',
  count: 'COUNT',
  distinctCount: 'COUNT DISTINCT',
};

function buildAggOrderExpr(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  alias: string,
  fn: string,
  field: string,
  joinGroup: Record<string, JoinGroupRequest> | undefined,
  startIdx: number
): { expr: string; values: unknown[] } {
  if (!(fn in AGG_FN_SQL)) {
    err400(`Invalid aggregation function: ${fn}`);
  }

  const groupReq = joinGroup?.[alias];
  if (!groupReq) {
    err400(`orderBy/conditions reference undeclared joinGroup: ${alias}`);
  }
  const declaredFields = (groupReq!.aggregations as Record<string, unknown>)[fn];
  if (!Array.isArray(declaredFields) || !declaredFields.includes(field)) {
    err400(`orderBy/conditions reference undeclared aggregation: ${alias}.${fn}.${field}`);
  }

  const joinDef = requireJoin(tableConf, alias, false);
  const { joinSchema, joinField, mainField } = joinDef;

  if (groupReq!.aggregations.by && groupReq!.aggregations.by !== joinField) {
    err400(`Cannot order by aggregation on joinGroup with 'by' clause on non-FK column: ${alias} (grouped by '${groupReq!.aggregations.by}', correlation FK is '${joinField}')`);
  }

  const fieldCol = validateSchemaField(field, joinSchema);

  const mainColName = Array.isArray(mainField) ? mainField[0] : mainField;
  const mainCol = db.qi(tableConf.Schema.col(mainColName));
  const mainTable = db.qi(tableConf.Schema.tableName);
  const joinTable = db.qi(joinSchema.tableName);
  const fkCol = db.qi(joinSchema.col(joinField));

  let filterWhere = '';
  let filterVals: unknown[] = [];
  const joinTableConf = dbTables[joinSchema.tableName];
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

  const qField = db.qi(fieldCol);
  const fnSql = AGG_FN_SQL[fn];
  const aggExpr = fnSql === 'COUNT DISTINCT'
    ? `COUNT(DISTINCT ${joinTable}.${qField})`
    : `${fnSql}(${joinTable}.${qField})`;

  const expr = `COALESCE((SELECT ${aggExpr} FROM ${joinTable} WHERE ${joinTable}.${fkCol} = ${mainTable}.${mainCol}${filterWhere}), 0)`;

  return { expr, values: filterVals };
}

// ─── orderBy parsing & validation ───────────────────────────

interface OrderByResult {
  sql: string;
  values: unknown[];
  /** Aliases referenced in 2-parti notation (joinLeft) — need a LEFT JOIN. */
  leftJoinAliases: Set<string>;
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

    // 3-parti: <alias>.<fn>.<field> [ASC|DESC] (aggregation via joinGroup)
    const dotted3 = trimmed.match(/^(\w+)\.(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i);
    if (dotted3) {
      if (tableConf.distinctResults) {
        err400('Cannot combine distinctResults with aggregation orderBy');
      }
      const [, alias, fn, field, dir] = dotted3;
      const { expr, values } = buildAggOrderExpr(
        db, dbTables, tableConf, alias, fn, field, joinGroup, currentIdx
      );
      outParts.push(`${expr} ${(dir || 'ASC').toUpperCase()}`);
      outValues.push(...values);
      currentIdx += values.length;
      continue;
    }

    // 2-parti: <alias>.<field> [ASC|DESC] (joinLeft inline ordering)
    const dotted2 = trimmed.match(/^(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i);
    if (dotted2) {
      const [, alias, field, dir] = dotted2;
      const joinDef = requireJoin(tableConf, alias, true);
      const col = validateSchemaField(field, joinDef.joinSchema);
      // Reference the LEFT JOIN'd table via its alias (SQL identifier).
      outParts.push(`${db.qi(alias)}.${db.qi(col)} ${(dir || 'ASC').toUpperCase()}`);
      leftJoinAliases.add(alias);
      continue;
    }

    // 1-parte: <field> [ASC|DESC]
    const plain = trimmed.match(/^(\w+)(?:\s+(ASC|DESC))?$/i);
    if (!plain) {
      err400(`Invalid orderBy: ${trimmed}`);
    }
    const [, field, dir] = plain!;
    const col = validateSchemaField(field, tableConf.Schema);
    outParts.push(`${db.qi(col)} ${(dir || 'ASC').toUpperCase()}`);
  }

  return { sql: outParts.join(', '), values: outValues, leftJoinAliases };
}

// ─── joinLeft: LEFT JOIN clause builder ─────────────────────

interface LeftJoinBuild {
  joinClauses: string[];
  whereExtras: string[];
  values: unknown[];
}

function buildLeftJoinClauses(
  db: QueryClient,
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
    const { joinSchema, joinField, mainField } = joinDef;

    const mainColName = Array.isArray(mainField) ? mainField[0] : mainField;
    const mainCol = db.qi(tableConf.Schema.col(mainColName));
    const mainTable = db.qi(tableConf.Schema.tableName);
    const joinTable = db.qi(joinSchema.tableName);
    const fkCol = db.qi(joinSchema.col(joinField));
    const aliasIdent = db.qi(alias);

    joinClauses.push(
      `LEFT JOIN ${joinTable} AS ${aliasIdent} ON ${aliasIdent}.${fkCol} = ${mainTable}.${mainCol}`
    );

    const ref = joinLeft?.[alias];
    if (ref && (ref.filters || ref.conditions?.length)) {
      // Build a ConditionBuilder where each column is prefixed with the alias
      // (so SQL references the LEFT JOIN'd table, not a bare table name).
      // Note: extraFilters declared on joinTableConf are not supported here for
      // joinLeft (they would require alias-aware handlers); only schema fields apply.
      const cb = new ConditionBuilder('AND');

      if (ref.filters) {
        for (const [field, value] of Object.entries(ref.filters)) {
          if (value === null || value === undefined) continue;
          if (field in joinSchema.fields) {
            cb.isEqual(`${aliasIdent}.${db.qi(joinSchema.col(field))}`, value);
          }
        }
      }

      if (ref.conditions?.length) {
        for (const c of ref.conditions) {
          if (!ALLOWED_SET.has(c.method)) {
            err400(`Invalid condition method: ${c.method}`);
          }
          const col = `${aliasIdent}.${db.qi(validateSchemaField(c.field, joinSchema))}`;
          dispatchConditionMethod(cb, c.method, col, (c.params as unknown[]) ?? []);
        }
      }

      const sql = cb.build(currentIdx, db.ph);
      const vals = cb.getValues();
      if (sql) {
        whereExtras.push(sql);
        values.push(...vals);
        currentIdx += vals.length;
      }
    }
  }

  return { joinClauses, whereExtras, values };
}

// ─── Main query execution ───────────────────────────────────

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

// ─── joinMultiple (virtual fetch, child rows in side query) ─

async function executeJoinMultiple(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  mainResults: Record<string, unknown>[],
  joinMultiple: Record<string, JoinFetchRequest>
): Promise<Record<string, Record<string, unknown>[]>> {
  const result: Record<string, Record<string, unknown>[]> = {};

  for (const [alias, ref] of Object.entries(joinMultiple)) {
    const joinDef = requireJoin(tableConf, alias, false);
    const { joinSchema, joinField, mainField, selection: defaultSelection } = joinDef;
    const joinTableConf = dbTables[joinSchema.tableName];

    const ids = collectIds(mainResults, mainField);
    if (ids.length === 0) {
      result[alias] = [];
      continue;
    }

    const cb = buildJoinRefCondition(joinTableConf, joinSchema, ref || {}, db);
    const fkCol = joinSchema.col(joinField);
    cb.isIn(db.qi(fkCol), ids);
    const where = cb.build(1, db.ph);
    const values = cb.getValues();

    const selection = ref?.selection ?? defaultSelection;
    const columns = selection === '*'
      ? '*'
      : selection.split(',').map((c) => db.qi(joinSchema.col(c.trim()))).join(', ');

    const rows = await db.select({
      tableName: joinSchema.tableName,
      columns,
      where,
      values,
    });

    result[alias] = rows.map((r) => camelcaseObject(r as Record<string, unknown>, joinSchema));
  }

  return result;
}

// ─── joinLeft (parent fetch via PK IN side query) ───────────

async function executeJoinLeft(
  db: QueryClient,
  tableConf: ITable,
  mainResults: Record<string, unknown>[],
  joinLeft: Record<string, JoinFetchRequest>
): Promise<Record<string, Record<string, unknown>[]>> {
  const result: Record<string, Record<string, unknown>[]> = {};

  for (const [alias, ref] of Object.entries(joinLeft)) {
    const joinDef = requireJoin(tableConf, alias, true);
    const { joinSchema, joinField, mainField, selection: defaultSelection } = joinDef;

    // For joinLeft (N:1), mainField on main is the FK pointing to joinField (PK) on parent.
    // We collect the FK values from the main results and look up parents by their PK.
    const ids = collectIds(mainResults, mainField);
    if (ids.length === 0) {
      result[alias] = [];
      continue;
    }

    const fkCol = joinSchema.col(joinField);
    const cb = new ConditionBuilder('AND');
    cb.isIn(db.qi(fkCol), ids);
    const where = cb.build(1, db.ph);
    const values = cb.getValues();

    const selection = ref?.selection ?? defaultSelection;
    const columns = selection === '*'
      ? '*'
      : selection.split(',').map((c) => db.qi(joinSchema.col(c.trim()))).join(', ');

    const rows = await db.select({
      tableName: joinSchema.tableName,
      columns,
      where,
      values,
    });

    result[alias] = rows.map((r) => camelcaseObject(r as Record<string, unknown>, joinSchema));
  }

  return result;
}

const TRUNCATE_UNITS = new Set(['year', 'quarter', 'month', 'day', 'hour']);

function buildByExpression(
  by: string | { field: string; truncate: string },
  joinSchema: SchemaDefinition,
  db: QueryClient
): string {
  if (typeof by === 'string') {
    return db.qi(validateSchemaField(by, joinSchema));
  }
  if (!by.field || !by.truncate) {
    err400(`Invalid 'by' specification: expected { field, truncate }`);
  }
  if (!TRUNCATE_UNITS.has(by.truncate)) {
    err400(`Invalid truncate unit: '${by.truncate}'. Allowed: year, quarter, month, day, hour`);
  }
  const col = db.qi(validateSchemaField(by.field, joinSchema));
  const qualifiedCol = `${db.qi(joinSchema.tableName)}.${col}`;
  return db.dateTrunc(by.truncate as 'year' | 'quarter' | 'month' | 'day' | 'hour', qualifiedCol);
}

// ─── joinGroup (aggregations) ───────────────────────────────

async function executeJoinGroup(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  mainResults: Record<string, unknown>[],
  joinGroup: Record<string, JoinGroupRequest>
): Promise<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = {};

  for (const [alias, groupReq] of Object.entries(joinGroup)) {
    const joinDef = requireJoin(tableConf, alias, false);
    const { joinSchema, joinField, mainField } = joinDef;

    const ids = collectIds(mainResults, mainField);
    if (ids.length === 0) {
      result[alias] = {};
      continue;
    }

    const { aggregations, filters: groupFilters, conditions: groupConditions } = groupReq;
    const selectParts: string[] = [];
    const groupByParts: string[] = [];

    if (aggregations.by) {
      const byExpr = buildByExpression(aggregations.by, joinSchema, db);
      selectParts.push(`${byExpr} as "by"`);
      groupByParts.push(byExpr);
    }

    const addAgg = (kind: string, fnSql: string, fields: string[] | undefined): void => {
      if (!fields) return;
      for (const f of fields) {
        const col = validateSchemaField(f, joinSchema);
        const expr = fnSql === 'COUNT DISTINCT'
          ? `COUNT(DISTINCT ${db.qi(col)})`
          : `${fnSql}(${db.qi(col)})`;
        selectParts.push(`${expr} as "${kind}_${f}"`);
      }
    };
    addAgg('distinctCount', 'COUNT DISTINCT', aggregations.distinctCount);
    addAgg('min', 'MIN', aggregations.min);
    addAgg('max', 'MAX', aggregations.max);
    addAgg('sum', 'SUM', aggregations.sum);
    addAgg('avg', 'AVG', aggregations.avg);
    addAgg('count', 'COUNT', aggregations.count);

    if (selectParts.length === 0) {
      result[alias] = {};
      continue;
    }

    const joinTableConf = dbTables[joinSchema.tableName];
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

    result[alias] = formatted;
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
        err400(`Invalid condition method: ${c.method}`);
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

    if (!ALLOWED_SET.has(c.method)) {
      err400(`Invalid condition method: ${c.method}`);
    }

    const col = db.qi(validateSchemaField(c.field, schema));
    dispatchConditionMethod(condition, c.method, col, c.params as unknown[]);
  }
}

function appendAggConditions(
  currentWhere: string,
  currentValues: unknown[],
  conditions: SearchCondition[],
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  joinGroup: Record<string, JoinGroupRequest> | undefined
): { where: string; values: unknown[] } {
  let where = currentWhere;
  let values = [...currentValues];

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

    const { expr, values: exprValues } = buildAggOrderExpr(
      db, dbTables, tableConf, alias, fn, field, joinGroup, values.length + 1
    );
    values = [...values, ...exprValues];

    const tmpCb = new ConditionBuilder('AND');
    dispatchConditionMethod(tmpCb, c.method, expr, c.params as unknown[]);
    const startIdx = values.length + 1;
    const clause = tmpCb.build(startIdx, db.ph);
    where += ` AND ${clause}`;
    values.push(...tmpCb.getValues());
  }

  return { where, values };
}

// ─── joinMustExist (EXISTS subquery filter on main) ─────────

function buildJoinMustExistClauses(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  joinMustExist: Record<string, JoinRefFilter>,
  currentWhere: string,
  currentValues: unknown[]
): { where: string; values: unknown[] } {
  let where = currentWhere;
  const values = [...currentValues];

  for (const [alias, ref] of Object.entries(joinMustExist)) {
    const joinDef = requireJoin(tableConf, alias, false);
    const { joinSchema, joinField, mainField } = joinDef;
    const joinTableConf = dbTables[joinSchema.tableName];

    const filterCondition = buildJoinRefCondition(joinTableConf, joinSchema, ref, db);
    const startIdx = values.length + 1;
    const filterWhere = filterCondition.build(startIdx, db.ph);
    const filterVals = filterCondition.getValues();

    const fkCol = db.qi(joinSchema.col(joinField));
    const mainColName = Array.isArray(mainField) ? mainField[0] : mainField;
    const mainCol = db.qi(tableConf.Schema.col(mainColName));
    const mainTable = db.qi(tableConf.Schema.tableName);

    const innerWhere = filterWhere
      ? `${fkCol} = ${mainTable}.${mainCol} AND ${filterWhere}`
      : `${fkCol} = ${mainTable}.${mainCol}`;

    where += ` AND EXISTS (SELECT 1 FROM ${db.qi(joinSchema.tableName)} WHERE ${innerWhere})`;
    values.push(...filterVals);
  }

  return { where, values };
}

// ─── searchEngine entrypoint ────────────────────────────────

export async function searchEngine(
  dbTables: DbTables,
  params: SearchParams
): Promise<SearchResult> {
  const {
    db, tableConf, filters, conditions,
    joinMustExist, joinMultiple, joinGroup, joinLeft,
    orderBy, paginator,
    computeMin, computeMax, computeSum, computeAvg, tenant,
  } = params;

  // Validate aliases used as keys against allowedReadJoins + unique flag (early 400s)
  if (joinMustExist) for (const a of Object.keys(joinMustExist)) requireJoin(tableConf, a, false);
  if (joinMultiple) for (const a of Object.keys(joinMultiple)) requireJoin(tableConf, a, false);
  if (joinGroup) for (const a of Object.keys(joinGroup)) requireJoin(tableConf, a, false);
  if (joinLeft) for (const a of Object.keys(joinLeft)) requireJoin(tableConf, a, true);

  // Build main condition
  const condition = tableConf.filters(filters || {});

  if (conditions?.length) {
    applyConditions(condition, conditions, tableConf.Schema, db);
  }

  // Tenant
  const tenantJoins: string[] = [];
  if (tenant) {
    condition.append(buildTenantCondition(db, tenant.scope, tenant.ids));
    if ('through' in tenant.scope) {
      tenantJoins.push(buildTenantJoin(db, tenant.scope as TenantScopeIndirect, tableConf.Schema.tableName));
    }
  }

  let where = condition.build(1, db.ph);
  let values: unknown[] = [...condition.getValues()];

  // joinMustExist (EXISTS)
  if (joinMustExist && Object.keys(joinMustExist).length > 0) {
    ({ where, values } = buildJoinMustExistClauses(db, dbTables, tableConf, joinMustExist, where, values));
  }

  // Aggregation conditions (HAVING-style)
  if (conditions?.length) {
    const hasAggConditions = conditions.some((c) => c.field.includes('.'));
    if (hasAggConditions) {
      ({ where, values } = appendAggConditions(where, values, conditions, db, dbTables, tableConf, joinGroup));
    }
  }

  // orderBy parsing — collects 2-parti aliases that need LEFT JOIN on the main query
  let safeOrderBy: string | undefined;
  let orderByValues: unknown[] = [];
  let orderByLeftAliases = new Set<string>();
  if (orderBy) {
    const obResult = validateOrderBy(orderBy, tableConf, db, dbTables, joinGroup, values.length + 1);
    safeOrderBy = obResult.sql;
    orderByValues = obResult.values;
    orderByLeftAliases = obResult.leftJoinAliases;
  }

  // Determine which joinLeft aliases need a LEFT JOIN on the main query:
  // - any alias used in 2-parti orderBy
  // - any alias in joinLeft body that has filters or conditions on the parent
  const aliasesNeedingLeftJoin = new Set<string>(orderByLeftAliases);
  if (joinLeft) {
    for (const [alias, ref] of Object.entries(joinLeft)) {
      if (ref?.filters || ref?.conditions?.length) aliasesNeedingLeftJoin.add(alias);
    }
  }

  // Build LEFT JOIN clauses + extra WHERE for filtered parents
  const extraJoinClauses: string[] = [...tenantJoins];
  let leftJoinValues: unknown[] = [];
  if (aliasesNeedingLeftJoin.size > 0) {
    const lj = buildLeftJoinClauses(
      db, tableConf, aliasesNeedingLeftJoin, joinLeft, values.length + 1
    );
    extraJoinClauses.push(...lj.joinClauses);
    leftJoinValues = lj.values;
    for (const w of lj.whereExtras) where += ` AND ${w}`;
  }

  // Bind WHERE values + LEFT JOIN values + orderBy aggregation values for main query.
  // Pagination COUNT/compute include WHERE + LEFT JOIN values (no orderBy).
  const whereAndJoinValues = [...values, ...leftJoinValues];
  const mainValues = [...whereAndJoinValues, ...orderByValues];

  const main = await executeMainQuery(
    db, tableConf, where, mainValues, safeOrderBy, paginator, extraJoinClauses
  );

  let pagination: PaginationResult | undefined;
  if (paginator) {
    pagination = await buildPagination(
      db, tableConf, where, whereAndJoinValues, paginator, extraJoinClauses,
      computeMin, computeMax, computeSum, computeAvg
    );
  }

  const result: SearchResult = { main };

  if (joinMultiple && Object.keys(joinMultiple).length > 0) {
    result.joinMultiple = await executeJoinMultiple(db, dbTables, tableConf, main, joinMultiple);
  }

  if (joinLeft && Object.keys(joinLeft).length > 0) {
    result.joinLeft = await executeJoinLeft(db, tableConf, main, joinLeft);
  }

  if (joinGroup && Object.keys(joinGroup).length > 0) {
    result.joinGroup = await executeJoinGroup(db, dbTables, tableConf, main, joinGroup);
  }

  if (pagination) {
    result.pagination = pagination;
  }

  return result;
}
