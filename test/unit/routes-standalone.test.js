import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { searchRoutes, getRoutes, exportTableInfo, toUnderscore, Type } from '../../dist/index.js';

// Granular composition: route plugins registered WITHOUT the main plugin
// (AGENTS_BACKEND.md "Register only specific routes") must create the sqlApi
// decorator on their own instead of exploding with 500 at request time.

const schema = {
  col: (f) => toUnderscore(f),
  fields: { id: Type.Number(), name: Type.String() },
  validation: Type.Object({ id: Type.Number(), name: Type.String() }),
  tableName: 'test_table',
  partialValidation: Type.Partial(Type.Object({ id: Type.Number(), name: Type.String() })),
};

const DbTables = {
  test_table: {
    primary: 'id',
    ...exportTableInfo(schema),
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

describe('granular route plugins registered standalone', () => {
  it('searchRoutes works without the main plugin', async () => {
    const pool = createMockPool([
      { rows: [{ id: 1, name: 'Mario' }], rowCount: 1 }, // main
      { rows: [{ total: '1' }], rowCount: 1 },           // pagination COUNT
    ]);
    const app = await buildApp(pool, (app) =>
      app.register(searchRoutes, { DbTables })
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

  it('searchRoutes + getRoutes work as siblings in the same scope', async () => {
    const pool = createMockPool([
      { rows: [], rowCount: 0 },                         // search main
      { rows: [{ total: '0' }], rowCount: 1 },           // search COUNT
      { rows: [{ id: 7, name: 'Luigi' }], rowCount: 1 }, // get
    ]);
    const app = await buildApp(pool, async (app) => {
      await app.register(searchRoutes, { DbTables });
      await app.register(getRoutes, { DbTables });
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

  it('granular routes respect a prefix on the enclosing scope', async () => {
    const pool = createMockPool([
      { rows: [], rowCount: 0 },
      { rows: [{ total: '0' }], rowCount: 1 },
    ]);
    const app = await buildApp(pool, (app) =>
      app.register(async (instance) => {
        await instance.register(searchRoutes, { DbTables });
      }, { prefix: '/public' })
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
