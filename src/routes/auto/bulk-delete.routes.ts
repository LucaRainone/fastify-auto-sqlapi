import type { FastifyInstance } from 'fastify';
import { BulkDeleteTableBody, BulkDeleteTableResponse } from '../../lib/schema/bulk-delete.js';
import { primaryAsString } from '../../types.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function bulkDeleteRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    const bodySchema = BulkDeleteTableBody(DbTables, tableName);
    const responseSchema = BulkDeleteTableResponse(DbTables, tableName);

    fastify.route({
      method: 'POST',
      url: `/bulk/${tableConf.Schema.tableName}/delete`,
      schema: {
        body: bodySchema,
        response: { 200: responseSchema },
        tags: [`SqlAPI-${tableName}`],
        summary: `Bulk delete ${tableName}`,
        description: `Delete multiple records from ${tableName} by primary key`,
      },
      onRequest: [...(options.onRequests || []), ...(tableConf.onRequests || [])],
      handler: async (request, reply) => {
        const items = request.body as Record<string, unknown>[];
        const ids = items.map((item) => item[primaryAsString(tableConf.primary)] as string | number);
        reply.send(await fastify.sqlApi.bulkDelete(tableName, ids, request));
      },
    });
  }
}
