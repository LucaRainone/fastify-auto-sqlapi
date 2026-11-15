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

/** Resolves a registration's SqlApi on first use (the pool may be decorated after registration). */
export type SqlApiGetter = () => SqlApi;

/**
 * Route options key under which the main plugin hands its own SqlApi to the route plugins it
 * registers, so the eight of them share one instance. A symbol: it is not an option a
 * consumer can set, and it never collides with one.
 */
export const REGISTRATION_SQL_API = Symbol('fastify-auto-sqlapi.registrationSqlApi');

/** Route plugin options as the main plugin passes them: the consumer's, plus its SqlApi. */
export type RegistrationOptions = SqlApiPluginOptions & { [REGISTRATION_SQL_API]?: SqlApiGetter };

/**
 * The SqlApi of ONE registration, built lazily from that registration's options: its
 * `DbTables`, `getTenantId`, `dialect` and `debug`. The routes of a registration always run
 * through it, never through whatever `fastify.sqlApi` resolves to in their scope — with the
 * plugin registered under two prefixes, that decorator belongs to the first registration, and
 * the second one's tables, tenant scopes and rules would silently be ignored.
 *
 * The underlying pool (`fastify.pg` / `fastify.mysql`) is shared by every registration.
 */
export function createRegistrationSqlApi(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): SqlApiGetter {
  let cachedSqlApi: SqlApi | undefined;

  return () => {
    if (!cachedSqlApi) {
      const pool = (options.dialect === 'mysql' || options.dialect === 'mariadb')
        ? mysqlQueryable((fastify as any).mysql)
        : pgQueryable((fastify as any).pg);
      const db = createQueryClient(pool, options.dialect);
      if (options.debug) db.setDebug(true);
      // Reads work either way; the first insert or update would fail with the same message.
      // Said once, here, so a misconfigured client is found before that request arrives.
      if (!db.supportsTransactions) {
        fastify.log.warn(
          'sqlapi: the database client has no connect(): inserts and updates need a transaction ' +
          'and will fail. Decorate a pool (fastify.pg from @fastify/postgres, a mysql2/promise pool).'
        );
      }
      cachedSqlApi = createSqlApi(db, options.DbTables, { getTenantId: options.getTenantId });
    }
    return cachedSqlApi;
  };
}

/**
 * Decorates `fastify.sqlApi` (lazy getter) for application code, unless the decorator is
 * already present in scope. The main plugin calls this at the fp level (parent scope);
 * granular route plugins call it through `registerForAllTables`, so they also work
 * standalone, each within its own encapsulation context.
 *
 * The decorator is for the consumer's own routes only: the auto routes never read it.
 */
export function ensureSqlApiDecorator(fastify: FastifyInstance, getSqlApi: SqlApiGetter): void {
  if (fastify.hasDecorator('sqlApi')) return;
  fastify.decorate('sqlApi', { getter: getSqlApi });
}
