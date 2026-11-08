import type { SchemaDefinition } from './schema.js';
import type { ApiRequest } from './request.js';

export type TenantId = string | number;

/**
 * The value `getTenantId` returns for a caller allowed to see every tenant's rows. Admin is
 * declared, never inferred: an absent tenant (`null`/`undefined`) is a 401 on any scoped
 * table, so an auth hook that failed to run cannot open the data. A registry symbol, so two
 * copies of the package agree on it and no real tenant id can collide with it.
 */
export const TENANT_ADMIN: unique symbol = Symbol.for('fastify-auto-sqlapi.tenant.admin');
export type TenantAdmin = typeof TENANT_ADMIN;

/**
 * What `getTenantId` resolves a request to: one tenant id, several (a caller who belongs to
 * more than one tenant), `TENANT_ADMIN` for no filtering, or nothing — which is refused with
 * 401 as soon as a scoped table is in reach. `[]` is a caller with no tenant at all: 403.
 */
export type TenantResolution = TenantId | TenantId[] | TenantAdmin | null | undefined;
export type GetTenantId = (request: ApiRequest) => TenantResolution | Promise<TenantResolution>;

export interface TenantScopeDirect {
  column: string;
}

export interface TenantScopeIndirect {
  column: string;
  through: {
    schema: SchemaDefinition;
    localField: string;
    foreignField: string;
  };
}

/**
 * A row owned by several parties, visible to any of them: a message (`sender_id` /
 * `recipient_id`), a transfer (`from_account_id` / `to_account_id`), a shift swap. Reads test
 * every listed column with an OR, so a row matches when *any* of them holds a tenant id.
 *
 * Writes cannot auto-inject a tenant the way a single-column scope does — the plugin has no way
 * to know which party the caller is meant to be — so the payload must anchor the row itself:
 * see `assertTenantAnchor`. Columns are DB column names, like `TenantScopeDirect.column`.
 *
 * Not combinable with `column`/`through`: an entry reached through a parent FK would need its
 * own join per entry, and is rejected at `defineTable` time rather than half-supported.
 */
export interface TenantScopeAnyOf {
  anyOf: string[];
}

export type TenantScope = TenantScopeDirect | TenantScopeIndirect | TenantScopeAnyOf;

/**
 * Who the caller is, for this request — plus how the table currently being addressed is scoped.
 *
 * `ids` is request-level: it is resolved once from `getTenantId` and stays valid for every table
 * the request touches. `scope` is table-level and therefore **optional**: the addressed table may
 * declare no scope of its own while a table it reaches through a relation does. Absent `scope`
 * means "no filtering on this table", never "no tenant" — `tenantForTable` re-targets the same
 * ids onto a related table's own scope.
 */
export interface TenantContext {
  ids: TenantId[];
  scope?: TenantScope;
}
