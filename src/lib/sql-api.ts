import type { ApiRequest } from '../types/request.js';
import { ConditionBuilder } from 'node-condition-builder';
import { createQueryClient, QueryClient } from './db.js';
import { getDialect, type DialectName } from './dialect.js';
import { resolveTenant } from './tenant.js';
import { validateJoinTargets } from './table-helpers.js';
import { httpError } from './errors.js';
import { searchEngine } from './engine/search/search.js';
import { rejectRetiredSearchKeys } from './engine/search/fields.js';
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
  ComputeRequest,
  JoinGroupRequest,
  JoinRefFilter,
  JoinFetchRequest,
  SearchResult,
  GetResult,
  InsertResult,
  UpdateResult,
  DeleteResult,
  BulkUpsertItem,
  BulkUpsertResult,
  BulkDeleteResult,
  GetTenantId,
  TenantContext,
  RowsByAlias,
} from '../types.js';

// ─── Public param types ─────────────────────────────────────

export interface SqlApiSearchParams {
  filters?: FilterRecord;
  conditions?: SearchCondition[];
  joinMustExist?: Record<string, JoinRefFilter>;
  joinMultiple?: Record<string, JoinFetchRequest>;
  joinGroup?: Record<string, JoinGroupRequest>;
  joinLeft?: Record<string, JoinFetchRequest>;
  orderBy?: string;
  paginator?: Paginator;
  /** Aggregates over all matching rows, by function (see SearchParams.compute). */
  compute?: ComputeRequest;
  /** Main fields to project, schema and computed alike (see SearchParams.select). */
  select?: string[];
  /** Row cap for the main query when no paginator is provided (see SearchParams.maxRows). */
  maxRows?: number;
}

/** The body of `POST /rest/:table`: the main row and the secondaries written with it. */
export interface SqlApiInsertParams {
  main: Record<string, unknown>;
  secondaries?: RowsByAlias;
}

/** The body of `PUT /rest/:table`: the main row (with its PK), secondaries and deletions. */
export interface SqlApiUpdateParams {
  main: Record<string, unknown>;
  secondaries?: RowsByAlias;
  deletions?: RowsByAlias;
}

/** The body of `POST /bulk/:table/delete`: the primary key values to delete. */
export interface SqlApiBulkDeleteParams {
  ids: (string | number)[];
}

/**
 * The ids of a bulk delete's params. A JavaScript caller can still pass the pre-1.0 bare
 * array: refused, naming the key, before any SQL.
 */
function idsOf(tableName: string, params: { ids?: unknown }): (string | number)[] {
  const ids = Array.isArray(params) ? undefined : params?.ids;
  if (!Array.isArray(ids)) {
    throw new TypeError(
      `sqlApi.bulkDelete('${tableName}'): the ids go under \`ids\`, as in the HTTP body` +
      (Array.isArray(params) ? ' (a bare array was the pre-1.0 form)' : '')
    );
  }
  return ids as (string | number)[];
}

/**
 * The main row of a write's params. A JavaScript caller can still send the pre-1.0 key
 * `record`, which would otherwise write an empty row or miss the one to update: refused,
 * naming the key, before any SQL.
 */
function mainOf(method: 'insert' | 'update', tableName: string, params: { main?: unknown }): Record<string, unknown> {
  const main = params?.main;
  if (main === null || typeof main !== 'object' || Array.isArray(main)) {
    throw new TypeError(
      `sqlApi.${method}('${tableName}'): the main row goes under \`main\`, as in the HTTP body` +
      ('record' in (params ?? {}) ? ' (`record` was renamed `main`)' : '')
    );
  }
  return main as Record<string, unknown>;
}

// ─── SqlApi class ───────────────────────────────────────────

export interface SqlApiOptions {
  dialect?: DialectName;
  /** As on the plugin: a tenant id or several, `TENANT_ADMIN` for no filter, `null`/`undefined` → 401. */
  getTenantId?: GetTenantId;
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

    // A relation whose target cannot be resolved is a configuration error: fail here, with
    // the table's name, rather than on the first request that uses the join.
    validateJoinTargets(dbTables);

    // Set ConditionBuilder dialect (used by filters built via exportTableInfo)
    if (options.dialect) {
      const dialect = getDialect(options.dialect);
      ConditionBuilder.DIALECT = dialect.cbDialect;
    }
  }

  private getTableConf(tableName: string) {
    const conf = this.dbTables[tableName];
    if (!conf) throw httpError(400, `Table "${tableName}" not found in DbTables`, { code: 'unknown_table' });
    return conf;
  }

  private async getTenant(tableName: string, request?: ApiRequest): Promise<TenantContext | undefined> {
    if (!request || !this.options.getTenantId) return undefined;
    const tableConf = this.getTableConf(tableName);
    return resolveTenant(
      { DbTables: this.dbTables, getTenantId: this.options.getTenantId },
      tableConf,
      request
    );
  }

  async search(tableName: string, params: SqlApiSearchParams = {}, request?: ApiRequest): Promise<SearchResult> {
    rejectRetiredSearchKeys(params);
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return searchEngine(this.dbTables, {
      db: this.db,
      tableConf,
      filters: params.filters,
      conditions: params.conditions,
      joinMustExist: params.joinMustExist,
      joinMultiple: params.joinMultiple,
      joinGroup: params.joinGroup,
      joinLeft: params.joinLeft,
      orderBy: params.orderBy,
      paginator: params.paginator,
      compute: params.compute,
      select: params.select,
      maxRows: params.maxRows,
      tenant,
      request,
    });
  }

  async get(tableName: string, id: string | number, request?: ApiRequest): Promise<GetResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return getEngine({ db: this.db, tableConf, id, tenant, request });
  }

  async insert(tableName: string, params: SqlApiInsertParams, request?: ApiRequest): Promise<InsertResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return insertEngine({
      db: this.db,
      tableConf,
      dbTables: this.dbTables,
      request,
      record: mainOf('insert', tableName, params),
      secondaries: params.secondaries,
      tenant,
    });
  }

  async update(tableName: string, params: SqlApiUpdateParams, request?: ApiRequest): Promise<UpdateResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return updateEngine({
      db: this.db,
      tableConf,
      dbTables: this.dbTables,
      request,
      record: mainOf('update', tableName, params),
      secondaries: params.secondaries,
      deletions: params.deletions,
      tenant,
    });
  }

  async delete(tableName: string, id: string | number, request?: ApiRequest): Promise<DeleteResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return deleteEngine({ db: this.db, tableConf, id, tenant, request });
  }

  async bulkUpsert(tableName: string, items: BulkUpsertItem[], request?: ApiRequest): Promise<BulkUpsertResult[]> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return bulkUpsertEngine({
      db: this.db,
      tableConf,
      dbTables: this.dbTables,
      request,
      items,
      tenant,
    });
  }

  async bulkDelete(tableName: string, params: SqlApiBulkDeleteParams, request?: ApiRequest): Promise<BulkDeleteResult[]> {
    const ids = idsOf(tableName, params);
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return bulkDeleteEngine({ db: this.db, tableConf, ids, tenant, request });
  }
}

export function createSqlApi(dbOrPool: QueryClient | Queryable, dbTables: DbTables, options?: SqlApiOptions): SqlApi {
  return new SqlApi(dbOrPool, dbTables, options);
}
