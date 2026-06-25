import type { Queryable, SqlResult, TransactionQueryable } from '../../types.js';

export interface MysqlQueryable {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<[T[] & { affectedRows?: number; insertId?: number }, unknown]>;
  /** Present on mysql2 promise pools (and @fastify/mysql): checks out a dedicated connection. */
  getConnection?(): Promise<MysqlQueryable & { release(): void }>;
}

function wrapQuery(client: MysqlQueryable): Queryable['query'] {
  return async <T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<SqlResult<T>> => {
    const [result] = await client.query<T>(text, values);

    // SELECT returns an array of rows
    if (Array.isArray(result) && !('affectedRows' in result)) {
      return {
        rows: result as T[],
        affectedRows: result.length,
      };
    }

    // INSERT/UPDATE/DELETE returns ResultSetHeader-like
    const header = result as T[] & { affectedRows?: number; insertId?: number };
    return {
      rows: [],
      affectedRows: header.affectedRows ?? 0,
      insertId: header.insertId,
    };
  };
}

export function mysqlQueryable(pool: MysqlQueryable): Queryable {
  const queryable: Queryable = { query: wrapQuery(pool) };

  if (typeof pool.getConnection === 'function') {
    queryable.connect = async (): Promise<TransactionQueryable> => {
      const conn = await pool.getConnection!();
      return {
        query: wrapQuery(conn),
        release: () => conn.release(),
      };
    };
  }

  return queryable;
}
