import type { FastifyInstance } from 'fastify';
import { setupSwagger } from '../../lib/setup-swagger.js';
import searchRoutes from './search.routes.js';
import getRoutes from './get.routes.js';
import insertRoutes from './insert.routes.js';
import updateRoutes from './update.routes.js';
import deleteRoutes from './delete.routes.js';
import bulkUpsertRoutes from './bulk-upsert.routes.js';
import bulkDeleteRoutes from './bulk-delete.routes.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function fastifyAutoSqlApi(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  if (options.swagger) {
    await setupSwagger(fastify, options);
  }

  await fastify.register(searchRoutes, options);
  await fastify.register(getRoutes, options);
  await fastify.register(insertRoutes, options);
  await fastify.register(updateRoutes, options);
  await fastify.register(deleteRoutes, options);
  await fastify.register(bulkUpsertRoutes, options);
  await fastify.register(bulkDeleteRoutes, options);
}
