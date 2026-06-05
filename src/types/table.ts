import type { Expression, ConditionBuilder, ConditionValueOrUndefined } from 'node-condition-builder';
import type { TSchema, Static } from '@sinclair/typebox';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { QueryClient } from '../lib/db.js';
import type { SchemaDefinition } from './schema.js';
import type { ComputedFieldFn } from './computed.js';
import type { JoinDefinition } from './join.js';
import type { TenantScope } from './tenant.js';
import type { ValidatorFn, BulkValidatorFn } from './validation.js';

export type FilterRecord = Record<string, ConditionValueOrUndefined>;
export type ExtendedConditionFn = (condition: ConditionBuilder, filters: FilterRecord) => void;
export type TableFilterFn = (filters: FilterRecord) => ConditionBuilder;

export interface ITable<F extends Record<string, TSchema> = Record<string, TSchema>> {
  primary: (string & keyof F) | (string & keyof F)[];
  Schema: SchemaDefinition<F>;
  filters: TableFilterFn;
  extraFilters: Record<string, TSchema>;
  /**
   * Virtual fields produced by a SQL expression. Usable like schema fields in
   * `filters`, `conditions` (non-dotted), `orderBy` (1-parte),
   * `computeMin/Max/Sum/Avg`, and (opt-in) in `selectComputed` for the main
   * response. Each entry MUST declare `type` for Swagger and validation.
   *
   * Naming clashes with `Schema.fields` or `extraFilters` keys throw at
   * `defineTable` time.
   */
  computedFields?: Record<string, ComputedFieldFn>;
  allowedReadJoins?: JoinDefinition[];
  allowedWriteJoins?: JoinDefinition[];
  upsertMap?: Map<SchemaDefinition, string[]>;
  schemaOverrides?: Partial<Record<string & keyof F, TSchema>>;
  validate?: ValidatorFn<F>;
  validateBulk?: BulkValidatorFn<F>;
  beforeInsert?: (
    db: QueryClient,
    req: FastifyRequest,
    record: { [K in keyof F]?: Static<F[K]> | Expression | null }
  ) => Promise<void>;
  beforeUpdate?: (
    db: QueryClient,
    req: FastifyRequest,
    fields: { [K in keyof F]?: Static<F[K]> | Expression | null },
    secondaryFieldsFetcher?: unknown
  ) => void | Promise<void>;
  afterInsert?: (
    db: QueryClient,
    req: FastifyRequest,
    record: { [K in keyof F]?: Static<F[K]> },
    secondaryRecords?: unknown
  ) => Promise<void>;
  /**
   * Runs before a single record is deleted (DELETE /rest/:id). Throw to abort the
   * deletion (the thrown error's `statusCode`/`message` are surfaced to the client).
   * Use it to enforce referential or business rules the DB cascade would otherwise hide.
   *
   * For tenant-scoped tables the hook only runs once ownership has been verified, so it
   * never fires for rows the caller cannot access.
   *
   * `req` is the Fastify request that triggered the operation. It is always present when
   * the delete comes through the auto-generated HTTP route. It is `undefined` only if you
   * call `sqlApi.delete(table, id)` programmatically without passing a request — in that
   * case any hook that reads request context (e.g. `req.user`) must guard for it.
   */
  beforeDelete?: (
    db: QueryClient,
    req: FastifyRequest,
    id: string | number
  ) => void | Promise<void>;
  /**
   * Bulk counterpart of `beforeDelete`, invoked ONCE with all ids before a bulk delete
   * (POST /bulk/:table/delete). Called once — not per id — to preserve the single-query
   * optimization. Throw to abort the whole batch. `beforeDelete` is NOT called for bulk
   * deletes; configure this hook if you need a guard there.
   *
   * Same `req` caveat as `beforeDelete`: present via the HTTP route, `undefined` only when
   * `sqlApi.bulkDelete(table, ids)` is called programmatically without a request.
   */
  beforeBulkDelete?: (
    db: QueryClient,
    req: FastifyRequest,
    ids: (string | number)[]
  ) => void | Promise<void>;
  defaultOrder?: string;
  excludeFromCreation?: (string & keyof F)[];
  distinctResults?: boolean;
  onRequests?: ((request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>)[];
  tenantScope?: TenantScope;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbTables = Record<string, ITable<any>>;

// Primary key helpers
export function primaryAsString(pk: string | string[]): string {
  return Array.isArray(pk) ? pk[0] : pk;
}

export function primaryAsCols(pk: string | string[], colFn: (f: string) => string): string | string[] {
  return Array.isArray(pk) ? pk.map(colFn) : colFn(pk);
}
