/**
 * Turning a request's `filters` and `conditions` into ConditionBuilder clauses.
 *
 * The method vocabulary itself lives in lib/condition-methods.ts, which is a pure data
 * module shared with the TypeBox schema builders — the dispatch below is kept out of it so
 * that module keeps its zero dependencies.
 */
import { ConditionBuilder, Expression } from 'node-condition-builder';
import type { QueryClient } from '../../db.js';
import { assertFiltersReadable, ownField } from '../../read-access.js';
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
  ComputedFieldFn,
  FilterRecord,
  ITable,
  JoinRefFilter,
  SchemaDefinition,
  SearchCondition,
} from '../../../types.js';

/**
 * Apply one condition method to a builder, after checking the request actually supplied the
 * operands that method needs.
 *
 * `params` is optional in the request schema, so `{field, method}` with no params is a
 * well-formed request that reaches here — reading `params[0]` off it throws a TypeError the
 * error handler can only report as a 500. Arity is checked here rather than at the four call
 * sites so no path can skip it.
 */
export function dispatchConditionMethod(
  cb: ConditionBuilder,
  method: string,
  colOrExpr: string | Expression,
  params: unknown[] | undefined
): void {
  if (params !== undefined && !Array.isArray(params)) {
    err400(`Condition method '${method}': 'params' must be an array`);
  }
  const args = params ?? [];
  const require = (n: number): void => {
    if (args.length < n) {
      err400(`Condition method '${method}' requires ${n} param(s), got ${args.length}`);
    }
  };

  if (SINGLE_VALUE_SET.has(method)) {
    require(1);
    (cb[method as keyof ConditionBuilder] as Function)(colOrExpr, args[0]);
  } else if (BETWEEN_SET.has(method)) {
    require(2);
    (cb[method as keyof ConditionBuilder] as Function)(colOrExpr, args[0], args[1]);
  } else if (IN_SET.has(method)) {
    require(1);
    // An explicit `undefined` stays a documented no-op; any other non-array would make the
    // builder iterate a non-iterable.
    if (args[0] !== undefined && !Array.isArray(args[0])) {
      err400(`Condition method '${method}' requires an array as its first param`);
    }
    (cb[method as keyof ConditionBuilder] as Function)(colOrExpr, args[0]);
  } else if (NULL_SET.has(method)) {
    (cb[method as keyof ConditionBuilder] as Function)(colOrExpr, true);
  }
}

/**
 * Equality filters targeting *computed* fields: `filters.<computedName>` becomes
 * `<expr> = <value>` on the builder `tableConf.filters()` has already populated with the plain
 * column filters. A name that is not a declared computed field is skipped — it was either
 * handled there or rejected up front by `assertKnownFilterKeys`.
 *
 * `qualifier` prefixes the columns the computed expression references: the join's qualifier
 * inside a side query, undefined on the main table (where the schema's own name is used).
 */
function applyComputedEqualityFilters(
  cb: ConditionBuilder,
  filters: FilterRecord,
  computed: Record<string, ComputedFieldFn> | undefined,
  schema: SchemaDefinition,
  db: QueryClient,
  qualifier?: string
): void {
  if (!computed) return;

  for (const [name, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    const fn = ownField(computed, name);
    if (!fn) continue;
    const expr = evaluateComputedField(name, fn, schema, db, qualifier, '', true);
    cb.isEqual(expr, value);
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
    const fn = ownField(computed, c.field);
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
    applyComputedEqualityFilters(
      cb, ref.filters, joinTableConf?.computedFields, joinSchema, db, colQualifier
    );
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

/** Computed-field equality filters on the main table. */
export function applyComputedFilters(
  condition: ConditionBuilder,
  filters: FilterRecord,
  tableConf: ITable,
  db: QueryClient
): void {
  applyComputedEqualityFilters(
    condition, filters, tableConf.computedFields, tableConf.Schema, db
  );
}
