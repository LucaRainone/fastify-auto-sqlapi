// maxItemsPerPage below 500 must not break requests without an explicit itemsPerPage.
// The (pre-1.0) querystring schema once declared a fixed `default: 500`: Ajv injected it
// BEFORE the runtime cap check, so any cap below 500 made every default request fail with
// 400 — and any request without `itemsPerPage` was silently paginated. The body's
// `paginator` declares no default at all (the route handler applies min(500, cap) when `page` alone is sent, see
// search-route-no-paginator.test.js) and the cap is the schema `maximum`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { fastifyAutoSqlApi, SearchTableBodyPost, Type, exportTableInfo } =
  await import(path.join(ROOT, 'dist/index.js'));

function testDbTables() {
  const fields = { id: Type.Number(), name: Type.String() };
  const schema = {
    col: (f) => f,
    fields,
    validation: Type.Object(fields),
    tableName: 'test_table',
    partialValidation: Type.Partial(Type.Object(fields)),
  };
  return { test_table: { primary: 'id', ...exportTableInfo(schema), defaultOrder: 'id' } };
}

/** The body schema's `paginator.itemsPerPage`, built with the given cap (or the default). */
const itemsPerPageOf = (...cap) =>
  SearchTableBodyPost(testDbTables(), 'test_table', ...cap).properties.paginator.properties.itemsPerPage;

describe('search body schema — paginator.itemsPerPage', () => {
  it('uses maxItemsPerPage as the schema maximum', () => {
    assert.equal(itemsPerPageOf(100).maximum, 100);
  });

  it('declares no schema default for itemsPerPage (Ajv would inject it on every request)', () => {
    assert.equal(itemsPerPageOf(100).default, undefined);
    assert.equal(itemsPerPageOf(2000).default, undefined);
  });

  it('uses the default cap (1000) when called without one', () => {
    assert.equal(itemsPerPageOf().maximum, 1000);
  });
});

function createTestApp(maxItemsPerPage) {
  const DbTables = testDbTables();

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
      url: '/search/test_table',
      payload: { paginator: { itemsPerPage: 200 } },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it('explicit itemsPerPage within the cap succeeds', async () => {
    const app = await createTestApp(100);
    const res = await app.inject({
      method: 'POST',
      url: '/search/test_table',
      payload: { paginator: { itemsPerPage: 50 } },
    });
    assert.equal(res.statusCode, 200, res.payload);
    await app.close();
  });
});
