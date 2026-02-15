import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import { setupSwagger, searchRoutes, insertRoutes } from 'fastify-auto-sqlapi';
import { dbTables } from './tables.js';

const connectionString = 'postgres://test:test@127.0.0.1:5433/testdb';

const app = Fastify({ logger: true });

await app.register(fastifyPostgres, { connectionString });

await app.register(async (instance) => {
  await setupSwagger(instance, { swagger: true });
  await instance.register(searchRoutes, { DbTables: dbTables });
  await instance.register(insertRoutes, { DbTables: dbTables });
}, { prefix: '/auto' });

// Health check
app.get('/health', async () => ({ status: 'ok' }));

try {
  await app.listen({ port: 3000 });
  console.log('\n  Swagger UI: http://localhost:3000/auto/documentation');
  console.log('\n  Available routes:');
  console.log('  POST http://localhost:3000/auto/customer/search');
  console.log('  POST http://localhost:3000/auto/customer_order/search');
  console.log('  POST http://localhost:3000/auto/product/search');
  console.log('  POST http://localhost:3000/auto/customer          (insert)');
  console.log('  POST http://localhost:3000/auto/customer_order    (insert)');
  console.log('  POST http://localhost:3000/auto/product           (insert)');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
