import type { ApiRequest, ApiReply } from './request.js';
import type { DialectName } from '../lib/dialect.js';
import type { DbTables } from './table.js';
import type { TenantId } from './tenant.js';

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
  getTenantId?: (request: ApiRequest) => TenantId | TenantId[] | null | undefined
    | Promise<TenantId | TenantId[] | null | undefined>;
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
