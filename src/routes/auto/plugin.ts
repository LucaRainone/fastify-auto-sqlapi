import type { FastifyInstance } from 'fastify';
import { ConditionBuilder } from 'node-condition-builder';
import { getDialect } from '../../lib/dialect.js';
import { createQueryClient, type QueryClient } from '../../lib/db.js';
import { pgQueryable } from '../../lib/adapters/pg-adapter.js';
import { mysqlQueryable } from '../../lib/adapters/mysql-adapter.js';
import { setupSwagger } from '../../lib/setup-swagger.js';
import searchRoutes from './search.routes.js';
import getRoutes from './get.routes.js';
import insertRoutes from './insert.routes.js';
import updateRoutes from './update.routes.js';
import deleteRoutes from './delete.routes.js';
import bulkUpsertRoutes from './bulk-upsert.routes.js';
import bulkDeleteRoutes from './bulk-delete.routes.js';
import type { SqlApiPluginOptions } from '../../types.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: QueryClient;
  }
}

export default async function fastifyAutoSqlApi(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  // Set ConditionBuilder dialect globally
  const dialect = getDialect(options.dialect || 'postgres');
  ConditionBuilder.DIALECT = dialect.cbDialect;

  // Lazy-init QueryClient on first access, cached for all subsequent requests.
  // Encapsulated: only visible inside this plugin and its sub-routes.
  let cachedDb: QueryClient | undefined;
  fastify.decorate('db', {
    getter() {
      if (!cachedDb) {
        const pool = (options.dialect === 'mysql' || options.dialect === 'mariadb')
          ? mysqlQueryable((fastify as any).mysql)
          : pgQueryable((fastify as any).pg);
        cachedDb = createQueryClient(pool, options.dialect);
        console.log({options})
        if (options.debug) cachedDb.setDebug(true);
      }
      return cachedDb;
    },
  });

  if (options.swagger) {
    await setupSwagger(fastify, options);
  }

  // Strip prefix to avoid double-prefixing: Fastify already applied
  // it when the consumer registered this plugin.
  const { prefix: _prefix, ...routeOptions } = options;

  await fastify.register(searchRoutes, routeOptions);
  await fastify.register(getRoutes, routeOptions);
  await fastify.register(insertRoutes, routeOptions);
  await fastify.register(updateRoutes, routeOptions);
  await fastify.register(deleteRoutes, routeOptions);
  await fastify.register(bulkUpsertRoutes, routeOptions);
  await fastify.register(bulkDeleteRoutes, routeOptions);
}
