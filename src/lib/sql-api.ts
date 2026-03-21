import type { FastifyRequest } from 'fastify';
import { ConditionBuilder } from 'node-condition-builder';
import { createQueryClient, QueryClient } from './db.js';
import { getDialect, type DialectName } from './dialect.js';
import { resolveTenant } from './tenant.js';
import { searchEngine } from './engine/search/search.js';
import { getEngine } from './engine/rest/get.js';
import { insertEngine } from './engine/rest/insert.js';
import { updateEngine } from './engine/rest/update.js';
import { deleteEngine } from './engine/rest/delete.js';
import { bulkUpsertEngine } from './engine/bulk/bulk-upsert.js';
import { bulkDeleteEngine } from './engine/bulk/bulk-delete.js';
import type {
  DbTables,
  Queryable,
  FilterRecord,
  SearchCondition,
  Paginator,
  JoinGroupRequest,
  SearchResult,
  GetResult,
  InsertResult,
  UpdateResult,
  DeleteResult,
  BulkUpsertItem,
  BulkUpsertResult,
  BulkDeleteResult,
  TenantId,
  SqlApiPluginOptions,
  TenantContext,
} from '../types.js';

// ─── Public param types ─────────────────────────────────────

export interface SqlApiSearchParams {
  filters?: FilterRecord;
  conditions?: SearchCondition[];
  joinFilters?: Record<string, FilterRecord>;
  joins?: Record<string, { filters?: FilterRecord }>;
  joinGroups?: Record<string, JoinGroupRequest>;
  orderBy?: string;
  paginator?: Paginator;
  computeMin?: string;
  computeMax?: string;
  computeSum?: string;
  computeAvg?: string;
}

export interface SqlApiInsertParams {
  record: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
}

export interface SqlApiUpdateParams {
  record: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
  deletions?: Record<string, Record<string, unknown>[]>;
}

// ─── SqlApi class ───────────────────────────────────────────

export interface SqlApiOptions {
  dialect?: DialectName;
  getTenantId?: (request: FastifyRequest) => TenantId | TenantId[] | null | undefined
    | Promise<TenantId | TenantId[] | null | undefined>;
}

export class SqlApi {
  private db: QueryClient;

  constructor(
    dbOrPool: QueryClient | Queryable,
    private dbTables: DbTables,
    private options: SqlApiOptions = {}
  ) {
    // Accept either a QueryClient or a raw Queryable pool
    if (dbOrPool instanceof QueryClient) {
      this.db = dbOrPool;
    } else {
      this.db = createQueryClient(dbOrPool, options.dialect);
    }

    // Set ConditionBuilder dialect (used by filters built via exportTableInfo)
    if (options.dialect) {
      const dialect = getDialect(options.dialect);
      ConditionBuilder.DIALECT = dialect.cbDialect;
    }
  }

  private getTableConf(tableName: string) {
    const conf = this.dbTables[tableName];
    if (!conf) {
      const err = new Error(`Table "${tableName}" not found in DbTables`) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
    return conf;
  }

  private async getTenant(tableName: string, request?: FastifyRequest): Promise<TenantContext | undefined> {
    if (!request || !this.options.getTenantId) return undefined;
    const tableConf = this.getTableConf(tableName);
    return resolveTenant(
      { DbTables: this.dbTables, getTenantId: this.options.getTenantId } as SqlApiPluginOptions,
      tableConf,
      request
    );
  }

  async search(tableName: string, params: SqlApiSearchParams = {}, request?: FastifyRequest): Promise<SearchResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return searchEngine(this.dbTables, {
      db: this.db,
      tableConf,
      filters: params.filters,
      conditions: params.conditions,
      joinFilters: params.joinFilters,
      joins: params.joins,
      joinGroups: params.joinGroups,
      orderBy: params.orderBy,
      paginator: params.paginator,
      computeMin: params.computeMin,
      computeMax: params.computeMax,
      computeSum: params.computeSum,
      computeAvg: params.computeAvg,
      tenant,
    });
  }

  async get(tableName: string, id: string | number, request?: FastifyRequest): Promise<GetResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return getEngine({ db: this.db, tableConf, id, tenant });
  }

  async insert(tableName: string, params: SqlApiInsertParams, request?: FastifyRequest): Promise<InsertResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return insertEngine({
      db: this.db,
      tableConf,
      dbTables: this.dbTables,
      request: request as FastifyRequest,
      record: params.record,
      secondaries: params.secondaries,
      tenant,
    });
  }

  async update(tableName: string, params: SqlApiUpdateParams, request?: FastifyRequest): Promise<UpdateResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return updateEngine({
      db: this.db,
      tableConf,
      dbTables: this.dbTables,
      request: request as FastifyRequest,
      record: params.record,
      secondaries: params.secondaries,
      deletions: params.deletions,
      tenant,
    });
  }

  async delete(tableName: string, id: string | number, request?: FastifyRequest): Promise<DeleteResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return deleteEngine({ db: this.db, tableConf, id, tenant });
  }

  async bulkUpsert(tableName: string, items: BulkUpsertItem[], request?: FastifyRequest): Promise<BulkUpsertResult[]> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return bulkUpsertEngine({
      db: this.db,
      tableConf,
      dbTables: this.dbTables,
      request: request as FastifyRequest,
      items,
      tenant,
    });
  }

  async bulkDelete(tableName: string, ids: (string | number)[], request?: FastifyRequest): Promise<BulkDeleteResult[]> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return bulkDeleteEngine({ db: this.db, tableConf, ids, tenant });
  }
}

export function createSqlApi(dbOrPool: QueryClient | Queryable, dbTables: DbTables, options?: SqlApiOptions): SqlApi {
  return new SqlApi(dbOrPool, dbTables, options);
}
