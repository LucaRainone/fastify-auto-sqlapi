import type { Expression } from 'node-condition-builder';

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
