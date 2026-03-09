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
  PaginationResult,
  JoinDefinition,
  JoinGroupRequest,
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

function validateOrderBy(orderBy: string, tableConf: ITable, db: QueryClient): string {
  return orderBy.split(',').map((part) => {
    const trimmed = part.trim();
    const match = trimmed.match(/^(\w+)(?:\s+(ASC|DESC))?$/i);
    if (!match) {
      const err = new Error(`Invalid orderBy: ${trimmed}`) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
    const [, field, dir] = match;
    const col = validateSchemaField(field, tableConf.Schema);
    return `${db.qi(col)} ${(dir || 'ASC').toUpperCase()}`;
  }).join(', ');
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

  return rows.map((r) => camelcaseObject(r as Record<string, unknown>));
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
  joins: Record<string, { filters?: FilterRecord }>
): Promise<Record<string, Record<string, unknown>[]>> {
  const result: Record<string, Record<string, unknown>[]> = {};

  for (const [joinTableName, joinOpts] of Object.entries(joins)) {
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

    // Build join filters
    const cb = joinTableConf
      ? joinTableConf.filters(joinOpts?.filters || {})
      : new ConditionBuilder('AND');
    const fkCol = joinSchema.col(joinField);
    cb.isIn(db.qi(fkCol), ids);
    const where = cb.build(1, db.ph);
    const values = cb.getValues();

    const columns = selection === '*' ? '*' : selection;
    const rows = await db.select({
      tableName: joinSchema.tableName,
      columns,
      where,
      values,
    });

    result[joinTableName] = rows.map((r) => camelcaseObject(r as Record<string, unknown>));
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

    const { aggregations, filters: groupFilters } = groupReq;
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

    if (selectParts.length === 0) {
      result[joinTableName] = {};
      continue;
    }

    // Build WHERE clause
    const joinTableConf = dbTables[joinTableName];
    const cb = joinTableConf && groupFilters
      ? joinTableConf.filters(groupFilters)
      : new ConditionBuilder('AND');
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

function buildJoinFiltersExists(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  joinFilters: Record<string, FilterRecord>,
  currentWhere: string,
  currentValues: unknown[]
): { where: string; values: unknown[] } {
  let where = currentWhere;
  const values = [...currentValues];

  for (const [joinTableName, filterValues] of Object.entries(joinFilters)) {
    const joinDef = findJoinDefinition(tableConf, joinTableName);
    if (!joinDef) continue;

    const [joinSchema, joinField, mainField] = joinDef;
    const joinTableConf = dbTables[joinTableName];
    if (!joinTableConf) continue;

    const filterCondition = joinTableConf.filters(filterValues);
    const startIdx = values.length + 1;
    const filterWhere = filterCondition.build(startIdx, db.ph);
    const filterVals = filterCondition.getValues();

    const fkCol = db.qi(joinSchema.col(joinField));
    const mainColName = Array.isArray(mainField) ? mainField[0] : mainField;
    const mainCol = db.qi(tableConf.Schema.col(mainColName));
    const mainTable = db.qi(tableConf.Schema.tableName);

    where += ` AND EXISTS (SELECT 1 FROM ${db.qi(joinSchema.tableName)} WHERE ${fkCol} = ${mainTable}.${mainCol} AND ${filterWhere})`;
    values.push(...filterVals);
  }

  return { where, values };
}

export async function searchEngine(
  dbTables: DbTables,
  params: SearchParams
): Promise<SearchResult> {
  const { db, tableConf, filters, joinFilters, joins, joinGroups, orderBy, paginator, computeMin, computeMax, computeSum, computeAvg, tenant } = params;

  // Build main condition
  const condition = tableConf.filters(filters || {});

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

  // Validate and sanitize orderBy (user input -> SQL identifier)
  const safeOrderBy = orderBy ? validateOrderBy(orderBy, tableConf, db) : undefined;

  // Main query
  const main = await executeMainQuery(db, tableConf, where, values, safeOrderBy, paginator, tenantJoins);

  // Pagination
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
