// A search request that sends neither `page` nor `itemsPerPage` is NOT paginated: the main
// query is capped at `maxItemsPerPage` rows, no COUNT runs and no `pagination` block is
// returned (AGENTS_FRONTEND.md, "Pagination"). The querystring schema must therefore not
// declare a `default` for `itemsPerPage`: Ajv injects schema defaults before the handler runs,
// which would turn every request into page 1 of a 500-row paginator.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT } from './_harness.js';

const { fastifyAutoSqlApi, Type, exportTableInfo } = await import(path.join(ROOT, 'dist/index.js'));

async function createTestApp(maxItemsPerPage) {
  const fields = { id: Type.Number(), name: Type.String() };
  const schema = {
    col: (f) => f,
    fields,
    validation: Type.Object(fields),
    tableName: 'test_table',
    partialValidation: Type.Partial(Type.Object(fields)),
  };
  const DbTables = {
    test_table: { primary: 'id', ...exportTableInfo(schema), defaultOrder: 'id' },
  };

  const app = Fastify();
  const sql = [];
  app.decorate('pg', {
    query: async (text) => {
      sql.push(text);
      return /count/i.test(text)
        ? { rows: [{ total: 0 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    },
  });
  await app.register(fastifyAutoSqlApi, { DbTables, maxItemsPerPage });
  return { app, sql };
}

describe('POST /search without page or itemsPerPage', () => {
  it('returns no pagination block', async () => {
    const { app } = await createTestApp(1000);
    const res = await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().pagination, undefined, res.payload);
    await app.close();
  });

  it('caps the main query at maxItemsPerPage and runs no COUNT', async () => {
    const { app, sql } = await createTestApp(1000);
    await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });
    assert.equal(sql.length, 1, sql.join('\n---\n'));
    assert.match(sql[0], /LIMIT 1000\b/);
    assert.doesNotMatch(sql[0], /OFFSET/);
    await app.close();
  });

  it('uses a lower maxItemsPerPage as the cap', async () => {
    const { app, sql } = await createTestApp(100);
    const res = await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().pagination, undefined);
    assert.match(sql[0], /LIMIT 100\b/);
    await app.close();
  });
});

describe('POST /search with a partial paginator', () => {
  it('page alone defaults itemsPerPage to 500', async () => {
    const { app, sql } = await createTestApp(1000);
    const res = await app.inject({ method: 'POST', url: '/search/test_table?page=2', payload: {} });
    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json().pagination.paginator, { page: 2, itemsPerPage: 500 });
    assert.match(sql[0], /LIMIT 500 OFFSET 500/);
    assert.equal(sql.length, 2, 'a paginated search runs the COUNT');
    await app.close();
  });

  it('page alone defaults itemsPerPage to maxItemsPerPage when that is below 500', async () => {
    const { app } = await createTestApp(100);
    const res = await app.inject({ method: 'POST', url: '/search/test_table?page=1', payload: {} });
    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json().pagination.paginator, { page: 1, itemsPerPage: 100 });
    await app.close();
  });

  it('itemsPerPage alone defaults page to 1', async () => {
    const { app, sql } = await createTestApp(1000);
    const res = await app.inject({ method: 'POST', url: '/search/test_table?itemsPerPage=20', payload: {} });
    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json().pagination.paginator, { page: 1, itemsPerPage: 20 });
    assert.match(sql[0], /LIMIT 20 OFFSET 0/);
    await app.close();
  });
});
