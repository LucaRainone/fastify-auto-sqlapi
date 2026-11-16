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

/**
 * A value the QueryClient binds. `Date` is handed to the driver as is (pg and mysql2 both
 * convert it). A JSON object or array is not: pg sends an array as a Postgres array literal
 * and mysql2 expands an object into `key = value` pairs — `JSON.stringify` it first.
 */
export type DbRecordValue =
  | string
  | number
  | boolean
  | null
  | Date
  | Expression;

export type DbRecord = Record<string, DbRecordValue>;

/**
 * A primary key as a request names a row: the value itself for a single-column key, an object
 * naming every key field for a composite one (`{ postId: 1, tagId: 2 }`).
 */
export type PrimaryKeyValue = string | number | Record<string, string | number>;

/** What a write that may be an upsert did to a row. */
export type WriteAction = 'inserted' | 'updated';

/** A written row: its primary key columns, and whether the statement inserted or updated it. */
export interface WrittenRow {
  pk: Record<string, unknown>;
  action: WriteAction;
}

/**
 * Rows grouped by relation alias: the `upsert`, `delete` and `replace` sections of a write
 * request, the rows written (`secondaries`) and removed (`deletions`) as a write answers them
 * and hands them to `afterInsert`/`afterUpdate`, and `joinMultiple` / `joinLeft` in a search
 * result. Rows are camelCase.
 */
export type RowsByAlias = Record<string, Record<string, unknown>[]>;

/**
 * The child rows a write request carries, by write-join alias, one section per action
 * (ADR 0029). An alias appears in one section at most.
 */
export interface WriteJoinSections {
  /** Child rows to write: inserted, or upserted on the relation's `upsertKey`. Others stay. */
  upsert?: RowsByAlias;
  /** Child rows to delete, named by their key (the FK to the main row is filled in). Update only. */
  delete?: RowsByAlias;
  /**
   * The complete set of child rows: upserted on the relation's `upsertKey`, and every other
   * child row of the main row deleted. `[]` deletes them all. Needs the relation's `upsertKey`.
   */
  replace?: RowsByAlias;
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
