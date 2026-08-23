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
 *
 * `qualifier` is the raw (unquoted) table name or alias to prefix columns with; it
 * defaults to the table's own name. The engines pass an alias when the condition lands
 * inside a correlated subquery whose FROM is aliased — there the bare table name would
 * resolve against the OUTER query.
 */
export type TableFilterFn = (filters: FilterRecord, dialect?: CbDialect, qualifier?: string) => ConditionBuilder;

/** Which read path produced the rows an `afterRead` hook is handed. */
export type ReadSource = 'get' | 'search' | 'joinMultiple' | 'joinLeft';

/** Where the rows an `afterRead` hook receives came from. */
export interface AfterReadContext {
  source: ReadSource;
  /** The relation's alias, on the two join sources; absent on `get` and `search`. */
  alias?: string;
}

export interface ITable<F extends Record<string, TSchema> = Record<string, TSchema>> {
  primary: (string & keyof F) | (string & keyof F)[];
  Schema: SchemaDefinition<F>;
  filters: TableFilterFn;
  extraFilters: Record<string, TSchema>;
  /**
   * Virtual fields produced by a SQL expression. Usable like schema fields in
   * `filters`, `conditions` (non-dotted), `orderBy` (1-part),
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
  /**
   * Narrow a field's generated type where the DB could only describe it loosely: a column
   * Postgres calls `text` is an email, a UUID, a URL; an `integer` has a range. The generated
   * schema is as precise as `information_schema` allows, and this is where the rest goes.
   *
   * **Write bodies only.** An override is a rule about what this API accepts from now on, and
   * the rows already in the table were written before it existed: a column narrowed to
   * `format: 'email'` today holds whatever was accepted last year. Narrowing the response
   * would publish a promise about data nobody can retroactively make true, so responses and
   * the `filters` map stay on the generated type.
   *
   * The override is taken **verbatim**, because on the request side the schema is the rule: no
   * `Type.Optional` means the field is mandatory and no `Nullable` means an explicit `null` is
   * rejected, whatever the column allows. That is how a column the database had to leave
   * nullable, because it was added to a populated table, is made mandatory going forward.
   *
   * It is not a re-typing mechanism. Nothing stops an override from turning a `number` into a
   * `string`, but the value crossing the wire is still whatever the driver read from the
   * column, so the declaration would simply be false. Transforming a value between storage and
   * API is what `afterRead` (out) and `beforeInsert`/`beforeUpdate` (in) are for.
   */
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
   * Runs on the rows a read returned, once per result set, before they become the response.
   * The read-side counterpart of `beforeInsert`/`beforeUpdate`: the place to turn a stored
   * representation back into the API one (decrypting a column, unpacking a blob).
   *
   * `rows` are camelCase records and are mutated **in place** — the return value is ignored.
   * Rows cannot be added or removed: the pagination `COUNT` has already run, so a hook that
   * dropped rows would report a `total` that does not match what it returned. Narrowing what
   * a caller sees is `filters`, `tenantScope` and `readExclude`; hiding a field is
   * `readExclude`.
   *
   * Declared on the table that OWNS the column, and it follows a join: the hook runs whenever
   * that table's rows surface, including through a `joinMultiple` or `joinLeft` declared on
   * another table (`ctx.source` and `ctx.alias` say which). It does not run on `joinGroup`,
   * whose rows are aggregates rather than table rows.
   *
   * Not called when the read returned no rows. Whatever the hook writes is serialized against
   * the response schema, so a transform that changes a field's JSON type needs a matching
   * `schemaOverrides` entry — without it `fast-json-stringify` coerces the value silently.
   *
   * `req` is the Fastify request that triggered the read. Same caveat as `beforeDelete`:
   * present through the auto-generated HTTP routes, `undefined` when a programmatic caller
   * invokes `sqlApi.search()`/`sqlApi.get()` without passing one.
   */
  afterRead?: (
    db: QueryClient,
    req: FastifyRequest | undefined,
    rows: Record<string, unknown>[],
    ctx: AfterReadContext
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
  /**
   * Fields hidden from every read: they are not projected by search/get, not included
   * in the read response schemas, and omitted from this table's default join selection
   * when it is the target of a join.
   *
   * Referencing an excluded field from filters, conditions, orderBy, aggregations or an
   * explicit join selection is rejected with 400 — hiding a field from the output while
   * letting it be filtered would still leak its value by bisection.
   *
   * Write paths are NOT affected: a field can be writable but never readable (e.g. a
   * password hash). Primary-key fields cannot be excluded.
   */
  readExclude?: (string & keyof F)[];
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

/**
 * True when the primary key spans more than one column. Operations that address a
 * record by a single PK value (get, delete, bulkDelete) cannot work on such tables:
 * matching on the first column alone would hit every row sharing that value.
 */
export function isCompositePrimary(pk: string | string[]): boolean {
  return Array.isArray(pk) && pk.length > 1;
}

export function primaryAsCols(pk: string | string[], colFn: (f: string) => string): string | string[] {
  return Array.isArray(pk) ? pk.map(colFn) : colFn(pk);
}
