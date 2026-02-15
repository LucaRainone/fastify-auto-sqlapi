import pg from 'pg';
import type { ColumnInfo } from '../types.js';

const { Client } = pg;

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
  const client = new Client({ connectionString });

  try {
    await client.connect();

    const result = await client.query<ColumnInfo>(
      `SELECT table_name, column_name, udt_name, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [schema]
    );

    return result.rows;
  } finally {
    await client.end();
  }
}
