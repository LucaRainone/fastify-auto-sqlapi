import type { FastifyInstance } from 'fastify';
import type { SqlApiPluginOptions, SwaggerOptions } from '../types.js';

export async function setupSwagger(
  fastify: FastifyInstance,
  options: Pick<SqlApiPluginOptions, 'swagger'>
): Promise<void> {
  if (!options.swagger) return;
  if (fastify.hasDecorator('swagger')) return;

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
      indexPrefix: fastify.prefix,
    });
  } catch {
    fastify.log.warn(
      'swagger: true requires @fastify/swagger and @fastify/swagger-ui. Install them: npm i @fastify/swagger @fastify/swagger-ui'
    );
  }
}
