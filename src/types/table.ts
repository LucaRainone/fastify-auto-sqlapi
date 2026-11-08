import type { ConditionBuilder, ConditionValueOrUndefined, DialectName as CbDialect } from 'node-condition-builder';
import type { TSchema } from 'typebox';
import type { ApiRequest, ApiReply } from './request.js';
import type { SchemaDefinition } from './schema.js';
import type { ComputedFieldFn } from './computed.js';
import type { JoinDefinition } from './join.js';
import type { TenantScope } from './tenant.js';
import type { ValidatorFn, BulkValidatorFn } from './validation.js';
import type {
  WriteHookContext,
  AfterInsertContext,
  AfterUpdateContext,
  AfterReadContext,
  DeleteHookContext,
  BulkDeleteHookContext,
} from './hooks.js';

/** Auto-generated HTTP operations that can be enabled per table via `TableConfig.operations`. */
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

export interface TableConfig<F extends Record<string, TSchema> = Record<string, TSchema>> {
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
  // ─── Hooks: each receives ONE context object (`HookContext` + the operation's data) ───
  //
  // `ctx.db` is the client the operation runs on (inside a write, the transaction's), `ctx.req`
  // the triggering request — `undefined` when `sqlApi.*` is called without one. The data is
  // named as in the glossary: `record`, `secondaries`, `deletions`, `rows`, `id`, `ids`.

  /** Business validation of an insert/update: `{ db, req, main, secondaries }` → errors (any → 400, nothing written). */
  validate?: ValidatorFn<F>;
  /** Bulk upsert validation, called once with every item: `{ db, req, items }`. When set, per-item `validate` is skipped in bulk. */
  validateBulk?: BulkValidatorFn<F>;
  /** Before the INSERT, after `insertExclude` stripped the client payload (ADR 0005): mutate `ctx.record` in place. */
  beforeInsert?: (ctx: WriteHookContext<F>) => void | Promise<void>;
  /** Before the UPDATE: mutate `ctx.record` in place. The PK is present but never written. */
  beforeUpdate?: (ctx: WriteHookContext<F>) => void | Promise<void>;
  /**
   * Runs after a successful insert: `{ db, req, record, secondaries }`, the camelCase input
   * record merged with the generated primary key, and the secondaries written with it, keyed
   * by alias (absent when the request had none).
   *
   * On an insert it runs inside the transaction of the INSERT and its secondaries, so throwing
   * rolls them back. On a bulk upsert it runs once per item, outside any transaction (ADR 0003).
   */
  afterInsert?: (ctx: AfterInsertContext<F>) => void | Promise<void>;
  /**
   * Runs after a successful update, inside the same transaction as the UPDATE + secondaries +
   * deletions: throwing here rolls back the whole operation. `{ db, req, record, secondaries,
   * deletions }`: the camelCase input record (including the PK) plus the secondaries written
   * and the child rows deleted, by alias.
   */
  afterUpdate?: (ctx: AfterUpdateContext<F>) => void | Promise<void>;
  /**
   * Runs on the rows a read returned, once per result set, before they become the response:
   * `{ db, req, rows, source, alias }`. The read-side counterpart of `beforeInsert`/
   * `beforeUpdate`: the place to turn a stored representation back into the API one
   * (decrypting a column, unpacking a blob).
   *
   * `rows` are camelCase records and are mutated **in place** — the return value is ignored.
   * Rows cannot be added or removed: the pagination `COUNT` has already run, so a hook that
   * dropped rows would report a `total` that does not match what it returned. Narrowing what
   * a caller sees is `filters`, `tenantScope` and `readExclude`; hiding a field is
   * `readExclude`.
   *
   * Declared on the table that OWNS the column, and it follows a join: the hook runs whenever
   * that table's rows surface, including through a `joinMultiple` or `joinLeft` declared on
   * another table (`source` and `alias` say which). It does not run on `joinGroup`, whose rows
   * are aggregates rather than table rows.
   *
   * Not called when the read returned no rows. Whatever the hook writes is serialized against
   * the response schema, so a transform that changes a field's JSON type needs a matching
   * `schemaOverrides` entry — without it `fast-json-stringify` coerces the value silently.
   */
  afterRead?: (ctx: AfterReadContext) => void | Promise<void>;
  /**
   * Runs before a single record is deleted (DELETE /rest/:id): `{ db, req, id }`. Throw to
   * abort the deletion (the thrown error's `statusCode`/`message` are surfaced to the client).
   * Use it to enforce referential or business rules the DB cascade would otherwise hide.
   *
   * For tenant-scoped tables the hook only runs once ownership has been verified, so it
   * never fires for rows the caller cannot access.
   */
  beforeDelete?: (ctx: DeleteHookContext) => void | Promise<void>;
  /** Runs after a single record has been deleted: `{ db, req, id }`. Not called when the record was not found (404). */
  afterDelete?: (ctx: DeleteHookContext) => void | Promise<void>;
  /**
   * Bulk counterpart of `beforeDelete`, invoked ONCE with all ids before a bulk delete
   * (POST /bulk/:table/delete): `{ db, req, ids }`. Called once — not per id — to preserve the
   * single-query optimization. Throw to abort the whole batch. `beforeDelete` is NOT called
   * for bulk deletes; configure this hook if you need a guard there.
   */
  beforeBulkDelete?: (ctx: BulkDeleteHookContext) => void | Promise<void>;
  /**
   * Bulk counterpart of `afterDelete`, invoked ONCE after a bulk delete with the ids that were
   * ACTUALLY deleted (a subset of the requested ones when some rows did not exist):
   * `{ db, req, ids }`. Not called when nothing was deleted.
   */
  afterBulkDelete?: (ctx: BulkDeleteHookContext) => void | Promise<void>;
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
  /**
   * Fields that no write may carry: removed from the insert, update and bulk-upsert bodies
   * (so sending one is a 400, not a driver error) and dropped again in the engines, which
   * `sqlApi.*` reaches without the HTTP schemas. Reads are untouched — the field stays
   * projected, filterable and orderable.
   *
   * It is the write-side counterpart of `readExclude`, and it exists for columns the database
   * refuses to be told about: a `GENERATED ALWAYS AS (<expr>)` column is already excluded
   * automatically through the Schema's `generatedFields`, and this key covers the rest — a
   * column a trigger owns, one a migration is about to drop.
   *
   * Not a per-caller permission: it is static and applies to everyone, admins included.
   * Field-level rules that depend on who is asking belong in `beforeUpdate` (silent strip) or
   * `validate` (loud 400). Not `insertExclude` either — that one whitelists client input on
   * insert only, and deliberately lets a hook assign the field afterwards.
   *
   * The primary key cannot be excluded: the update body identifies the row with it.
   */
  writeExclude?: (string & keyof F)[];
  /**
   * Fields a client may not send on insert: their value is dropped from the client payload,
   * and they are Optional in the insert body. The server still may set them — `beforeInsert`
   * runs after the drop, and the FK of a secondary is auto-filled after it too (ADR 0005).
   * The generator lists auto-increment and identity primary keys here.
   *
   * Insert only, and client input only: every field stays updatable (ADR 0004), and it applies
   * to the rows this table receives as secondaries of another table as well. For a column no
   * write may carry, whoever sets it, use `writeExclude`.
   */
  insertExclude?: (string & keyof F)[];
  defaultOrder?: string;
  distinctResults?: boolean;
  onRequests?: ((request: ApiRequest, reply: ApiReply) => Promise<void | ApiReply>)[];
  tenantScope?: TenantScope;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbTables = Record<string, TableConfig<any>>;

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
