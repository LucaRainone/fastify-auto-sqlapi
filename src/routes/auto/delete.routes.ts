import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { QueryClient } from '../../lib/db.js';
import { deleteEngine } from '../../lib/engine/delete.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function deleteRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    const responseSchema = Type.Object({
      main: Type.Partial(Type.Object(tableConf.Schema.fields)),
    });

    fastify.route({
      method: 'DELETE',
      url: `/rest/${tableConf.Schema.tableName}/:id`,
      schema: {
        params: Type.Object({ id: Type.String() }),
        response: { 200: responseSchema },
        tags: [`SqlAPI-${tableName}`],
        summary: `Delete ${tableName}`,
        description: `Delete a record from ${tableName} by primary key`,
      },
      onRequest: [...(options.onRequests || []), ...(tableConf.onRequests || [])],
      handler: async (request, reply) => {
        const db = new QueryClient((fastify as any).pg);
        const { id } = request.params as { id: string };

        const result = await deleteEngine({ db, tableConf, id });

        reply.send(result);
      },
    });
  }
}
