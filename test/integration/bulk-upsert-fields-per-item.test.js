// A bulk upsert is N single writes issued efficiently (ADR 0003): each item — and each
// secondary row — writes exactly its own fields. Pinned against a real database, reading back
// what was stored: a field only on a later item must be stored, a field an item omits must
// fall back to the column default on INSERT and stay untouched on UPDATE.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALECT,
  createTestApp,
  cleanTables,
  seedRows,
  exportTableInfo,
  buildRelation,
  toUnderscore,
  Type,
} from './_helpers.js';

function createSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}

const customerSchema = createSchema('customer', {
  id: Type.Optional(Type.Integer()),
  name: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
  phoneNumber: Type.Optional(Type.String()),
  isActive: Type.Optional(Type.Boolean()),
});

const orderSchema = createSchema('customer_order', {
  id: Type.Optional(Type.Integer()),
  customerId: Type.Optional(Type.Integer()),
  total: Type.Optional(Type.Number()),
  notes: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
});

const DbTables = {
  customer: {
    primary: 'id',
    ...exportTableInfo(customerSchema),
    defaultOrder: 'id',
    upsertMap: new Map([[customerSchema, ['id']]]),
    allowedWriteJoins: [
      buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
    ],
  },
  customer_order: {
    primary: 'id',
    ...exportTableInfo(orderSchema),
    defaultOrder: 'id',
  },
};

describe(`[${DIALECT}] bulk upsert — each item writes its own fields`, () => {
  let app;
  let db;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));
  });

  beforeEach(async () => {
    await cleanTables(db, ['customer_order', 'customer']);
  });

  after(async () => {
    await app.close();
  });

  async function customer(id) {
    const res = await db.query(
      `SELECT ${db.qi('name')} AS name, ${db.qi('email')} AS email, ` +
      `${db.qi('phone_number')} AS phone, ${db.qi('is_active')} AS active ` +
      `FROM ${db.qi('customer')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
      [id]
    );
    const row = res.rows[0];
    return row && { ...row, active: Boolean(row.active) };
  }

  async function ordersOf(customerId) {
    const res = await db.query(
      `SELECT ${db.qi('total')} AS total, ${db.qi('notes')} AS notes, ${db.qi('status')} AS status ` +
      `FROM ${db.qi('customer_order')} WHERE ${db.qi('customer_id')} = ${db.ph(1)} ORDER BY ${db.qi('id')}`,
      [customerId]
    );
    return res.rows.map((r) => ({ ...r, total: Number(r.total) }));
  }

  function bulkPut(table, payload) {
    return app.inject({ method: 'PUT', url: `/auto/bulk/${table}`, payload });
  }

  it('stores a field present only on a later item (route)', async () => {
    const res = await bulkPut('customer', [
      { main: { id: 1, name: 'First' } },
      { main: { id: 2, name: 'Second', email: 'second@test.it' } },
    ]);

    assert.equal(res.statusCode, 200, res.payload);
    assert.equal((await customer(1)).email, null);
    assert.equal((await customer(2)).email, 'second@test.it');
  });

  it('stores a field present only on a later item (sqlApi.bulkUpsert)', async () => {
    await app.sqlApi.bulkUpsert('customer', [
      { main: { id: 1, name: 'First' } },
      { main: { id: 2, name: 'Second', email: 'second@test.it', phoneNumber: '555' } },
    ]);

    assert.deepEqual(await customer(1), { name: 'First', email: null, phone: null, active: true });
    assert.deepEqual(
      await customer(2),
      { name: 'Second', email: 'second@test.it', phone: '555', active: true },
    );
  });

  it('gives an omitted field its column default on insert, not NULL', async () => {
    const res = await bulkPut('customer', [
      { main: { id: 1, name: 'First', isActive: false } },
      { main: { id: 2, name: 'Second' } },
    ]);

    assert.equal(res.statusCode, 200, res.payload);
    assert.equal((await customer(1)).active, false);
    assert.equal((await customer(2)).active, true, 'is_active must take its DEFAULT true');
  });

  it('leaves untouched on an existing row a field the item omits', async () => {
    await seedRows(db, 'customer', [
      { id: 1, name: 'Old one', email: 'one@test.it', phone_number: '111' },
      { id: 2, name: 'Old two', email: 'two@test.it', phone_number: '222' },
    ]);

    const res = await bulkPut('customer', [
      { main: { id: 1, name: 'New one', phoneNumber: '999' } },
      { main: { id: 2, name: 'New two' } },
    ]);

    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(
      await customer(1),
      { name: 'New one', email: 'one@test.it', phone: '999', active: true },
    );
    assert.deepEqual(
      await customer(2),
      { name: 'New two', email: 'two@test.it', phone: '222', active: true },
    );
  });

  it('returns the PKs in input order when items have different fields', async () => {
    const res = await bulkPut('customer', [
      { main: { id: 3, name: 'c' } },
      { main: { id: 1, name: 'a', email: 'a@test.it' } },
      { main: { id: 2, name: 'b' } },
    ]);

    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(JSON.parse(res.payload).map((r) => r.main.id), [3, 1, 2]);
  });

  it('writes each secondary of a bulk item with its own fields', async () => {
    const res = await bulkPut('customer', [{
      main: { id: 1, name: 'With orders' },
      secondaries: {
        customer_order: [
          { total: 10, status: 'shipped' },
          { total: 20, notes: 'fragile' },
        ],
      },
    }]);

    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(await ordersOf(1), [
      { total: 10, notes: null, status: 'shipped' },
      { total: 20, notes: 'fragile', status: 'pending' },
    ]);
  });

  it('writes each secondary of a single insert with its own fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/customer',
      payload: {
        main: { id: 1, name: 'With orders' },
        secondaries: {
          customer_order: [
            { total: 10, status: 'shipped' },
            { total: 20, notes: 'fragile' },
          ],
        },
      },
    });

    assert.equal(res.statusCode, 201, res.payload);
    assert.deepEqual(await ordersOf(1), [
      { total: 10, notes: null, status: 'shipped' },
      { total: 20, notes: 'fragile', status: 'pending' },
    ]);
  });
});

const tagSchema = createSchema('tag', {
  id: Type.Optional(Type.Integer()),
  code: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
});

// An item holding only its conflict keys has nothing to update: the existing row is left
// untouched, and its PK must still come back in position — never a missing result or a 500.
describe(`[${DIALECT}] upsert — an item holding only the conflict keys`, () => {
  let app;
  let db;

  before(async () => {
    ({ app, db } = await createTestApp({
      ...DbTables,
      tag: {
        primary: 'id',
        ...exportTableInfo(tagSchema),
        defaultOrder: 'id',
        upsertMap: new Map([[tagSchema, ['code']]]),
      },
    }, { prefix: '/auto' }));
  });

  beforeEach(async () => {
    await cleanTables(db, ['customer_order', 'customer', 'tag']);
  });

  after(async () => {
    await app.close();
  });

  async function names() {
    const res = await db.query(
      `SELECT ${db.qi('id')} AS id, ${db.qi('name')} AS name FROM ${db.qi('customer')} ORDER BY ${db.qi('id')}`
    );
    return res.rows;
  }

  it('bulk: leaves the row untouched and returns its PK in position', async () => {
    await seedRows(db, 'customer', [{ id: 1, name: 'one' }, { id: 2, name: 'two' }]);

    const res = await app.inject({
      method: 'PUT',
      url: '/auto/bulk/customer',
      payload: [{ main: { id: 1, name: 'uno' } }, { main: { id: 2 } }],
    });

    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(JSON.parse(res.payload).map((r) => r.main.id), [1, 2]);
    assert.deepEqual(await names(), [{ id: 1, name: 'uno' }, { id: 2, name: 'two' }]);
  });

  it('single insert: leaves the row untouched and returns its PK', async () => {
    await seedRows(db, 'customer', [{ id: 2, name: 'two' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/customer',
      payload: { main: { id: 2 } },
    });

    assert.equal(res.statusCode, 201, res.payload);
    assert.equal(JSON.parse(res.payload).main.id, 2);
    assert.deepEqual(await names(), [{ id: 2, name: 'two' }]);
  });

  it('looks up the PK when the conflict key is not the PK', async () => {
    const [existing] = await seedRows(db, 'tag', [{ code: 'old', label: 'Old tag' }]);

    const results = await app.sqlApi.bulkUpsert('tag', [
      { main: { code: 'new', label: 'New tag' } },
      { main: { code: 'old' } },
      { main: { code: 'fresh' } },
    ]);

    const res = await db.query(
      `SELECT ${db.qi('id')} AS id, ${db.qi('code')} AS code, ${db.qi('label')} AS label ` +
      `FROM ${db.qi('tag')} ORDER BY ${db.qi('code')}`
    );
    const byCode = Object.fromEntries(res.rows.map((r) => [r.code, r]));
    assert.deepEqual(
      results.map((r) => r.main.id),
      [byCode.new.id, existing.id, byCode.fresh.id],
    );
    assert.equal(byCode.old.label, 'Old tag');
    assert.equal(byCode.fresh.label, null);
  });
});

// The README's sync scenario: the client knows no ids and upserts by natural key; re-sending
// the payload updates the existing rows, and the response must name THOSE rows.
describe(`[${DIALECT}] upsert by a natural key — re-sending the payload`, () => {
  let app;
  let db;

  before(async () => {
    ({ app, db } = await createTestApp({
      tag: {
        primary: 'id',
        ...exportTableInfo(tagSchema),
        defaultOrder: 'id',
        upsertMap: new Map([[tagSchema, ['code']]]),
      },
    }, { prefix: '/auto' }));
  });

  beforeEach(async () => {
    await cleanTables(db, ['tag']);
  });

  after(async () => {
    await app.close();
  });

  async function idsByCode() {
    const res = await db.query(
      `SELECT ${db.qi('id')} AS id, ${db.qi('code')} AS code, ${db.qi('label')} AS label FROM ${db.qi('tag')}`
    );
    return Object.fromEntries(res.rows.map((r) => [r.code, r]));
  }

  it('bulk: returns the PKs of the rows it updated and of the rows it inserted', async () => {
    await bulkSync([{ main: { code: 'a', label: 'A' } }, { main: { code: 'b', label: 'B' } }]);

    const body = await bulkSync([
      { main: { code: 'b', label: 'B2' } },
      { main: { code: 'c', label: 'C' } },
      { main: { code: 'a', label: 'A2' } },
    ]);

    const rows = await idsByCode();
    assert.deepEqual(body.map((r) => r.main.id), [rows.b.id, rows.c.id, rows.a.id]);
    assert.deepEqual([rows.a.label, rows.b.label, rows.c.label], ['A2', 'B2', 'C']);
  });

  it('single insert: returns the PK of the row it updated', async () => {
    await bulkSync([{ main: { code: 'x', label: 'X' } }, { main: { code: 'a', label: 'A' } }]);

    const res = await app.inject({
      method: 'POST', url: '/auto/rest/tag', payload: { main: { code: 'a', label: 'A2' } },
    });

    assert.equal(res.statusCode, 201, res.payload);
    const rows = await idsByCode();
    assert.equal(JSON.parse(res.payload).main.id, rows.a.id);
    assert.equal(rows.a.label, 'A2');
  });

  async function bulkSync(payload) {
    const res = await app.inject({ method: 'PUT', url: '/auto/bulk/tag', payload });
    assert.equal(res.statusCode, 200, res.payload);
    return JSON.parse(res.payload);
  }
});
