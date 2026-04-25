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
 *  - `expr`: SQL fragment usable as a scalar expression.
 *  - `values`: bound parameter values (always parameterized — never interpolate
 *    user-derived data into `expr`).
 *  - `type`: TypeBox schema for Swagger filters and main response (REQUIRED).
 */
export interface ComputedFieldExpr {
  expr: string;
  values: unknown[];
  type: TSchema;
}

export type ComputedFieldFn = (ctx: ComputedFieldContext) => ComputedFieldExpr;
