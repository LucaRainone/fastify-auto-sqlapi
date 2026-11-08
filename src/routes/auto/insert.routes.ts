import type { FastifyInstance } from 'fastify';
import { InsertTableBody, InsertTableResponse } from '../../lib/schema/insert.js';
import { registerForAllTables, buildWriteDescription } from './route-helpers.js';
import type { SqlApiPluginOptions, RowsByAlias } from '../../types.js';

export default async function insertRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'insert',
    method: 'POST',
    url: (tableName) => `/rest/${tableName}`,
    successStatus: 201,
    schemas: (db, table) => ({
      body: InsertTableBody(db, table),
      response: InsertTableResponse(db, table),
    }),
    summary: 'Insert',
    description: (name, tc) => buildWriteDescription('Insert a record into', name, tc),
    handle: (fastify, tableName, _tc, request) => {
      const body = request.body as {
        main: Record<string, unknown>;
        secondaries?: RowsByAlias;
      };
      return fastify.sqlApi.insert(tableName, {
        record: body.main,
        secondaries: body.secondaries,
      }, request);
    },
  });
}
