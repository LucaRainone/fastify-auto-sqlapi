import type { SchemaDefinition } from './schema.js';

export type TenantId = string | number;

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

export interface TenantContext {
  ids: TenantId[];
  scope: TenantScope;
}
