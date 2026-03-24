import type { Queryable, SqlResult } from '../../types.js';

export interface PgQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export function pgQueryable(client: PgQueryable): Queryable {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      values?: unknown[]
    ): Promise<SqlResult<T>> {
      const result = await client.query<T>(text, values);
      return {
        rows: result.rows,
        affectedRows: result.rowCount ?? 0,
      };
    },
  };
}
