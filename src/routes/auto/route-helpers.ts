import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { REGISTRATION_SQL_API, type RegistrationOptions } from '../sql-api-decorator.js';
import { sanitizeRouteError } from '../../lib/errors.js';
import type { SqlApi } from '../../lib/sql-api.js';
import { isCompositePrimary } from '../../types.js';
import type { TableConfig, SqlApiPluginOptions, DbTables, TableOperation } from '../../types.js';

type RequestHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;

function mergeOnRequests(options: SqlApiPluginOptions, tableConf: TableConfig): RequestHook[] {
  return [...(options.onRequests || []), ...(tableConf.onRequests || [])];
}

export function buildWriteDescription(action: string, tableName: string, tableConf: TableConfig): string {
  const joinList = tableConf.writeJoins
    ?.map((j) => j.alias)
    .join(', ');
  return [
    `${action} ${tableName}`,
    joinList && `Child rows (upsert, delete, replace) for: ${joinList}`,
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

/** Requests that reached one of the plugin's route handlers. */
const HANDLER_REACHED = new WeakSet<FastifyRequest>();

/**
 * Whether this request reached a route handler of the plugin. An error raised from then on is
 * the route's to answer, even one raised after the handler returned (the serializer refusing a
 * stored value); one raised before it, by the consumer's `onRequests`, is the consumer's own.
 */
export function routeHandlerReached(request: FastifyRequest): boolean {
  return HANDLER_REACHED.has(request);
}

/**
 * Answer an error a route did not raise itself: replace it with one that carries no database
 * detail (`sanitizeRouteError`, ADR 0013) and log the original under the request's `reqId`.
 * A 4xx comes back unchanged.
 */
export function sanitizeAndLog(
  err: unknown,
  request: FastifyRequest,
  options: Pick<SqlApiPluginOptions, 'exposeDebugInfo' | 'dbErrors'>,
): unknown {
  const safe = sanitizeRouteError(err, {
    requestId: request.id,
    exposeDebugInfo: options.exposeDebugInfo,
    dbErrors: options.dbErrors,
  });
  if (safe !== err) {
    // A code the consumer mapped is an expected outcome, not a server fault: the
    // driver error stays in the log, at a level that does not page anyone.
    if ((safe as { statusCode: number }).statusCode >= 500) request.log.error({ err }, 'sqlapi: unhandled error');
    else request.log.info({ err }, 'sqlapi: database error answered through dbErrors');
  }
  return safe;
}

export interface AutoRouteSpec {
  /** Operation key matched against `TableConfig.operations` to decide whether to register the route. */
  operation: TableOperation;
  /**
   * Set when the route addresses records by a single PK value in its path (get, delete).
   * Tables with a composite primary key skip these routes: matching on the first PK column
   * alone would touch every row sharing that value. Explicitly listing the operation in
   * `TableConfig.operations` for such a table throws at registration.
   */
  singlePkOnly?: boolean;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /**
   * URL builder receiving the `dbTables` key — never `Schema.tableName`: several table
   * configs may expose the same physical table, and each key needs its own route.
   */
  url: (tableName: string) => string;
  successStatus: 200 | 201;
  /** Build per-table schemas (body, params, querystring, response). Response is wrapped with `{ [successStatus]: ... }` automatically. */
  schemas: (dbTables: DbTables, tableName: string, tableConf: TableConfig) => RouteSchema;
  summary: string;
  description: (tableName: string, tableConf: TableConfig, schemas: RouteSchema) => string;
  /** Translates the request to a call on this registration's sqlApi. If it does not call
   * reply.send/status itself, the registrar will reply.status(successStatus).send(returnValue). */
  handle: (
    sqlApi: SqlApi,
    tableName: string,
    tableConf: TableConfig,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<unknown>;
}

/**
 * Iterates over every table in `options.dbTables` and registers one Fastify route for it
 * following `spec`. Centralizes onRequest hook merging, tags, schema response wrapping,
 * default reply when handler returns a value.
 */
/**
 * Whether this table is addressable by the spec's route shape.
 *
 * A single-PK route cannot address a composite-PK table. Skipping is the default, but when
 * the consumer explicitly listed the operation it is a configuration error: failing at
 * startup beats a route that silently never exists.
 */
function isTableRoutable(
  tableName: string,
  tableConf: TableConfig,
  spec: AutoRouteSpec,
  allowed: TableOperation[] | undefined
): boolean {
  // Both whitelists apply, the registration's and the table's; an omitted one allows all.
  if (allowed && !allowed.includes(spec.operation)) return false;
  if (tableConf.operations && !tableConf.operations.includes(spec.operation)) return false;
  if (!spec.singlePkOnly || !isCompositePrimary(tableConf.primary)) return true;

  if (tableConf.operations?.includes(spec.operation)) {
    throw new Error(
      `Table "${tableName}" has a composite primary key (${(tableConf.primary as string[]).join(', ')}): ` +
      `operation "${spec.operation}" addresses records by a single PK value and cannot be exposed. ` +
      `Remove it from "operations": read it with search, write it with update, delete it with bulkDelete.`
    );
  }
  return false;
}

/**
 * Fastify route schema for one table.
 *
 * Only keys that are actually defined are included: Fastify checks for key *presence*
 * (not an undefined value) to decide whether to emit FSTWRN001.
 */
function buildRouteSchema(
  tableName: string,
  tableConf: TableConfig,
  spec: AutoRouteSpec,
  schemas: RouteSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
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

  return schema;
}

export async function registerForAllTables(
  fastify: FastifyInstance,
  options: RegistrationOptions,
  spec: AutoRouteSpec,
): Promise<void> {
  // The routes run through the SqlApi of the registration that declared them, never through
  // whatever `fastify.sqlApi` resolves to in their scope.
  const getSqlApi = options[REGISTRATION_SQL_API];
  const { dbTables } = options;

  for (const [tableName, tableConf] of Object.entries(dbTables)) {
    if (!isTableRoutable(tableName, tableConf, spec, options.operations)) continue;

    const schemas = spec.schemas(dbTables, tableName, tableConf);

    fastify.route({
      method: spec.method,
      url: spec.url(tableName),
      schema: buildRouteSchema(tableName, tableConf, spec, schemas),
      onRequest: mergeOnRequests(options, tableConf),
      handler: async (request, reply) => {
        HANDLER_REACHED.add(request);
        try {
          const result = await spec.handle(getSqlApi(), tableName, tableConf, request, reply);
          if (!reply.sent) reply.status(spec.successStatus).send(result);
        } catch (err) {
          throw sanitizeAndLog(err, request, options);
        }
      },
    });
  }
}
