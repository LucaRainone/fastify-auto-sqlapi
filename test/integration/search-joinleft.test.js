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
  customer: { primary: 'id', ...customerInfo, defaultOrder: 'id' },
  customer_order: {
    primary: 'id',
    ...orderInfo,
    defaultOrder: 'id',
    allowedReadJoins: [
      buildRelation(orderSchema, 'customerId', customerSchema, 'id', {
        alias: 'customer',
        unique: true,
      }),
    ],
  },
};

describe(`[${DIALECT}] joinLeft (N:1 parent) integration`, () => {
  let app;
  let db;
  let customerIds;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));
    await cleanTables(db, ['customer_order', 'customer']);

    const customers = await seedRows(db, 'customer', [
      { name: 'Mario Rossi', email: 'mario@test.it', is_active: true },
      { name: 'Luigi Verdi', email: 'luigi@test.it', is_active: false },
    ]);
    customerIds = customers.map((c) => c.id);

    await seedRows(db, 'customer_order', [
      { customer_id: customerIds[0], total: 100, status: 'completed' },
      { customer_id: customerIds[0], total: 200, status: 'pending' },
      { customer_id: customerIds[1], total: 50, status: 'completed' },
    ]);
  });

  after(async () => {
    await app.close();
  });

  it('joinLeft without filter or orderBy: side query only, no LEFT JOIN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer_order',
      payload: { joinLeft: { customer: {} } },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 3);
    assert.ok(body.joinLeft.customer);
    assert.equal(body.joinLeft.customer.length, 2);
    assert.ok(body.joinLeft.customer.every((c) => c.name));
  });

  it('joinLeft with filter on parent: filters main rows via LEFT JOIN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer_order',
      payload: {
        joinLeft: { customer: { filters: { isActive: true } } },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    // Only orders whose customer is active (Mario, 2 orders)
    assert.equal(body.main.length, 2);
    assert.ok(body.main.every((o) => o.customerId === customerIds[0]));
  });

  it('joinLeft with orderBy 2-parti on parent field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer_order?orderBy=customer.name+ASC',
      payload: { joinLeft: { customer: {} } },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 3);
    // Anna(none) | Luigi(50) | Mario(100,200) — but no Anna because no orders
    // Sorted by customer.name ASC: Luigi (V…) before Mario (R…)? No — Luigi < Mario alphabetically.
    // Verify the first row's customer is Luigi
    const firstCustomer = body.joinLeft.customer.find((c) => c.id === body.main[0].customerId);
    assert.equal(firstCustomer.name, 'Luigi Verdi');
  });

  it('rejects orderBy 2-parti on non-joinLeft alias with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer_order?orderBy=bogus.name+ASC',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });
});
