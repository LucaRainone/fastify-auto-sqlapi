import type { FastifyInstance } from 'fastify';
import { InsertTableBody, InsertTableResponse } from '../../lib/schema/insert.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function insertRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    const bodySchema = InsertTableBody(DbTables, tableName);
    const responseSchema = InsertTableResponse(DbTables, tableName);

    const joinList = tableConf.allowedWriteJoins
      ?.map(([joinSchema]) => joinSchema.tableName)
      .join(', ');
    const description = [
      `Insert a record into ${tableName}`,
      joinList && `Available secondaries: ${joinList}`,
    ].filter(Boolean).join('. ');

    fastify.route({
      method: 'POST',
      url: `/rest/${tableConf.Schema.tableName}`,
      schema: {
        body: bodySchema,
        response: { 201: responseSchema },
        tags: [`SqlAPI-${tableName}`],
        summary: `Insert ${tableName}`,
        description,
      },
      onRequest: [...(options.onRequests || []), ...(tableConf.onRequests || [])],
      handler: async (request, reply) => {
        const body = request.body as {
          main: Record<string, unknown>;
          secondaries?: Record<string, Record<string, unknown>[]>;
        };

        const result = await fastify.sqlApi.insert(tableName, {
          record: body.main,
          secondaries: body.secondaries,
        }, request);

        reply.status(201).send(result);
      },
    });
  }
}
