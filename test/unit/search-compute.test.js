import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { fastifyAutoSqlApi, exportTableInfo, toUnderscore, Type } from '../../dist/index.js';

// `compute` aggregates over ALL rows matching the search, whatever page is returned. It
// stands on its own: no paginator needed, the result in `computed` at the top level, and the
// same functions as joinGroup (min, max, sum, avg, count, distinctCount).

const fields = { id: Type.Integer(), status: Type.String(), total: Type.Number() };
const SchemaOrder = {
  col: (f) => toUnderscore(f),
  fields,
  validation: Type.Object(fields),
  tableName: 'customer_order',
  partialValidation: Type.Partial(Type.Object(fields)),
};
const DbTables = { customer_order: { primary: 'id', ...exportTableInfo(SchemaOrder) } };

// pg-shaped pool: every aggregate statement answers 42, COUNT(*) answers 7, the rest no rows
function createMockPool() {
  const calls = [];
  return {
    calls,
    query(text, values) {
      const sql = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: sql, values });
      if (/^SELECT COUNT\(\*\) as total/.test(sql)) return Promise.resolve({ rows: [{ total: '7' }], rowCount: 1 });
      if (/ as value FROM/.test(sql)) return Promise.resolve({ rows: [{ value: 42 }], rowCount: 1 });
      return Promise.resolve({ rows: [{ id: 1, status: 'paid', total: 10 }], rowCount: 1 });
    },
  };
}

async function search(pool, payload) {
  const app = Fastify();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { DbTables });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/search/customer_order', payload });
  await app.close();
  return res;
}

describe('compute aggregates every matching row, with or without a paginator', () => {
  it('without a paginator: computed at the top level, no pagination block', async () => {
    const pool = createMockPool();
    const res = await search(pool, { filters: { status: 'paid' }, compute: { sum: ['total'] } });

    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(body.computed, { sum: { total: 42 } });
    assert.equal(body.pagination, undefined);
    const agg = pool.calls.find((c) => /SUM\(/.test(c.text));
    assert.ok(agg, 'the aggregate never ran');
    assert.doesNotMatch(agg.text, /LIMIT/, 'the aggregate must cover every matching row, not a page');
    assert.ok(agg.values.includes('paid'), 'the aggregate ignores the search filters');
  });

  it('with a paginator: computed at the top level, beside pagination and not inside it', async () => {
    const pool = createMockPool();
    const res = await search(pool, { paginator: { page: 1, itemsPerPage: 5 }, compute: { max: ['total'] } });

    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(body.computed, { max: { total: 42 } });
    assert.equal(body.pagination.total, 7);
    assert.equal(body.pagination.computed, undefined);
  });

  it('count and distinctCount, as in joinGroup', async () => {
    const pool = createMockPool();
    const res = await search(pool, { compute: { count: ['id'], distinctCount: ['status'] } });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().computed, { count: { id: 42 }, distinctCount: { status: 42 } });
    assert.ok(pool.calls.some((c) => /COUNT\(DISTINCT "customer_order"\."status"\)/.test(c.text)), 'no COUNT(DISTINCT)');
  });

  it('no compute: no computed key', async () => {
    const res = await search(createMockPool(), {});
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().computed, undefined);
  });

  it('an unknown field is still a 400 at compute.<fn>.<i> without a paginator', async () => {
    const res = await search(createMockPool(), { compute: { count: ['id', 'nope'] } });
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['compute.count.1', 'unknown_field']]);
  });
});
