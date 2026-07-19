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

function createSchema(tableName, fields, col) {
  return {
    col: col ?? ((f) => toUnderscore(f)),
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
  taxNumber: Type.Optional(Type.String()),
});

const orderSchema = createSchema('customer_order', {
  id: Type.Optional(Type.Integer()),
  customerId: Type.Optional(Type.Integer()),
  total: Type.Optional(Type.Number()),
  status: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

// camelCase quoted columns: exercises qualified projections on case-sensitive identifiers
const accountSchema = createSchema('userAccount', {
  id: Type.String(),
  userId: Type.String(),
  providerId: Type.Optional(Type.String()),
  accountId: Type.Optional(Type.String()),
  accessToken: Type.Optional(Type.String()),
}, (f) => f);

const DbTables = {
  customer: {
    primary: 'id',
    ...exportTableInfo(customerSchema),
    defaultOrder: 'id',
    readExclude: ['taxNumber'],
    allowedReadJoins: [
      buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
    ],
  },
  customer_order: {
    primary: 'id',
    ...exportTableInfo(orderSchema),
    defaultOrder: 'id',
    readExclude: ['notes'],
  },
  userAccount: {
    primary: 'id',
    ...exportTableInfo(accountSchema),
    defaultOrder: 'id',
    readExclude: ['accessToken'],
  },
};

describe(`[${DIALECT}] readExclude integration`, () => {
  let app;
  let db;
  let customerIds;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));

    await cleanTables(db, ['customer_order', 'customer', 'userAccount']);

    const customers = await seedRows(db, 'customer', [
      { name: 'Mario Rossi', email: 'mario@test.it', tax_number: 'TAX-001' },
      { name: 'Luigi Verdi', email: 'luigi@test.it', tax_number: 'TAX-002' },
    ]);
    customerIds = customers.map((c) => c.id);

    await seedRows(db, 'customer_order', [
      { customer_id: customerIds[0], total: 100.5, status: 'completed', notes: 'secret note' },
    ]);

    await db.query(
      `INSERT INTO ${db.qi('userAccount')} (${db.qi('id')}, ${db.qi('userId')}, ${db.qi('providerId')}, ${db.qi('accountId')}, ${db.qi('accessToken')}) VALUES (${db.ph(1)}, ${db.ph(2)}, ${db.ph(3)}, ${db.ph(4)}, ${db.ph(5)})`,
      ['acc-1', 'user-1', 'google', 'g-123', 'super-secret-token']
    );
  });

  after(async () => {
    await app.close();
  });

  it('search omits the excluded column from results', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer',
      payload: {},
    });

    assert.equal(res.statusCode, 200, res.body);
    const { main } = res.json();
    assert.equal(main.length, 2);
    for (const row of main) {
      assert.ok(row.name, 'readable fields are still present');
      assert.equal(row.taxNumber, undefined, 'excluded field must not be returned');
      assert.ok(!('taxNumber' in row));
    }
  });

  it('get omits the excluded column from the record', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auto/rest/customer/${customerIds[0]}`,
    });

    assert.equal(res.statusCode, 200, res.body);
    const { main } = res.json();
    assert.equal(main.name, 'Mario Rossi');
    assert.ok(!('taxNumber' in main), 'excluded field must not be returned');
  });

  it('search on a table with quoted camelCase columns omits the excluded token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/userAccount',
      payload: {},
    });

    assert.equal(res.statusCode, 200, res.body);
    const { main } = res.json();
    assert.equal(main.length, 1);
    assert.equal(main[0].userId, 'user-1');
    assert.ok(!('accessToken' in main[0]), 'excluded token must not be returned');
  });

  it('joins omit the excluded column of the joined table', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer',
      payload: { joinMultiple: { customer_order: {} } },
    });

    assert.equal(res.statusCode, 200, res.body);
    const orders = res.json().joinMultiple.customer_order;
    assert.equal(orders.length, 1);
    assert.equal(Number(orders[0].total), 100.5);
    assert.ok(!('notes' in orders[0]), 'excluded join field must not be returned');
  });

  it('filtering on an excluded field is rejected with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer',
      payload: { filters: { taxNumber: 'TAX-001' } },
    });

    assert.equal(res.statusCode, 400, res.body);
  });

  it('ordering by an excluded field is rejected with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/customer?orderBy=taxNumber',
      payload: {},
    });

    assert.equal(res.statusCode, 400, res.body);
  });

  it('excluded fields remain writable and are persisted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/customer',
      payload: { main: { name: 'Anna Bianchi', email: 'anna@test.it', taxNumber: 'TAX-999' } },
    });

    assert.equal(res.statusCode, 201, res.body);
    const newId = res.json().main.id;

    // The value reached the database even though it can never be read back via the API
    const rows = await db.query(
      `SELECT ${db.qi('tax_number')} FROM ${db.qi('customer')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
      [newId]
    );
    assert.equal(rows.rows[0].tax_number, 'TAX-999');

    const readBack = await app.inject({ method: 'GET', url: `/auto/rest/customer/${newId}` });
    assert.equal(readBack.statusCode, 200);
    assert.ok(!('taxNumber' in readBack.json().main));
  });
});
