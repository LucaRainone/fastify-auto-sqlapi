import type { FastifyInstance, FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import { ConditionBuilder } from 'node-condition-builder';
import { getDialect } from '../../lib/dialect.js';
import { createQueryClient } from '../../lib/db.js';
import { pgQueryable } from '../../lib/adapters/pg-adapter.js';
import { mysqlQueryable } from '../../lib/adapters/mysql-adapter.js';
import { createSqlApi, type SqlApi } from '../../lib/sql-api.js';
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
    sqlApi: SqlApi;
  }
}

export default fp(async function fastifyAutoSqlApi(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  // Set ConditionBuilder dialect globally
  const dialect = getDialect(options.dialect || 'postgres');
  ConditionBuilder.DIALECT = dialect.cbDialect;

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

  // SqlApi: exposed to parent scope via fp
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

  // Routes in a child scope — prefix applies here, not at fp level
  const { prefix, ...routeOptions } = options;
  await fastify.register(async (instance) => {
    // Structured validation errors with field-level detail
    instance.setErrorHandler((error: FastifyError, request, reply) => {
      // Schema validation errors (Ajv)
      if (error.validation) {
        const fields = error.validation.map((v) => ({
          path: (v.instancePath || '').replace(/\//g, '.').replace(/^\./, ''),
          message: v.message || 'invalid',
          code: v.keyword || 'unknown',
        }));
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation failed',
          fields,
        });
      }

      // Custom validation errors (validate / validateBulk)
      const validationErrors = (error as any).validationErrors;
      if (validationErrors) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation failed',
          fields: validationErrors,
        });
      }

      const statusCode = error.statusCode || 500;
      reply.status(statusCode).send({
        statusCode,
        error: error.name || 'Error',
        message: error.message,
      });
    });

    if (options.swagger) {
      await setupSwagger(instance, options);
    }

    await instance.register(searchRoutes, routeOptions);
    await instance.register(getRoutes, routeOptions);
    await instance.register(insertRoutes, routeOptions);
    await instance.register(updateRoutes, routeOptions);
    await instance.register(deleteRoutes, routeOptions);
    await instance.register(bulkUpsertRoutes, routeOptions);
    await instance.register(bulkDeleteRoutes, routeOptions);
  }, { prefix });
}, { name: 'fastify-auto-sqlapi' });
