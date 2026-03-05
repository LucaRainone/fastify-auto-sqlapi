import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { deleteEngine } from '../../lib/engine/delete.js';
import { resolveTenant } from '../../lib/tenant.js';
import { primaryAsString } from '../../types.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function deleteRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    const pkField = primaryAsString(tableConf.primary);
    const pkType = tableConf.Schema.fields[pkField];
    const responseSchema = Type.Object({
      main: Type.Object({ [pkField]: pkType }),
    });

    fastify.route({
      method: 'DELETE',
      url: `/rest/${tableConf.Schema.tableName}/:id`,
      schema: {
        params: Type.Object({ id: Type.String() }),
        response: { 200: responseSchema },
        tags: [`SqlAPI-${tableName}`],
        summary: `Delete ${tableName}`,
        description: `Delete a record from ${tableName} by primary key`,
      },
      onRequest: [...(options.onRequests || []), ...(tableConf.onRequests || [])],
      handler: async (request, reply) => {
        const db = fastify.db;
        const tenant = await resolveTenant(options, tableConf, request);
        const { id } = request.params as { id: string };

        const result = await deleteEngine({ db, tableConf, id, tenant });

        reply.send(result);
      },
    });
  }
}
