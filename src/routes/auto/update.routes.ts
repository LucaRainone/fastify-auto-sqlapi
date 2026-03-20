import type { FastifyInstance } from 'fastify';
import { UpdateTableBody, UpdateTableResponse } from '../../lib/schema/update.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function updateRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    const bodySchema = UpdateTableBody(DbTables, tableName);
    const responseSchema = UpdateTableResponse(DbTables, tableName);

    const joinList = tableConf.allowedWriteJoins
      ?.map(([joinSchema]) => joinSchema.tableName)
      .join(', ');
    const description = [
      `Update a record in ${tableName}`,
      joinList && `Available secondaries/deletions: ${joinList}`,
    ].filter(Boolean).join('. ');

    fastify.route({
      method: 'PUT',
      url: `/rest/${tableConf.Schema.tableName}`,
      schema: {
        body: bodySchema,
        response: { 200: responseSchema },
        tags: [`SqlAPI-${tableName}`],
        summary: `Update ${tableName}`,
        description,
      },
      onRequest: [...(options.onRequests || []), ...(tableConf.onRequests || [])],
      handler: async (request, reply) => {
        const body = request.body as {
          main: Record<string, unknown>;
          secondaries?: Record<string, Record<string, unknown>[]>;
          deletions?: Record<string, Record<string, unknown>[]>;
        };

        const result = await fastify.sqlApi.update(tableName, {
          record: body.main,
          secondaries: body.secondaries,
          deletions: body.deletions,
        }, request);

        reply.send(result);
      },
    });
  }
}
