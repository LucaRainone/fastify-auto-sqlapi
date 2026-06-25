import type { Expression, ConditionBuilder, ConditionValueOrUndefined, DialectName as CbDialect } from 'node-condition-builder';
import type { TSchema, Static } from '@sinclair/typebox';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { QueryClient } from '../lib/db.js';
import type { SchemaDefinition } from './schema.js';
import type { ComputedFieldFn } from './computed.js';
import type { JoinDefinition } from './join.js';
import type { TenantScope } from './tenant.js';
import type { ValidatorFn, BulkValidatorFn } from './validation.js';

/** Auto-generated HTTP operations that can be enabled per table via `ITable.operations`. */
export type TableOperation =
  | 'search'
  | 'get'
  | 'insert'
  | 'update'
  | 'delete'
  | 'bulkUpsert'
  | 'bulkDelete';

export type FilterRecord = Record<string, ConditionValueOrUndefined>;
export type ExtendedConditionFn = (condition: ConditionBuilder, filters: FilterRecord) => void;
/**
 * Builds the WHERE ConditionBuilder for a table from filter values. The optional
 * `dialect` selects identifier quoting and builder behavior per call (the engines pass
 * the dialect of the QueryClient that runs the query); when omitted, the global
 * `ConditionBuilder.DIALECT` is used.
 */
export type TableFilterFn = (filters: FilterRecord, dialect?: CbDialect) => ConditionBuilder;

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
   * Runs after a successful update, inside the same transaction as the UPDATE +
   * secondaries + deletions: throwing here rolls back the whole operation (when the
   * adapter supports transactions). Receives the camelCase input record (including the
   * PK) plus the secondaries/deletions results, mirroring `afterInsert`.
   */
  afterUpdate?: (
    db: QueryClient,
    req: FastifyRequest,
    record: { [K in keyof F]?: Static<F[K]> | Expression | null },
    secondaryRecords?: unknown,
    deletionRecords?: unknown
  ) => void | Promise<void>;
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
   * Runs after a single record has been deleted (DELETE /rest/:id). Not called when the
   * record was not found (404). Same `req` caveat as `beforeDelete`.
   */
  afterDelete?: (
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
  /**
   * Bulk counterpart of `afterDelete`, invoked ONCE after a bulk delete with the ids that
   * were ACTUALLY deleted (which may be a subset of the requested ids). Not called when
   * nothing was deleted. Same `req` caveat as `beforeBulkDelete`.
   */
  afterBulkDelete?: (
    db: QueryClient,
    req: FastifyRequest,
    deletedIds: (string | number)[]
  ) => void | Promise<void>;
  /**
   * Whitelist of auto-generated HTTP routes for this table. When omitted, ALL operations
   * are exposed (search, get, insert, update, delete, bulkUpsert, bulkDelete) — the
   * default is intentionally open, see the Security section in the README. Listing only
   * some operations skips registering the others entirely (they answer 404).
   *
   * Note: this gates the HTTP routes only; the programmatic `sqlApi.*` methods are not
   * affected.
   */
  operations?: TableOperation[];
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
