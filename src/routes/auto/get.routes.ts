import type { FastifyInstance } from 'fastify';
import { GetTableResponse } from '../../lib/schema/get.js';
import { pkParams } from '../../lib/schema/helpers.js';
import { registerForAllTables } from './route-helpers.js';
import type { RegistrationOptions } from '../sql-api-decorator.js';

export default async function getRoutes(
  fastify: FastifyInstance,
  options: RegistrationOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'get',
    singlePkOnly: true,
    method: 'GET',
    url: (tableName) => `/rest/${tableName}/:id`,
    successStatus: 200,
    schemas: (db, table, tc) => ({
      params: pkParams(tc),
      response: GetTableResponse(db, table),
    }),
    summary: 'Get',
    description: (name) => `Get a record from ${name} by primary key`,
    handle: (sqlApi, tableName, _tc, request) => {
      const { id } = request.params as { id: string };
      return sqlApi.get(tableName, id, request);
    },
  });
}
