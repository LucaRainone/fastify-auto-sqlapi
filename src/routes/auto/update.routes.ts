import type { FastifyInstance } from 'fastify';
import { UpdateTableBody, UpdateTableResponse } from '../../lib/schema/update.js';
import { registerForAllTables, buildWriteDescription } from './route-helpers.js';
import type { SqlApiPluginOptions } from '../../types.js';
import type { SqlApiUpdateParams } from '../../lib/sql-api.js';

export default async function updateRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'update',
    method: 'PUT',
    url: (tableName) => `/rest/${tableName}`,
    successStatus: 200,
    schemas: (db, table) => ({
      body: UpdateTableBody(db, table),
      response: UpdateTableResponse(db, table),
    }),
    summary: 'Update',
    description: (name, tc) => buildWriteDescription('Update a record in', name, tc),
    handle: (sqlApi, tableName, _tc, request) =>
      sqlApi.update(tableName, request.body as SqlApiUpdateParams, request),
  });
}
