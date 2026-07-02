import type { FastifyInstance } from 'fastify';
import { BulkDeleteTableBody, BulkDeleteTableResponse } from '../../lib/schema/bulk-delete.js';
import { primaryAsString } from '../../types.js';
import { registerForAllTables } from './route-helpers.js';
import { DEFAULT_MAX_BULK_ITEMS } from '../../types.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function bulkDeleteRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'bulkDelete',
    method: 'POST',
    url: (tc) => `/bulk/${tc.Schema.tableName}/delete`,
    successStatus: 200,
    schemas: (db, table) => ({
      body: BulkDeleteTableBody(db, table, options.maxBulkItems ?? DEFAULT_MAX_BULK_ITEMS),
      response: BulkDeleteTableResponse(db, table),
    }),
    summary: 'Bulk delete',
    description: (name) => `Delete multiple records from ${name} by primary key`,
    handle: (fastify, tableName, tc, request) => {
      const items = request.body as Record<string, unknown>[];
      const ids = items.map((item) => item[primaryAsString(tc.primary)] as string | number);
      return fastify.sqlApi.bulkDelete(tableName, ids, request);
    },
  });
}
