import type { FastifyInstance } from 'fastify';
import { UpdateTableBody, UpdateTableResponse } from '../../lib/schema/update.js';
import { registerForAllTables, buildWriteDescription } from './route-helpers.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function updateRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'update',
    method: 'PUT',
    url: (tc) => `/rest/${tc.Schema.tableName}`,
    successStatus: 200,
    schemas: (db, table) => ({
      body: UpdateTableBody(db, table),
      response: UpdateTableResponse(db, table),
    }),
    summary: 'Update',
    description: (name, tc) => buildWriteDescription('Update a record in', name, tc),
    handle: (fastify, tableName, _tc, request) => {
      const body = request.body as {
        main: Record<string, unknown>;
        secondaries?: Record<string, Record<string, unknown>[]>;
        deletions?: Record<string, Record<string, unknown>[]>;
      };
      return fastify.sqlApi.update(tableName, {
        record: body.main,
        secondaries: body.secondaries,
        deletions: body.deletions,
      }, request);
    },
  });
}
