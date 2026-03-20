import type { FastifyInstance } from 'fastify';
import { SearchTableBodyPost, SearchTableQueryString, SearchTableResponse } from '../../lib/schema/search.js';
import type { SqlApiPluginOptions } from '../../types.js';

export default async function searchRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  for (const [tableName, tableConf] of Object.entries(DbTables)) {
    const bodySchema = SearchTableBodyPost(DbTables, tableName);
    const responseSchema = SearchTableResponse(DbTables, tableName);

    const joinList = Object.keys(bodySchema.properties.joins?.properties || {}).join(', ');
    const description = [
      `Search records in ${tableName}`,
      joinList && `Available joins: ${joinList}`,
    ].filter(Boolean).join('. ');

    fastify.route({
      method: 'POST',
      url: `/search/${tableConf.Schema.tableName}`,
      schema: {
        body: bodySchema,
        querystring: SearchTableQueryString,
        response: { 200: responseSchema },
        tags: [`SqlAPI-${tableName}`],
        summary: `Search ${tableName}`,
        description,
      },
      onRequest: [...(options.onRequests || []), ...(tableConf.onRequests || [])],
      handler: async (request, reply) => {
        const body = request.body as Record<string, any>;
        const query = request.query as Record<string, any>;

        const result = await fastify.sqlApi.search(tableName, {
          filters: body.filters,
          joinFilters: body.joinFilters,
          joins: body.joins,
          joinGroups: body.joinGroups,
          orderBy: query.orderBy,
          paginator: (query.page || query.itemsPerPage)
            ? {
                page: query.page || 1,
                itemsPerPage: query.itemsPerPage || 500,
              }
            : undefined,
          computeMin: query.computeMin,
          computeMax: query.computeMax,
          computeSum: query.computeSum,
          computeAvg: query.computeAvg,
        }, request);

        reply.send({ table: tableConf.Schema.tableName, ...result });
      },
    });
  }
}
