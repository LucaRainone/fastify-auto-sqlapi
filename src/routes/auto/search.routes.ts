import type { FastifyInstance } from 'fastify';
import { SearchTableBodyPost, SearchTableQueryString, SearchTableResponse } from '../../lib/schema/search.js';
import { registerForAllTables } from './route-helpers.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function searchRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  await registerForAllTables(fastify, options, {
    operation: 'search',
    method: 'POST',
    url: (tc) => `/search/${tc.Schema.tableName}`,
    successStatus: 200,
    schemas: (db, table) => ({
      body: SearchTableBodyPost(db, table),
      querystring: SearchTableQueryString,
      response: SearchTableResponse(db, table),
    }),
    summary: 'Search',
    description: (name, _tc, schemas) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = schemas.body as any;
      const multiAliases = Object.keys(body?.properties?.joinMultiple?.properties || {});
      const leftAliases = Object.keys(body?.properties?.joinLeft?.properties || {});
      return [
        `Search records in ${name}`,
        multiAliases.length && `Available joinMultiple/joinMustExist/joinGroup aliases: ${multiAliases.join(', ')}`,
        leftAliases.length && `Available joinLeft aliases: ${leftAliases.join(', ')}`,
      ].filter(Boolean).join('. ');
    },
    handle: async (fastify, tableName, tc, request) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = request.body as Record<string, any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const query = request.query as Record<string, any>;

      const result = await fastify.sqlApi.search(tableName, {
        filters: body.filters,
        conditions: body.conditions,
        joinMustExist: body.joinMustExist,
        joinMultiple: body.joinMultiple,
        joinGroup: body.joinGroup,
        joinLeft: body.joinLeft,
        selectComputed: body.selectComputed,
        orderBy: query.orderBy,
        paginator: (query.page || query.itemsPerPage)
          ? { page: query.page || 1, itemsPerPage: query.itemsPerPage || 500 }
          : undefined,
        computeMin: query.computeMin,
        computeMax: query.computeMax,
        computeSum: query.computeSum,
        computeAvg: query.computeAvg,
      }, request);

      return { table: tc.Schema.tableName, ...result };
    },
  });
}
