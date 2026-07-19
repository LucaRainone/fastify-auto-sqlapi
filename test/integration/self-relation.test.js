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

// Regression suite for the correlation-shadowing class of bug: a relation pointing back
// to the same table (customer edited-by customer via updated_by). A correlated subquery
// saying `FROM "customer"` bare shadows the outer "customer", so the correlation
// `updated_by = id` silently compares each row with itself — no error, wrong rows.
// The subquery FROM must be aliased, and everything inside must reference the alias.
//
// Seed graph: Alice edited Bob; Bob edited Carol and Dave. Edit counts are therefore
// Bob 2, Alice 1, Carol/Dave 0 — distinct values, so a shadowed correlation (which
// zeroes every count and empties every EXISTS) changes the result, not just the SQL.

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
  updatedBy: Type.Optional(Type.Integer()),
});

const DbTables = {
  customer: {
    primary: 'id',
    ...exportTableInfo(customerSchema),
    defaultOrder: 'id',
    allowedReadJoins: [
      // Rows edited by this customer: join.updated_by = main.id
      buildRelation(customerSchema, 'id', customerSchema, 'updatedBy', { alias: 'edited' }),
    ],
  },
};

describe(`[${DIALECT}] self-referencing relation (correlation shadowing regression)`, () => {
  let app;
  let db;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));

    await cleanTables(db, ['customer_order', 'customer']);

    const [alice] = await seedRows(db, 'customer', [{ name: 'Alice' }]);
    const [bob] = await seedRows(db, 'customer', [{ name: 'Bob', updated_by: alice.id }]);
    await seedRows(db, 'customer', [
      { name: 'Carol', updated_by: bob.id },
      { name: 'Dave', updated_by: bob.id },
    ]);
  });

  after(async () => {
    await app.close();
  });

  async function search(query, body) {
    const res = await app.inject({
      method: 'POST',
      url: `/auto/search/customer${query ? '?' + query : ''}`,
      payload: body,
    });
    assert.equal(res.statusCode, 200, res.payload);
    return JSON.parse(res.payload);
  }

  it('joinMustExist correlates to the outer row, not to itself', async () => {
    // Who edited someone? A shadowed correlation asks "who edited themselves" → nobody.
    const body = await search('', { joinMustExist: { edited: {} } });
    assert.deepEqual(body.main.map((c) => c.name), ['Alice', 'Bob']);
  });

  it('joinMustExist filters apply to the inner (aliased) row', async () => {
    // Who edited Carol? The name filter must hit the edited row, not the editor.
    const body = await search('', { joinMustExist: { edited: { filters: { name: 'Carol' } } } });
    assert.deepEqual(body.main.map((c) => c.name), ['Bob']);
  });

  it('aggregation orderBy counts the edited rows of each outer row', async () => {
    // A shadowed correlation zeroes every count: the DESC order collapses to the id
    // fallback and Alice comes first.
    const body = await search(
      `orderBy=${encodeURIComponent('edited.count.id DESC')}&page=1&itemsPerPage=2`,
      { joinGroup: { edited: { aggregations: { count: ['id'] } } } }
    );
    assert.deepEqual(body.main.map((c) => c.name), ['Bob', 'Alice']);
  });

  it('aggregation conditions compare the aggregate of the outer row', async () => {
    // Who edited more than one row? Only Bob (2).
    const body = await search('', {
      joinGroup: { edited: { aggregations: { count: ['id'] } } },
      conditions: [{ field: 'edited.count.id', method: 'isGreater', params: [1] }],
    });
    assert.deepEqual(body.main.map((c) => c.name), ['Bob']);
  });

  it('joinMultiple side-fetch returns the edited rows', async () => {
    // Non-correlated side query: sanity check that the self-relation also works there.
    const body = await search('', {
      filters: { name: 'Bob' },
      joinMultiple: { edited: {} },
    });
    assert.deepEqual(body.main.map((c) => c.name), ['Bob']);
    assert.deepEqual(body.joinMultiple.edited.map((c) => c.name).sort(), ['Carol', 'Dave']);
  });
});
