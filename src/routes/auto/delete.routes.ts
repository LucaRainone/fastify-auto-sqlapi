import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { primaryAsString } from '../../types.js';
import { registerForAllTables } from './route-helpers.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function deleteRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'delete',
    method: 'DELETE',
    url: (tc) => `/rest/${tc.Schema.tableName}/:id`,
    successStatus: 200,
    schemas: (_db, _table, tc) => {
      const pkField = primaryAsString(tc.primary);
      return {
        params: Type.Object({ id: Type.String() }),
        response: Type.Object({ main: Type.Object({ [pkField]: tc.Schema.fields[pkField] }) }),
      };
    },
    summary: 'Delete',
    description: (name) => `Delete a record from ${name} by primary key`,
    handle: (fastify, tableName, _tc, request) => {
      const { id } = request.params as { id: string };
      return fastify.sqlApi.delete(tableName, id, request);
    },
  });
}
