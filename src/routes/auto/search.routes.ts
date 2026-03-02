import type { FastifyInstance } from 'fastify';
import { getDb } from './route-helpers.js';
import { searchEngine } from '../../lib/engine/search.js';
import { resolveTenant } from '../../lib/tenant.js';
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
        const db = getDb(fastify, options.dialect);
        const tenant = await resolveTenant(options, tableConf, request);

        const body = request.body as Record<string, any>;
        const query = request.query as Record<string, any>;

        const result = await searchEngine(DbTables, {
          db,
          tableConf,
          filters: body.filters,
          joins: body.joins,
          joinGroups: body.joinGroups,
          orderBy: query.orderBy,
          paginator: query.page
            ? {
                page: query.page,
                itemsPerPage: query.itemsPerPage || 500,
              }
            : undefined,
          computeMin: query.computeMin,
          computeMax: query.computeMax,
          computeSum: query.computeSum,
          computeAvg: query.computeAvg,
          tenant,
        });

        reply.send({ table: tableConf.Schema.tableName, ...result });
      },
    });
  }
}
