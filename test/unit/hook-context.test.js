// Every hook and validator receives ONE context object: `{ db, req, ...the operation's data }`.
// Positional parameters made every new piece of information a breaking change, and `req` was
// typed as always present while `sqlApi.*` called without a request handed `undefined`. Now
// `req` is `ApiRequest | undefined` in the type and in fact, and the data travels under the
// glossary's names: `record`, `secondaries`, `deletions`, `rows`, `id`, `ids`, `main`, `items`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockPg, createMockSchema } from './_harness.js';

const { createSqlApi, defineTable, exportTableInfo, buildRelation, QueryClient, Type } =
  await import(path.join(ROOT, 'dist/index.js'));

const SchemaCustomer = createMockSchema('customer', { id: Type.Optional(Type.Integer()), name: Type.String() });
const SchemaOrder = createMockSchema('customer_order', {
  id: Type.Optional(Type.Integer()),
  customerId: Type.Optional(Type.Integer()),
  total: Type.Number(),
});

/** Every statement succeeds and returns one row with id 1 (a SELECT, an INSERT RETURNING, an UPDATE). */
const okDb = () => createMockPg(() => ({ rows: [{ id: 1, name: 'Mario', customer_id: 1, total: 5 }], affectedRows: 1 }));

function createDbTables(hooks = {}, orderHooks = {}) {
  return {
    customer: defineTable({
      primary: 'id',
      ...exportTableInfo(SchemaCustomer),
      insertExclude: ['id'],
      allowedWriteJoins: [buildRelation(SchemaCustomer, 'id', SchemaOrder, 'customerId', { alias: 'orders' })],
      allowedReadJoins: [buildRelation(SchemaCustomer, 'id', SchemaOrder, 'customerId', { alias: 'orders' })],
      ...hooks,
    }),
    order: defineTable({ primary: 'id', ...exportTableInfo(SchemaOrder), insertExclude: ['id'], ...orderHooks }),
  };
}

const REQ = { id: 'req-1', user: { id: 7 } };

function assertBase(ctx, req) {
  assert.ok(ctx.db instanceof QueryClient, 'ctx.db is the QueryClient (the transaction one on writes)');
  assert.equal(ctx.req, req);
}

describe('hook context — writes', () => {
  it('validate gets { db, req, main, secondaries }', async () => {
    let seen;
    const api = createSqlApi(okDb(), createDbTables({ validate: (ctx) => { seen = ctx; return []; } }));
    await api.insert('customer', { record: { name: 'Mario' }, secondaries: { orders: [{ total: 5 }] } }, REQ);
    assertBase(seen, REQ);
    assert.deepEqual(seen.main, { name: 'Mario' });
    assert.deepEqual(seen.secondaries, { orders: [{ total: 5 }] });
  });

  it('beforeInsert gets { db, req, record } and its mutation reaches the INSERT', async () => {
    let seen;
    const db = okDb();
    const api = createSqlApi(db, createDbTables({ beforeInsert: (ctx) => { seen = ctx; ctx.record.name = 'Luigi'; } }));
    await api.insert('customer', { record: { name: 'Mario' } }, REQ);
    assertBase(seen, REQ);
    const insert = db.calls.find((c) => /^INSERT/.test(c.text));
    assert.ok(insert.values.includes('Luigi'), insert.text);
  });

  it('afterInsert gets { db, req, record, secondaries }', async () => {
    let seen;
    const api = createSqlApi(okDb(), createDbTables({ afterInsert: (ctx) => { seen = ctx; } }));
    await api.insert('customer', { record: { name: 'Mario' }, secondaries: { orders: [{ total: 5 }] } }, REQ);
    assertBase(seen, REQ);
    assert.equal(seen.record.name, 'Mario');
    assert.equal(seen.record.id, 1, 'the generated PK is merged in');
    assert.ok(Array.isArray(seen.secondaries.orders));
  });

  it('beforeUpdate and afterUpdate get { db, req, record } and { db, req, record, secondaries, deletions }', async () => {
    const seen = {};
    const api = createSqlApi(okDb(), createDbTables({
      beforeUpdate: (ctx) => { seen.before = ctx; },
      afterUpdate: (ctx) => { seen.after = ctx; },
    }));
    await api.update('customer', {
      record: { id: 1, name: 'Mario' },
      secondaries: { orders: [{ total: 5 }] },
      deletions: { orders: [{ id: 9 }] },
    }, REQ);
    assertBase(seen.before, REQ);
    assert.equal(seen.before.record.name, 'Mario');
    assertBase(seen.after, REQ);
    assert.ok(seen.after.secondaries.orders, 'secondaries written');
    assert.ok(seen.after.deletions.orders, 'deletions performed');
  });

  it('validateBulk gets { db, req, items }', async () => {
    let seen;
    const twoRows = createMockPg(() => ({ rows: [{ id: 1 }, { id: 2 }], affectedRows: 2 }));
    const api = createSqlApi(twoRows, createDbTables({ validateBulk: (ctx) => { seen = ctx; return []; } }));
    await api.bulkUpsert('customer', [{ main: { name: 'A' } }, { main: { name: 'B' } }], REQ);
    assertBase(seen, REQ);
    assert.deepEqual(seen.items.map((i) => i.main.name), ['A', 'B']);
  });

  it("a secondary's own beforeInsert gets the same shape", async () => {
    let seen;
    const api = createSqlApi(okDb(), createDbTables({}, { beforeInsert: (ctx) => { seen = ctx; } }));
    await api.insert('customer', { record: { name: 'Mario' }, secondaries: { orders: [{ total: 5 }] } }, REQ);
    assertBase(seen, REQ);
    assert.equal(seen.record.total, 5);
  });
});

describe('hook context — deletes', () => {
  it('beforeDelete and afterDelete get { db, req, id }', async () => {
    const seen = {};
    const api = createSqlApi(okDb(), createDbTables({
      beforeDelete: (ctx) => { seen.before = ctx; },
      afterDelete: (ctx) => { seen.after = ctx; },
    }));
    await api.delete('customer', 1, REQ);
    assertBase(seen.before, REQ);
    assert.equal(seen.before.id, 1);
    assertBase(seen.after, REQ);
    assert.equal(seen.after.id, 1);
  });

  it('beforeBulkDelete and afterBulkDelete get { db, req, ids }', async () => {
    const seen = {};
    const db = createMockPg(() => ({ rows: [], affectedRows: 2 }));
    const api = createSqlApi(db, createDbTables({
      beforeBulkDelete: (ctx) => { seen.before = ctx; },
      afterBulkDelete: (ctx) => { seen.after = ctx; },
    }));
    await api.bulkDelete('customer', [1, 2], REQ);
    assertBase(seen.before, REQ);
    assert.deepEqual(seen.before.ids, [1, 2]);
    assertBase(seen.after, REQ);
    assert.deepEqual(seen.after.ids, [1, 2]);
  });
});

describe('hook context — reads', () => {
  it('afterRead gets { db, req, rows, source, alias }', async () => {
    const seen = [];
    const api = createSqlApi(okDb(), createDbTables(
      { afterRead: (ctx) => { seen.push(ctx); } },
      { afterRead: (ctx) => { seen.push(ctx); } },
    ));
    await api.search('customer', { joinMultiple: { orders: {} } }, REQ);
    const main = seen.find((c) => c.source === 'search');
    const join = seen.find((c) => c.source === 'joinMultiple');
    assertBase(main, REQ);
    assert.equal(main.rows[0].name, 'Mario');
    assert.equal(main.alias, undefined);
    assertBase(join, REQ);
    assert.equal(join.alias, 'orders');
  });
});

describe('hook context — req is undefined when sqlApi.* runs without a request', () => {
  it('and every hook still runs', async () => {
    const reqs = [];
    const record = (ctx) => { reqs.push(ctx.req); };
    const api = createSqlApi(okDb(), createDbTables({
      validate: (ctx) => { record(ctx); return []; },
      beforeInsert: record,
      afterInsert: record,
      beforeDelete: record,
      afterRead: record,
    }));
    await api.insert('customer', { record: { name: 'Mario' } });
    await api.delete('customer', 1);
    await api.get('customer', 1);
    assert.equal(reqs.length, 5, 'validate, beforeInsert, afterInsert, beforeDelete, afterRead');
    assert.ok(reqs.every((r) => r === undefined));
  });
});
