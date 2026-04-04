import { createRequire } from 'node:module';
import type { ColumnInfo } from '../../types.js';

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

export async function introspectTables(
  connectionString: string,
  schema: string
): Promise<ColumnInfo[]> {
  // Dynamic require from cwd so it works with npm link
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pg: any;
  try {
    const require = createRequire(process.cwd() + '/noop.js');
    pg = require('pg');
  } catch {
    try {
      // Fallback: resolve from the package's own node_modules
      const require = createRequire(import.meta.url);
      pg = require('pg');
    } catch {
      throw new Error('pg is required for PostgreSQL introspection. Install it with: npm install pg');
    }
  }

  const client = new pg.Client({ connectionString });

  try {
    await client.connect();

    const result = await client.query(
      `SELECT table_name, column_name, udt_name, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [schema]
    );

    return result.rows as ColumnInfo[];
  } finally {
    await client.end();
  }
}
