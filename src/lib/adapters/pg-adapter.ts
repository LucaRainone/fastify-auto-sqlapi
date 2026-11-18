import type { Queryable, SqlResult, TransactionQueryable } from '../../types.js';

export interface PgQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  /**
   * Present on pg.Pool (and @fastify/postgres): checks out a dedicated client. Only its `query`
   * and `release` are used — a PoolClient's own `connect()` is not a checkout.
   */
  connect?(): Promise<Pick<PgQueryable, 'query'> & { release(): void }>;
}

function wrapQuery(client: Pick<PgQueryable, 'query'>): Queryable['query'] {
  return async <T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<SqlResult<T>> => {
    const result = await client.query<T>(text, values);
    return {
      rows: result.rows,
      affectedRows: result.rowCount ?? 0,
    };
  };
}

export function pgQueryable(client: PgQueryable): Queryable {
  const queryable: Queryable = { query: wrapQuery(client) };

  if (typeof client.connect === 'function') {
    queryable.connect = async (): Promise<TransactionQueryable> => {
      const conn = await client.connect!();
      return {
        query: wrapQuery(conn),
        release: () => conn.release(),
      };
    };
  }

  return queryable;
}
