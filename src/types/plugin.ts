import type { ApiRequest, ApiReply } from './request.js';
import type { DialectName } from '../lib/dialect.js';
import type { DbTables } from './table.js';
import type { GetTenantId } from './tenant.js';

export interface SwaggerOptions {
  title?: string;
  description?: string;
  version?: string;
  routePrefix?: string;
}

export interface SqlApiPluginOptions {
  DbTables: DbTables;
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
   * `requestId`, and attached as the `cause` of the error a consumer `setErrorHandler`
   * receives — which is where policy such as unique-violation → `409` belongs (ADR 0006).
   *
   * Nothing derives this: not `debug` (whoever registers the plugin decides that one, and
   * may wire it to an environment variable), not `NODE_ENV`. See ADR 0013.
   */
  exposeDebugInfo?: boolean;
}

/** Default row cap for search (page size and no-paginator LIMIT). Override via `maxItemsPerPage`. */
export const DEFAULT_MAX_ITEMS_PER_PAGE = 1000;

/** Default cap on bulk endpoint array length. Override via `maxBulkItems`. */
export const DEFAULT_MAX_BULK_ITEMS = 1000;
