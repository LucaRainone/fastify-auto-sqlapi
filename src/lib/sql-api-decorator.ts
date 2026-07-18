import type { FastifyInstance } from 'fastify';
import { createQueryClient } from './db.js';
import { pgQueryable } from './adapters/pg-adapter.js';
import { mysqlQueryable } from './adapters/mysql-adapter.js';
import { createSqlApi, type SqlApi } from './sql-api.js';
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
