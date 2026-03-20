import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { primaryAsString } from '../../types.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function deleteRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    const pkField = primaryAsString(tableConf.primary);
    const pkType = tableConf.Schema.fields[pkField];
    const responseSchema = Type.Object({
      main: Type.Object({ [pkField]: pkType }),
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
        const { id } = request.params as { id: string };
        reply.send(await fastify.sqlApi.delete(tableName, id, request));
      },
    });
  }
}
