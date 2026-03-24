import type { Queryable, SqlResult } from '../../types.js';

export interface MysqlQueryable {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<[T[] & { affectedRows?: number; insertId?: number }, unknown]>;
}

export function mysqlQueryable(pool: MysqlQueryable): Queryable {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      values?: unknown[]
    ): Promise<SqlResult<T>> {
      const [result] = await pool.query<T>(text, values);

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
    },
  };
}
