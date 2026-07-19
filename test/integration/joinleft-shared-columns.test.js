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

const DbTables = {
  organization: { primary: 'id', ...exportTableInfo(orgSchema), defaultOrder: 'id' },
  customer: {
    primary: 'id',
    ...exportTableInfo(customerSchema),
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
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));

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

  async function search(query, body) {
    const res = await app.inject({
      method: 'POST',
      url: `/auto/search/customer${query ? '?' + query : ''}`,
      payload: body,
    });
    assert.equal(res.statusCode, 200, res.payload);
    return JSON.parse(res.payload);
  }

  it('filters on a shared column resolve against the main table', async () => {
    const body = await search('', { filters: { name: 'Mario' }, joinLeft });
    assert.deepEqual(body.main.map((c) => c.name), ['Mario']);
  });

  it('conditions on a shared column resolve against the main table', async () => {
    const body = await search('', {
      conditions: [{ field: 'id', method: 'isGreater', params: [0] }],
      joinLeft,
    });
    // Luigi is excluded by the org filter, not by the id condition.
    assert.deepEqual(body.main.map((c) => c.name), ['Mario']);
  });

  it('computed-field filters referencing a shared column resolve against the main table', async () => {
    const body = await search('', { filters: { loudName: 'MARIO' }, joinLeft });
    assert.deepEqual(body.main.map((c) => c.name), ['Mario']);
  });

  it('compute aggregates on a shared column read the main table', async () => {
    const body = await search('page=1&itemsPerPage=5&computeMax=id', { joinLeft });
    assert.equal(body.pagination.total, 1);
    // Mario's customer id, not his org's (org ids are all smaller — see the seed).
    assert.equal(Number(body.pagination.computed.max.id), marioId);
  });

  it('selectComputed referencing a shared column reads the main table', async () => {
    const body = await search('', { selectComputed: ['loudName'], joinLeft });
    assert.equal(body.main.length, 1);
    assert.equal(body.main[0].loudName, 'MARIO');
  });
});
