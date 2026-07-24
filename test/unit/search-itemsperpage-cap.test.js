// maxItemsPerPage below 500 must not break requests without an explicit itemsPerPage.
// The querystring schema declared a fixed `default: 500`: Ajv injected it BEFORE the
// runtime cap check, so any cap below 500 made every default request fail with 400.
// The schema is now parameterized: default = min(500, cap), maximum = cap.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { fastifyAutoSqlApi, SearchTableQuery, SearchTableQueryString, Type, exportTableInfo } =
  await import(path.join(ROOT, 'dist/index.js'));

describe('SearchTableQuery schema builder', () => {
  it('caps the default when maxItemsPerPage is below 500', () => {
    const q = SearchTableQuery(100).properties.itemsPerPage;
    assert.equal(q.default, 100);
    assert.equal(q.maximum, 100);
  });

  it('keeps default 500 when the cap is higher', () => {
    const q = SearchTableQuery(2000).properties.itemsPerPage;
    assert.equal(q.default, 500);
    assert.equal(q.maximum, 2000);
  });

  it('backward-compatible const uses the default cap (1000)', () => {
    const q = SearchTableQueryString.properties.itemsPerPage;
    assert.equal(q.default, 500);
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
