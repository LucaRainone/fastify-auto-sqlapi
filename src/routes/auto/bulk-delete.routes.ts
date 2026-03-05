import type { FastifyInstance } from 'fastify';
import { getDb } from './route-helpers.js';
import { bulkDeleteEngine } from '../../lib/engine/bulk-delete.js';
import { resolveTenant } from '../../lib/tenant.js';
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
        const db = getDb(fastify, options.dialect);
        const tenant = await resolveTenant(options, tableConf, request);
        const items = request.body as Record<string, unknown>[];
        const ids = items.map((item) => item[primaryAsString(tableConf.primary)] as string | number);

        const result = await bulkDeleteEngine({ db, tableConf, ids, tenant });

        reply.send(result);
      },
    });
  }
}
