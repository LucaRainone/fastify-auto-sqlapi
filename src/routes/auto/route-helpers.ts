import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ensureSqlApiDecorator } from '../../lib/sql-api-decorator.js';
import type { ITable, SqlApiPluginOptions, DbTables, TableOperation } from '../../types.js';

type RequestHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;

export function mergeOnRequests(options: SqlApiPluginOptions, tableConf: ITable): RequestHook[] {
  return [...(options.onRequests || []), ...(tableConf.onRequests || [])];
}

export function buildWriteDescription(action: string, tableName: string, tableConf: ITable): string {
  const joinList = tableConf.allowedWriteJoins
    ?.map((j) => j.alias)
    .join(', ');
  return [
    `${action} ${tableName}`,
    joinList && `Available secondaries: ${joinList}`,
  ].filter(Boolean).join('. ');
}

interface RouteSchema {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  querystring?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response?: any;
}

export interface AutoRouteSpec {
  /** Operation key matched against `ITable.operations` to decide whether to register the route. */
  operation: TableOperation;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** URL builder receiving the table configuration to read `Schema.tableName`. */
  url: (tableConf: ITable) => string;
  successStatus: 200 | 201;
  /** Build per-table schemas (body, params, querystring, response). Response is wrapped with `{ [successStatus]: ... }` automatically. */
  schemas: (dbTables: DbTables, tableName: string, tableConf: ITable) => RouteSchema;
  summary: string;
  description: (tableName: string, tableConf: ITable, schemas: RouteSchema) => string;
  /** Translates the request to a sqlApi call. If it does not call reply.send/status itself,
   * the registrar will reply.status(successStatus).send(returnValue). */
  handle: (
    fastify: FastifyInstance,
    tableName: string,
    tableConf: ITable,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<unknown>;
}

/**
 * Iterates over every table in `options.DbTables` and registers one Fastify route for it
 * following `spec`. Centralizes onRequest hook merging, tags, schema response wrapping,
 * default reply when handler returns a value.
 */
export async function registerForAllTables(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
  spec: AutoRouteSpec,
): Promise<void> {
  // Granular composition support: when a route plugin is registered without the
  // main plugin, no ancestor has decorated `sqlApi` — create it in this scope.
  ensureSqlApiDecorator(fastify, options);

  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    // operations acts as a whitelist; when omitted every operation is exposed.
    if (tableConf.operations && !tableConf.operations.includes(spec.operation)) continue;

    const schemas = spec.schemas(DbTables, tableName, tableConf);

    // Only include schema keys that are actually defined: Fastify checks for key
    // *presence* (not undefined value) to decide whether to emit FSTWRN001.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema: Record<string, any> = {
      tags: [`SqlAPI-${tableName}`],
      summary: `${spec.summary} ${tableName}`,
      description: spec.description(tableName, tableConf, schemas),
    };
    if (schemas.body !== undefined) schema.body = schemas.body;
    if (schemas.params !== undefined) schema.params = schemas.params;
    if (schemas.querystring !== undefined) schema.querystring = schemas.querystring;
    if (schemas.response !== undefined) schema.response = { [spec.successStatus]: schemas.response };

    fastify.route({
      method: spec.method,
      url: spec.url(tableConf),
      schema,
      onRequest: mergeOnRequests(options, tableConf),
      handler: async (request, reply) => {
        const result = await spec.handle(fastify, tableName, tableConf, request, reply);
        if (!reply.sent) reply.status(spec.successStatus).send(result);
      },
    });
  }
}
