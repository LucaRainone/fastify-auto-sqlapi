// `orderBy`, the paginator and the compute request travel in the search BODY, like every
// other part of the request; the querystring form (`?orderBy=&page=&itemsPerPage=&computeSum=`)
// stays as an alternative. The body is canonical: a value given in both places is a 400,
// and the engine reports compute/paginator errors at the body path.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, defineTable, exportTableInfo, Type } = await import(path.join(ROOT, 'dist/index.js'));

const SchemaOrder = createMockSchema('customer_order', {
  id: Type.Integer(),
  total: Type.Number(),
  status: Type.String(),
});

function createMockPool() {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      const sql = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: sql, values });
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: '3' }], rowCount: 1 };
      if (/^SELECT (SUM|MIN|MAX|AVG)\(/.test(sql)) return { rows: [{ value: 42 }], rowCount: 1 };
      return { rows: [{ id: 1, total: 10, status: 'paid' }], rowCount: 1 };
    },
  };
}

async function createApp(pluginOverrides = {}) {
  const DbTables = { order: defineTable({ primary: 'id', ...exportTableInfo(SchemaOrder) }) };
  const app = Fastify();
  const pool = createMockPool();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { DbTables, ...pluginOverrides });
  return { app, pool };
}

const search = (app, payload, qs = '') => app.inject({ method: 'POST', url: `/search/order${qs}`, payload });

describe('search body — orderBy', () => {
  it('orders the main query', async () => {
    const { app, pool } = await createApp();
    const res = await search(app, { orderBy: 'total DESC' });
    assert.equal(res.statusCode, 200, res.payload);
    assert.match(pool.calls[0].text, /ORDER BY "customer_order"\."total" DESC/);
    await app.close();
  });

  it('is a 400 at orderBy when malformed', async () => {
    const { app } = await createApp();
    const res = await search(app, { orderBy: 'total;drop' });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['orderBy', 'invalid_order_by']]);
    await app.close();
  });
});

describe('search body — paginator', () => {
  it('pages the main query and returns the pagination block', async () => {
    const { app, pool } = await createApp();
    const res = await search(app, { paginator: { page: 2, itemsPerPage: 10 } });
    assert.equal(res.statusCode, 200, res.payload);
    assert.match(pool.calls[0].text, /LIMIT 10 OFFSET 10/);
    assert.deepEqual(res.json().pagination.paginator, { page: 2, itemsPerPage: 10 });
    assert.equal(res.json().pagination.total, 3);
    await app.close();
  });

  it('page alone defaults itemsPerPage to 500', async () => {
    const { app, pool } = await createApp();
    const res = await search(app, { paginator: { page: 3 } });
    assert.equal(res.statusCode, 200, res.payload);
    assert.match(pool.calls[0].text, /LIMIT 500 OFFSET 1000/);
    await app.close();
  });

  it('itemsPerPage over maxItemsPerPage is a schema 400 at paginator.itemsPerPage', async () => {
    const { app } = await createApp({ maxItemsPerPage: 100 });
    const res = await search(app, { paginator: { page: 1, itemsPerPage: 200 } });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['paginator.itemsPerPage', 'maximum']]);
    await app.close();
  });
});

describe('search body — compute', () => {
  it('runs one aggregate per function and field, into pagination.computed', async () => {
    const { app, pool } = await createApp();
    const res = await search(app, { paginator: { page: 1, itemsPerPage: 10 }, compute: { sum: ['total'], min: ['total', 'id'] } });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.deepEqual(body.pagination.computed, { min: { total: 42, id: 42 }, sum: { total: 42 } });
    const aggregates = pool.calls.map((c) => c.text).filter((t) => /^SELECT (SUM|MIN)\(/.test(t));
    assert.equal(aggregates.length, 3, pool.calls.map((c) => c.text).join('\n'));
    await app.close();
  });

  it('an unknown field is a 400 at compute.<fn>.<i>', async () => {
    const { app } = await createApp();
    const res = await search(app, { paginator: { page: 1 }, compute: { sum: ['total', 'nope'] } });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['compute.sum.1', 'unknown_field']]);
    await app.close();
  });

  it('the querystring form still works and lands in the same place', async () => {
    const { app } = await createApp();
    const res = await search(app, {}, '?page=1&itemsPerPage=10&computeSum=total');
    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json().pagination.computed, { sum: { total: 42 } });
    await app.close();
  });
});

describe('search body — a value given in both body and querystring', () => {
  const cases = [
    ['orderBy', { orderBy: 'id' }, '?orderBy=total', 'orderBy'],
    ['paginator', { paginator: { page: 1 } }, '?itemsPerPage=10', 'paginator'],
    ['compute', { compute: { sum: ['total'] } }, '?computeMin=total', 'compute'],
  ];
  for (const [label, payload, qs, expectedPath] of cases) {
    it(`${label}: 400 conflicting_input at the body key`, async () => {
      const { app } = await createApp();
      const res = await search(app, payload, qs);
      assert.equal(res.statusCode, 400, res.payload);
      assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [[expectedPath, 'conflicting_input']]);
      await app.close();
    });
  }
});

describe('search body schema', () => {
  it('advertises orderBy, paginator and compute, with the paginator cap', async () => {
    const { SearchTableBodyPost } = await import(path.join(ROOT, 'dist/lib/schema/search.js'));
    const DbTables = { order: defineTable({ primary: 'id', ...exportTableInfo(SchemaOrder) }) };
    const body = SearchTableBodyPost(DbTables, 'order', 100);
    assert.equal(body.properties.orderBy?.type, 'string');
    assert.equal(body.properties.paginator?.properties?.itemsPerPage?.maximum, 100);
    assert.deepEqual(Object.keys(body.properties.compute?.properties ?? {}).sort(), ['avg', 'max', 'min', 'sum']);
  });
});
