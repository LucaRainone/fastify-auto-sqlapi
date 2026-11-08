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
   * Check out a dedicated connection for `QueryClient.withTransaction`. Optional in the type
   * because a read-only client needs none, but every insert and update runs in a transaction:
   * without `connect()` they fail with an explicit error instead of running unprotected
   * (ADR 0023). The built-in adapters provide it from a pool.
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

/** What a write that may be an upsert did to a row. */
export type WriteAction = 'inserted' | 'updated';

/** A written row: its primary key columns, and whether the statement inserted or updated it. */
export interface WrittenRow {
  pk: Record<string, unknown>;
  action: WriteAction;
}

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
