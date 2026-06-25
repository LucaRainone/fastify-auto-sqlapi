import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { registerForAllTables } from './route-helpers.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function getRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'get',
    method: 'GET',
    url: (tc) => `/rest/${tc.Schema.tableName}/:id`,
    successStatus: 200,
    schemas: (_db, _table, tc) => ({
      params: Type.Object({ id: Type.String() }),
      response: Type.Object({ main: Type.Partial(Type.Object(tc.Schema.fields)) }),
    }),
    summary: 'Get',
    description: (name) => `Get a record from ${name} by primary key`,
    handle: (fastify, tableName, _tc, request) => {
      const { id } = request.params as { id: string };
      return fastify.sqlApi.get(tableName, id, request);
    },
  });
}
