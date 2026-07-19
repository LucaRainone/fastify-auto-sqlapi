import type { QueryClient } from '../../db.js';
import { ConditionBuilder, Expression, type ConditionValue } from 'node-condition-builder';
import { camelcaseObject } from '../../naming.js';
import { QueryParams } from '../query-params.js';
import { buildTenantCondition, buildTenantJoin } from '../../tenant.js';
import { assertReadable, assertFiltersReadable, readableSelectColumns } from '../../read-access.js';
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
  TenantContext,
  TenantScopeIndirect,
  ComputedFieldContext,
  ComputedFieldExpr,
  ComputedFieldFn,
} from '../../../types.js';

// ─── Schema field validation ────────────────────────────────

function validateSchemaField(
  field: string,
  schema: SchemaDefinition,
  tableConf?: ITable
): string {
  if (!(field in schema.fields)) {
    const err = new Error(`Unknown field: ${field}`) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  assertReadable(tableConf, field);
  return schema.col(field);
}

function err400(msg: string): never {
  const e = new Error(msg) as Error & { statusCode: number };
  e.statusCode = 400;
  throw e;
}

// ─── Computed fields resolution ─────────────────────────────

/**
 * Build a ComputedFieldContext bound to a specific table/schema. `alias`
 * (if provided) qualifies the columns produced by `qiCol` — needed when the
 * computed is embedded in a `LEFT JOIN <table> AS <alias>` (joinLeft).
 */
function buildComputedContext(
  db: QueryClient,
  schema: SchemaDefinition,
  alias?: string
): ComputedFieldContext {
  return {
    db,
    qiCol(field: string, opts?: { qualifier?: string }): string {
      if (!(field in schema.fields)) {
        err400(`Unknown field referenced by computed expression: ${field}`);
      }
      const col = db.qi(schema.col(field));
      // Default to the owning table: the statement may carry joins, and a bare
      // column shared with a joined table would be ambiguous.
      const qualifier = opts?.qualifier ?? alias ?? schema.tableName;
      return qualifier ? `${db.qi(qualifier)}.${col}` : col;
    },
  };
}

/**
 * Resolve a field reference in a request body to a SQL operand. A schema column becomes
 * the quoted column name; a computed field becomes an Expression carrying its own bound
 * values, so it can be handed straight to a ConditionBuilder. Throws 400 if neither.
 */
interface ResolvedFieldRef {
  expr: string | Expression;
  computed: boolean;
}

function resolveFieldRef(
  field: string,
  schema: SchemaDefinition,
  tableConf: ITable | undefined,
  db: QueryClient,
  alias?: string
): ResolvedFieldRef {
  if (field in schema.fields) {
    assertReadable(tableConf, field);
    const col = db.qi(schema.col(field));
    // Qualified with the alias or the owning table — never bare, so the reference
    // stays unambiguous when the statement carries joins.
    const expr = `${db.qi(alias ?? schema.tableName)}.${col}`;
    return { expr, computed: false };
  }

  const fn = tableConf?.computedFields?.[field];
  if (fn) {
    const ctx = buildComputedContext(db, schema, alias);
    return { expr: computedExpression(field, fn(ctx)), computed: true };
  }

  err400(`Unknown field: ${field}`);
}

// ─── Join lookup ────────────────────────────────────────────

/**
 * Tenant-scope a join side-query. When the joined table declares its own `tenantScope`,
 * appends the tenant condition to `cb` (direct: `col IN ids`; indirect: condition on the
 * through table) and, for indirect scopes, pushes the INNER JOIN clause into `joins`.
 * No-op without a tenant context (admin) or when the join table is not tenant-scoped.
 */
function appendJoinTenantScope(
  db: QueryClient,
  joinTableConf: ITable | undefined,
  tenant: TenantContext | undefined,
  joinTableName: string,
  cb: ConditionBuilder,
  joins?: string[]
): void {
  const scope = joinTableConf?.tenantScope;
  if (!tenant || !scope) return;
  cb.append(buildTenantCondition(db, scope, tenant.ids, joinTableName));
  if ('through' in scope) {
    joins?.push(buildTenantJoin(db, scope as TenantScopeIndirect, joinTableName));
  }
}

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

// ─── Reusable helpers for join references / computed fields ─

interface JoinRefs {
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
function extractJoinRefs(db: QueryClient, tableConf: ITable, joinDef: JoinDefinition): JoinRefs {
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

/**
 * Evaluate a computed field into an Expression carrying its own bound values.
 *
 * Inside a WHERE clause the ConditionBuilder assigns the placeholder indexes, so bound
 * values are always safe there. `allowBoundValues=false` is for the positions that sit
 * *before* the WHERE values in the parameter order (SELECT projections, aggregations),
 * where they cannot be placed correctly; those still reject with 400.
 */
function evaluateComputedField(
  name: string,
  fn: ComputedFieldFn,
  schema: SchemaDefinition,
  db: QueryClient,
  alias: string | undefined,
  message: string,
  allowBoundValues = false,
): Expression {
  const ev: ComputedFieldExpr = fn(buildComputedContext(db, schema, alias));
  if (!allowBoundValues && (ev.values?.length ?? 0) > 0) {
    err400(message);
  }
  return computedExpression(name, ev);
}

/**
 * Build the Expression for a computed field, checking that it marks each bound value
 * with a `?`.
 *
 * A mismatch is always a table-configuration bug and would otherwise produce a query that
 * binds values nobody references — silently returning wrong rows. Expressions without
 * bound values are exempt: they are emitted verbatim, so a `?` there is a literal operator
 * (PostgreSQL jsonb) rather than a marker.
 */
function computedExpression(name: string, ev: ComputedFieldExpr): Expression {
  const values = ev.values ?? [];
  if (values.length > 0) {
    const markers = (ev.expr.match(/\\\?|\?/g) ?? []).filter((m) => m === '?').length;
    if (markers !== values.length) {
      throw new Error(
        `Computed field '${name}' declares ${values.length} bound value(s) but its expression ` +
        `contains ${markers} '?' marker(s). Mark each bound value with '?' (use '\\?' for a ` +
        `literal question mark) so the engine can assign placeholder positions.`
      );
    }
  }
  return new Expression(ev.expr, values);
}

/** Bound values carried by a resolved field reference. */
function refValues(expr: string | Expression): unknown[] {
  return expr instanceof Expression ? [...expr.values] : [];
}

/** Render a resolved field reference to SQL, binding any values from `startIndex`. */
function renderRef(
  expr: string | Expression,
  startIndex: number,
  db: QueryClient
): string {
  return expr instanceof Expression ? expr.render(startIndex, db.ph) : expr;
}

/** Map rows from snake_case columns to camelCase fields, preserving any computed-field columns
 * that are projected by their declared name (skipped by camelcaseObject). */
function mapRowsToCamelCase(
  rows: Record<string, unknown>[],
  schema: SchemaDefinition,
  computedFieldNames?: Iterable<string>,
): Record<string, unknown>[] {
  const computed = computedFieldNames ? new Set(computedFieldNames) : null;
  return rows.map((r) => {
    const camel = camelcaseObject(r, schema);
    if (computed) {
      for (const name of computed) {
        if (name in r) camel[name] = r[name];
      }
    }
    return camel;
  });
}

/**
 * Build the SELECT columns list for a join fetch: '*' or comma-separated quoted columns.
 * A default '*' selection narrows to the join table's readable columns when it declares
 * `readExclude`; an explicit selection naming an excluded field is rejected with 400.
 */
function buildSelectionColumns(
  selection: string,
  joinSchema: SchemaDefinition,
  db: QueryClient,
  joinTableConf?: ITable
): string {
  if (selection === '*') {
    return readableSelectColumns(joinTableConf, joinSchema, db) ?? '*';
  }
  const table = db.qi(joinSchema.tableName);
  return selection
    .split(',')
    .map((c) => `${table}.${db.qi(validateSchemaField(c.trim(), joinSchema, joinTableConf))}`)
    .join(', ');
}

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

  const fieldCol = validateSchemaField(field, joinSchema);
  const refs = extractJoinRefs(db, tableConf, joinDef);

  let filterWhere = '';
  let filterVals: unknown[] = [];
  const joinTableConf = dbTables[joinSchema.tableName];
  if (groupReq.filters || groupReq.conditions?.length) {
    const cb = buildJoinRefCondition(
      joinTableConf,
      joinSchema,
      { filters: groupReq.filters, conditions: groupReq.conditions },
      db,
    );
    const fragment = cb.toExpression();
    if (fragment.value) {
      filterWhere = ` AND ${fragment.value}`;
      filterVals = [...fragment.values];
    }
  }

  const qualifiedCol = `${refs.joinTable}.${db.qi(fieldCol)}`;
  const expr = `COALESCE((SELECT ${aggExpr(aggFn, qualifiedCol)} FROM ${refs.joinTable} WHERE ${refs.joinTable}.${refs.fkCol} = ${refs.mainTable}.${refs.mainCol}${filterWhere}), 0)`;

  return new Expression(expr, filterVals);
}

// ─── orderBy parsing & validation ───────────────────────────

interface OrderByResult {
  sql: string;
  values: unknown[];
  /** Aliases referenced in 2-parti notation (joinLeft) — need a LEFT JOIN. */
  leftJoinAliases: Set<string>;
}

/**
 * Pre-scan `orderBy` for the joinLeft aliases referenced in 2-parti notation (`<alias>.<field>`).
 * Needed BEFORE building the LEFT JOIN clauses (which must know their aliases) while the actual
 * orderBy SQL — with its parameter placeholders — is only baked later, once the LEFT JOIN value
 * count is known. Validates each alias against `allowedReadJoins` (throws 400), mirroring
 * `validateOrderBy`; 3-parti aggregation entries are ignored (they use joinGroup, not a LEFT JOIN).
 */
function collectOrderByLeftAliases(orderBy: string, tableConf: ITable): Set<string> {
  const aliases = new Set<string>();
  for (const part of orderBy.split(',')) {
    const trimmed = part.trim();
    if (/^(\w+)\.(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i.test(trimmed)) continue; // 3-parti aggregation
    const m = trimmed.match(/^(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i);
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

    // 3-parti: <alias>.<fn>.<field> [ASC|DESC] (aggregation via joinGroup)
    const dotted3 = trimmed.match(/^(\w+)\.(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i);
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

    // 2-parti: <alias>.<field> [ASC|DESC] (joinLeft inline ordering)
    const dotted2 = trimmed.match(/^(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i);
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

    // 1-parte: <field> [ASC|DESC] — schema field or computed
    const plain = trimmed.match(/^(\w+)(?:\s+(ASC|DESC))?$/i);
    if (!plain) {
      err400(`Invalid orderBy: ${trimmed}`);
    }
    const [, field, dir] = plain!;
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
    if (ref && (ref.filters || ref.conditions?.length)) {
      // Build a ConditionBuilder where each column is prefixed with the alias
      // (so SQL references the LEFT JOIN'd table, not a bare table name).
      // Note: extraFilters declared on joinTableConf are not supported here for
      // joinLeft (they would require alias-aware handlers); only schema fields
      // and computed fields apply.
      const cb = new ConditionBuilder('AND', db.cbDialect);
      const joinTableConf = dbTables[joinSchema.tableName];
      const computed = joinTableConf?.computedFields;

      assertFiltersReadable(ref.filters as Record<string, unknown> | undefined, joinTableConf);

      if (ref.filters) {
        for (const [field, value] of Object.entries(ref.filters)) {
          if (value === null || value === undefined) continue;
          if (field in joinSchema.fields) {
            cb.isEqual(`${aliasIdent}.${db.qi(joinSchema.col(field))}`, value);
          } else if (computed?.[field]) {
            // Computed field on the parent table: expr with alias-qualified columns. Bound
            // values are placed by this ConditionBuilder, whose SQL lands in the WHERE.
            const expr = evaluateComputedField(field, computed[field], joinSchema, db, alias, '', true);
            cb.isEqual(expr, value);
          }
        }
      }

      if (ref.conditions?.length) {
        for (const c of ref.conditions) {
          if (!ALLOWED_SET.has(c.method)) {
            err400(`Invalid condition method: ${c.method}`);
          }
          if (c.field in joinSchema.fields) {
            assertReadable(dbTables[joinSchema.tableName], c.field);
            const col = `${aliasIdent}.${db.qi(joinSchema.col(c.field))}`;
            dispatchConditionMethod(cb, c.method, col, (c.params as unknown[]) ?? []);
          } else if (computed?.[c.field]) {
            const expr = evaluateComputedField(c.field, computed[c.field], joinSchema, db, alias, '', true);
            dispatchConditionMethod(cb, c.method, expr, (c.params as unknown[]) ?? []);
          } else {
            err400(`Unknown field: ${c.field}`);
          }
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
      const match = trimmed.match(/^(\w+)(?:\s+(ASC|DESC))?$/i);
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
        name, fn!, tableConf.Schema, db, undefined,
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

  return mapRowsToCamelCase(rows as Record<string, unknown>[], tableConf.Schema, selectComputed);
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

// ─── joinMultiple (virtual fetch, child rows in side query) ─

async function executeJoinMultiple(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  mainResults: Record<string, unknown>[],
  joinMultiple: Record<string, JoinFetchRequest>,
  tenant?: TenantContext
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
    cb.isIn(`${db.qi(joinSchema.tableName)}.${db.qi(fkCol)}`, ids);
    const tenantJoins: string[] = [];
    appendJoinTenantScope(db, joinTableConf, tenant, joinSchema.tableName, cb, tenantJoins);
    const where = cb.build(1, db.ph);
    const values = cb.getValues();

    const selection = ref?.selection ?? defaultSelection;
    const columns = buildSelectionColumns(selection, joinSchema, db, joinTableConf);

    const rows = await db.select({
      tableName: joinSchema.tableName,
      columns,
      where,
      values,
      joins: tenantJoins.length > 0 ? tenantJoins : undefined,
    });

    result[alias] = mapRowsToCamelCase(rows as Record<string, unknown>[], joinSchema);
  }

  return result;
}

// ─── joinLeft (parent fetch via PK IN side query) ───────────

async function executeJoinLeft(
  db: QueryClient,
  dbTables: DbTables,
  tableConf: ITable,
  mainResults: Record<string, unknown>[],
  joinLeft: Record<string, JoinFetchRequest>,
  tenant?: TenantContext
): Promise<Record<string, Record<string, unknown>[]>> {
  const result: Record<string, Record<string, unknown>[]> = {};

  for (const [alias, ref] of Object.entries(joinLeft)) {
    const joinDef = requireJoin(tableConf, alias, true);
    const { joinSchema, joinField, mainField, selection: defaultSelection } = joinDef;
    const joinTableConf = dbTables[joinSchema.tableName];

    // For joinLeft (N:1), mainField on main is the FK pointing to joinField (PK) on parent.
    // We collect the FK values from the main results and look up parents by their PK.
    const ids = collectIds(mainResults, mainField);
    if (ids.length === 0) {
      result[alias] = [];
      continue;
    }

    const fkCol = joinSchema.col(joinField);
    const cb = new ConditionBuilder('AND', db.cbDialect);
    cb.isIn(`${db.qi(joinSchema.tableName)}.${db.qi(fkCol)}`, ids);
    const tenantJoins: string[] = [];
    appendJoinTenantScope(db, joinTableConf, tenant, joinSchema.tableName, cb, tenantJoins);
    const where = cb.build(1, db.ph);
    const values = cb.getValues();

    const selection = ref?.selection ?? defaultSelection;
    const columns = buildSelectionColumns(selection, joinSchema, db, joinTableConf);

    const rows = await db.select({
      tableName: joinSchema.tableName,
      columns,
      where,
      values,
      joins: tenantJoins.length > 0 ? tenantJoins : undefined,
    });

    result[alias] = mapRowsToCamelCase(rows as Record<string, unknown>[], joinSchema);
  }

  return result;
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
    return `${db.qi(joinSchema.tableName)}.${db.qi(joinSchema.col(by))}`;
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
    if (ids.length === 0) {
      result[alias] = {};
      continue;
    }

    const { aggregations, filters: groupFilters, conditions: groupConditions } = groupReq;
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
        selectParts.push(`${aggExpr(fn, `${db.qi(joinSchema.tableName)}.${db.qi(col)}`)} as "${kind}_${f}"`);
      }
    };
    addAgg('distinctCount', aggregations.distinctCount);
    addAgg('min', aggregations.min);
    addAgg('max', aggregations.max);
    addAgg('sum', aggregations.sum);
    addAgg('avg', aggregations.avg);
    addAgg('count', aggregations.count);

    if (selectParts.length === 0) {
      result[alias] = {};
      continue;
    }

    const groupRef = { filters: groupFilters, conditions: groupConditions };
    const cb = buildJoinRefCondition(joinTableConf, joinSchema, groupRef, db);
    const fkCol = joinSchema.col(joinField);
    cb.isIn(`${db.qi(joinSchema.tableName)}.${db.qi(fkCol)}`, ids);
    const tenantJoins: string[] = [];
    appendJoinTenantScope(db, joinTableConf, tenant, joinSchema.tableName, cb, tenantJoins);
    const where = cb.build(1, db.ph);
    const values = cb.getValues();

    const groupBy = groupByParts.length > 0 ? `GROUP BY ${groupByParts.join(', ')}` : '';
    const fromJoins = tenantJoins.length > 0 ? ` ${tenantJoins.join(' ')}` : '';
    const sql = `SELECT ${selectParts.join(', ')} FROM ${db.qi(joinSchema.tableName)}${fromJoins} WHERE ${where} ${groupBy}`;

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

function buildJoinRefCondition(
  joinTableConf: ITable | undefined,
  joinSchema: SchemaDefinition,
  ref: JoinRefFilter,
  db: QueryClient
): ConditionBuilder {
  assertFiltersReadable(ref.filters as Record<string, unknown> | undefined, joinTableConf);

  const cb = (ref.filters && joinTableConf)
    ? joinTableConf.filters(ref.filters, db.cbDialect)
    : new ConditionBuilder('AND', db.cbDialect);

  // Equality filters targeting the join table's computed fields
  const computed = joinTableConf?.computedFields;
  if (computed && ref.filters) {
    for (const [name, value] of Object.entries(ref.filters)) {
      if (value === null || value === undefined) continue;
      if (!computed[name]) continue;
      const expr = evaluateComputedField(name, computed[name], joinTableConf!.Schema, db, undefined, '', true);
      cb.isEqual(expr, value as ConditionValue);
    }
  }

  if (ref.conditions?.length) {
    for (const c of ref.conditions) {
      if (!ALLOWED_SET.has(c.method)) {
        err400(`Invalid condition method: ${c.method}`);
      }
      // Computed fields resolve to an Expression carrying their own bound values, which
      // the ConditionBuilder places together with the compared value.
      const operand = computed?.[c.field]
        ? evaluateComputedField(c.field, computed[c.field], joinTableConf!.Schema, db, undefined, '', true)
        : `${db.qi(joinSchema.tableName)}.${db.qi(validateSchemaField(c.field, joinSchema, joinTableConf))}`;
      dispatchConditionMethod(cb, c.method, operand, (c.params as unknown[]) ?? []);
    }
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
    dispatchConditionMethod(condition, c.method, ref.expr, c.params as unknown[]);
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
    dispatchConditionMethod(tmpCb, c.method, expr, c.params as unknown[]);
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

    const filterCondition = buildJoinRefCondition(joinTableConf, joinSchema, ref, db);
    const tenantJoins: string[] = [];
    appendJoinTenantScope(db, joinTableConf, tenant, joinSchema.tableName, filterCondition, tenantJoins);
    const filterWhere = params.emitCondition(filterCondition, db);

    // Qualify the FK with the join table: the EXISTS FROM may include the tenant
    // through-join, so a bare column could become ambiguous.
    const innerWhere = filterWhere
      ? `${refs.joinTable}.${refs.fkCol} = ${refs.mainTable}.${refs.mainCol} AND ${filterWhere}`
      : `${refs.joinTable}.${refs.fkCol} = ${refs.mainTable}.${refs.mainCol}`;

    const existsJoins = tenantJoins.length > 0 ? ` ${tenantJoins.join(' ')}` : '';
    where += ` AND EXISTS (SELECT 1 FROM ${refs.joinTable}${existsJoins} WHERE ${innerWhere})`;
  }

  return where;
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
  assertFiltersReadable(filters as Record<string, unknown> | undefined, tableConf);
  const condition = tableConf.filters(filters || {}, db.cbDialect);

  // Filters and conditions targeting computed fields go on the same ConditionBuilder:
  // a computed resolves to an Expression carrying its own values, and the builder is
  // what assigns every placeholder index.
  if (filters && tableConf.computedFields) {
    applyComputedFilters(condition, filters, tableConf, db);
  }

  if (conditions?.length) {
    applyConditions(condition, conditions, tableConf.Schema, tableConf, db);
  }

  // Tenant
  const tenantJoins: string[] = [];
  if (tenant) {
    condition.append(buildTenantCondition(db, tenant.scope, tenant.ids, tableConf.Schema.tableName));
    if ('through' in tenant.scope) {
      tenantJoins.push(buildTenantJoin(db, tenant.scope as TenantScopeIndirect, tableConf.Schema.tableName));
    }
  }

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

  // Determine which joinLeft aliases need a LEFT JOIN on the main query:
  // - any alias used in 2-parti orderBy
  // - any alias in joinLeft body that has filters or conditions on the parent
  const aliasesNeedingLeftJoin = new Set<string>();
  if (orderBy) {
    for (const a of collectOrderByLeftAliases(orderBy, tableConf)) aliasesNeedingLeftJoin.add(a);
  }
  if (joinLeft) {
    for (const [alias, ref] of Object.entries(joinLeft)) {
      if (ref?.filters || ref?.conditions?.length) aliasesNeedingLeftJoin.add(alias);
    }
  }

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

  if (joinMultiple && Object.keys(joinMultiple).length > 0) {
    result.joinMultiple = await executeJoinMultiple(db, dbTables, tableConf, main, joinMultiple, tenant);
  }

  if (joinLeft && Object.keys(joinLeft).length > 0) {
    result.joinLeft = await executeJoinLeft(db, dbTables, tableConf, main, joinLeft, tenant);
  }

  if (joinGroup && Object.keys(joinGroup).length > 0) {
    result.joinGroup = await executeJoinGroup(db, dbTables, tableConf, main, joinGroup, tenant);
  }

  if (pagination) {
    result.pagination = pagination;
  }

  return result;
}
