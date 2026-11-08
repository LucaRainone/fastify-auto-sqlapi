// maxItemsPerPage below 500 must not break requests without an explicit itemsPerPage.
// The querystring schema once declared a fixed `default: 500`: Ajv injected it BEFORE the
// runtime cap check, so any cap below 500 made every default request fail with 400 — and
// any request without `itemsPerPage` was silently paginated. The schema now declares no
// default at all (the route handler applies min(500, cap) when `page` alone is sent, see
// search-route-no-paginator.test.js) and the cap is the schema `maximum`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { fastifyAutoSqlApi, SearchTableQuery, Type, exportTableInfo } =
  await import(path.join(ROOT, 'dist/index.js'));

describe('SearchTableQuery schema builder', () => {
  it('uses maxItemsPerPage as the schema maximum', () => {
    const q = SearchTableQuery(100).properties.itemsPerPage;
    assert.equal(q.maximum, 100);
  });

  it('declares no schema default for itemsPerPage (Ajv would inject it on every request)', () => {
    assert.equal(SearchTableQuery(100).properties.itemsPerPage.default, undefined);
    assert.equal(SearchTableQuery(2000).properties.itemsPerPage.default, undefined);
  });

  it('uses the default cap (1000) when called without one', () => {
    const q = SearchTableQuery().properties.itemsPerPage;
    assert.equal(q.maximum, 1000);
  });
});

function createTestApp(maxItemsPerPage) {
  const fields = { id: Type.Number(), name: Type.String() };
  const schema = {
    col: (f) => f,
    fields,
    validation: Type.Object(fields),
    tableName: 'test_table',
    partialValidation: Type.Partial(Type.Object(fields)),
  };
  const DbTables = {
    test_table: {
      primary: 'id',
      ...exportTableInfo(schema),
      defaultOrder: 'id',
    },
  };

  const app = Fastify();
  // Minimal pg stand-in: empty result set, count 0 for the paginator query.
  app.decorate('pg', {
    query: async (text) => /count/i.test(text)
      ? { rows: [{ total: 0 }], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  });
  return app.register(fastifyAutoSqlApi, { DbTables, maxItemsPerPage }).then(() => app);
}

describe('maxItemsPerPage below 500 — route behavior', () => {
  it('request WITHOUT itemsPerPage succeeds (default is capped, not 500)', async () => {
    const app = await createTestApp(100);
    const res = await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });
    assert.equal(res.statusCode, 200, res.payload);
    await app.close();
  });

  it('explicit itemsPerPage over the cap is rejected with 400', async () => {
    const app = await createTestApp(100);
    const res = await app.inject({
      method: 'POST',
      url: '/search/test_table?itemsPerPage=200',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it('explicit itemsPerPage within the cap succeeds', async () => {
    const app = await createTestApp(100);
    const res = await app.inject({
      method: 'POST',
      url: '/search/test_table?itemsPerPage=50',
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.payload);
    await app.close();
  });
});
