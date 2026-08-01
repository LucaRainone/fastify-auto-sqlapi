/**
 * Field resolution for the search engine: turning a name in a request body into a SQL
 * operand, and rows back into API records.
 *
 * This is the leaf of the search modules — it knows about schemas, computed fields and
 * read access, and nothing about joins, ordering or query execution.
 */
import { Expression } from 'node-condition-builder';
import type { QueryClient } from '../../db.js';
import { camelcaseObject } from '../../naming.js';
import {
  assertReadable,
  readableSelectColumns,
  explicitSelectColumns,
  hasOwnField,
  ownField,
} from '../../read-access.js';
import type {
  ITable,
  SchemaDefinition,
  ComputedFieldContext,
  ComputedFieldExpr,
  ComputedFieldFn,
} from '../../../types.js';

// ─── Schema field validation ────────────────────────────────

export function validateSchemaField(
  field: string,
  schema: SchemaDefinition,
  tableConf?: ITable
): string {
  if (!hasOwnField(schema.fields, field)) {
    const err = new Error(`Unknown field: ${field}`) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  assertReadable(tableConf, field);
  return schema.col(field);
}

export function err400(msg: string): never {
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
      if (!hasOwnField(schema.fields, field)) {
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
export interface ResolvedFieldRef {
  expr: string | Expression;
  computed: boolean;
}

export function resolveFieldRef(
  field: string,
  schema: SchemaDefinition,
  tableConf: ITable | undefined,
  db: QueryClient,
  alias?: string
): ResolvedFieldRef {
  if (hasOwnField(schema.fields, field)) {
    assertReadable(tableConf, field);
    const col = db.qi(schema.col(field));
    // Qualified with the alias or the owning table — never bare, so the reference
    // stays unambiguous when the statement carries joins.
    const expr = `${db.qi(alias ?? schema.tableName)}.${col}`;
    return { expr, computed: false };
  }

  const fn = ownField(tableConf?.computedFields, field);
  if (fn) {
    const ctx = buildComputedContext(db, schema, alias);
    return { expr: computedExpression(field, fn(ctx)), computed: true };
  }

  err400(`Unknown field: ${field}`);
}

/**
 * Evaluate a computed field into an Expression carrying its own bound values.
 *
 * Inside a WHERE clause the ConditionBuilder assigns the placeholder indexes, so bound
 * values are always safe there. `allowBoundValues=false` is for the positions that sit
 * *before* the WHERE values in the parameter order (SELECT projections, aggregations),
 * where they cannot be placed correctly; those still reject with 400.
 */
export function evaluateComputedField(
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
export function refValues(expr: string | Expression): unknown[] {
  return expr instanceof Expression ? [...expr.values] : [];
}

/** Render a resolved field reference to SQL, binding any values from `startIndex`. */
export function renderRef(
  expr: string | Expression,
  startIndex: number,
  db: QueryClient
): string {
  return expr instanceof Expression ? expr.render(startIndex, db.ph) : expr;
}

/** Map rows from snake_case columns to camelCase fields, preserving any computed-field columns
 * that are projected by their declared name (skipped by camelcaseObject). */
export function mapRowsToCamelCase(
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
 *
 * On a relation narrowed by a `fields` allowlist the '*' is always spelled out. Emitting a
 * real `SELECT *` there would fetch the excluded columns and leave them to be dropped by
 * the response serializer — which does not run for a caller of `sqlApi.search()`.
 */
export function buildSelectionColumns(
  selection: string,
  joinSchema: SchemaDefinition,
  db: QueryClient,
  joinTableConf?: ITable,
  restricted = false
): string {
  if (selection === '*') {
    if (restricted) return explicitSelectColumns(joinTableConf, joinSchema, db);
    return readableSelectColumns(joinTableConf, joinSchema, db) ?? '*';
  }
  const table = db.qi(joinSchema.tableName);
  return selection
    .split(',')
    .map((c) => `${table}.${db.qi(validateSchemaField(c.trim(), joinSchema, joinTableConf))}`)
    .join(', ');
}
