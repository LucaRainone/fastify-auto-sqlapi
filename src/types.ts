import type { Expression, ConditionBuilder, ConditionValueOrUndefined } from 'node-condition-builder';
import type { TSchema, TObject, Static } from '@sinclair/typebox';
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

// ─── Validation ─────────────────────────────────────────────

/**
 * Validation error tuple: [field, code] or [field, code, message].
 * - field: the field path (e.g. 'name', 'session_period[1].startDate')
 * - code: machine-readable error code (e.g. 'required', 'overlap', 'unique')
 * - message: human-readable description (defaults to code if omitted)
 */
export type ValidationError =
  | [field: string, code: string]
  | [field: string, code: string, message: string];

export type ValidatorFn<F extends Record<string, TSchema> = Record<string, TSchema>> = (
  db: QueryClient,
  req: FastifyRequest,
  main: { [K in keyof F]?: Static<F[K]> },
  secondaries?: Record<string, Record<string, unknown>[]>
) => Promise<ValidationError[]> | ValidationError[];

export interface BulkValidatorItem<F extends Record<string, TSchema> = Record<string, TSchema>> {
  main: { [K in keyof F]?: Static<F[K]> };
  secondaries?: Record<string, Record<string, unknown>[]>;
}

export type BulkValidatorFn<F extends Record<string, TSchema> = Record<string, TSchema>> = (
  db: QueryClient,
  req: FastifyRequest,
  items: BulkValidatorItem<F>[]
) => Promise<ValidationError[]> | ValidationError[];

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
  validate?: ValidatorFn<F>;
  validateBulk?: BulkValidatorFn<F>;
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
  debug?: boolean;
}

// ─── Conditions (advanced filters) ───────────────────────────

import type { ConditionBuilder as CB } from 'node-condition-builder';

// Methods that accept (field, value)
type SingleValueMethods =
  | 'isEqual' | 'isNotEqual'
  | 'isGreater' | 'isNotGreater' | 'isGreaterOrEqual' | 'isNotGreaterOrEqual'
  | 'isLess' | 'isNotLess' | 'isLessOrEqual' | 'isNotLessOrEqual'
  | 'isLike' | 'isNotLike' | 'isILike' | 'isNotILike';

// Methods that accept (field, from, to)
type BetweenMethods = 'isBetween' | 'isNotBetween';

// Methods that accept (field, values[])
type InMethods = 'isIn' | 'isNotIn';

// Methods that accept (field) only
type NullMethods = 'isNull' | 'isNotNull';

export type ConditionMethod = SingleValueMethods | BetweenMethods | InMethods | NullMethods;

// Params type per method category
type ConditionParams<M extends ConditionMethod> =
  M extends SingleValueMethods ? [value: Parameters<CB[M]>[1]] :
  M extends BetweenMethods ? [from: Parameters<CB[M]>[1], to: Parameters<CB[M]>[2]] :
  M extends InMethods ? [values: Parameters<CB[M]>[1]] :
  M extends NullMethods ? [] :
  never;

export type SearchCondition<F extends string = string> = {
  [M in ConditionMethod]: { field: F; method: M; params: ConditionParams<M> }
}[ConditionMethod];

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
