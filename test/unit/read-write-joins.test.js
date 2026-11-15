// A table's relations are listed under the name of what they grant, like `operations`:
// `readJoins` for search, `writeJoins` for secondaries and deletions. The pre-1.0
// `allowedReadJoins` / `allowedWriteJoins` fail at startup naming the new key, never silently.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, defineTable, buildRelation, createSqlApi, Type } =
  await import(path.join(ROOT, 'dist/index.js'));

const customerSchema = createMockSchema('customer', { id: Type.Integer(), name: Type.String() });
const orderSchema = createMockSchema('customer_order', { id: Type.Integer(), customerId: Type.Integer(), total: Type.Number() });
const orders = () => buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'orders' });

function createMockPool() {
  const calls = [];
  return {
    calls,
    async connect() {
      return { query: (text, values) => this.query(text, values), release() {} };
    },
    async query(text, values) {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
      calls.push(sql);
      if (/^INSERT INTO "customer" /.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      if (/^INSERT INTO "customer_order"/.test(sql)) return { rows: [{ id: 10 }], rowCount: 1 };
      return { rows: [{ id: 1, name: 'Mario', customer_id: 1, total: 5 }], rowCount: 1 };
    },
  };
}

describe('readJoins and writeJoins', () => {
  it('readJoins grants the relation to search', async () => {
    const dbTables = {
      customer: defineTable({ primary: 'id', schema: customerSchema, readJoins: [orders()] }),
    };
    const app = Fastify();
    const pool = createMockPool();
    app.decorate('pg', pool);
    await app.register(fastifyAutoSqlApi, { dbTables });
    const res = await app.inject({ method: 'POST', url: '/search/customer', payload: { joinMultiple: { orders: {} } } });
    assert.equal(res.statusCode, 200, res.payload);
    assert.ok(pool.calls.some((sql) => /FROM "customer_order"/.test(sql)), pool.calls.join('\n'));
    await app.close();
  });

  it('writeJoins grants the relation to secondaries', async () => {
    const dbTables = {
      customer: defineTable({ primary: 'id', schema: customerSchema, insertExclude: ['id'], writeJoins: [orders()] }),
    };
    const pool = createMockPool();
    const sqlApi = createSqlApi(pool, dbTables, { dialect: 'postgres' });
    await sqlApi.insert('customer', { main: { name: 'Mario' }, secondaries: { orders: [{ total: 5 }] } });
    assert.ok(pool.calls.some((sql) => /^INSERT INTO "customer_order"/.test(sql)), pool.calls.join('\n'));
  });

  it('a relation granted for reading only is never written', async () => {
    const dbTables = {
      customer: defineTable({
        primary: 'id',
        schema: customerSchema,
        insertExclude: ['id'],
        readJoins: [orders()],
        writeJoins: [buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'lines' })],
      }),
    };
    const app = Fastify();
    const pool = createMockPool();
    app.decorate('pg', pool);
    await app.register(fastifyAutoSqlApi, { dbTables });
    const res = await app.inject({
      method: 'POST', url: '/rest/customer',
      payload: { main: { name: 'Mario' }, secondaries: { orders: [{ total: 5 }] } },
    });
    assert.equal(res.statusCode, 201, res.payload);
    assert.ok(!pool.calls.some((sql) => /INSERT INTO "customer_order"/.test(sql)), pool.calls.join('\n'));
    await app.close();
  });
});

describe('allowedReadJoins / allowedWriteJoins are the pre-1.0 names', () => {
  for (const [old, now] of [['allowedReadJoins', 'readJoins'], ['allowedWriteJoins', 'writeJoins']]) {
    it(`defineTable with ${old} throws, pointing at ${now}`, () => {
      assert.throws(
        () => defineTable({ primary: 'id', schema: customerSchema, [old]: [orders()] }),
        new RegExp(`'${old}'.*'${now}'`, 's')
      );
    });

    it(`a dbTables entry with ${old}, not passed through defineTable, fails createSqlApi`, () => {
      assert.throws(
        () => createSqlApi(createMockPool(), { customer: { primary: 'id', schema: customerSchema, [old]: [orders()] } }, { dialect: 'postgres' }),
        new RegExp(`dbTables\\.customer.*'${old}'.*'${now}'`, 's')
      );
    });
  }
});
