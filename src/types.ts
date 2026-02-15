import type { QueryResult, QueryResultRow } from 'pg';
import type { Expression } from 'node-condition-builder';

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
