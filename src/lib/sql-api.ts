import type { ApiRequest } from '../types/request.js';
import { ConditionBuilder } from 'node-condition-builder';
import { createQueryClient, QueryClient } from './db.js';
import type { DialectName } from './dialect.js';
import { resolveTenant } from './tenant.js';
import { validateDbTables } from './table-helpers.js';
import { searchEngine } from './engine/search/search.js';
import { rejectRetiredSearchKeys } from './engine/search/fields.js';
import { rejectRetiredWriteKeys } from './engine/write-helpers.js';
import { getEngine } from './engine/rest/get.js';
import { insertEngine } from './engine/rest/insert.js';
import { updateEngine } from './engine/rest/update.js';
import { deleteEngine } from './engine/rest/delete.js';
import { bulkUpsertEngine } from './engine/bulk/bulk-upsert.js';
import { bulkDeleteEngine } from './engine/bulk/bulk-delete.js';
import type {
  DbTables,
  TableConfig,
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
  PrimaryKeyValue,
  GetTenantId,
  TenantContext,
  WriteJoinSections,
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

/** The body of `POST /rest/:table`: the main row and the child rows to `upsert` or `replace`. */
export interface SqlApiInsertParams extends Omit<WriteJoinSections, 'delete'> {
  main: Record<string, unknown>;
}

/** The body of `PUT /rest/:table`: the main row (with its PK) and the child rows to `upsert`, `delete` or `replace`. */
export interface SqlApiUpdateParams extends WriteJoinSections {
  main: Record<string, unknown>;
}

/**
 * The body of `POST /bulk/:table/delete`: the primary keys to delete — values for a
 * single-column key, objects naming every key field for a composite one.
 */
export interface SqlApiBulkDeleteParams {
  ids: PrimaryKeyValue[];
}

/**
 * The ids of a bulk delete's params. A JavaScript caller can still pass the pre-1.0 bare
 * array: refused, naming the key, before any SQL.
 */
function idsOf(tableName: string, params: { ids?: unknown }): PrimaryKeyValue[] {
  const ids = Array.isArray(params) ? undefined : params?.ids;
  if (!Array.isArray(ids)) {
    throw new TypeError(
      `sqlApi.bulkDelete('${tableName}'): the ids go under \`ids\`, as in the HTTP body` +
      (Array.isArray(params) ? ' (a bare array was the pre-1.0 form)' : '')
    );
  }
  return ids as PrimaryKeyValue[];
}

/**
 * The main row of a write's params. A JavaScript caller can still send the pre-1.0 key
 * `record`, which would otherwise write an empty row or miss the one to update: refused,
 * naming the key, before any SQL.
 */
function mainOf(method: 'insert' | 'update', tableName: string, params: { main?: unknown }): Record<string, unknown> {
  rejectRetiredWriteKeys(params ?? {});
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
  /**
   * The dialect of a raw pool, `postgres` by default as in the plugin. Refused beside a
   * QueryClient, which carries its own: two sources could disagree.
   */
  dialect?: DialectName;
  /** As on the plugin: a tenant id or several, `TENANT_ADMIN` for no filter, `null`/`undefined` → 401. */
  getTenantId?: GetTenantId;
}

/** A table name of `T`: a literal key when `createSqlApi` was given a typed map, otherwise any string. */
type TableKey<T extends DbTables> = keyof T & string;

/**
 * The programmatic API over one `dbTables` map. `T` is that map's type, inferred by
 * `createSqlApi`, so a misspelled table name fails at compile time; `app.sqlApi` is typed
 * over plain `DbTables` and takes any string.
 */
export class SqlApi<T extends DbTables = DbTables> {
  private db: QueryClient;

  constructor(
    dbOrPool: QueryClient | Queryable,
    private dbTables: T,
    private options: SqlApiOptions = {}
  ) {
    // One source for the dialect: the QueryClient's own, or the option for a raw pool.
    if (dbOrPool instanceof QueryClient) {
      if (options.dialect !== undefined) {
        throw new TypeError(
          `createSqlApi: the QueryClient already carries its dialect ('${dbOrPool.dialectName}'), ` +
          `drop the 'dialect' option — it is for a raw pool only`
        );
      }
      this.db = dbOrPool;
    } else {
      this.db = createQueryClient(dbOrPool, options.dialect);
    }

    // A config in the pre-1.0 shape, or a relation whose target cannot be resolved, is a
    // configuration error: fail here, with the table's name, rather than on the first request.
    validateDbTables(dbTables);

    // The global ConditionBuilder dialect, which a builder created without one (in an
    // `extendedCondition`) uses, follows the dialect the queries run on.
    ConditionBuilder.DIALECT = this.db.cbDialect;
  }

  /**
   * The config of `tableName`. An unknown name is the caller's bug — the routes only ever pass
   * the keys they were built from — so it is a plain Error (500), not a client 400.
   */
  private getTableConf(tableName: string): TableConfig {
    if (!Object.hasOwn(this.dbTables, tableName)) {
      throw new Error(
        `sqlApi: table '${tableName}' is not a key of dbTables. Known: ${Object.keys(this.dbTables).join(', ')}`
      );
    }
    return this.dbTables[tableName];
  }

  private async getTenant(tableName: string, request?: ApiRequest): Promise<TenantContext | undefined> {
    if (!request || !this.options.getTenantId) return undefined;
    const tableConf = this.getTableConf(tableName);
    return resolveTenant(
      { dbTables: this.dbTables, getTenantId: this.options.getTenantId },
      tableConf,
      request
    );
  }

  async search(tableName: TableKey<T>, params: SqlApiSearchParams = {}, request?: ApiRequest): Promise<SearchResult> {
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

  async get(tableName: TableKey<T>, id: string | number, request?: ApiRequest): Promise<GetResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return getEngine({ db: this.db, tableConf, id, tenant, request });
  }

  async insert(tableName: TableKey<T>, params: SqlApiInsertParams, request?: ApiRequest): Promise<InsertResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return insertEngine({
      db: this.db,
      tableConf,
      dbTables: this.dbTables,
      request,
      record: mainOf('insert', tableName, params),
      upsert: params.upsert,
      replace: params.replace,
      tenant,
    });
  }

  async update(tableName: TableKey<T>, params: SqlApiUpdateParams, request?: ApiRequest): Promise<UpdateResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return updateEngine({
      db: this.db,
      tableConf,
      dbTables: this.dbTables,
      request,
      record: mainOf('update', tableName, params),
      upsert: params.upsert,
      delete: params.delete,
      replace: params.replace,
      tenant,
    });
  }

  async delete(tableName: TableKey<T>, id: string | number, request?: ApiRequest): Promise<DeleteResult> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return deleteEngine({ db: this.db, tableConf, id, tenant, request });
  }

  async bulkUpsert(tableName: TableKey<T>, items: BulkUpsertItem[], request?: ApiRequest): Promise<BulkUpsertResult[]> {
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    items.forEach((item, i) => rejectRetiredWriteKeys(item ?? {}, String(i)));
    return bulkUpsertEngine({
      db: this.db,
      tableConf,
      dbTables: this.dbTables,
      request,
      items,
      tenant,
    });
  }

  async bulkDelete(tableName: TableKey<T>, params: SqlApiBulkDeleteParams, request?: ApiRequest): Promise<BulkDeleteResult[]> {
    const ids = idsOf(tableName, params);
    const tableConf = this.getTableConf(tableName);
    const tenant = await this.getTenant(tableName, request);
    return bulkDeleteEngine({ db: this.db, tableConf, ids, tenant, request });
  }
}

export function createSqlApi<T extends DbTables>(
  dbOrPool: QueryClient | Queryable,
  dbTables: T,
  options?: SqlApiOptions
): SqlApi<T> {
  return new SqlApi(dbOrPool, dbTables, options);
}
