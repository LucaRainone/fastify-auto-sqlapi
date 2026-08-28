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
  /** Only used to order the union; not part of `ColumnInfo`. */
  ordinal_position?: number;
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
      // The UNION picks up materialized views, which `information_schema` does not describe at
      // all: they live only in `pg_catalog`, and without this half they were silently absent
      // from every generation run. Their columns are cast to the same shapes the standard view
      // returns, so the two halves stay union-compatible.
      `SELECT * FROM (
         SELECT c.table_name::text, c.column_name::text, c.udt_name::text,
                c.column_default::text, c.is_nullable::text,
                c.is_identity::text, c.is_generated::text,
                (pk.column_name IS NOT NULL) AS is_primary,
                (t.table_type = 'VIEW') AS is_view,
                c.ordinal_position::int AS ordinal_position
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         LEFT JOIN (
           SELECT kcu.table_name, kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
           WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
         ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
         WHERE c.table_schema = $1
         UNION ALL
         SELECT mc.relname::text, ma.attname::text, mt.typname::text,
                NULL::text, CASE WHEN ma.attnotnull THEN 'NO' ELSE 'YES' END,
                'NO'::text, 'NEVER'::text,
                false, true, ma.attnum::int
         FROM pg_class mc
         JOIN pg_namespace mn ON mn.oid = mc.relnamespace
         JOIN pg_attribute ma
           ON ma.attrelid = mc.oid AND ma.attnum > 0 AND NOT ma.attisdropped
         JOIN pg_type mt ON mt.oid = ma.atttypid
         WHERE mc.relkind = 'm' AND mn.nspname = $1
       ) cols
       ORDER BY table_name, ordinal_position`,
      [schema]
    );

    // The query's own columns are spelled out rather than spread: `is_identity` and
    // `is_generated` arrive as the standard's string enums and `ordinal_position` only exists
    // to order the union, so none of the three belongs in the `ColumnInfo` handed back.
    return result.rows.map((row) => ({
      table_name: row.table_name,
      column_name: row.column_name,
      udt_name: row.udt_name,
      column_default: row.column_default,
      is_nullable: row.is_nullable,
      is_primary: row.is_primary,
      is_view: row.is_view,
      // An identity column has no `column_default`, so without this flag it is emitted as a
      // mandatory field and the table cannot be inserted into at all.
      ...(row.is_identity === 'YES' ? { is_auto_increment: true } : {}),
      ...(row.is_generated === 'ALWAYS' ? { is_generated: true } : {}),
    }));
  } finally {
    await client.end();
  }
}
