import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALECT,
  createTestApp,
  cleanTables,
  seedRows,
  buildRelation,
  toUnderscore,
  Type,
} from './_helpers.js';

// Regression suite for the ambiguous-column class of bug: a filtered joinLeft adds a
// LEFT JOIN to the main query, and the joined table shares column names with the main
// one (id, name — the common case for any two conventionally-named tables). Every
// main-table column reference must therefore be table-qualified, or the database
// rejects the statement ("column reference is ambiguous").
//
// Assertions are on CONTENT, not just status: org and customer both have `id` and
// `name`, with values chosen so that a reference resolved against the wrong table
// changes the result instead of erroring.

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
});

const customerSchema = createSchema('customer', {
  id: Type.Optional(Type.Integer()),
  name: Type.Optional(Type.String()),
  organizationId: Type.Optional(Type.Integer()),
});

const customerComputed = {
  loudName: ({ qiCol }) => ({
    expr: `UPPER(${qiCol('name')})`,
    values: [],
    type: Type.String(),
  }),
};

const dbTables = {
  organization: { primary: 'id', schema: orgSchema, defaultOrder: 'id' },
  customer: {
    primary: 'id',
    schema: customerSchema,
    defaultOrder: 'id',
    computedFields: customerComputed,
    allowedReadJoins: [
      buildRelation(customerSchema, 'organizationId', orgSchema, 'id', { alias: 'org', unique: true }),
    ],
  },
};

// Every request carries the filtered joinLeft, so the main query always has the LEFT JOIN.
const joinLeft = { org: { filters: { name: 'Acme' } } };

describe(`[${DIALECT}] joinLeft with shared column names (ambiguity regression)`, () => {
  let app;
  let db;
  let marioId;

  before(async () => {
    ({ app, db } = await createTestApp(dbTables, { prefix: '/auto' }));

    await cleanTables(db, ['customer_order', 'customer', 'organization']);

    const orgs = await seedRows(db, 'organization', [
      { name: 'Acme' },
      { name: 'Globex' },
    ]);

    // Customers are seeded after the orgs, so every customer id is greater than every
    // org id: an id reference resolved against the wrong table changes the numbers.
    const customers = await seedRows(db, 'customer', [
      { name: 'Mario', organization_id: orgs[0].id },
      { name: 'Luigi', organization_id: orgs[1].id },
    ]);
    marioId = customers[0].id;
  });

  after(async () => {
    await app.close();
  });

  async function search(body) {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer',
      payload: body,
    });
    assert.equal(res.statusCode, 200, res.payload);
    return JSON.parse(res.payload);
  }

  it('filters on a shared column resolve against the main table', async () => {
    const body = await search({ filters: { name: 'Mario' }, joinLeft });
    assert.deepEqual(body.main.map((c) => c.name), ['Mario']);
  });

  it('conditions on a shared column resolve against the main table', async () => {
    const body = await search({
      conditions: [{ field: 'id', method: 'isGreater', params: [0] }],
      joinLeft,
    });
    // Luigi is excluded by the org filter, not by the id condition.
    assert.deepEqual(body.main.map((c) => c.name), ['Mario']);
  });

  it('computed-field filters referencing a shared column resolve against the main table', async () => {
    const body = await search({ filters: { loudName: 'MARIO' }, joinLeft });
    assert.deepEqual(body.main.map((c) => c.name), ['Mario']);
  });

  it('compute aggregates on a shared column read the main table', async () => {
    const body = await search({ paginator: { page: 1, itemsPerPage: 5 }, compute: { max: ['id'] }, joinLeft });
    assert.equal(body.pagination.total, 1);
    // Mario's customer id, not his org's (org ids are all smaller — see the seed).
    assert.equal(Number(body.computed.max.id), marioId);
  });

  it('a computed field in select referencing a shared column reads the main table', async () => {
    const body = await search({ select: ['id', 'name', 'loudName'], joinLeft });
    assert.equal(body.main.length, 1);
    assert.equal(body.main[0].loudName, 'MARIO');
  });

  // The projection itself: with a computed field (pre-1.0 `selectComputed`) the main query
  // once built `*, <expr>` by hand, and the LEFT JOIN's columns leaked into the row — the
  // org's id and name won over Mario's.
  it("a computed field in select with a filtered joinLeft keeps the main row's own id and name", async () => {
    const body = await search({ select: ['id', 'name', 'loudName'], joinLeft });
    assert.equal(body.main.length, 1);
    assert.equal(body.main[0].id, marioId, 'the customer id, not the org id');
    assert.equal(body.main[0].name, 'Mario', 'the customer name, not the org name');
  });

  it("a parent orderBy with a computed field in select keeps the main row's own id and name", async () => {
    const body = await search({ orderBy: 'org.name', select: ['id', 'name', 'loudName'], joinLeft: { org: {} } });
    assert.deepEqual(body.main.map((c) => c.name), ['Mario', 'Luigi'], 'Acme before Globex');
    assert.equal(body.main[0].id, marioId);
  });
});
