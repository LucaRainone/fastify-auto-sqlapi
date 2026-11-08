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
  subPath,
  validateSchemaField,
  evaluateComputedField,
  resolveFieldRef,
} from './fields.js';
import type {
  ComputedFieldFn,
  FilterRecord,
  TableConfig,
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
  params: unknown[] | undefined,
  at = ''
): void {
  const paramsPath = subPath(at, 'params');
  if (params !== undefined && !Array.isArray(params)) {
    err400('invalid_params', paramsPath, `Condition method '${method}': 'params' must be an array`);
  }
  const args = params ?? [];
  const require = (n: number): void => {
    if (args.length < n) {
      err400('invalid_params', paramsPath, `Condition method '${method}' requires ${n} param(s), got ${args.length}`);
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
      err400('invalid_params', paramsPath, `Condition method '${method}' requires an array as its first param`);
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

/**
 * Operator conditions on a join reference, against a schema or a computed field. `at` is the
 * request path of the join reference (`joinMultiple.<alias>`), '' when unknown.
 */
function applyJoinRefConditions(
  cb: ConditionBuilder,
  conditions: SearchCondition[],
  joinTableConf: TableConfig | undefined,
  joinSchema: SchemaDefinition,
  db: QueryClient,
  colQualifier: string,
  at: string
): void {
  const computed = joinTableConf?.computedFields;

  for (const [i, c] of conditions.entries()) {
    const here = subPath(subPath(at, 'conditions'), i);
    if (!ALLOWED_SET.has(c.method)) {
      err400('invalid_method', subPath(here, 'method'), `Invalid condition method: ${c.method}`);
    }
    // Computed fields resolve to an Expression carrying their own bound values, which the
    // ConditionBuilder places together with the compared value.
    const fn = ownField(computed, c.field);
    const operand = fn
      ? evaluateComputedField(c.field, fn, joinSchema, db, colQualifier, '', true)
      : `${db.qi(colQualifier)}.${db.qi(validateSchemaField(c.field, joinSchema, joinTableConf, subPath(here, 'field')))}`;
    dispatchConditionMethod(cb, c.method, operand, c.params ?? [], here);
  }
}

/**
 * The WHERE of a join reference: its equality `filters` (plain, computed) and its operator
 * `conditions`. `at` is the reference's request path (`joinGroup.<alias>`), for the 400s.
 */
export function buildJoinRefCondition(
  joinTableConf: TableConfig | undefined,
  joinSchema: SchemaDefinition,
  ref: JoinRefFilter,
  db: QueryClient,
  qualifier?: string,
  at = ''
): ConditionBuilder {
  assertFiltersReadable(ref.filters, joinTableConf, subPath(at, 'filters'));
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
    applyJoinRefConditions(cb, ref.conditions, joinTableConf, joinSchema, db, colQualifier, at);
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
  tableConf: TableConfig,
  db: QueryClient
): void {
  for (const [i, c] of conditions.entries()) {
    // Skip dot-notation fields — those become aggregation conditions processed later
    if (c.field.includes('.')) continue;

    const here = `conditions.${i}`;
    if (!ALLOWED_SET.has(c.method)) {
      err400('invalid_method', `${here}.method`, `Invalid condition method: ${c.method}`);
    }

    // A computed field resolves to an Expression carrying its own bound values; the
    // ConditionBuilder places them, so no placeholder offset is computed here.
    const ref = resolveFieldRef(c.field, schema, tableConf, db, undefined, `${here}.field`);
    dispatchConditionMethod(condition, c.method, ref.expr, c.params, here);
  }
}

/** Computed-field equality filters on the main table. */
export function applyComputedFilters(
  condition: ConditionBuilder,
  filters: FilterRecord,
  tableConf: TableConfig,
  db: QueryClient
): void {
  applyComputedEqualityFilters(
    condition, filters, tableConf.computedFields, tableConf.Schema, db
  );
}
