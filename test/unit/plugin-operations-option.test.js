// A registration of the plugin can narrow what it exposes with `operations`, intersected with
// each table's own: a read-only surface is a second registration, not a hand-assembled set of
// route plugins. The route plugins, `setupSwagger`, the engines and the schema builders are
// internals, no longer exported: the plugin is the one way to mount the routes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const lib = await import(path.join(ROOT, 'dist/index.js'));
const { fastifyAutoSqlApi, defineTable, Type } = lib;

const fields = { id: Type.Number(), name: Type.String() };
const table = (extra = {}) => defineTable({ primary: 'id', schema: createMockSchema('item', fields), ...extra });

const routes = (prefix = '') => ({
  search: { method: 'POST', url: `${prefix}/search/item` },
  get: { method: 'GET', url: `${prefix}/rest/item/:id` },
  insert: { method: 'POST', url: `${prefix}/rest/item` },
  update: { method: 'PUT', url: `${prefix}/rest/item` },
  delete: { method: 'DELETE', url: `${prefix}/rest/item/:id` },
  bulkUpsert: { method: 'PUT', url: `${prefix}/bulk/item` },
  bulkDelete: { method: 'POST', url: `${prefix}/bulk/item/delete` },
});

async function registered(options, prefix) {
  const app = Fastify();
  app.decorate('pg', { query: async () => ({ rows: [], rowCount: 0 }) });
  await app.register(fastifyAutoSqlApi, options);
  await app.ready();
  const out = Object.entries(routes(prefix)).filter(([, r]) => app.hasRoute(r)).map(([op]) => op);
  await app.close();
  return out;
}

describe('plugin operations', () => {
  it('registers only the listed operations', async () => {
    assert.deepEqual(await registered({ dbTables: { item: table() }, operations: ['search', 'get'] }), ['search', 'get']);
  });

  it('is intersected with the table operations', async () => {
    const dbTables = { item: table({ operations: ['search', 'insert'] }) };
    assert.deepEqual(await registered({ dbTables, operations: ['search', 'get'] }), ['search']);
  });

  it('omitted, every table operation is registered', async () => {
    assert.equal((await registered({ dbTables: { item: table() } })).length, 7);
  });

  it('a composite-PK table under operations naming get is skipped for get, not refused', async () => {
    const schema = createMockSchema('link', { a: Type.Number(), b: Type.Number() });
    const app = Fastify();
    app.decorate('pg', { query: async () => ({ rows: [], rowCount: 0 }) });
    await app.register(fastifyAutoSqlApi, {
      dbTables: { link: defineTable({ primary: ['a', 'b'], schema }) },
      operations: ['search', 'get'],
    });
    await app.ready();
    assert.equal(app.hasRoute({ method: 'POST', url: '/search/link' }), true);
    assert.equal(app.hasRoute({ method: 'GET', url: '/rest/link/:id' }), false);
    await app.close();
  });

  it('a read-only surface beside a full one: a second registration', async () => {
    const app = Fastify();
    app.decorate('pg', { query: async () => ({ rows: [], rowCount: 0 }) });
    const dbTables = { item: table() };
    await app.register(fastifyAutoSqlApi, { dbTables, prefix: '/admin' });
    await app.register(fastifyAutoSqlApi, { dbTables, prefix: '/public', decorate: false, operations: ['search'] });
    await app.ready();
    assert.equal(app.hasRoute(routes('/admin').insert), true);
    assert.equal(app.hasRoute(routes('/public').search), true);
    assert.equal(app.hasRoute(routes('/public').insert), false);
    await app.close();
  });

  it('the agent manifest of a registration reports its intersected operations', async () => {
    const app = Fastify();
    app.decorate('pg', { query: async () => ({ rows: [], rowCount: 0 }) });
    await app.register(fastifyAutoSqlApi, {
      dbTables: { item: table({ operations: ['search', 'get', 'insert'] }) },
      operations: ['search', 'get', 'update'],
      agentManifest: true,
    });
    const res = await app.inject({ method: 'GET', url: '/agent/manifest' });
    assert.deepEqual(res.json().tables.item.operations, ['search', 'get']);
    await app.close();
  });

  it('agentToolSchemas takes the same operations, so a narrowed surface offers no write tool', () => {
    const dbTables = { item: table() };
    assert.deepEqual(Object.keys(lib.agentToolSchemas(dbTables, 'item', { operations: ['search', 'get'] })), ['search']);
    assert.ok('insert' in lib.agentToolSchemas(dbTables, 'item'));
  });

  for (const [label, operations, pattern] of [
    ['not an array', 'search', /operations.*array/s],
    ['an unknown operation', ['search', 'list'], /operations.*'list'/s],
  ]) {
    it(`${label} fails at register`, async () => {
      const app = Fastify();
      app.decorate('pg', { query: async () => ({ rows: [], rowCount: 0 }) });
      await assert.rejects(async () => {
        await app.register(fastifyAutoSqlApi, { dbTables: { item: table() }, operations });
        await app.ready();
      }, pattern);
    });
  }
});

describe('the plugin is the one way to mount the routes', () => {
  const internals = [
    'searchRoutes', 'getRoutes', 'insertRoutes', 'updateRoutes', 'deleteRoutes', 'bulkUpsertRoutes',
    'bulkDeleteRoutes', 'agentManifestRoutes', 'setupSwagger',
    'searchEngine', 'getEngine', 'insertEngine', 'updateEngine', 'deleteEngine', 'bulkUpsertEngine',
    'bulkDeleteEngine',
    'SearchTableBodyPost', 'SearchTableResponse', 'InsertTableBody', 'InsertTableResponse',
    'UpdateTableBody', 'UpdateTableResponse', 'BulkUpsertTableBody', 'BulkUpsertTableResponse',
    'BulkDeleteTableBody', 'BulkDeleteTableResponse',
  ];
  it('route plugins, setupSwagger, engines and schema builders are not exported', () => {
    assert.deepEqual(internals.filter((name) => name in lib), []);
  });
});
