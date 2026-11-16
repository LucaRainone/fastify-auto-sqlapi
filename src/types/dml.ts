import type { ApiRequest } from './request.js';
import type { QueryClient } from '../lib/db.js';
import type { TableConfig, DbTables } from './table.js';
import type { TenantContext } from './tenant.js';
import type { RowsByAlias } from './db.js';
import type { WriteAction, PrimaryKeyValue, WriteJoinSections } from './db.js';

interface DmlBaseParams {
  db: QueryClient;
  tableConf: TableConfig;
  tenant?: TenantContext;
}

interface DmlWriteBaseParams extends DmlBaseParams {
  dbTables: DbTables;
  /** Handed to hooks and validators as `ctx.req`; absent for a programmatic caller that did not pass one. */
  request?: ApiRequest;
}

// ─── Insert ──────────────────────────────────────────────────

export interface InsertParams extends DmlWriteBaseParams, Omit<WriteJoinSections, 'delete'> {
  record: Record<string, unknown>;
}

export interface InsertResult {
  main: Record<string, unknown>;
  /** `'updated'` when an upsert rule landed the write on an existing row, else `'inserted'`. */
  action: WriteAction;
  /** The child rows written, by alias: those of `upsert` and of `replace`. */
  secondaries?: RowsByAlias;
  /** The child rows a `replace` removed, by alias (ADR 0029). */
  deletions?: RowsByAlias;
}

// ─── Update ──────────────────────────────────────────────────

export interface UpdateParams extends DmlWriteBaseParams, WriteJoinSections {
  record: Record<string, unknown>;
}

export interface UpdateResult {
  main: Record<string, unknown>;
  /** The child rows written, by alias: those of `upsert` and of `replace`. */
  secondaries?: RowsByAlias;
  /** The child rows removed, by alias: those of `delete`, and those a `replace` left out. */
  deletions?: RowsByAlias;
}

// ─── Get ─────────────────────────────────────────────────────

export interface GetParams extends DmlBaseParams {
  id: string | number;
  /** Handed to the `afterRead` hook; absent for a programmatic caller that did not pass one. */
  request?: ApiRequest;
}

export interface GetResult {
  main: Record<string, unknown>;
}

// ─── Delete ──────────────────────────────────────────────────

export interface DeleteParams extends DmlBaseParams {
  id: string | number;
  request?: ApiRequest;
}

export interface DeleteResult {
  main: Record<string, unknown>;
}

// ─── Bulk Upsert ─────────────────────────────────────────────

export interface BulkUpsertItem extends WriteJoinSections {
  main: Record<string, unknown>;
}

export interface BulkUpsertParams extends DmlWriteBaseParams {
  items: BulkUpsertItem[];
}

export interface BulkUpsertResult {
  main: Record<string, unknown>;
  /** What the statement did to this item's main row; `'inserted'` for every item without an upsert rule. */
  action: WriteAction;
  /** The child rows written, by alias: those of `upsert` and of `replace`. */
  secondaries?: RowsByAlias;
  /** The child rows removed, by alias: those of `delete`, and those a `replace` left out. */
  deletions?: RowsByAlias;
}

// ─── Bulk Delete ─────────────────────────────────────────────

export interface BulkDeleteParams extends DmlBaseParams {
  ids: PrimaryKeyValue[];
  request?: ApiRequest;
}

export interface BulkDeleteResult {
  main: Record<string, unknown>;
}
