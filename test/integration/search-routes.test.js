import { describe, it, before, after } from 'node:test';
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
  isActive: Type.Optional(Type.Boolean()),
});

const orderSchema = createSchema('customer_order', {
  id: Type.Optional(Type.Integer()),
  customerId: Type.Optional(Type.Integer()),
  total: Type.Optional(Type.Number()),
  status: Type.Optional(Type.String()),
});

const customerInfo = exportTableInfo(customerSchema);
const orderInfo = exportTableInfo(orderSchema);

const DbTables = {
  customer: {
    primary: 'id',
    ...customerInfo,
    defaultOrder: 'id',
    allowedReadJoins: [
      buildRelation(customerSchema, 'id', orderSchema, 'customerId'),
    ],
  },
  customer_order: {
    primary: 'id',
    ...orderInfo,
    defaultOrder: 'id',
  },
};

describe(`[${DIALECT}] search routes integration`, () => {
  let app;
  let db;
  let customerIds;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));

    await cleanTables(db, ['customer_order', 'customer']);

    // Seed using QueryClient so auto-increment IDs are returned portably
    const customers = await seedRows(db, 'customer', [
      { name: 'Mario Rossi', email: 'mario@test.it', is_active: true },
      { name: 'Luigi Verdi', email: 'luigi@test.it', is_active: true },
      { name: 'Anna Bianchi', email: 'anna@test.it', is_active: false },
    ]);
    customerIds = customers.map((c) => c.id);

    await seedRows(db, 'customer_order', [
      { customer_id: customerIds[0], total: 100.50, status: 'completed' },
      { customer_id: customerIds[0], total: 200.00, status: 'pending' },
      { customer_id: customerIds[1], total: 50.00, status: 'completed' },
    ]);
  });

  after(async () => {
    await app.close();
  });

  it('POST /auto/search/customer returns all records', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer',
      payload: {},
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.table, 'customer');
    assert.equal(body.main.length, 3);
  });

  it('filters by field value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer',
      payload: { filters: { isActive: true } },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 2);
    assert.ok(body.main.every((r) => r.isActive === true || r.isActive === 1));
  });

  it('filters by name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer',
      payload: { filters: { name: 'Mario Rossi' } },
    });

    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 1);
    assert.equal(body.main[0].name, 'Mario Rossi');
  });

  it('supports pagination', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?page=1&itemsPerPage=2',
      payload: {},
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 2);
    assert.ok(body.pagination);
    assert.equal(body.pagination.total, 3);
    assert.equal(body.pagination.pages, 2);
    assert.equal(body.pagination.paginator.page, 1);
    assert.equal(body.pagination.paginator.itemsPerPage, 2);
  });

  it('pagination page 2', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?page=2&itemsPerPage=2',
      payload: {},
    });

    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 1);
    assert.equal(body.pagination.paginator.page, 2);
  });

  it('supports orderBy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=name%20DESC',
      payload: {},
    });

    const body = JSON.parse(res.payload);
    assert.equal(body.main[0].name, 'Mario Rossi');
    assert.equal(body.main[1].name, 'Luigi Verdi');
    assert.equal(body.main[2].name, 'Anna Bianchi');
  });

  it('supports virtual joins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer',
      payload: {
        filters: { isActive: true },
        joins: { customer_order: {} },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.joins.customer_order);
    assert.equal(body.joins.customer_order.length, 3);
  });

  it('supports join filters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer',
      payload: {
        joins: {
          customer_order: { filters: { status: 'completed' } },
        },
      },
    });

    const body = JSON.parse(res.payload);
    assert.ok(body.joins.customer_order.every((o) => o.status === 'completed'));
  });

  it('supports joinGroups with aggregations', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer',
      payload: {
        filters: { name: 'Mario Rossi' },
        joinGroups: {
          customer_order: {
            aggregations: { sum: ['total'] },
          },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.joinGroups.customer_order);
    assert.ok(body.joinGroups.customer_order.sum);
  });

  it('search on customer_order table', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer_order',
      payload: { filters: { status: 'completed' } },
    });

    const body = JSON.parse(res.payload);
    assert.equal(body.table, 'customer_order');
    assert.equal(body.main.length, 2);
    assert.ok(body.main.every((r) => r.status === 'completed'));
  });

  it('computeMin/computeMax with pagination', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer_order?page=1&itemsPerPage=10&computeMin=total&computeMax=total',
      payload: {},
    });

    const body = JSON.parse(res.payload);
    assert.ok(body.pagination.computed);
    assert.ok(body.pagination.computed.min);
    assert.ok(body.pagination.computed.max);
  });
});
