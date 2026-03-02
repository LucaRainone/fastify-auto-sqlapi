import type { FastifyInstance } from 'fastify';
import { getDb } from './route-helpers.js';
import { insertEngine } from '../../lib/engine/insert.js';
import { resolveTenant } from '../../lib/tenant.js';
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
        const db = getDb(fastify, options.dialect);
        const tenant = await resolveTenant(options, tableConf, request);
        const body = request.body as {
          main: Record<string, unknown>;
          secondaries?: Record<string, Record<string, unknown>[]>;
        };

        const result = await insertEngine({
          db,
          tableConf,
          dbTables: DbTables,
          request,
          record: body.main,
          secondaries: body.secondaries,
          tenant,
        });

        reply.status(201).send(result);
      },
    });
  }
}
