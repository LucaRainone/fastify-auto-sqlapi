import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import { fastifyAutoSqlApi } from 'fastify-auto-sqlapi';
import { dbTables } from './tables.js';

const connectionString = 'postgres://test:test@127.0.0.1:5433/testdb';

const app = Fastify({
  logger: true,
  ajv: { customOptions: { removeAdditional: false } },
});

await app.register(fastifyPostgres, { connectionString });

await app.register(fastifyAutoSqlApi, {
  DbTables: dbTables,
  swagger: true,
  prefix: '/auto',
});

// Health check
app.get('/health', async () => ({ status: 'ok' }));

try {
  await app.listen({ port: 3000 });
  console.log('\n  Swagger UI: http://localhost:3000/auto/documentation');
  console.log('\n  Available routes:');
  console.log('  POST   http://localhost:3000/auto/search/customer');
  console.log('  POST   http://localhost:3000/auto/search/customer_order');
  console.log('  POST   http://localhost:3000/auto/search/product');
  console.log('  POST   http://localhost:3000/auto/rest/customer          (insert)');
  console.log('  PUT    http://localhost:3000/auto/rest/customer          (update)');
  console.log('  GET    http://localhost:3000/auto/rest/customer/:id      (get)');
  console.log('  DELETE http://localhost:3000/auto/rest/customer/:id      (delete)');
  console.log('  PUT    http://localhost:3000/auto/bulk/customer          (bulk upsert)');
  console.log('  POST   http://localhost:3000/auto/bulk/customer/delete  (bulk delete)');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
