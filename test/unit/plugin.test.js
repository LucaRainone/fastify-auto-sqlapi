import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { fastifyAutoSqlApi, Type } from '../../dist/index.js';

// Minimal table config for testing route registration
const mockSchema = {
  col: (f) => f,
  fields: { id: Type.Number() },
  validation: Type.Object({ id: Type.Number() }),
  tableName: 'test_table',
  partialValidation: Type.Partial(Type.Object({ id: Type.Number() })),
};

const mockTable = {
  primary: 'id',
  Schema: mockSchema,
  filters: () => ({ build: () => ({ where: '1=1', values: [] }) }),
  extraFilters: {},
};

const DbTables = { test_table: mockTable };

describe('fastifyAutoSqlApi plugin', () => {
  it('should be a function', () => {
    assert.equal(typeof fastifyAutoSqlApi, 'function');
  });

  it('should register all routes', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, { DbTables });
    await app.ready();

    const routes = app.printRoutes({ commonPrefix: false });

    // search
    assert.ok(routes.includes('/search/test_table'), 'should have search route');
    // get/delete (nested under /rest/test_table)
    assert.ok(routes.includes('/:id'), 'should have get/delete route');
    // insert/update (POST, PUT /rest/test_table)
    assert.ok(routes.includes('/rest/test_table'), 'should have rest routes');
    // bulk
    assert.ok(routes.includes('/bulk/test_table'), 'should have bulk routes');
    assert.ok(routes.includes('/delete'), 'should have bulk delete route');

    await app.close();
  });

  it('should work with prefix option', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, { DbTables, prefix: '/api' });
    await app.ready();

    const routes = app.printRoutes({ commonPrefix: false });
    assert.ok(routes.includes('/api/search/test_table'), 'should have prefixed search route');
    assert.ok(routes.includes('/api/rest/test_table'), 'should have prefixed rest route');

    await app.close();
  });

  it('should skip swagger when not requested', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, { DbTables });
    await app.ready();

    assert.equal(app.hasDecorator('swagger'), false);

    await app.close();
  });
});

// setupSwagger swallows a failed import and only logs a warning, so these assert on the
// served documentation: a broken @fastify/swagger(-ui) must fail here, not pass silently.
describe('fastifyAutoSqlApi swagger documentation', () => {
  it('swagger: true serves the OpenAPI spec of the table routes and the UI at /documentation', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, { DbTables, swagger: true });
    await app.ready();

    const spec = await app.inject('/documentation/json');
    assert.equal(spec.statusCode, 200);
    assert.ok(spec.json().openapi, 'should serve an OpenAPI document');
    assert.ok(spec.json().paths['/search/test_table'], 'spec should list the search route');

    const ui = await app.inject('/documentation/');
    assert.equal(ui.statusCode, 200);
    assert.match(ui.headers['content-type'], /text\/html/);

    await app.close();
  });

  it('swagger options set the spec title and the UI route prefix', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, {
      DbTables,
      swagger: { title: 'Orders API', version: '2.0.0', routePrefix: '/docs' },
    });
    await app.ready();

    const spec = await app.inject('/docs/json');
    assert.equal(spec.statusCode, 200);
    assert.equal(spec.json().info.title, 'Orders API');
    assert.equal(spec.json().info.version, '2.0.0');
    assert.equal((await app.inject('/documentation/json')).statusCode, 404);

    await app.close();
  });

  it('swagger documentation is served under the plugin prefix', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, { DbTables, prefix: '/api', swagger: true });
    await app.ready();

    const spec = await app.inject('/api/documentation/json');
    assert.equal(spec.statusCode, 200);
    assert.ok(spec.json().paths['/api/search/test_table'], 'spec should list the prefixed search route');
    assert.equal((await app.inject('/api/documentation/')).statusCode, 200);

    await app.close();
  });
});
