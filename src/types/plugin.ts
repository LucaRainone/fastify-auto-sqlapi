import type { ApiRequest, ApiReply } from './request.js';
import type { DialectName } from '../lib/dialect.js';
import type { DbTables, TableOperation } from './table.js';
import type { GetTenantId } from './tenant.js';

export interface SwaggerOptions {
  title?: string;
  description?: string;
  version?: string;
  routePrefix?: string;
}

/** One `dbErrors` entry: the HTTP status and the stable code the client translates. */
export interface DbErrorMapping {
  status: number;
  code: string;
}

export interface SqlApiPluginOptions {
  dbTables: DbTables;
  /**
   * The operations this registration exposes, intersected with each table's own
   * `operations`: a table registers a route only when both allow it. Omitted, every table
   * exposes what its config allows. A read-only surface beside a full one is a second
   * registration with `operations: ['search', 'get']`, its own `prefix` and `decorate: false`.
   *
   * Unlike a table's `operations`, naming a single-PK operation (`get`, `delete`,
   * `bulkDelete`) here does not refuse a composite-PK table: the table is skipped for it.
   */
  operations?: TableOperation[];
  onRequests?: ((request: ApiRequest, reply: ApiReply) => Promise<void | ApiReply>)[];
  prefix?: string;
  swagger?: boolean | SwaggerOptions;
  dialect?: DialectName;
  /**
   * Resolve the caller's tenant id(s) for this request. Returning one id (or an array, for a
   * caller who belongs to several tenants) scopes every read and write to rows that tenant owns.
   * Called only when a scoped table is in reach of the request.
   *
   * Unrestricted, cross-tenant access is declared by returning {@link TENANT_ADMIN}. Returning
   * `null`/`undefined` is refused with 401: the tenant identity comes from the request
   * (typically `request.user`, populated by your own auth hook in {@link onRequests}), and an
   * absent one is the signature of a hook that is missing, mis-ordered or failed — never of an
   * admin. `[]` is a caller who belongs to no tenant: 403.
   *
   * ```ts
   * getTenantId: (req) => (req.user?.isSuperadmin ? TENANT_ADMIN : req.user?.organizationId),
   * // no user → undefined → 401 on scoped tables; unscoped tables never ask
   * ```
   */
  getTenantId?: GetTenantId;
  debug?: boolean;
  /**
   * Hard cap on the search page size (the `itemsPerPage` query param), and the row LIMIT applied
   * even when no paginator is supplied — so an unbounded `POST /search/:table` cannot dump an
   * entire table. Requests exceeding it get a 400. Defaults to {@link DEFAULT_MAX_ITEMS_PER_PAGE}.
   */
  maxItemsPerPage?: number;
  /**
   * Hard cap on the number of items accepted by the bulk endpoints (`PUT /bulk/:table`,
   * `POST /bulk/:table/delete`). Larger arrays are rejected at schema validation (400).
   * Defaults to {@link DEFAULT_MAX_BULK_ITEMS}.
   */
  maxBulkItems?: number;
  /**
   * Register `GET /agent/manifest` (JSON) and `GET /agent/manifest.md` (markdown): a
   * machine-readable description of every exposed table (fields, operations, join
   * aliases, computed fields), for LLM/agent clients. Opt-in, like `swagger`. The
   * routes run behind the same global `onRequests` hooks as the data routes.
   */
  agentManifest?: boolean;
  /**
   * Attach a `debugInfo` payload — the driver message, its `code`/`constraint`/`detail`,
   * the stack — to the `500` an error the plugin did not raise itself produces (a
   * constraint violation, a hook throwing without a `statusCode`).
   *
   * **Development only**: it hands whoever triggers an error a description of the schema,
   * and the auto routes are open by default (ADR 0002). Off unless set. It is additive —
   * `statusCode`, `error`, `message` and `requestId` keep the shape they have in production,
   * so client-side error handling does not fork between environments.
   *
   * Without it the response carries no database detail, and the original error is still
   * reachable: logged through `request.log.error` under the same `reqId` the body reports as
   * `requestId`. A status for a driver code (unique violation → `409`) is `dbErrors`.
   *
   * Nothing derives this: not `debug` (whoever registers the plugin decides that one, and
   * may wire it to an environment variable), not `NODE_ENV`. See ADR 0013.
   */
  exposeDebugInfo?: boolean;
  /**
   * Driver error codes answered with an HTTP status instead of the sanitized `500`, keyed by
   * the driver's `err.code` exactly as it arrives — `'23505'` (pg unique_violation),
   * `'ER_DUP_ENTRY'` (mysql2), `'40001'` (serialization failure) — and valued with the status
   * (400–599) and a stable code of the consumer's choosing.
   *
   * The mapping is the consumer's and partial by nature: codes depend on the database and its
   * version, and which ones deserve a status is a product decision, so the plugin ships none
   * and interprets nothing (ADR 0006). A mapped error is answered in the plugin's envelope with
   * the status' reason phrase as `message` and `fields: [{ path: '', code }]`, whatever the
   * status: the client translates the code, the API carries no prose. No driver detail reaches
   * the client (ADR 0013). Every other error stays a `500`.
   *
   * ```ts
   * dbErrors: { '23505': { status: 409, code: 'duplicate' }, '23503': { status: 409, code: 'in_use' } }
   * ```
   *
   * Applies to the auto routes only: `sqlApi.*` throws the driver error as is.
   */
  dbErrors?: Record<string, DbErrorMapping>;
  /**
   * Decorate `app.sqlApi`, this registration's programmatic API, for application code. On by
   * default. The decorator belongs to one registration: when the scope already has a `sqlApi`
   * (another registration of the plugin, or the application's own) startup fails, so a second
   * registration — another prefix, another surface — passes `false`. Its routes run with its
   * own configuration either way; `createSqlApi()` gives application code another instance.
   */
  decorate?: boolean;
}

/** Default row cap for search (page size and no-paginator LIMIT). Override via `maxItemsPerPage`. */
export const DEFAULT_MAX_ITEMS_PER_PAGE = 1000;

/** Default cap on bulk endpoint array length. Override via `maxBulkItems`. */
export const DEFAULT_MAX_BULK_ITEMS = 1000;
