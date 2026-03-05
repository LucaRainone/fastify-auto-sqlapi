import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { getEngine } from '../../lib/engine/rest/get.js';
import { resolveTenant } from '../../lib/tenant.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function getRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    const responseSchema = Type.Object({
      main: Type.Partial(Type.Object(tableConf.Schema.fields)),
    });

    fastify.route({
      method: 'GET',
      url: `/rest/${tableConf.Schema.tableName}/:id`,
      schema: {
        params: Type.Object({ id: Type.String() }),
        response: { 200: responseSchema },
        tags: [`SqlAPI-${tableName}`],
        summary: `Get ${tableName}`,
        description: `Get a record from ${tableName} by primary key`,
      },
      onRequest: [...(options.onRequests || []), ...(tableConf.onRequests || [])],
      handler: async (request, reply) => {
        const db = fastify.db;
        const tenant = await resolveTenant(options, tableConf, request);
        const { id } = request.params as { id: string };

        const result = await getEngine({ db, tableConf, id, tenant });

        reply.send(result);
      },
    });
  }
}
