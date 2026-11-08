import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { primaryAsString } from '../../types.js';
import { pkParams, pkSchema } from '../../lib/schema/helpers.js';
import { registerForAllTables } from './route-helpers.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function deleteRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'delete',
    singlePkOnly: true,
    method: 'DELETE',
    url: (tableName) => `/rest/${tableName}/:id`,
    successStatus: 200,
    schemas: (_db, _table, tc) => ({
      params: pkParams(tc),
      response: Type.Object({ main: Type.Object(pkSchema(tc, tc.Schema, primaryAsString(tc.primary))) }),
    }),
    summary: 'Delete',
    description: (name) => `Delete a record from ${name} by primary key`,
    handle: (fastify, tableName, _tc, request) => {
      const { id } = request.params as { id: string };
      return fastify.sqlApi.delete(tableName, id, request);
    },
  });
}
