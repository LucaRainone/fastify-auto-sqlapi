import type { FastifyRequest } from 'fastify';
import type { QueryClient } from '../lib/db.js';
import type { ITable, DbTables } from './table.js';
import type { TenantContext } from './tenant.js';

interface DmlBaseParams {
  db: QueryClient;
  tableConf: ITable;
  tenant?: TenantContext;
}

interface DmlWriteBaseParams extends DmlBaseParams {
  dbTables: DbTables;
  request: FastifyRequest;
}

// ─── Insert ──────────────────────────────────────────────────

export interface InsertParams extends DmlWriteBaseParams {
  record: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
}

export interface InsertResult {
  main: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
}

// ─── Update ──────────────────────────────────────────────────

export interface UpdateParams extends DmlWriteBaseParams {
  record: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
  deletions?: Record<string, Record<string, unknown>[]>;
}

export interface UpdateResult {
  main: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
  deletions?: Record<string, Record<string, unknown>[]>;
}

// ─── Get ─────────────────────────────────────────────────────

export interface GetParams extends DmlBaseParams {
  id: string | number;
}

export interface GetResult {
  main: Record<string, unknown>;
}

// ─── Delete ──────────────────────────────────────────────────

export interface DeleteParams extends DmlBaseParams {
  id: string | number;
}

export interface DeleteResult {
  main: Record<string, unknown>;
}

// ─── Bulk Upsert ─────────────────────────────────────────────

export interface BulkUpsertItem {
  main: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
  deletions?: Record<string, Record<string, unknown>[]>;
}

export interface BulkUpsertParams extends DmlWriteBaseParams {
  items: BulkUpsertItem[];
}

export interface BulkUpsertResult {
  main: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
  deletions?: Record<string, Record<string, unknown>[]>;
}

// ─── Bulk Delete ─────────────────────────────────────────────

export interface BulkDeleteParams extends DmlBaseParams {
  ids: (string | number)[];
}

export interface BulkDeleteResult {
  main: Record<string, unknown>;
}
