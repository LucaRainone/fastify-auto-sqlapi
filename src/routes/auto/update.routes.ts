import type { FastifyInstance } from 'fastify';
import { UpdateTableBody, UpdateTableResponse } from '../../lib/schema/update.js';
import { mergeOnRequests, buildWriteDescription } from './route-helpers.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function updateRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    const bodySchema = UpdateTableBody(DbTables, tableName);
    const responseSchema = UpdateTableResponse(DbTables, tableName);

    fastify.route({
      method: 'PUT',
      url: `/rest/${tableConf.Schema.tableName}`,
      schema: {
        body: bodySchema,
        response: { 200: responseSchema },
        tags: [`SqlAPI-${tableName}`],
        summary: `Update ${tableName}`,
        description: buildWriteDescription('Update a record in', tableName, tableConf),
      },
      onRequest: mergeOnRequests(options, tableConf),
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
