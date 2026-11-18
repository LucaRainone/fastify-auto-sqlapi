// `tenantScope` names schema fields (ADR 0032), on a real database whose columns are
// snake_case — where a field and its column differ, so a name left unresolved would reach the
// SQL as a column that does not exist. Every form is driven through the HTTP routes: a direct
// scope (read and insert), an indirect one (read through the parent, delete of another
// tenant's row) and an `anyOf` one (read).

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DIALECT, createTestApp, cleanTables, seedRows, toUnderscore, Type } from './_helpers.js';

function schemaOf(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Partial(Type.Object(fields)),
  };
}

const customerSchema = schemaOf('customer', {
  id: Type.Optional(Type.Integer()),
  name: Type.String(),
  organizationId: Type.Optional(Type.Integer()),
});
const orderSchema = schemaOf('customer_order', {
  id: Type.Optional(Type.Integer()),
  customerId: Type.Integer(),
  total: Type.Number(),
});
const swapSchema = schemaOf('shift_swap_request', {
  id: Type.Optional(Type.Integer()),
  requesterAgentId: Type.Optional(Type.Integer()),
  targetAgentId: Type.Optional(Type.Integer()),
  message: Type.Optional(Type.String()),
});

const dbTables = {
  customer: {
    primary: 'id',
    schema: customerSchema,
    defaultOrder: 'id',
    insertExclude: ['id'],
    tenantScope: { column: 'organizationId' },
  },
  customer_order: {
    primary: 'id',
    schema: orderSchema,
    defaultOrder: 'id',
    tenantScope: {
      column: 'organizationId',
      through: { schema: customerSchema, localField: 'customerId', foreignField: 'id' },
    },
  },
  shift_swap_request: {
    primary: 'id',
    schema: swapSchema,
    defaultOrder: 'id',
    tenantScope: { anyOf: ['requesterAgentId', 'targetAgentId'] },
  },
};

describe(`[${DIALECT}] tenantScope names schema fields`, () => {
  let app;
  let db;
  let mine;
  let theirs;
  let orders;

  before(async () => {
    ({ app, db } = await createTestApp(dbTables, { prefix: '/auto', getTenantId: () => 1 }));
  });

  beforeEach(async () => {
    await cleanTables(db, ['customer_order', 'customer', 'shift_swap_request']);
    [mine] = await seedRows(db, 'customer', [{ name: 'Mine', organization_id: 1 }], 'id');
    [theirs] = await seedRows(db, 'customer', [{ name: 'Theirs', organization_id: 2 }], 'id');
    orders = await seedRows(db, 'customer_order', [
      { customer_id: mine.id, total: 1 },
      { customer_id: theirs.id, total: 2 },
    ], 'id');
    await seedRows(db, 'shift_swap_request', [
      { requester_agent_id: 1, target_agent_id: 3, message: 'asked' },
      { requester_agent_id: 3, target_agent_id: 1, message: 'offered' },
      { requester_agent_id: 3, target_agent_id: 4, message: 'other' },
    ], 'id');
  });

  after(async () => {
    await cleanTables(db, ['customer_order', 'customer', 'shift_swap_request']);
    await app.close();
  });

  const search = async (table, payload = {}) => {
    const res = await app.inject({ method: 'POST', url: `/auto/search/${table}`, payload });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().main;
  };

  it('a direct scope returns the rows of the caller tenant only', async () => {
    assert.deepEqual((await search('customer')).map((r) => r.name), ['Mine']);
  });

  it('a direct scope writes the caller tenant on insert', async () => {
    const res = await app.inject({ method: 'POST', url: '/auto/rest/customer', payload: { main: { name: 'New' } } });
    assert.equal(res.statusCode, 201, res.body);
    const { rows } = await db.query(
      `SELECT ${db.qi('organization_id')} AS org FROM ${db.qi('customer')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
      [res.json().main.id]
    );
    assert.equal(Number(rows[0].org), 1);
  });

  it('an indirect scope returns the rows whose parent belongs to the caller tenant', async () => {
    assert.deepEqual((await search('customer_order')).map((r) => r.id), [orders[0].id]);
  });

  it('an indirect scope answers 404 to a delete of another tenant row', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/auto/rest/customer_order/${orders[1].id}` });
    assert.equal(res.statusCode, 404, res.body);
  });

  it('an anyOf scope returns the rows the caller is a party to', async () => {
    assert.deepEqual((await search('shift_swap_request')).map((r) => r.message), ['asked', 'offered']);
  });
});
