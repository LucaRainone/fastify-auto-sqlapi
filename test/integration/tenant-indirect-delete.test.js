// Deletes under an indirect tenant scope, on a real database. The row to delete is owned
// through its parent (customer_order → customer.organization_id), so the DELETE tests the
// parent with a correlated EXISTS. MySQL refuses a DELETE whose subquery reads the table being
// deleted from (error 1093): these tests lock the statement down on both dialects, for the
// single delete and the bulk one.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DIALECT, createTestApp, cleanTables, seedRows, Type } from './_helpers.js';

function schemaOf(tableName, fields, colMap) {
  return {
    col: (f) => colMap[f] ?? f,
    colMap,
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Partial(Type.Object(fields)),
  };
}

const customerSchema = schemaOf(
  'customer',
  { id: Type.Optional(Type.Integer()), name: Type.String(), organizationId: Type.Integer() },
  { id: 'id', name: 'name', organizationId: 'organization_id' },
);
const orderSchema = schemaOf(
  'customer_order',
  { id: Type.Optional(Type.Integer()), customerId: Type.Integer(), total: Type.Number() },
  { id: 'id', customerId: 'customer_id', total: 'total' },
);

const dbTables = {
  customer_order: {
    primary: 'id',
    schema: orderSchema,
    defaultOrder: 'id',
    tenantScope: {
      column: 'organization_id',
      through: { schema: customerSchema, localField: 'customer_id', foreignField: 'id' },
    },
  },
};

describe(`[${DIALECT}] delete under an indirect tenant scope`, () => {
  let app;
  let db;
  let mine;
  let theirs;

  before(async () => {
    ({ app, db } = await createTestApp(dbTables, { prefix: '/auto', getTenantId: () => 1 }));
    await cleanTables(db, ['customer_order', 'customer']);
    [mine] = await seedRows(db, 'customer', [{ name: 'Mine', organization_id: 1 }], 'id');
    [theirs] = await seedRows(db, 'customer', [{ name: 'Theirs', organization_id: 2 }], 'id');
  });

  after(async () => {
    await cleanTables(db, ['customer_order', 'customer']);
    await app.close();
  });

  let orders;
  beforeEach(async () => {
    await cleanTables(db, ['customer_order']);
    orders = await seedRows(db, 'customer_order', [
      { customer_id: mine.id, total: 1 },
      { customer_id: mine.id, total: 2 },
      { customer_id: theirs.id, total: 3 },
    ], 'id');
  });

  const remaining = async () =>
    (await db.query(`SELECT id FROM ${db.qi('customer_order')} ORDER BY id`, [])).rows.map((r) => Number(r.id));

  it('DELETE /rest/:table/:id removes an owned row', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/auto/rest/customer_order/${orders[0].id}` });
    assert.equal(res.statusCode, 200, `body: ${res.body}`);
    assert.deepEqual(await remaining(), [orders[1].id, orders[2].id]);
  });

  it('DELETE /rest/:table/:id of another tenant\'s row is a 404 and deletes nothing', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/auto/rest/customer_order/${orders[2].id}` });
    assert.equal(res.statusCode, 404, `body: ${res.body}`);
    assert.deepEqual(await remaining(), orders.map((o) => o.id));
  });

  it('bulk delete removes the owned rows and leaves another tenant\'s alone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/bulk/customer_order/delete',
      payload: { ids: orders.map((o) => o.id) },
    });
    assert.equal(res.statusCode, 200, `body: ${res.body}`);
    assert.deepEqual(res.json().map((r) => Number(r.main.id)).sort((a, b) => a - b), [orders[0].id, orders[1].id]);
    assert.deepEqual(await remaining(), [orders[2].id]);
  });
});
