import type { FastifyInstance } from 'fastify';
import { QueryClient } from '../../lib/db.js';
import { searchEngine } from '../../lib/search-engine.js';
import { SearchTableBodyPost, SearchTableQueryString, SearchTableResponse } from '../../lib/search-schema.js';
import type { SqlApiPluginOptions, SwaggerOptions } from '../../types.js';

export default async function searchRoutes(
  fastify: FastifyInstance,
  options: SqlApiPluginOptions
): Promise<void> {
  const { DbTables } = options;

  if (options.swagger) {
    if (!fastify.hasDecorator('swagger')) {
      try {
        const swaggerMod = await import('@fastify/swagger');
        const swaggerUiMod = await import('@fastify/swagger-ui');

        const swaggerConf: SwaggerOptions = typeof options.swagger === 'object' ? options.swagger : {};

        await fastify.register(swaggerMod.default, {
          openapi: {
            info: {
              title: swaggerConf.title || 'SqlAPI Documentation',
              description: swaggerConf.description || 'Auto-generated API documentation',
              version: swaggerConf.version || '1.0.0',
            },
          },
        });

        await fastify.register(swaggerUiMod.default, {
          routePrefix: swaggerConf.routePrefix || '/documentation',
          indexPrefix: options.prefix || '',
        });
      } catch {
        fastify.log.warn(
          'swagger: true requires @fastify/swagger and @fastify/swagger-ui. Install them: npm i @fastify/swagger @fastify/swagger-ui'
        );
      }
    }
  }

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
        const db = new QueryClient((fastify as any).pg);

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
        });

        reply.send({ table: tableConf.Schema.tableName, ...result });
      },
    });
  }
}
