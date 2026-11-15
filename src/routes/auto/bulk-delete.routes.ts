import type { FastifyInstance } from 'fastify';
import { BulkDeleteTableBody, BulkDeleteTableResponse } from '../../lib/schema/bulk-delete.js';
import { registerForAllTables } from './route-helpers.js';
import { DEFAULT_MAX_BULK_ITEMS } from '../../types.js';
import type { SqlApiPluginOptions } from '../../types.js';
import type { SqlApiBulkDeleteParams } from '../../lib/sql-api.js';

export default async function bulkDeleteRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'bulkDelete',
    singlePkOnly: true,
    method: 'POST',
    url: (tableName) => `/bulk/${tableName}/delete`,
    successStatus: 200,
    schemas: (db, table) => ({
      body: BulkDeleteTableBody(db, table, options.maxBulkItems ?? DEFAULT_MAX_BULK_ITEMS),
      response: BulkDeleteTableResponse(db, table),
    }),
    summary: 'Bulk delete',
    description: (name) => `Delete multiple records from ${name} by primary key`,
    handle: (sqlApi, tableName, _tc, request) =>
      sqlApi.bulkDelete(tableName, request.body as SqlApiBulkDeleteParams, request),
  });
}
