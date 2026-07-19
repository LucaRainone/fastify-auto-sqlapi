import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALECT,
  createTestApp,
  cleanTables,
  seedRows,
  exportTableInfo,
  toUnderscore,
  Type,
} from './_helpers.js';

// A computed field that binds its own parameter, combined with an ordinary filter.
// Before the placeholder binding was fixed, the computed's `?` resolved to the *other*
// filter's value and the query silently returned the wrong rows.

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

const DbTables = {
  customer: {
    primary: 'id',
    ...exportTableInfo(customerSchema),
    defaultOrder: 'id',
    computedFields: {
      // Bound value: the '%vip%' pattern. Its placeholder must resolve to '%vip%',
      // never to whatever another filter happens to bind.
      tier: ({ qiCol }) => ({
        expr: `CASE WHEN ${qiCol('email')} LIKE ? THEN 'vip' ELSE 'std' END`,
        values: ['%vip%'],
        type: Type.String(),
      }),
    },
  },
};

describe(`[${DIALECT}] computed fields with bound values`, () => {
  let app;
  let db;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));

    await cleanTables(db, ['customer_order', 'customer']);
    await seedRows(db, 'customer', [
      { name: 'Mario', email: 'mario+vip@test.it', is_active: true },
      { name: 'Mario', email: 'mario@test.it', is_active: true },
      { name: 'Luigi', email: 'luigi+vip@test.it', is_active: true },
    ]);
  });

  after(async () => {
    await app.close();
  });

  it('filters on a computed field alongside a plain filter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer',
      payload: { filters: { name: 'Mario', tier: 'vip' } },
    });

    assert.equal(res.statusCode, 200, res.body);
    const { main } = res.json();

    // Exactly one row: named Mario AND with a vip email
    assert.equal(main.length, 1, `expected 1 row, got ${JSON.stringify(main)}`);
    assert.equal(main[0].email, 'mario+vip@test.it');
  });

  it('applies a condition on a computed field alongside a plain filter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer',
      payload: {
        filters: { name: 'Mario' },
        conditions: [{ field: 'tier', method: 'isEqual', params: ['std'] }],
      },
    });

    assert.equal(res.statusCode, 200, res.body);
    const { main } = res.json();
    assert.equal(main.length, 1, `expected 1 row, got ${JSON.stringify(main)}`);
    assert.equal(main[0].email, 'mario@test.it');
  });

  it('orders by a computed field alongside a plain filter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=tier',
      payload: { filters: { isActive: true } },
    });

    assert.equal(res.statusCode, 200, res.body);
    const { main } = res.json();
    assert.equal(main.length, 3);
    // 'std' sorts before 'vip': the non-vip customer comes first
    assert.equal(main[0].email, 'mario@test.it');
  });

  it('counts correctly when paginating a computed filter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?page=1&itemsPerPage=10',
      payload: { filters: { isActive: true, tier: 'vip' } },
    });

    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.main.length, 2);
    assert.equal(body.pagination.total, 2, 'COUNT must bind the same values as the main query');
  });
});
