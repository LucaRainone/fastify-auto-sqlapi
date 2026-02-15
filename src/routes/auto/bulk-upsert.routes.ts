import type { FastifyInstance } from 'fastify';
import { QueryClient } from '../../lib/db.js';
import { bulkUpsertEngine } from '../../lib/engine/bulk-upsert.js';
import { resolveTenant } from '../../lib/tenant.js';
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
        const db = new QueryClient((fastify as any).pg);
        const tenant = await resolveTenant(options, tableConf, request);
        const items = request.body as BulkUpsertItem[];

        const result = await bulkUpsertEngine({
          db,
          tableConf,
          dbTables: DbTables,
          request,
          items,
          tenant,
        });

        reply.send(result);
      },
    });
  }
}
