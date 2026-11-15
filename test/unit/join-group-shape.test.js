import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
  fastifyAutoSqlApi,
  exportTableInfo,
  buildRelation,
  toUnderscore,
  Type,
} from '../../dist/index.js';

// joinGroup has one request shape and one response shape. The request names `by` and the
// aggregate functions next to `filters`/`conditions`; the response is always `rows`, one per
// group (one row without `by`), with the aggregates nested as in the dotted notation
// `alias.fn.field`: `{ by, sum: { total } }`.

const customerFields = { id: Type.Integer(), name: Type.String() };
const orderFields = { id: Type.Integer(), customerId: Type.Integer(), status: Type.String(), total: Type.Number() };
const schema = (tableName, fields) => ({
  col: (f) => toUnderscore(f),
  fields,
  validation: Type.Object(fields),
  tableName,
  partialValidation: Type.Partial(Type.Object(fields)),
});
const SchemaCustomer = schema('customer', customerFields);
const SchemaOrder = schema('customer_order', orderFields);

const DbTables = {
  customer: {
    primary: 'id',
    ...exportTableInfo(SchemaCustomer),
    allowedReadJoins: [buildRelation(SchemaCustomer, 'id', SchemaOrder, 'customerId', { alias: 'orders' })],
  },
  customer_order: { primary: 'id', ...exportTableInfo(SchemaOrder) },
};

// pg-shaped pool: { rows, rowCount } responses consumed in order, statements recorded
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

async function search(pool, joinGroup) {
  const app = Fastify();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { DbTables });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/search/customer', payload: { joinGroup } });
  await app.close();
  return res;
}

const MAIN = { rows: [{ id: 1, name: 'Mario' }, { id: 2, name: 'Luigi' }], rowCount: 2 };

describe('joinGroup has one request and one response shape', () => {
  it('without by: one row under rows, aggregates nested by function', async () => {
    const pool = createMockPool([MAIN, { rows: [{ sum_total: 150, count_id: 3 }], rowCount: 1 }]);

    const res = await search(pool, { orders: { sum: ['total'], count: ['id'] } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().joinGroup, {
      orders: { rows: [{ sum: { total: 150 }, count: { id: 3 } }] },
    });
  });

  it('with by: one row per group, by beside the nested aggregates', async () => {
    const pool = createMockPool([MAIN, {
      rows: [{ by: 'pending', sum_total: 100 }, { by: 'paid', sum_total: 50 }],
      rowCount: 2,
    }]);

    const res = await search(pool, { orders: { by: 'status', sum: ['total'] } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().joinGroup, {
      orders: { rows: [{ by: 'pending', sum: { total: 100 } }, { by: 'paid', sum: { total: 50 } }] },
    });
    assert.match(pool.calls[1].text, /GROUP BY/);
  });

  it('no main rows: rows is empty, not a different shape', async () => {
    const pool = createMockPool([{ rows: [], rowCount: 0 }]);

    const res = await search(pool, { orders: { sum: ['total'] } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().joinGroup, { orders: { rows: [] } });
  });

  it('filters narrow the children beside the aggregates', async () => {
    const pool = createMockPool([MAIN, { rows: [{ sum_total: 40 }], rowCount: 1 }]);

    const res = await search(pool, { orders: { sum: ['total'], filters: { status: 'paid' } } });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(pool.calls[1].values.includes('paid'), 'the group filter was not applied');
  });

  it('an unknown by field is a 400 at joinGroup.<alias>.by', async () => {
    const res = await search(createMockPool([MAIN]), { orders: { by: 'nope', sum: ['total'] } });
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['joinGroup.orders.by', 'unknown_field']]);
  });

  it('an unknown aggregated field is a 400 at joinGroup.<alias>.<fn>.<i>', async () => {
    const res = await search(createMockPool([MAIN]), { orders: { sum: ['total', 'nope'] } });
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['joinGroup.orders.sum.1', 'unknown_field']]);
  });

  it('the pre-1.0 aggregations wrapper is a 400 naming the move, not an empty result', async () => {
    const pool = createMockPool([MAIN]);
    const res = await search(pool, { orders: { aggregations: { sum: ['total'] } } });
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['joinGroup.orders.aggregations', 'invalid_aggregation']]);
  });

  it('a joinGroup with no aggregate function is a 400', async () => {
    const res = await search(createMockPool([MAIN]), { orders: { by: 'status' } });
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['joinGroup.orders', 'invalid_aggregation']]);
  });
});
