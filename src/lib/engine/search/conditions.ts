/**
 * Turning a request's `filters` and `conditions` into ConditionBuilder clauses.
 *
 * The method vocabulary itself lives in lib/condition-methods.ts, which is a pure data
 * module shared with the TypeBox schema builders — the dispatch below is kept out of it so
 * that module keeps its zero dependencies.
 */
import { ConditionBuilder, Expression, type ConditionValue } from 'node-condition-builder';
import type { QueryClient } from '../../db.js';
import { assertFiltersReadable } from '../../read-access.js';
import {
  ALLOWED_SET, SINGLE_VALUE_SET, BETWEEN_SET, IN_SET, NULL_SET,
} from '../../condition-methods.js';
import {
  err400,
  validateSchemaField,
  evaluateComputedField,
  resolveFieldRef,
} from './fields.js';
import type {
  FilterRecord,
  ITable,
  JoinRefFilter,
  SchemaDefinition,
  SearchCondition,
} from '../../../types.js';

export function dispatchConditionMethod(
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

export function buildJoinRefCondition(
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
export function applyConditions(
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
export function applyComputedFilters(
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
