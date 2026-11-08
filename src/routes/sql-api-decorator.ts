import type { FastifyInstance } from 'fastify';
import { createQueryClient } from '../lib/db.js';
import { pgQueryable } from '../lib/adapters/pg-adapter.js';
import { mysqlQueryable } from '../lib/adapters/mysql-adapter.js';
import { createSqlApi, type SqlApi } from '../lib/sql-api.js';
import type { SqlApiPluginOptions } from '../types.js';

declare module 'fastify' {
  interface FastifyInstance {
    sqlApi: SqlApi;
  }
}

/**
 * Decorates `fastify.sqlApi` (lazy getter) on the given instance unless the
 * decorator is already present in scope. The main plugin calls this at the
 * fp level (parent scope); granular route plugins call it through
 * `registerForAllTables` so they also work standalone, each within its own
 * encapsulation context. The underlying pool (`fastify.pg` / `fastify.mysql`)
 * is shared either way.
 */
export function ensureSqlApiDecorator(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): void {
  if (fastify.hasDecorator('sqlApi')) return;

  // Lazy-init QueryClient (internal closure — not decorated on fastify)
  let cachedDb: ReturnType<typeof createQueryClient> | undefined;
  function getDb() {
    if (!cachedDb) {
      const pool = (options.dialect === 'mysql' || options.dialect === 'mariadb')
        ? mysqlQueryable((fastify as any).mysql)
        : pgQueryable((fastify as any).pg);
      cachedDb = createQueryClient(pool, options.dialect);
      if (options.debug) cachedDb.setDebug(true);
      // Reads work either way; the first insert or update would fail with the same message.
      // Said once, here, so a misconfigured client is found before that request arrives.
      if (!cachedDb.supportsTransactions) {
        fastify.log.warn(
          'sqlapi: the database client has no connect(): inserts and updates need a transaction ' +
          'and will fail. Decorate a pool (fastify.pg from @fastify/postgres, a mysql2/promise pool).'
        );
      }
    }
    return cachedDb;
  }

  let cachedSqlApi: SqlApi | undefined;
  fastify.decorate('sqlApi', {
    getter() {
      if (!cachedSqlApi) {
        cachedSqlApi = createSqlApi(getDb(), options.DbTables, {
          getTenantId: options.getTenantId,
        });
      }
      return cachedSqlApi;
    },
  });
}
