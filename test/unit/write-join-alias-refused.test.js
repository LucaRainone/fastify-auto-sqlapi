// An alias under `secondaries` or `deletions` that the table does not declare in `writeJoins`
// is a 400 `unknown_field` at that alias, and nothing is written — over HTTP and through
// `sqlApi` alike. It used to be dropped in silence: a typo'd alias answered 201 having written
// the main row and none of its children, and Ajv's `removeAdditional` stripped it before the
// closed alias container could ever reject it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, createSqlApi, defineTable, buildRelation, Type } =
  await import(path.join(ROOT, 'dist/index.js'));

const customerSchema = createMockSchema('customer', { id: Type.Number(), name: Type.String() });
const orderSchema = createMockSchema('customer_order', { id: Type.Number(), customerId: Type.Number(), total: Type.Number() });
const noteSchema = createMockSchema('note', { id: Type.Number(), customerId: Type.Number(), body: Type.String() });

const orders = () => buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'orders' });
const notes = () => buildRelation(customerSchema, 'id', noteSchema, 'customerId', { alias: 'notes' });

function dbTables(extra = { writeJoins: [orders()], readJoins: [notes()] }) {
  return { customer: defineTable({ primary: 'id', schema: customerSchema, insertExclude: ['id'], ...extra }) };
}

function createMockPool() {
  const calls = [];
  const pool = {
    calls,
    async connect() {
      return { query: (text, values) => pool.query(text, values), release() {} };
    },
    async query(text, values) {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
      calls.push(sql);
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
  };
  return pool;
}

async function http(tables, method, url, payload) {
  const app = Fastify();
  const pool = createMockPool();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { dbTables: tables });
  const res = await app.inject({ method, url, payload });
  await app.close();
  return { res, pool };
}

const fieldsOf = (res) => res.json().fields.map((f) => [f.path, f.code]);

describe('an undeclared write alias is a 400 unknown_field, over HTTP', () => {
  it('insert: a typo in a secondaries alias', async () => {
    const { res, pool } = await http(dbTables(), 'POST', '/rest/customer',
      { main: { name: 'Mario' }, upsert: { order: [{ total: 100 }] } });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(fieldsOf(res), [['upsert.order', 'unknown_field']]);
    assert.equal(pool.calls.length, 0);
  });

  it('insert: an alias granted for reading only', async () => {
    const { res, pool } = await http(dbTables(), 'POST', '/rest/customer',
      { main: { name: 'Mario' }, upsert: { notes: [{ body: 'hi' }] } });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(fieldsOf(res), [['upsert.notes', 'unknown_field']]);
    assert.equal(pool.calls.length, 0);
  });

  it('insert: secondaries on a table with no write join', async () => {
    const { res, pool } = await http(dbTables({}), 'POST', '/rest/customer',
      { main: { name: 'Mario' }, upsert: { orders: [{ total: 100 }] } });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(fieldsOf(res), [['upsert.orders', 'unknown_field']]);
    assert.equal(pool.calls.length, 0);
  });

  it('update: an undeclared deletions alias', async () => {
    const { res, pool } = await http(dbTables(), 'PUT', '/rest/customer',
      { main: { id: 1, name: 'Mario' }, delete: { order: [{ id: 5 }] } });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(fieldsOf(res), [['delete.order', 'unknown_field']]);
    assert.equal(pool.calls.length, 0);
  });

  it('bulk upsert: the item and alias are named, and no item is written', async () => {
    const { res, pool } = await http(dbTables(), 'PUT', '/bulk/customer', [
      { main: { name: 'A' }, upsert: { orders: [{ id: 1, total: 1 }] } },
      { main: { name: 'B' }, upsert: { order: [{ total: 2 }] } },
    ]);
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(fieldsOf(res), [['1.upsert.order', 'unknown_field']]);
    assert.equal(pool.calls.length, 0);
  });

  it('a declared alias, even with no rows, and an empty section still pass', async () => {
    const a = await http(dbTables(), 'POST', '/rest/customer', { main: { name: 'Mario' }, upsert: { orders: [] } });
    assert.equal(a.res.statusCode, 201, a.res.payload);
    const b = await http(dbTables(), 'POST', '/rest/customer', { main: { name: 'Mario' }, upsert: {} });
    assert.equal(b.res.statusCode, 201, b.res.payload);
  });
});

describe('an undeclared write alias is a 400 unknown_field, through sqlApi', () => {
  const rejects = (call) => assert.rejects(call, (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.validationErrors[0].code, 'unknown_field');
    return true;
  });

  it('insert, update and bulkUpsert', async () => {
    const pool = createMockPool();
    const sqlApi = createSqlApi(pool, dbTables(), { dialect: 'postgres' });
    await rejects(() => sqlApi.insert('customer', { main: { name: 'M' }, upsert: { order: [{ total: 1 }] } }));
    await rejects(() => sqlApi.update('customer', { main: { id: 1, name: 'M' }, delete: { order: [{ id: 5 }] } }));
    await rejects(() => sqlApi.bulkUpsert('customer', [{ main: { name: 'M' }, upsert: { order: [] } }]));
    assert.equal(pool.calls.length, 0);
  });
});
