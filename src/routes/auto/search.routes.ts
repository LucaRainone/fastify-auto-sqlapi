import type { FastifyInstance } from 'fastify';
import { SearchTableBodyPost, SearchTableResponse } from '../../lib/schema/search.js';
import { registerForAllTables } from './route-helpers.js';
import { rejectRetiredKey, rejectRetiredSearchKeys } from '../../lib/engine/search/fields.js';
import { DEFAULT_MAX_ITEMS_PER_PAGE } from '../../types.js';
import type { SqlApiPluginOptions, SearchParams } from '../../types.js';

/** The search request: every key travels in the body. */
interface SearchBody extends Pick<SearchParams,
  'filters' | 'conditions' | 'joinMustExist' | 'joinMultiple' | 'joinGroup' | 'joinLeft' | 'select' | 'orderBy' | 'compute'
> {
  paginator?: { page?: number; itemsPerPage?: number };
}

/**
 * The querystring keys the search read before 1.0. They moved into the body; a client still
 * sending one gets a 400 naming it instead of a result that silently ignores its ordering,
 * paging or aggregates. Any other querystring key is left alone, as on every route.
 */
const RETIRED_QUERY_KEYS: Record<string, string> = {
  orderBy: `send 'orderBy' in the body`,
  page: `send 'paginator': { page, itemsPerPage } in the body`,
  itemsPerPage: `send 'paginator': { page, itemsPerPage } in the body`,
  computeMin: `send 'compute': { min: [field] } in the body`,
  computeMax: `send 'compute': { max: [field] } in the body`,
  computeSum: `send 'compute': { sum: [field] } in the body`,
  computeAvg: `send 'compute': { avg: [field] } in the body`,
};

function rejectRetiredQuery(query: object): void {
  for (const [key, instead] of Object.entries(RETIRED_QUERY_KEYS)) rejectRetiredKey(query, key, key, instead);
}

export default async function searchRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions,
): Promise<void> {
  const maxRows = options.maxItemsPerPage ?? DEFAULT_MAX_ITEMS_PER_PAGE;

  await registerForAllTables(fastify, options, {
    operation: 'search',
    method: 'POST',
    url: (tableName) => `/search/${tableName}`,
    successStatus: 200,
    schemas: (db, table) => ({
      body: SearchTableBodyPost(db, table, maxRows),
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
    handle: async (sqlApi, tableName, _tc, request) => {
      rejectRetiredQuery(request.query as object);
      const body = request.body as SearchBody;
      rejectRetiredSearchKeys(body);

      // The page size cap is the schemas' `maximum` (a structured 400); `maxRows` is the LIMIT
      // applied when the client does not paginate, and the ceiling of the page-only default.
      const paginator = body.paginator
        ? { page: body.paginator.page ?? 1, itemsPerPage: body.paginator.itemsPerPage ?? Math.min(500, maxRows) }
        : undefined;

      const result = await sqlApi.search(tableName, {
        filters: body.filters,
        conditions: body.conditions,
        joinMustExist: body.joinMustExist,
        joinMultiple: body.joinMultiple,
        joinGroup: body.joinGroup,
        joinLeft: body.joinLeft,
        select: body.select,
        orderBy: body.orderBy,
        paginator,
        compute: body.compute,
        maxRows,
      }, request);

      return { table: tableName, ...result };
    },
  });
}
