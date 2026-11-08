import type { FastifyInstance } from 'fastify';
import { SearchTableBodyPost, SearchTableQuery, SearchTableResponse } from '../../lib/schema/search.js';
import { registerForAllTables } from './route-helpers.js';
import { DEFAULT_MAX_ITEMS_PER_PAGE } from '../../types.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function searchRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'search',
    method: 'POST',
    url: (tableName) => `/search/${tableName}`,
    successStatus: 200,
    schemas: (db, table) => ({
      body: SearchTableBodyPost(db, table),
      querystring: SearchTableQuery(options.maxItemsPerPage ?? DEFAULT_MAX_ITEMS_PER_PAGE),
      response: SearchTableResponse(db, table),
    }),
    summary: 'Search',
    description: (name, _tc, schemas) => {
       
      const body = schemas.body;
      const multiAliases = Object.keys(body?.properties?.joinMultiple?.properties || {});
      const leftAliases = Object.keys(body?.properties?.joinLeft?.properties || {});
      return [
        `Search records in ${name}`,
        multiAliases.length && `Available joinMultiple/joinMustExist/joinGroup aliases: ${multiAliases.join(', ')}`,
        leftAliases.length && `Available joinLeft aliases: ${leftAliases.join(', ')}`,
      ].filter(Boolean).join('. ');
    },
    handle: async (fastify, tableName, _tc, request) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = request.body as Record<string, any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const query = request.query as Record<string, any>;

      // DoS guard: the page size cap is the querystring schema's `maximum` (a structured
      // 400); here it is the LIMIT applied when the client does not paginate.
      const maxRows = options.maxItemsPerPage ?? DEFAULT_MAX_ITEMS_PER_PAGE;

      const result = await fastify.sqlApi.search(tableName, {
        filters: body.filters,
        conditions: body.conditions,
        joinMustExist: body.joinMustExist,
        joinMultiple: body.joinMultiple,
        joinGroup: body.joinGroup,
        joinLeft: body.joinLeft,
        select: body.select,
        selectComputed: body.selectComputed,
        orderBy: query.orderBy,
        paginator: (query.page || query.itemsPerPage)
          ? { page: query.page || 1, itemsPerPage: query.itemsPerPage || Math.min(500, maxRows) }
          : undefined,
        computeMin: query.computeMin,
        computeMax: query.computeMax,
        computeSum: query.computeSum,
        computeAvg: query.computeAvg,
        maxRows,
      }, request);

      return { table: tableName, ...result };
    },
  });
}
