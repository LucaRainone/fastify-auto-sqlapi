import type { FastifyInstance } from 'fastify';
import { BulkUpsertTableBody, BulkUpsertTableResponse } from '../../lib/schema/bulk-upsert.js';
import { registerForAllTables, buildWriteDescription } from './route-helpers.js';
import type { RegistrationOptions } from '../sql-api-decorator.js';
import { DEFAULT_MAX_BULK_ITEMS } from '../../types.js';
import type { BulkUpsertItem } from '../../types.js';

export default async function bulkUpsertRoutes(
  fastify: FastifyInstance,
  options: RegistrationOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'bulkUpsert',
    method: 'PUT',
    url: (tableName) => `/bulk/${tableName}`,
    successStatus: 200,
    schemas: (db, table) => ({
      body: BulkUpsertTableBody(db, table, options.maxBulkItems ?? DEFAULT_MAX_BULK_ITEMS),
      response: BulkUpsertTableResponse(db, table),
    }),
    summary: 'Bulk upsert',
    description: (name, tc) => buildWriteDescription('Bulk upsert records in', name, tc),
    handle: (sqlApi, tableName, _tc, request) => {
      const items = request.body as BulkUpsertItem[];
      return sqlApi.bulkUpsert(tableName, items, request);
    },
  });
}
