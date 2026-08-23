// `afterRead`: the read-side counterpart of the beforeInsert/beforeUpdate family.
//
// The capability under test is "declare the hook once, on the table that owns the column,
// and it runs wherever that table's rows surface" — including when they surface through a
// join declared on ANOTHER table. Every read path resolves the target through
// `dbTables[joinSchema.tableName]`, so the hook follows a join the way `readExclude` and
// `tenantScope` do (ADR 0010).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createMockPg } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { getEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/get.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import('@sinclair/typebox');

function createMockSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}

const customerFields = {
  id: Type.Number(),
  name: Type.String(),
  secret: Type.String(),
};

const orderFields = {
  id: Type.Number(),
  customerId: Type.Number(),
  total: Type.Number(),
  secret: Type.String(),
};

/**
 * `customer` is the host: it declares `customer_order` as a 1:N relation and `parent` as the
 * N:1 (unique) one, so both row-returning join families are reachable from a single fixture.
 */
function createTestDbTables(mockPg) {
  const customerSchema = createMockSchema('customer', customerFields);
  const orderSchema = createMockSchema('customer_order', orderFields);

  const DbTables = {
    customer: {
      primary: 'id',
      ...exportTableInfo(customerSchema),
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
        buildRelation(customerSchema, 'id', orderSchema, 'id', { alias: 'main_order', unique: true }),
      ],
    },
    customer_order: {
      primary: 'id',
      ...exportTableInfo(orderSchema),
      defaultOrder: 'id',
    },
  };

  return { DbTables, db: new QueryClient(mockPg) };
}

/** Records every invocation so a test can assert both the payload and the call count. */
function recordingHook(calls, transform) {
  return (db, req, rows, ctx) => {
    calls.push({ db, req, rows, ctx });
    if (transform) for (const row of rows) transform(row);
  };
}

describe('afterRead on the main table', () => {
  it('transforms the rows a search returns', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', secret: 'ENC(a)' }, { id: 2, name: 'Luigi', secret: 'ENC(b)' }], affectedRows: 2 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);
    const calls = [];
    DbTables.customer.afterRead = recordingHook(calls, (row) => {
      row.secret = row.secret.replace(/^ENC\((.*)\)$/, '$1');
    });

    const result = await searchEngine(DbTables, { db, tableConf: DbTables.customer });

    assert.equal(result.main[0].secret, 'a');
    assert.equal(result.main[1].secret, 'b');
    assert.equal(calls.length, 1, 'batched: one call for the whole result set, not one per row');
    assert.equal(calls[0].rows.length, 2);
    assert.equal(calls[0].ctx.source, 'search');
  });

  it('transforms the row a get returns', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', secret: 'ENC(a)' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);
    const calls = [];
    DbTables.customer.afterRead = recordingHook(calls, (row) => {
      row.secret = 'plain';
    });

    const result = await getEngine({ db, tableConf: DbTables.customer, id: '1' });

    assert.equal(result.main.secret, 'plain');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx.source, 'get');
  });

  it('receives the camelCase record, never the raw column names', async () => {
    const orderRows = [{ id: 10, customer_id: 1, total: 50, secret: 'x' }];
    const mockPg = createMockPg([{ rows: orderRows, affectedRows: 1 }]);
    const { DbTables, db } = createTestDbTables(mockPg);
    const calls = [];
    DbTables.customer_order.afterRead = recordingHook(calls);

    await searchEngine(DbTables, { db, tableConf: DbTables.customer_order });

    assert.equal(calls[0].rows[0].customerId, 1);
    assert.equal(calls[0].rows[0].customer_id, undefined);
  });

  it('is awaited, so an async hook completes before the result is returned', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', secret: 'ENC(a)' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);
    DbTables.customer.afterRead = async (hookDb, req, rows) => {
      await delay(0);
      for (const row of rows) row.secret = 'decrypted';
    };

    const result = await searchEngine(DbTables, { db, tableConf: DbTables.customer });

    assert.equal(result.main[0].secret, 'decrypted');
  });

  it('is not called when the read returned no rows', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createTestDbTables(mockPg);
    const calls = [];
    DbTables.customer.afterRead = recordingHook(calls);

    await searchEngine(DbTables, { db, tableConf: DbTables.customer });

    assert.equal(calls.length, 0);
  });

  it('receives the request when the caller supplied one', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', secret: 'ENC(a)' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);
    const request = { url: '/search/customer' };
    const calls = [];
    DbTables.customer.afterRead = recordingHook(calls);

    await searchEngine(DbTables, { db, tableConf: DbTables.customer, request });

    assert.equal(calls[0].req, request);
    assert.equal(calls[0].db, db);
  });
});

describe('afterRead follows a join', () => {
  it('runs the joined table\'s own hook on joinMultiple rows', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', secret: 'ENC(a)' }], affectedRows: 1 },
      { rows: [{ id: 10, customer_id: 1, total: 50, secret: 'ENC(child)' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);
    const calls = [];
    // Declared on the CHILD table only — the host `customer` knows nothing about it.
    DbTables.customer_order.afterRead = recordingHook(calls, (row) => {
      row.secret = row.secret.replace(/^ENC\((.*)\)$/, '$1');
    });

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinMultiple: { customer_order: {} },
    });

    assert.equal(result.joinMultiple.customer_order[0].secret, 'child');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx.source, 'joinMultiple');
    assert.equal(calls[0].ctx.alias, 'customer_order');
  });

  it('runs the joined table\'s own hook on joinLeft rows', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', secret: 'ENC(a)' }], affectedRows: 1 },
      { rows: [{ id: 1, customer_id: 1, total: 50, secret: 'ENC(parent)' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);
    const calls = [];
    DbTables.customer_order.afterRead = recordingHook(calls, (row) => {
      row.secret = row.secret.replace(/^ENC\((.*)\)$/, '$1');
    });

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinLeft: { main_order: {} },
    });

    assert.equal(result.joinLeft.main_order[0].secret, 'parent');
    assert.equal(calls[0].ctx.source, 'joinLeft');
    assert.equal(calls[0].ctx.alias, 'main_order');
  });

  it('runs the host hook and the joined hook independently in one search', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', secret: 'ENC(host)' }], affectedRows: 1 },
      { rows: [{ id: 10, customer_id: 1, total: 50, secret: 'ENC(child)' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);
    const seen = [];
    DbTables.customer.afterRead = (hookDb, req, rows, ctx) => seen.push(['customer', ctx.source]);
    DbTables.customer_order.afterRead = (hookDb, req, rows, ctx) => seen.push(['customer_order', ctx.source]);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinMultiple: { customer_order: {} },
    });

    // Each table's hook fires once, tagged with the source that produced its rows. The order
    // between them is fixed by the correlation guarantee below, not asserted here.
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.slice().sort(), [['customer', 'search'], ['customer_order', 'joinMultiple']]);
    assert.equal(result.main.length, 1);
    assert.equal(result.joinMultiple.customer_order.length, 1);
  });

  it('runs the main hook after the joins, so a rewritten key still correlates', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', secret: 'ENC(a)' }], affectedRows: 1 },
      { rows: [{ id: 10, customer_id: 1, total: 50, secret: 'x' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);
    // A hook that rewrites the very column the relation joins on: the side query must still
    // be correlated to the value the database returned.
    DbTables.customer.afterRead = (hookDb, req, rows) => {
      for (const row of rows) row.id = `masked-${row.id}`;
    };

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinMultiple: { customer_order: {} },
    });

    const joinCall = mockPg.calls[1];
    assert.ok(joinCall.values.includes(1), 'the join must bind the stored key, not the masked one');
    assert.ok(!joinCall.values.includes('masked-1'));
    assert.equal(result.main[0].id, 'masked-1');
    assert.equal(result.joinMultiple.customer_order.length, 1);
  });

  it('does not run on joinGroup, whose rows are aggregates and not table rows', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', secret: 'ENC(a)' }], affectedRows: 1 },
      { rows: [{ sum_total: 150 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);
    const calls = [];
    DbTables.customer_order.afterRead = recordingHook(calls);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinGroup: { customer_order: { aggregations: { sum: ['total'] } } },
    });

    assert.equal(calls.length, 0);
  });
});
