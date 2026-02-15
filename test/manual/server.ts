import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import { searchRoutes } from 'fastify-auto-sqlapi';
import { dbTables } from './tables.js';

const connectionString = 'postgres://test:test@127.0.0.1:5433/testdb';

const app = Fastify({ logger: true });

await app.register(fastifyPostgres, { connectionString });
await app.register(searchRoutes, { DbTables: dbTables, prefix: '/auto', swagger: true });

// Health check
app.get('/health', async () => ({ status: 'ok' }));

try {
  await app.listen({ port: 3000 });
  console.log('\n  Swagger UI: http://localhost:3000/auto/documentation');
  console.log('\n  Available routes:');
  console.log('  POST http://localhost:3000/auto/search/customer');
  console.log('  POST http://localhost:3000/auto/search/customer_order');
  console.log('  POST http://localhost:3000/auto/search/product');
  console.log('\n  Example:');
  console.log('  curl -X POST http://localhost:3000/auto/search/customer -H "Content-Type: application/json" -d \'{}\'');
  console.log('  curl -X POST http://localhost:3000/auto/search/customer -H "Content-Type: application/json" -d \'{"filters":{"isActive":true}}\'');
  console.log('  curl -X POST "http://localhost:3000/auto/search/customer?page=1&itemsPerPage=2" -H "Content-Type: application/json" -d \'{}\'');
  console.log('  curl -X POST http://localhost:3000/auto/search/customer -H "Content-Type: application/json" -d \'{"filters":{"q":"mario"}}\'');
  console.log('  curl -X POST http://localhost:3000/auto/search/customer -H "Content-Type: application/json" -d \'{"joins":{"customer_order":{}}}\'');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
