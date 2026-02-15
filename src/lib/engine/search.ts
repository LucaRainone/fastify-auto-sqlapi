import { escapeIdent, type QueryClient } from '../db.js';
import { camelcaseObject } from '../naming.js';
import { buildTenantWhere, buildTenantJoin } from '../tenant.js';
import type {
  DbTables,
  SearchParams,
  SearchResult,
  PaginationResult,
  JoinDefinition,
  JoinGroupRequest,
  ITable,
  SchemaDefinition,
  TenantScopeIndirect,
} from '../../types.js';

function validateSchemaField(field: string, schema: SchemaDefinition): string {
  if (!(field in schema.fields)) {
    const err = new Error(`Unknown field: ${field}`) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return schema.col(field);
}

function validateOrderBy(orderBy: string, tableConf: ITable): string {
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
    return `"${col}" ${(dir || 'ASC').toUpperCase()}`;
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
  const order = orderBy || tableConf.defaultOrder || tableConf.primary;

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
    `SELECT COUNT(*) as total FROM "${escapeIdent(tableName)}"${joinClause} WHERE ${where}`,
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
        `SELECT ${fn}("${escapeIdent(col)}") as value FROM "${escapeIdent(tableName)}"${joinClause} WHERE ${where}`,
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
  joins: Record<string, { filters?: Record<string, unknown> }>
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
    const joinCondition = joinTableConf
      ? joinTableConf.filters(joinOpts?.filters || {})
      : undefined;

    const values: unknown[] = [];
    let where: string;

    if (joinCondition) {
      const condStr = joinCondition.build(1, (i) => `$${i}`);
      values.push(...joinCondition.getValues());
      const inPlaceholders = ids.map((_, i) => `$${values.length + i + 1}`).join(', ');
      values.push(...ids);
      const fkCol = escapeIdent(joinSchema.col(joinField));
      where = condStr
        ? `${condStr} AND "${fkCol}" IN (${inPlaceholders})`
        : `"${fkCol}" IN (${inPlaceholders})`;
    } else {
      const inPlaceholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      values.push(...ids);
      const fkCol = escapeIdent(joinSchema.col(joinField));
      where = `"${fkCol}" IN (${inPlaceholders})`;
    }

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
      const byCol = escapeIdent(validateSchemaField(aggregations.by, joinSchema));
      selectParts.push(`"${byCol}" as "by"`);
      groupByParts.push(`"${byCol}"`);
    }

    if (aggregations.distinctCount) {
      for (const f of aggregations.distinctCount) {
        const col = escapeIdent(validateSchemaField(f, joinSchema));
        selectParts.push(`COUNT(DISTINCT "${col}") as "distinctCount_${f}"`);
      }
    }
    if (aggregations.min) {
      for (const f of aggregations.min) {
        const col = escapeIdent(validateSchemaField(f, joinSchema));
        selectParts.push(`MIN("${col}") as "min_${f}"`);
      }
    }
    if (aggregations.max) {
      for (const f of aggregations.max) {
        const col = escapeIdent(validateSchemaField(f, joinSchema));
        selectParts.push(`MAX("${col}") as "max_${f}"`);
      }
    }
    if (aggregations.sum) {
      for (const f of aggregations.sum) {
        const col = escapeIdent(validateSchemaField(f, joinSchema));
        selectParts.push(`SUM("${col}") as "sum_${f}"`);
      }
    }

    if (selectParts.length === 0) {
      result[joinTableName] = {};
      continue;
    }

    // Build WHERE clause
    const values: unknown[] = [];
    const joinTableConf = dbTables[joinTableName];
    const filterCondition = joinTableConf && groupFilters
      ? joinTableConf.filters(groupFilters)
      : undefined;

    let where: string;
    const fkCol = escapeIdent(joinSchema.col(joinField));
    if (filterCondition) {
      const condStr = filterCondition.build(1, (i) => `$${i}`);
      values.push(...filterCondition.getValues());
      const inPlaceholders = ids.map((_, i) => `$${values.length + i + 1}`).join(', ');
      values.push(...ids);
      where = condStr
        ? `${condStr} AND "${fkCol}" IN (${inPlaceholders})`
        : `"${fkCol}" IN (${inPlaceholders})`;
    } else {
      const inPlaceholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      values.push(...ids);
      where = `"${fkCol}" IN (${inPlaceholders})`;
    }

    const groupBy = groupByParts.length > 0 ? `GROUP BY ${groupByParts.join(', ')}` : '';
    const sql = `SELECT ${selectParts.join(', ')} FROM "${escapeIdent(joinSchema.tableName)}" WHERE ${where} ${groupBy}`;

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
): unknown[] {
  if (Array.isArray(mainField)) {
    // Composite key: collect tuples
    const seen = new Set<string>();
    const ids: unknown[] = [];
    for (const r of mainResults) {
      const key = mainField.map((f) => r[f]).join('|');
      if (!seen.has(key) && mainField.every((f) => r[f] != null)) {
        seen.add(key);
        ids.push(...mainField.map((f) => r[f]));
      }
    }
    return ids;
  }

  const unique = [...new Set(mainResults.map((r) => r[mainField]).filter((v) => v != null))];
  return unique;
}

export async function searchEngine(
  dbTables: DbTables,
  params: SearchParams
): Promise<SearchResult> {
  const { db, tableConf, filters, joins, joinGroups, orderBy, paginator, computeMin, computeMax, computeSum, computeAvg, tenant } = params;

  // Build main condition
  const condition = tableConf.filters(filters || {});
  const values = condition.getValues();
  let where = condition.build(1, (i) => `$${i}`) || '1=1';

  // Tenant filtering
  const tenantJoins: string[] = [];
  if (tenant) {
    const tw = buildTenantWhere(tenant.scope, tenant.ids, values.length + 1);
    where += ` AND ${tw.sql}`;
    values.push(...tw.values);
    if ('through' in tenant.scope) {
      tenantJoins.push(buildTenantJoin(tenant.scope as TenantScopeIndirect, tableConf.Schema.tableName));
    }
  }

  // Validate and sanitize orderBy (user input → SQL identifier)
  const safeOrderBy = orderBy ? validateOrderBy(orderBy, tableConf) : undefined;

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
