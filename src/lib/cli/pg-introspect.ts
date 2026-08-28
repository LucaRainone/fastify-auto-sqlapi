import { loadOptionalDependency } from './load-dependency.js';
import type { ColumnInfo } from '../../types.js';

/**
 * The slice of `pg` this CLI actually uses.
 *
 * Declared locally rather than imported: pg is an optional peer, so a real import would
 * break installs that only use MySQL, and its types would leak into the published `.d.ts`
 * and fail to resolve for consumers who never installed it.
 */
interface PgClient {
  connect(): Promise<void>;
  query<T>(sql: string, values: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

interface PgModule {
  Client: new (config: { connectionString: string }) => PgClient;
}

export function buildConnectionString(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const host = process.env.POSTGRES_HOST || '127.0.0.1';
  const port = process.env.POSTGRES_PORT || '5433';
  const user = process.env.POSTGRES_USER || 'test';
  const password = process.env.POSTGRES_PASSWORD || 'test';
  const db = process.env.POSTGRES_DB || 'testdb';

  return `postgres://${user}:${password}@${host}:${port}/${db}`;
}

/**
 * `information_schema.columns` as Postgres returns it. `is_identity` and `is_generated` are
 * the string enums the standard defines ('YES'/'NO', 'ALWAYS'/'NEVER'); they are folded into
 * the booleans `ColumnInfo` carries before leaving this module.
 */
interface PgColumnRow extends Omit<ColumnInfo, 'is_generated'> {
  is_identity?: string;
  is_generated?: string;
}

export async function introspectTables(
  connectionString: string,
  schema: string
): Promise<ColumnInfo[]> {
  const pg = loadOptionalDependency<PgModule>('pg', 'npm install pg');

  const client = new pg.Client({ connectionString });

  try {
    await client.connect();

    const result = await client.query<PgColumnRow>(
      `SELECT c.table_name, c.column_name, c.udt_name, c.column_default, c.is_nullable,
              c.is_identity, c.is_generated,
              (pk.column_name IS NOT NULL) AS is_primary
       FROM information_schema.columns c
       LEFT JOIN (
         SELECT kcu.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
       ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
       WHERE c.table_schema = $1
       ORDER BY c.table_name, c.ordinal_position`,
      [schema]
    );

    return result.rows.map(({ is_identity, is_generated, ...col }) => ({
      ...col,
      // An identity column has no `column_default`, so without this flag it is emitted as a
      // mandatory field and the table cannot be inserted into at all.
      ...(is_identity === 'YES' ? { is_auto_increment: true } : {}),
      ...(is_generated === 'ALWAYS' ? { is_generated: true } : {}),
    }));
  } finally {
    await client.end();
  }
}
