// Shared helpers for dialect-parametric integration tests.
//
// Usage:
//   import { DIALECT, createTestApp, seedRows, cleanTables } from './_helpers.js';
//
//   Set SQLAPI_TEST_DIALECT=postgres (default) or mysql to switch dialect.
//   Run only one dialect: `SQLAPI_TEST_DIALECT=mysql npm run test:integration`

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

export const DIALECT = process.env.SQLAPI_TEST_DIALECT || 'postgres';

if (DIALECT !== 'postgres' && DIALECT !== 'mysql') {
  throw new Error(`Unsupported SQLAPI_TEST_DIALECT: ${DIALECT}`);
}

export const PG_CONNECTION_STRING = 'postgres://test:test@127.0.0.1:5433/testdb';
export const MYSQL_CONFIG = {
  host: '127.0.0.1',
  port: 3307,
  user: 'test',
  password: 'test',
  database: 'testdb',
};

// Import plugin distribution once
const dist = await import(path.join(ROOT, 'dist/index.js'));
export const {
  fastifyAutoSqlApi,
  exportTableInfo,
  buildRelation,
  toUnderscore,
  Type,
  QueryClient,
  createQueryClient,
  pgQueryable,
  mysqlQueryable,
} = dist;

/**
 * Create a Fastify app configured for the current dialect, with the plugin registered.
 * Returns { app, db } where db is a plugin QueryClient you can use to seed.
 */
export async function createTestApp(DbTables, pluginOpts = {}) {
  const app = Fastify();

  let dbQueryable;
  if (DIALECT === 'postgres') {
    const fastifyPostgres = (await import('@fastify/postgres')).default;
    await app.register(fastifyPostgres, { connectionString: PG_CONNECTION_STRING });
    // Delay building the QueryClient until app.ready() has run (pool is available)
    dbQueryable = () => pgQueryable(app.pg.pool);
  } else {
    const mysql = (await import('mysql2/promise')).default;
    const pool = mysql.createPool(MYSQL_CONFIG);
    app.decorate('mysql', pool);
    app.addHook('onClose', async () => {
      await pool.end();
    });
    dbQueryable = () => mysqlQueryable(pool);
  }

  await app.register(fastifyAutoSqlApi, {
    DbTables,
    dialect: DIALECT,
    ...pluginOpts,
  });

  await app.ready();

  // Build a QueryClient for seeding
  const db = createQueryClient(dbQueryable(), DIALECT);

  return { app, db };
}

/**
 * Clean tables in order (respects FK constraints). DELETE only — does not drop schema.
 */
export async function cleanTables(db, tableNames) {
  for (const t of tableNames) {
    await db.query(`DELETE FROM ${db.qi(t)}`);
  }
}

/**
 * Insert multiple rows into a table. Uses QueryClient.bulkInsert so placeholders
 * and dialect-specific quoting are handled.
 */
export async function seedRows(db, tableName, rows, pkCol = 'id') {
  if (!rows.length) return [];
  return db.bulkInsert(tableName, rows, pkCol);
}
