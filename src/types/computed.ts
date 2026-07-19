import type { TSchema } from '@sinclair/typebox';
import type { QueryClient } from '../lib/db.js';

/**
 * Context passed to ComputedFieldFn when the engine resolves a computed field.
 * - `db` exposes dialect-aware helpers (qi, ph, dialectName, dateTrunc, ...).
 * - `qiCol(field, opts?)` returns a quoted column reference, optionally
 *   prefixed by an alias qualifier — needed when the computed is embedded in
 *   a `LEFT JOIN <table> AS <alias>` (joinLeft).
 */
export interface ComputedFieldContext {
  db: QueryClient;
  qiCol(field: string, opts?: { qualifier?: string }): string;
}

/**
 * Result returned by a ComputedFieldFn.
 *  - `expr`: SQL fragment usable as a scalar expression. Mark each bound value with `?`
 *    (use `\?` for a literal question mark, e.g. the PostgreSQL jsonb operator). The engine
 *    assigns the placeholder positions — never write `$1` / `db.ph(n)` yourself, and never
 *    interpolate user-derived data into the SQL.
 *  - `values`: bound parameter values, one per `?` marker in `expr`. A mismatch between
 *    markers and values is rejected: it would bind values the query never references.
 *  - `type`: TypeBox schema for Swagger filters and main response (REQUIRED).
 *
 * Example:
 *   ({ qiCol }) => ({
 *     expr: `CASE WHEN ${qiCol('role')} = ? THEN ${qiCol('salary')} ELSE 0 END`,
 *     values: ['admin'],
 *     type: Type.Number(),
 *   })
 */
export interface ComputedFieldExpr {
  expr: string;
  values: unknown[];
  type: TSchema;
}

export type ComputedFieldFn = (ctx: ComputedFieldContext) => ComputedFieldExpr;
