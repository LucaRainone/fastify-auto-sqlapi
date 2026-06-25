import type { FastifyInstance } from 'fastify';
import { BulkUpsertTableBody, BulkUpsertTableResponse } from '../../lib/schema/bulk-upsert.js';
import { registerForAllTables, buildWriteDescription } from './route-helpers.js';
import type { SqlApiPluginOptions, BulkUpsertItem } from '../../types.js';

export default async function bulkUpsertRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'bulkUpsert',
    method: 'PUT',
    url: (tc) => `/bulk/${tc.Schema.tableName}`,
    successStatus: 200,
    schemas: (db, table) => ({
      body: BulkUpsertTableBody(db, table),
      response: BulkUpsertTableResponse(db, table),
    }),
    summary: 'Bulk upsert',
    description: (name, tc) => buildWriteDescription('Bulk upsert records in', name, tc),
    handle: (fastify, tableName, _tc, request) => {
      const items = request.body as BulkUpsertItem[];
      return fastify.sqlApi.bulkUpsert(tableName, items, request);
    },
  });
}
