import type { FastifyInstance } from 'fastify';
import { BulkUpsertTableBody, BulkUpsertTableResponse } from '../../lib/schema/bulk-upsert.js';
import { mergeOnRequests, buildWriteDescription } from './route-helpers.js';
import type { SqlApiPluginOptions, BulkUpsertItem } from '../../types.js';

export default async function bulkUpsertRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    const bodySchema = BulkUpsertTableBody(DbTables, tableName);
    const responseSchema = BulkUpsertTableResponse(DbTables, tableName);

    fastify.route({
      method: 'PUT',
      url: `/bulk/${tableConf.Schema.tableName}`,
      schema: {
        body: bodySchema,
        response: { 200: responseSchema },
        tags: [`SqlAPI-${tableName}`],
        summary: `Bulk upsert ${tableName}`,
        description: buildWriteDescription('Bulk upsert records in', tableName, tableConf),
      },
      onRequest: mergeOnRequests(options, tableConf),
      handler: async (request, reply) => {
        const items = request.body as BulkUpsertItem[];
        reply.send(await fastify.sqlApi.bulkUpsert(tableName, items, request));
      },
    });
  }
}
