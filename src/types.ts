import type { Expression, ConditionBuilder, ConditionValueOrUndefined } from 'node-condition-builder';
import type { TSchema, TObject } from '@sinclair/typebox';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { QueryClient } from './lib/db.js';
import type { DialectName } from './lib/dialect.js';

export type { DialectName } from './lib/dialect.js';

// ─── CLI / Schema Generation ────────────────────────────────

export interface SqlApiConfig {
  outputDir: string;
  schema?: string;
  dialect?: DialectName;
}

export interface ColumnInfo {
  table_name: string;
  column_name: string;
  udt_name: string;
  column_default: string | null;
  is_nullable: string;
}

export interface TableMap {
  [schemaName: string]: {
    name: string;
    fields: Record<string, string>;
  };
}

// ─── Database ────────────────────────────────────────────────

export interface SqlResult<T = Record<string, unknown>> {
  rows: T[];
  affectedRows: number;
  insertId?: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<SqlResult<T>>;
}

export type DbRecordValue =
  | string
  | number
  | boolean
  | null
  | Expression;

export type DbRecord = Record<string, DbRecordValue>;

export interface SelectOptions {
  tableName: string;
  columns?: string;
  where: string;
  values: unknown[];
  limit?: string | null;
  orderBy?: string;
  joins?: string[];
  distinct?: boolean;
}

// ─── Schema Definition (output della CLI) ────────────────────

export interface SchemaDefinition<T = Record<string, TSchema>> {
  col(field: string): string;
  fields: T;
  validation: TObject;
  tableName: string;
  partialValidation: TObject;
}

// ─── Tenant ──────────────────────────────────────────────────

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

export type TenantScope = TenantScopeDirect | TenantScopeIndirect;

export interface TenantContext {
  ids: TenantId[];
  scope: TenantScope;
}

// ─── Join Definition ─────────────────────────────────────────

// [joinSchema, joinField, mainField, selection]
export type JoinDefinition = [SchemaDefinition, string, string | string[], string];

// ─── Table Configuration ─────────────────────────────────────

export type FilterRecord = Record<string, ConditionValueOrUndefined>;
export type ExtendedConditionFn = (condition: ConditionBuilder, filters: FilterRecord) => void;
export type TableFilterFn = (filters: FilterRecord) => ConditionBuilder;

export interface ITable<F extends Record<string, TSchema> = Record<string, TSchema>> {
  primary: (string & keyof F) | (string & keyof F)[];
  Schema: SchemaDefinition<F>;
  filters: TableFilterFn;
  extraFilters: Record<string, TSchema>;
  allowedReadJoins?: JoinDefinition[];
  allowedWriteJoins?: JoinDefinition[];
  upsertMap?: Map<SchemaDefinition, string[]>;
  beforeInsert?: (db: QueryClient, req: FastifyRequest, record: Record<string, unknown>) => Promise<void>;
  beforeUpdate?: (db: QueryClient, req: FastifyRequest, fields: Record<string, unknown>, secondaryFieldsFetcher?: unknown) => void | Promise<void>;
  afterInsert?: (db: QueryClient, req: FastifyRequest, record: Record<string, unknown>, secondaryRecords?: unknown) => Promise<void>;
  defaultOrder?: string;
  excludeFromCreation?: (string & keyof F)[];
  distinctResults?: boolean;
  onRequests?: ((request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>)[];
  tenantScope?: TenantScope;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbTables = Record<string, ITable<any>>;

// Primary key helpers
export function primaryAsString(pk: string | string[]): string {
  return Array.isArray(pk) ? pk[0] : pk;
}

export function primaryAsCols(pk: string | string[], colFn: (f: string) => string): string | string[] {
  return Array.isArray(pk) ? pk.map(colFn) : colFn(pk);
}

// ─── Swagger ─────────────────────────────────────────────────

export interface SwaggerOptions {
  title?: string;
  description?: string;
  version?: string;
  routePrefix?: string;
}

// ─── Plugin Options ──────────────────────────────────────────

export interface SqlApiPluginOptions {
  DbTables: DbTables;
  onRequests?: ((request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>)[];
  prefix?: string;
  swagger?: boolean | SwaggerOptions;
  dialect?: DialectName;
  getTenantId?: (request: FastifyRequest) => TenantId | TenantId[] | null | undefined
    | Promise<TenantId | TenantId[] | null | undefined>;
}

// ─── Search Types ────────────────────────────────────────────

export interface Paginator {
  page: number;
  itemsPerPage: number;
}

export interface AggregationRequest {
  by?: string;
  distinctCount?: string[];
  min?: string[];
  max?: string[];
  sum?: string[];
}

export interface JoinGroupRequest {
  aggregations: AggregationRequest;
  filters?: FilterRecord;
}

export interface SearchParams {
  db: QueryClient;
  tableConf: ITable;
  filters?: FilterRecord;
  joins?: Record<string, { filters?: FilterRecord }>;
  joinGroups?: Record<string, JoinGroupRequest>;
  orderBy?: string;
  paginator?: Paginator;
  computeMin?: string;
  computeMax?: string;
  computeSum?: string;
  computeAvg?: string;
  tenant?: TenantContext;
}

export interface PaginationResult {
  total: number;
  pages: number;
  computed?: Record<string, Record<string, unknown>>;
  paginator: Paginator;
}

export interface SearchResult {
  main: Record<string, unknown>[];
  joins?: Record<string, Record<string, unknown>[]>;
  joinGroups?: Record<string, Record<string, unknown>>;
  pagination?: PaginationResult;
}

// ─── Insert Types ─────────────────────────────────────────────

export interface InsertParams {
  db: QueryClient;
  tableConf: ITable;
  dbTables: DbTables;
  request: FastifyRequest;
  record: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
  tenant?: TenantContext;
}

export interface InsertResult {
  main: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
}

// ─── Get Types ────────────────────────────────────────────────

export interface GetParams {
  db: QueryClient;
  tableConf: ITable;
  id: string | number;
  tenant?: TenantContext;
}

export interface GetResult {
  main: Record<string, unknown>;
}

// ─── Delete Types ─────────────────────────────────────────────

export interface DeleteParams {
  db: QueryClient;
  tableConf: ITable;
  id: string | number;
  tenant?: TenantContext;
}

export interface DeleteResult {
  main: Record<string, unknown>;
}

// ─── Bulk Upsert Types ────────────────────────────────────────

export interface BulkUpsertItem {
  main: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
  deletions?: Record<string, Record<string, unknown>[]>;
}

export interface BulkUpsertParams {
  db: QueryClient;
  tableConf: ITable;
  dbTables: DbTables;
  request: FastifyRequest;
  items: BulkUpsertItem[];
  tenant?: TenantContext;
}

export interface BulkUpsertResult {
  main: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
  deletions?: Record<string, Record<string, unknown>[]>;
}

// ─── Bulk Delete Types ────────────────────────────────────────

export interface BulkDeleteParams {
  db: QueryClient;
  tableConf: ITable;
  ids: (string | number)[];
  tenant?: TenantContext;
}

export interface BulkDeleteResult {
  main: Record<string, unknown>;
}

// ─── Update Types ─────────────────────────────────────────────

export interface UpdateParams {
  db: QueryClient;
  tableConf: ITable;
  dbTables: DbTables;
  request: FastifyRequest;
  record: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
  deletions?: Record<string, Record<string, unknown>[]>;
  tenant?: TenantContext;
}

export interface UpdateResult {
  main: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
  deletions?: Record<string, Record<string, unknown>[]>;
}
