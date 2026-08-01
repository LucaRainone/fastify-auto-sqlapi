/**
 * Correlated aggregate subqueries — the machinery behind `<alias>.<fn>.<field>` in both
 * `orderBy` and `conditions` (HAVING-style).
 *
 * Kept separate from ./conditions.ts on purpose: an aggregate embeds a join-reference
 * condition, while a dotted condition embeds an aggregate. Holding both in one module would
 * be fine, but splitting them the other way round (aggregates with orderBy) would make
 * order-by and conditions import each other.
 */
import { ConditionBuilder, Expression } from 'node-condition-builder';
import type { QueryClient } from '../../db.js';
import type { QueryParams } from '../query-params.js';
import { ALLOWED_SET } from '../../condition-methods.js';
import { err400, validateSchemaField } from './fields.js';
import { requireJoin, extractJoinRefs, subqueryAlias } from './joins.js';
import { buildJoinRefCondition, dispatchConditionMethod } from './conditions.js';
import type {
  DbTables,
  ITable,
  JoinGroupRequest,
  SearchCondition,
} from '../../../types.js';

export interface AggFn { sql: string; distinct: boolean }

export const AGG_FN: Record<string, AggFn> = {
  sum:           { sql: 'SUM',   distinct: false },
  min:           { sql: 'MIN',   distinct: false },
  max:           { sql: 'MAX',   distinct: false },
  avg:           { sql: 'AVG',   distinct: false },
  count:         { sql: 'COUNT', distinct: false },
  distinctCount: { sql: 'COUNT', distinct: true  },
};

export function aggExpr(fn: AggFn, qualifiedCol: string): string {
  return fn.distinct ? `COUNT(DISTINCT ${qualifiedCol})` : `${fn.sql}(${qualifiedCol})`;
}

/**
 * Correlated aggregate subquery for `<alias>.<fn>.<field>`, as an Expression carrying the
 * values of its optional filter. Markers are `?`, so whoever embeds it — a ConditionBuilder
 * or an ORDER BY list — decides the placeholder positions.
 */
export function buildAggOrderExpr(
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

/** HAVING-style conditions: the dotted `<alias>.<fn>.<field>` entries of `conditions`. */
export function appendAggConditions(
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
