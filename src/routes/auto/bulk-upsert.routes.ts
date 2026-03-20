import type { FastifyInstance } from 'fastify';
import { BulkUpsertTableBody, BulkUpsertTableResponse } from '../../lib/schema/bulk-upsert.js';
import type { SqlApiPluginOptions, BulkUpsertItem } from '../../types.js';

export default async function bulkUpsertRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    const bodySchema = BulkUpsertTableBody(DbTables, tableName);
    const responseSchema = BulkUpsertTableResponse(DbTables, tableName);

    const joinList = tableConf.allowedWriteJoins
      ?.map(([joinSchema]) => joinSchema.tableName)
      .join(', ');
    const description = [
      `Bulk upsert records in ${tableName}`,
      joinList && `Available secondaries/deletions: ${joinList}`,
    ].filter(Boolean).join('. ');

    fastify.route({
      method: 'PUT',
      url: `/bulk/${tableConf.Schema.tableName}`,
      schema: {
        body: bodySchema,
        response: { 200: responseSchema },
        tags: [`SqlAPI-${tableName}`],
        summary: `Bulk upsert ${tableName}`,
        description,
      },
      onRequest: [...(options.onRequests || []), ...(tableConf.onRequests || [])],
      handler: async (request, reply) => {
        const items = request.body as BulkUpsertItem[];
        reply.send(await fastify.sqlApi.bulkUpsert(tableName, items, request));
      },
    });
  }
}
