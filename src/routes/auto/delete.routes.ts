import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { primaryAsString } from '../../types.js';
import { pkParams, pkSchema } from '../../lib/schema/helpers.js';
import { registerForAllTables } from './route-helpers.js';
import type { RegistrationOptions } from '../sql-api-decorator.js';

export default async function deleteRoutes(
  fastify: FastifyInstance,
  options: RegistrationOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'delete',
    singlePkOnly: true,
    method: 'DELETE',
    url: (tableName) => `/rest/${tableName}/:id`,
    successStatus: 200,
    schemas: (_db, _table, tc) => ({
      params: pkParams(tc),
      response: Type.Object({ main: Type.Object(pkSchema(tc, tc.schema, primaryAsString(tc.primary))) }),
    }),
    summary: 'Delete',
    description: (name) => `Delete a record from ${name} by primary key`,
    handle: (sqlApi, tableName, _tc, request) => {
      const { id } = request.params as { id: string };
      return sqlApi.delete(tableName, id, request);
    },
  });
}
