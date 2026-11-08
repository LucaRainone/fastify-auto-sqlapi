import type { ApiRequest } from './request.js';
import type { QueryClient } from '../lib/db.js';
import type { TableConfig, DbTables } from './table.js';
import type { TenantContext } from './tenant.js';
import type { RowsByAlias } from './join.js';
import type { WriteAction } from './db.js';

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

export interface InsertParams extends DmlWriteBaseParams {
  record: Record<string, unknown>;
  secondaries?: RowsByAlias;
}

export interface InsertResult {
  main: Record<string, unknown>;
  /** `'updated'` when an upsert rule landed the write on an existing row, else `'inserted'`. */
  action: WriteAction;
  secondaries?: RowsByAlias;
}

// ─── Update ──────────────────────────────────────────────────

export interface UpdateParams extends DmlWriteBaseParams {
  record: Record<string, unknown>;
  secondaries?: RowsByAlias;
  deletions?: RowsByAlias;
}

export interface UpdateResult {
  main: Record<string, unknown>;
  secondaries?: RowsByAlias;
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

export interface BulkUpsertItem {
  main: Record<string, unknown>;
  secondaries?: RowsByAlias;
  deletions?: RowsByAlias;
}

export interface BulkUpsertParams extends DmlWriteBaseParams {
  items: BulkUpsertItem[];
}

export interface BulkUpsertResult {
  main: Record<string, unknown>;
  /** What the statement did to this item's main row; `'inserted'` for every item without an upsert rule. */
  action: WriteAction;
  secondaries?: RowsByAlias;
  deletions?: RowsByAlias;
}

// ─── Bulk Delete ─────────────────────────────────────────────

export interface BulkDeleteParams extends DmlBaseParams {
  ids: (string | number)[];
  request?: ApiRequest;
}

export interface BulkDeleteResult {
  main: Record<string, unknown>;
}
