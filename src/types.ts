import type { QueryResult, QueryResultRow } from 'pg';
import type { Expression, ConditionBuilder } from 'node-condition-builder';
import type { TSchema, TObject } from '@sinclair/typebox';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { QueryClient } from './lib/db.js';

// ─── CLI / Schema Generation ────────────────────────────────

export interface SqlApiConfig {
  outputDir: string;
  schema?: string;
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

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>>;
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

// ─── Join Definition ─────────────────────────────────────────

// [joinSchema, joinField, mainField, selection]
export type JoinDefinition = [SchemaDefinition, string, string | string[], string];

// ─── Table Configuration ─────────────────────────────────────

export type ExtendedConditionFn = (condition: ConditionBuilder, filters: Record<string, unknown>) => void;
export type TableFilterFn = (filters: Record<string, unknown>) => ConditionBuilder;

export interface ITable<F extends Record<string, TSchema> = Record<string, TSchema>> {
  primary: string & keyof F;
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbTables = Record<string, ITable<any>>;

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
  filters?: Record<string, unknown>;
}

export interface SearchParams {
  db: QueryClient;
  tableConf: ITable;
  filters?: Record<string, unknown>;
  joins?: Record<string, { filters?: Record<string, unknown> }>;
  joinGroups?: Record<string, JoinGroupRequest>;
  orderBy?: string;
  paginator?: Paginator;
  computeMin?: string;
  computeMax?: string;
  computeSum?: string;
  computeAvg?: string;
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
}

export interface InsertResult {
  main: Record<string, unknown>;
  secondaries?: Record<string, Record<string, unknown>[]>;
}
