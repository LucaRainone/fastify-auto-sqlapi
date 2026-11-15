import type { FastifyInstance } from 'fastify';
import { InsertTableBody, InsertTableResponse } from '../../lib/schema/insert.js';
import { registerForAllTables, buildWriteDescription } from './route-helpers.js';
import type { RegistrationOptions } from '../sql-api-decorator.js';
import type { SqlApiInsertParams } from '../../lib/sql-api.js';

export default async function insertRoutes(
  fastify: FastifyInstance,
  options: RegistrationOptions,
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
    handle: (sqlApi, tableName, _tc, request) =>
      sqlApi.insert(tableName, request.body as SqlApiInsertParams, request),
  });
}
