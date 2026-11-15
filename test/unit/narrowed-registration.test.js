import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { fastifyAutoSqlApi, toUnderscore, Type } from '../../dist/index.js';

// A registration narrowed with `operations` (AGENTS_BACKEND.md, "Several surfaces") serves
// the routes it keeps, through its own SqlApi, under its own prefix. It replaces registering
// the route plugins one by one, which are no longer exported.

const schema = {
  col: (f) => toUnderscore(f),
  fields: { id: Type.Number(), name: Type.String() },
  validation: Type.Object({ id: Type.Number(), name: Type.String() }),
  tableName: 'test_table',
  partialValidation: Type.Partial(Type.Object({ id: Type.Number(), name: Type.String() })),
};

const dbTables = {
  test_table: {
    primary: 'id',
    schema,
  },
};

// pg-shaped pool: { rows, rowCount } responses, consumed in order
function createMockPool(responses = []) {
  let callIndex = 0;
  const calls = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      const response = responses[callIndex] || { rows: [], rowCount: 0 };
      callIndex++;
      return Promise.resolve(response);
    },
  };
}

async function buildApp(pool, register) {
  const app = Fastify();
  app.decorate('pg', pool);
  await register(app);
  await app.ready();
  return app;
}

describe('a registration narrowed with operations', () => {
  it('serves search alone', async () => {
    const pool = createMockPool([
      { rows: [{ id: 1, name: 'Mario' }], rowCount: 1 }, // main (no paginator: no COUNT)
    ]);
    const app = await buildApp(pool, (app) =>
      app.register(fastifyAutoSqlApi, { dbTables, operations: ['search'] })
    );

    const res = await app.inject({
      method: 'POST',
      url: '/search/test_table',
      payload: {},
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = res.json();
    assert.equal(body.table, 'test_table');
    assert.equal(body.main.length, 1);
    assert.equal(body.main[0].name, 'Mario');

    await app.close();
  });

  it('serves search and get together', async () => {
    const pool = createMockPool([
      { rows: [], rowCount: 0 },                         // search main (no paginator: no COUNT)
      { rows: [{ id: 7, name: 'Luigi' }], rowCount: 1 }, // get
    ]);
    const app = await buildApp(pool, async (app) => {
      await app.register(fastifyAutoSqlApi, { dbTables, operations: ['search', 'get'] });
    });

    const search = await app.inject({
      method: 'POST',
      url: '/search/test_table',
      payload: {},
    });
    assert.equal(search.statusCode, 200, `search: ${search.body}`);

    const get = await app.inject({ method: 'GET', url: '/rest/test_table/7' });
    assert.equal(get.statusCode, 200, `get: ${get.body}`);
    assert.equal(get.json().main.name, 'Luigi');

    await app.close();
  });

  it('serves its routes under its own prefix', async () => {
    const pool = createMockPool([
      { rows: [], rowCount: 0 },
    ]);
    const app = await buildApp(pool, (app) =>
      app.register(fastifyAutoSqlApi, { dbTables, operations: ['search'], prefix: '/public' })
    );

    const res = await app.inject({
      method: 'POST',
      url: '/public/search/test_table',
      payload: {},
    });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

    await app.close();
  });
});
