import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { fastifyAutoSqlApi, Type } from '../../dist/index.js';

function createMockTable(operations) {
  const fields = { id: Type.Number(), name: Type.String() };
  return {
    primary: 'id',
    Schema: {
      col: (f) => f,
      fields,
      validation: Type.Object(fields),
      tableName: 'test_table',
      partialValidation: Type.Partial(Type.Object(fields)),
    },
    filters: () => ({ build: () => ({ where: '1=1', values: [] }) }),
    extraFilters: {},
    ...(operations ? { operations } : {}),
  };
}

const ROUTES = {
  search: { method: 'POST', url: '/search/test_table' },
  get: { method: 'GET', url: '/rest/test_table/:id' },
  insert: { method: 'POST', url: '/rest/test_table' },
  update: { method: 'PUT', url: '/rest/test_table' },
  delete: { method: 'DELETE', url: '/rest/test_table/:id' },
  bulkUpsert: { method: 'PUT', url: '/bulk/test_table' },
  bulkDelete: { method: 'POST', url: '/bulk/test_table/delete' },
};

describe('ITable.operations - route registration whitelist', () => {
  it('registers only the listed operations', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, {
      DbTables: { test_table: createMockTable(['search', 'get']) },
    });
    await app.ready();

    assert.equal(app.hasRoute(ROUTES.search), true, 'search must be registered');
    assert.equal(app.hasRoute(ROUTES.get), true, 'get must be registered');
    assert.equal(app.hasRoute(ROUTES.insert), false, 'insert must NOT be registered');
    assert.equal(app.hasRoute(ROUTES.update), false, 'update must NOT be registered');
    assert.equal(app.hasRoute(ROUTES.delete), false, 'delete must NOT be registered');
    assert.equal(app.hasRoute(ROUTES.bulkUpsert), false, 'bulkUpsert must NOT be registered');
    assert.equal(app.hasRoute(ROUTES.bulkDelete), false, 'bulkDelete must NOT be registered');

    await app.close();
  });

  it('registers everything when operations is omitted (current default)', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, {
      DbTables: { test_table: createMockTable(undefined) },
    });
    await app.ready();

    for (const [name, route] of Object.entries(ROUTES)) {
      assert.equal(app.hasRoute(route), true, `${name} must be registered by default`);
    }

    await app.close();
  });

  it('write-only table: registers writes but not reads', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, {
      DbTables: { test_table: createMockTable(['insert', 'update', 'delete']) },
    });
    await app.ready();

    assert.equal(app.hasRoute(ROUTES.insert), true);
    assert.equal(app.hasRoute(ROUTES.update), true);
    assert.equal(app.hasRoute(ROUTES.delete), true);
    assert.equal(app.hasRoute(ROUTES.search), false);
    assert.equal(app.hasRoute(ROUTES.get), false);
    assert.equal(app.hasRoute(ROUTES.bulkUpsert), false);

    await app.close();
  });

  it('an unregistered operation answers 404 via HTTP', async () => {
    const app = Fastify();
    await app.register(fastifyAutoSqlApi, {
      DbTables: { test_table: createMockTable(['search']) },
    });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/rest/test_table', payload: { name: 'x' } });
    assert.equal(res.statusCode, 404);

    await app.close();
  });
});
