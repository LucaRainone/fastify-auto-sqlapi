import type { Expression } from 'node-condition-builder';

export interface SqlResult<T = Record<string, unknown>> {
  rows: T[];
  affectedRows: number;
  insertId?: number;
}

/** A dedicated connection checked out from a pool, used to run a transaction. */
export interface TransactionQueryable extends Queryable {
  /** Return the connection to the pool. Always called, even on error. */
  release(): void | Promise<void>;
}

export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<SqlResult<T>>;
  /**
   * Optional: check out a dedicated connection for `QueryClient.withTransaction`.
   * When absent, `withTransaction` degrades to running its callback without
   * transactional guarantees (legacy custom adapters keep working unchanged).
   */
  connect?(): Promise<TransactionQueryable>;
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
