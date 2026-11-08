import type { FastifyInstance } from 'fastify';
import { SearchTableBodyPost, SearchTableQuery, SearchTableResponse } from '../../lib/schema/search.js';
import { registerForAllTables } from './route-helpers.js';
import { httpError } from '../../lib/errors.js';
import { DEFAULT_MAX_ITEMS_PER_PAGE, COMPUTE_FNS } from '../../types.js';
import type { SqlApiPluginOptions, ComputeRequest, SearchParams } from '../../types.js';

/** The request keys that may arrive in the body or, for compatibility, in the querystring. */
interface SearchBody extends Pick<SearchParams,
  'filters' | 'conditions' | 'joinMustExist' | 'joinMultiple' | 'joinGroup' | 'joinLeft' | 'select' | 'selectComputed' | 'orderBy' | 'compute'
> {
  paginator?: { page?: number; itemsPerPage?: number };
}

interface SearchQuery {
  orderBy?: string;
  page?: number;
  itemsPerPage?: number;
  computeMin?: string;
  computeMax?: string;
  computeSum?: string;
  computeAvg?: string;
}

/**
 * The body is canonical and the querystring its flat alias: a key present in both would
 * leave the request ambiguous, so it is a 400 at the body key rather than a silent pick.
 */
function pickOne<T>(key: string, fromBody: T | undefined, fromQuery: T | undefined): T | undefined {
  if (fromBody !== undefined && fromQuery !== undefined) {
    throw httpError(400, `'${key}' was sent both in the body and in the querystring`, {
      code: 'conflicting_input',
      path: key,
    });
  }
  return fromBody ?? fromQuery;
}

/** The querystring's one-field `compute*` keys as a compute request, or undefined when none. */
function computeFromQuery(query: SearchQuery): ComputeRequest | undefined {
  const compute: ComputeRequest = {};
  for (const fn of COMPUTE_FNS) {
    const field = query[`compute${fn.charAt(0).toUpperCase()}${fn.slice(1)}` as keyof SearchQuery] as string | undefined;
    if (field) compute[fn] = [field];
  }
  return Object.keys(compute).length > 0 ? compute : undefined;
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
      querystring: SearchTableQuery(maxRows),
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
      const body = request.body as SearchBody;
      const query = request.query as SearchQuery;

      const orderBy = pickOne('orderBy', body.orderBy, query.orderBy);
      const queryPaginator = (query.page !== undefined || query.itemsPerPage !== undefined)
        ? { page: query.page, itemsPerPage: query.itemsPerPage }
        : undefined;
      const partialPaginator = pickOne('paginator', body.paginator, queryPaginator);
      const compute = pickOne('compute', body.compute, computeFromQuery(query));

      // The page size cap is the schemas' `maximum` (a structured 400); `maxRows` is the LIMIT
      // applied when the client does not paginate, and the ceiling of the page-only default.
      const paginator = partialPaginator
        ? { page: partialPaginator.page ?? 1, itemsPerPage: partialPaginator.itemsPerPage ?? Math.min(500, maxRows) }
        : undefined;

      const result = await fastify.sqlApi.search(tableName, {
        filters: body.filters,
        conditions: body.conditions,
        joinMustExist: body.joinMustExist,
        joinMultiple: body.joinMultiple,
        joinGroup: body.joinGroup,
        joinLeft: body.joinLeft,
        select: body.select,
        selectComputed: body.selectComputed,
        orderBy,
        paginator,
        compute,
        maxRows,
      }, request);

      return { table: tableName, ...result };
    },
  });
}
