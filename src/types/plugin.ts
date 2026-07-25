import type { FastifyRequest, FastifyReply } from 'fastify';
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
  onRequests?: ((request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>)[];
  prefix?: string;
  swagger?: boolean | SwaggerOptions;
  dialect?: DialectName;
  getTenantId?: (request: FastifyRequest) => TenantId | TenantId[] | null | undefined
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
}

/** Default row cap for search (page size and no-paginator LIMIT). Override via `maxItemsPerPage`. */
export const DEFAULT_MAX_ITEMS_PER_PAGE = 1000;

/** Default cap on bulk endpoint array length. Override via `maxBulkItems`. */
export const DEFAULT_MAX_BULK_ITEMS = 1000;
