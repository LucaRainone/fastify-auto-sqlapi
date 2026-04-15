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
  organizationId: Type.Optional(Type.Integer()),
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

describe(`[${DIALECT}] search orderBy — joinGroup aggregations`, () => {
  let app;
  let db;
  let marioId;
  let luigiId;
  let annaId;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));

    await cleanTables(db, ['customer_order', 'customer']);

    // Mario → orders totals: 100 + 200 = 300
    // Luigi → orders totals: 50
    // Anna  → no orders
    const customers = await seedRows(db, 'customer', [
      { name: 'Mario Rossi', email: 'mario@test.it', is_active: true },
      { name: 'Luigi Verdi', email: 'luigi@test.it', is_active: true },
      { name: 'Anna Bianchi', email: 'anna@test.it', is_active: true },
    ]);
    marioId = customers[0].id;
    luigiId = customers[1].id;
    annaId = customers[2].id;

    await seedRows(db, 'customer_order', [
      { customer_id: marioId, total: 100.00, status: 'completed' },
      { customer_id: marioId, total: 200.00, status: 'completed' },
      { customer_id: luigiId, total: 50.00, status: 'completed' },
    ]);
  });

  after(async () => {
    await app.close();
  });

  it('orders customers by SUM of customer_order totals DESC', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=customer_order.sum.total%20DESC',
      payload: {
        joinGroups: {
          customer_order: { aggregations: { sum: ['total'] } },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 3);
    assert.equal(body.main[0].name, 'Mario Rossi');
    assert.equal(body.main[1].name, 'Luigi Verdi');
    assert.equal(body.main[2].name, 'Anna Bianchi');
  });

  it('orders customers by SUM ASC — no-data customers get 0 via COALESCE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=customer_order.sum.total%20ASC',
      payload: {
        joinGroups: {
          customer_order: { aggregations: { sum: ['total'] } },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    // COALESCE with 0: Anna (no orders → 0) first, then Luigi (50), then Mario (300)
    assert.equal(body.main[0].name, 'Anna Bianchi');
    assert.equal(body.main[1].name, 'Luigi Verdi');
    assert.equal(body.main[2].name, 'Mario Rossi');
  });

  it('supports AVG aggregation in orderBy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=customer_order.avg.total%20DESC',
      payload: {
        joinGroups: {
          customer_order: { aggregations: { avg: ['total'] } },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    // Mario avg=150, Luigi avg=50, Anna NULL→0
    assert.equal(body.main[0].name, 'Mario Rossi');
    assert.equal(body.main[1].name, 'Luigi Verdi');
  });

  it('supports COUNT aggregation in orderBy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=customer_order.count.id%20DESC',
      payload: {
        joinGroups: {
          customer_order: { aggregations: { count: ['id'] } },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    // Mario 2 orders, Luigi 1 order, Anna 0 orders (COALESCE 0)
    assert.equal(body.main[0].name, 'Mario Rossi');
    assert.equal(body.main[1].name, 'Luigi Verdi');
  });

  it('applies joinGroup filters inside the subquery', async () => {
    // Add a pending order for Luigi (total 999) — should NOT affect sum when filtering by completed
    await seedRows(db, 'customer_order', [
      { customer_id: luigiId, total: 999.00, status: 'pending' },
    ]);

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auto/search/customer?orderBy=customer_order.sum.total%20DESC',
        payload: {
          joinGroups: {
            customer_order: {
              aggregations: { sum: ['total'] },
              filters: { status: 'completed' },
            },
          },
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      // Mario still wins (300) despite Luigi's pending 999 being excluded
      assert.equal(body.main[0].name, 'Mario Rossi');
      assert.equal(body.main[1].name, 'Luigi Verdi');
    } finally {
      await db.delete('customer_order', { total: 999.00 });
    }
  });

  it('supports multi-part orderBy mixing aggregation and plain field', async () => {
    // Add a customer with same sum as Mario
    const zorros = await seedRows(db, 'customer', [
      { name: 'Zorro Test', email: 'zorro@test.it', is_active: true },
    ]);
    const zorroId = zorros[0].id;
    await seedRows(db, 'customer_order', [
      { customer_id: zorroId, total: 300.00, status: 'completed' },
    ]);

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auto/search/customer?orderBy=customer_order.sum.total%20DESC,%20name%20ASC',
        payload: {
          joinGroups: {
            customer_order: { aggregations: { sum: ['total'] } },
          },
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      // Mario and Zorro both have sum=300. Tie broken by name ASC → Mario before Zorro
      assert.equal(body.main[0].name, 'Mario Rossi');
      assert.equal(body.main[1].name, 'Zorro Test');
    } finally {
      await db.delete('customer_order', { customer_id: zorroId });
      await db.delete('customer', { id: zorroId });
    }
  });

  it('paginates correctly with aggregation orderBy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=customer_order.sum.total%20DESC&page=1&itemsPerPage=2',
      payload: {
        joinGroups: {
          customer_order: { aggregations: { sum: ['total'] } },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 2);
    assert.equal(body.pagination.total, 3);
    assert.equal(body.main[0].name, 'Mario Rossi');
    assert.equal(body.main[1].name, 'Luigi Verdi');
  });

  it('returns breakdown in joinGroups response alongside ordering', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=customer_order.sum.total%20DESC',
      payload: {
        joinGroups: {
          customer_order: { aggregations: { sum: ['total'] } },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main[0].name, 'Mario Rossi');
    assert.ok(body.joinGroups);
    assert.ok(body.joinGroups.customer_order);
    assert.ok(body.joinGroups.customer_order.sum);
  });

  it('rejects orderBy with undeclared joinGroup (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=customer_order.sum.total%20DESC',
      payload: {},
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.match(body.message, /undeclared joinGroup/);
  });

  it('rejects orderBy with undeclared aggregation (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=customer_order.sum.total%20DESC',
      payload: {
        joinGroups: {
          customer_order: { aggregations: { sum: ['id'] } },
        },
      },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.match(body.message, /undeclared aggregation/);
  });

  it('rejects orderBy when joinGroup uses by on a non-FK column (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=customer_order.sum.total%20DESC',
      payload: {
        joinGroups: {
          customer_order: { aggregations: { sum: ['total'], by: 'status' } },
        },
      },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.match(body.message, /non-FK column/);
  });

  it('accepts orderBy when joinGroup uses by on the correlation FK', async () => {
    // by: 'customerId' is the FK of the correlation (customer_order.customer_id = customer.id).
    // The main ordering is still well-defined (1 group per customer), and the response
    // contains the grouped breakdown (one row per customer) so the UI can render per-row counts.
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=customer_order.count.id%20DESC',
      payload: {
        joinGroups: {
          customer_order: {
            aggregations: { count: ['id'], by: 'customerId' },
          },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    // Mario has 2 orders, Luigi 1, Anna 0 → ordered DESC
    assert.equal(body.main[0].name, 'Mario Rossi');
    assert.equal(body.main[1].name, 'Luigi Verdi');
    // Breakdown: per-customer buckets present
    assert.ok(body.joinGroups.customer_order);
    assert.ok(Array.isArray(body.joinGroups.customer_order.rows) || body.joinGroups.customer_order.count,
      'should contain per-customer breakdown');
  });
});

// ─── Multi-tenant — FK-based scoping ──────────────────────────

describe(`[${DIALECT}] search orderBy agg with multi-tenant (FK scoping)`, () => {
  let app;
  let db;

  const tenantDbTables = {
    customer: {
      primary: 'id',
      ...customerInfo,
      defaultOrder: 'id',
      tenantScope: { column: 'organization_id' },
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

  before(async () => {
    ({ app, db } = await createTestApp(tenantDbTables, {
      prefix: '/auto',
      getTenantId: (request) => {
        const header = request.headers['x-tenant-id'];
        return header ? parseInt(header, 10) : null;
      },
    }));

    await cleanTables(db, ['customer_order', 'customer']);

    const customers = await seedRows(db, 'customer', [
      { name: 'Mario A', email: 'marioA@test.it', is_active: true, organization_id: 1 },
      { name: 'Luigi A', email: 'luigiA@test.it', is_active: true, organization_id: 1 },
      { name: 'Anna B',  email: 'annaB@test.it',  is_active: true, organization_id: 2 },
    ]);

    await seedRows(db, 'customer_order', [
      { customer_id: customers[0].id, total: 200.00, status: 'completed' },
      { customer_id: customers[1].id, total: 50.00, status: 'completed' },
      { customer_id: customers[2].id, total: 9999.00, status: 'completed' },
    ]);
  });

  after(async () => {
    await app.close();
  });

  it('tenant 1 sees only its customers, ordered by sum — tenant 2 data not visible', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=customer_order.sum.total%20DESC',
      headers: { 'x-tenant-id': '1' },
      payload: {
        joinGroups: {
          customer_order: { aggregations: { sum: ['total'] } },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 2);
    assert.equal(body.main[0].name, 'Mario A');
    assert.equal(body.main[1].name, 'Luigi A');
    assert.ok(!body.main.some((r) => r.name === 'Anna B'));
  });

  it('tenant 2 sees only its single customer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=customer_order.sum.total%20DESC',
      headers: { 'x-tenant-id': '2' },
      payload: {
        joinGroups: {
          customer_order: { aggregations: { sum: ['total'] } },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 1);
    assert.equal(body.main[0].name, 'Anna B');
  });
});
