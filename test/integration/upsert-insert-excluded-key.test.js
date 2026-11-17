// An upsert key the client may not set on insert (`insertExclude`) addresses an existing row.
// The CLI lists every generated primary key under `insertExclude`, so `upsertKey: ['id']` on a
// generated table is the common case: the key was stripped as client input and every row sent
// with an id was inserted again under a new one. Now a row carrying the key updates the row it
// names, a row without it is inserted, and a key naming no row is a 400 before any write — the
// client still never picks the key of a new row.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALECT,
  createTestApp,
  cleanTables,
  seedRows,
  toUnderscore,
  buildRelation,
  Type,
} from './_helpers.js';

function mockSchema(tableName, fields) {
  const schema = { col: (f) => toUnderscore(f), fields, tableName, primaryKey: ['id'], uniqueKeys: [] };
  schema.validation = Type.Object(fields);
  schema.partialValidation = Type.Object(fields);
  return schema;
}

const tagSchema = mockSchema('tag', {
  id: Type.Optional(Type.Integer()),
  code: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
});
const customerSchema = mockSchema('customer', {
  id: Type.Optional(Type.Integer()),
  name: Type.Optional(Type.String()),
});
const orderSchema = mockSchema('customer_order', {
  id: Type.Optional(Type.Integer()),
  customerId: Type.Optional(Type.Integer()),
  total: Type.Optional(Type.Number()),
});

const dbTables = {
  tag: { primary: 'id', schema: tagSchema, defaultOrder: 'id', insertExclude: ['id'], upsertKey: ['id'] },
  customer: {
    primary: 'id',
    schema: customerSchema,
    defaultOrder: 'id',
    insertExclude: ['id'],
    writeJoins: [
      buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'orders', upsertKey: ['id'] }),
    ],
  },
  customer_order: { primary: 'id', schema: orderSchema, defaultOrder: 'id', insertExclude: ['id'] },
};

async function rows(db, table, cols) {
  const res = await db.query(
    `SELECT ${cols.map((c) => db.qi(c)).join(', ')} FROM ${db.qi(table)} ORDER BY ${db.qi('id')}`
  );
  return res.rows.map((r) => ({ ...r, ...(r.total !== undefined ? { total: Number(r.total) } : {}) }));
}

describe(`[${DIALECT}] an insertExclude'd upsert key addresses an existing row`, () => {
  let app;
  let db;
  let tags;
  let customerId;
  let orders;

  before(async () => {
    ({ app, db } = await createTestApp(dbTables, { prefix: '/auto' }));
  });

  beforeEach(async () => {
    await cleanTables(db, ['customer_order', 'customer', 'tag']);
    await seedRows(db, 'tag', [{ code: 'a', label: 'A' }, { code: 'b', label: 'B' }]);
    tags = await rows(db, 'tag', ['id', 'code', 'label']);
    [{ id: customerId }] = await seedRows(db, 'customer', [{ name: 'Ada' }]);
    await seedRows(db, 'customer_order', [{ customer_id: customerId, total: 10 }]);
    orders = await rows(db, 'customer_order', ['id', 'total']);
  });

  after(async () => {
    await app.close();
  });

  it('a bulk upsert updates the row its key names and inserts the rows without one', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/bulk/tag',
      payload: [{ main: { id: tags[1].id, code: 'b', label: 'B2' } }, { main: { code: 'c', label: 'C' } }],
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body[0], { main: { id: tags[1].id }, action: 'updated' });
    assert.equal(body[1].action, 'inserted');
    const after = await rows(db, 'tag', ['id', 'code', 'label']);
    assert.deepEqual(after.slice(0, 2), [tags[0], { ...tags[1], label: 'B2' }]);
    assert.equal(after.length, 3, 'only the row without a key is inserted');
  });

  it('a bulk upsert answers 400 not_found at the key of a row that does not exist, and writes nothing', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/bulk/tag',
      payload: [{ main: { id: tags[0].id, code: 'a', label: 'A2' } }, { main: { id: 999999, code: 'z' } }],
    });

    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(
      JSON.parse(res.payload).fields.map(({ path, code }) => ({ path, code })),
      [{ path: '1.main.id', code: 'not_found' }]
    );
    assert.deepEqual(await rows(db, 'tag', ['id', 'code', 'label']), tags);
  });

  it('an insert updates the row its key names', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/tag',
      payload: { main: { id: tags[0].id, code: 'a', label: 'A2' } },
    });

    assert.equal(res.statusCode, 201, res.payload);
    assert.deepEqual(JSON.parse(res.payload), { main: { id: tags[0].id }, action: 'updated' });
    assert.deepEqual(await rows(db, 'tag', ['id', 'code', 'label']), [{ ...tags[0], label: 'A2' }, tags[1]]);
  });

  it('an insert answers 400 not_found at main.<key> when no row has that key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/tag',
      payload: { main: { id: 999999, code: 'z' } },
    });

    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(
      JSON.parse(res.payload).fields.map(({ path, code }) => ({ path, code })),
      [{ path: 'main.id', code: 'not_found' }]
    );
    assert.deepEqual(await rows(db, 'tag', ['id', 'code', 'label']), tags);
  });

  it('a child row carrying its key updates that row instead of inserting a copy', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/rest/customer',
      payload: { main: { id: customerId }, upsert: { orders: [{ id: orders[0].id, total: 20 }, { total: 30 }] } },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const after = await rows(db, 'customer_order', ['id', 'total']);
    assert.deepEqual(after[0], { id: orders[0].id, total: 20 });
    assert.equal(after.length, 2, 'only the child row without a key is inserted');
  });

  it('a child row whose key names no row is a 400 not_found at its path, and the write rolls back', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/rest/customer',
      payload: { main: { id: customerId, name: 'Bea' }, upsert: { orders: [{ total: 30 }, { id: 999999, total: 20 }] } },
    });

    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(
      JSON.parse(res.payload).fields.map(({ path, code }) => ({ path, code })),
      [{ path: 'upsert.orders.1.id', code: 'not_found' }]
    );
    assert.deepEqual(await rows(db, 'customer_order', ['id', 'total']), orders);
    assert.deepEqual(await rows(db, 'customer', ['id', 'name']), [{ id: customerId, name: 'Ada' }]);
  });

  it('in a bulk upsert, the path of a child row names its item', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/bulk/customer',
      payload: [{ main: { name: 'Cy' }, replace: { orders: [{ id: 999999, total: 20 }] } }],
    });

    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(
      JSON.parse(res.payload).fields.map(({ path, code }) => ({ path, code })),
      [{ path: '0.replace.orders.0.id', code: 'not_found' }]
    );
  });
});
