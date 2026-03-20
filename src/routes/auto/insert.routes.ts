import type { FastifyInstance } from 'fastify';
import { InsertTableBody, InsertTableResponse } from '../../lib/schema/insert.js';
import { mergeOnRequests, buildWriteDescription } from './route-helpers.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function insertRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    const bodySchema = InsertTableBody(DbTables, tableName);
    const responseSchema = InsertTableResponse(DbTables, tableName);

    fastify.route({
      method: 'POST',
      url: `/rest/${tableConf.Schema.tableName}`,
      schema: {
        body: bodySchema,
        response: { 201: responseSchema },
        tags: [`SqlAPI-${tableName}`],
        summary: `Insert ${tableName}`,
        description: buildWriteDescription('Insert a record into', tableName, tableConf),
      },
      onRequest: mergeOnRequests(options, tableConf),
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
