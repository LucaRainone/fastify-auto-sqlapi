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

// Regression suite for the placeholder-misbinding class of bug: an aggregation orderBy
// (3-part, with its own bound filter value) combined with a filtered joinLeft (bound value
// in the LEFT JOIN's WHERE extra) on the same query. This is the exact combination that
// once shipped broken: each fragment numbered its placeholders independently, so the WHERE
// could silently read the ORDER BY's value and vice versa.
//
// A query with swapped bindings still EXECUTES on both dialects — Postgres binds $n by
// number, MySQL binds ? by position — so executability checks cannot catch it. These tests
// therefore assert CONTENT: which rows come back and in which order, from seed data chosen
// so that any value swap changes the result.

function createSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}

const orgSchema = createSchema('organization', {
  id: Type.Optional(Type.Integer()),
  name: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
});

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

const DbTables = {
  organization: { primary: 'id', ...exportTableInfo(orgSchema), defaultOrder: 'id' },
  customer: {
    primary: 'id',
    ...exportTableInfo(customerSchema),
    defaultOrder: 'id',
    allowedReadJoins: [
      // Multiple children: enables joinGroup and the 3-part aggregation orderBy.
      buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'orders' }),
      // Unique parent: enables joinLeft with a filter on the parent.
      buildRelation(customerSchema, 'organizationId', orgSchema, 'id', { alias: 'org', unique: true }),
    ],
  },
  customer_order: { primary: 'id', ...exportTableInfo(orderSchema), defaultOrder: 'id' },
};

// Every request combines the two bound fragments; orderBy varies per test.
const combinedBody = {
  joinGroup: { orders: { aggregations: { sum: ['total'] }, filters: { status: 'pending' } } },
  joinLeft: { org: { filters: { name: 'Acme' } } },
};

describe(`[${DIALECT}] aggregation orderBy + filtered joinLeft (misbinding regression)`, () => {
  let app;
  let db;
  let acmeOrgId;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));

    try {
      await db.query(`SELECT 1 FROM ${db.qi('organization')} LIMIT 1`);
    } catch {
      throw new Error(
        "Table 'organization' is missing: the test database predates it. " +
        'Recreate it with: npm run test:teardown && npm run test:setup'
      );
    }

    await cleanTables(db, ['customer_order', 'customer', 'organization']);

    const orgs = await seedRows(db, 'organization', [
      { name: 'Acme', city: 'Rome' },
      { name: 'Globex', city: 'Milan' },
    ]);
    const [acmeId, globexId] = orgs.map((o) => o.id);
    acmeOrgId = acmeId;

    // Pending-total sums, Acme customers only: Luigi 300 > Mario 100 > Anna 0 (no orders).
    // Peach (Globex) has the highest pending sum, so a leaked filter shows up in the order.
    // Globex is also seeded after Acme: computeMax=organizationId flips from Acme's id to
    // Globex's if the joinLeft filter is misapplied to the COUNT/compute queries.
    const customers = await seedRows(db, 'customer', [
      { name: 'Mario', email: 'mario@test.it', is_active: true, organization_id: acmeId },
      { name: 'Luigi', email: 'luigi@test.it', is_active: true, organization_id: acmeId },
      { name: 'Anna', email: 'anna@test.it', is_active: false, organization_id: acmeId },
      { name: 'Peach', email: 'peach@test.it', is_active: true, organization_id: globexId },
    ]);
    const [marioId, luigiId, , peachId] = customers.map((c) => c.id);

    await seedRows(db, 'customer_order', [
      { customer_id: marioId, total: 100, status: 'pending' },
      { customer_id: marioId, total: 900, status: 'shipped' },
      { customer_id: luigiId, total: 300, status: 'pending' },
      { customer_id: peachId, total: 500, status: 'pending' },
    ]);
  });

  after(async () => {
    await app.close();
  });

  async function search(query, body) {
    const res = await app.inject({
      method: 'POST',
      url: `/auto/search/customer?${query}`,
      payload: body,
    });
    assert.equal(res.statusCode, 200, res.payload);
    return JSON.parse(res.payload);
  }

  it('orders by filtered aggregate while joinLeft filter selects the rows', async () => {
    // Correct bindings: WHERE gets 'Acme', the ORDER BY subquery gets 'pending'.
    // Swapped bindings ('pending' in the WHERE) return no rows; 'Acme' in the aggregate
    // filter zeroes every sum and the strict Luigi > Mario > Anna order collapses.
    const body = await search(
      `orderBy=${encodeURIComponent('orders.sum.total DESC')}`,
      combinedBody
    );
    assert.deepEqual(body.main.map((c) => c.name), ['Luigi', 'Mario', 'Anna']);
  });

  it('binds a third value in the base WHERE ahead of both fragments', async () => {
    // Three bound values across three fragments, in emission order: isActive (WHERE),
    // 'Acme' (joinLeft extra), 'pending' (ORDER BY aggregate). Any pairwise swap either
    // empties the result or reverses the expected ASC order.
    const body = await search(
      `orderBy=${encodeURIComponent('orders.sum.total ASC')}`,
      { ...combinedBody, filters: { isActive: true } }
    );
    assert.deepEqual(body.main.map((c) => c.name), ['Mario', 'Luigi']);
  });

  it('reuses WHERE + joinLeft values (without orderBy values) in COUNT and compute queries', async () => {
    // The pagination COUNT and computeMax reuse the WHERE with a snapshot of its values,
    // excluding the ORDER BY's 'pending'. A wrong snapshot fails outright on Postgres
    // (parameter count mismatch) and miscounts on MySQL; a leaked joinLeft filter would
    // surface as total 4 and max organizationId = Globex's.
    // computeMax targets organizationId because the compute query renders the column
    // unqualified: a column the joined table also has (id, name) would be ambiguous here.
    const body = await search(
      `orderBy=${encodeURIComponent('orders.sum.total DESC')}&page=1&itemsPerPage=2&computeMax=organizationId`,
      combinedBody
    );
    assert.deepEqual(body.main.map((c) => c.name), ['Luigi', 'Mario']);
    assert.equal(body.pagination.total, 3);
    assert.equal(body.pagination.pages, 2);
    assert.equal(Number(body.pagination.computed.max.organizationId), acmeOrgId);
  });
});
