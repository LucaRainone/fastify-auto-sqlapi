// Bulk upsert through the engine: each item — and each secondary row — writes its own fields.
// Items that do not all share the same keys must neither lose a field nor overwrite a column
// they omit. The driver-level cases live in query-client-bulk-fields.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockPg, createMockSchema, insertedRows, upsertUpdatedColumns } from './_harness.js';

const { bulkUpsertEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-upsert.js'));
const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import(path.join(ROOT, 'dist/index.js'));

const canon = (row) => JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]));

function rowsWrittenTo(calls, table) {
  return calls
    .filter((c) => c.text.startsWith(`INSERT INTO "${table}"`))
    .flatMap(insertedRows)
    .map(canon)
    .sort();
}

const customerSchema = createMockSchema('customer', {
  id: Type.Optional(Type.Number()),
  name: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
});
const orderSchema = createMockSchema('customer_order', {
  id: Type.Optional(Type.Number()),
  customerId: Type.Optional(Type.Number()),
  total: Type.Optional(Type.Number()),
  status: Type.Optional(Type.String()),
});

function createDbTables(opts = {}) {
  return {
    customer: {
      primary: 'id',
      ...exportTableInfo(customerSchema),
      defaultOrder: 'id',
      allowedWriteJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
      ],
      ...(opts.upsertMap ? { upsertMap: opts.upsertMap } : {}),
    },
    customer_order: { primary: 'id', ...exportTableInfo(orderSchema), defaultOrder: 'id' },
  };
}

/**
 * Answers every INSERT with one PK per inserted row: mains get their `name` as id, child rows
 * a sequential id. Statement count and order are left to the engine.
 */
function createDb() {
  let nextChildId = 100;
  const mockPg = createMockPg((call) => {
    const rows = insertedRows(call).map((r) => ({ id: r.name ?? nextChildId++ }));
    return { rows, affectedRows: rows.length };
  });
  return { mockPg, db: new QueryClient(mockPg) };
}

describe('bulkUpsertEngine - items with different fields', () => {
  it('writes a field present only on a later item', async () => {
    const { mockPg, db } = createDb();
    const DbTables = createDbTables();

    await bulkUpsertEngine({
      db, tableConf: DbTables.customer, dbTables: DbTables, request: {},
      items: [
        { main: { name: 'Mario' } },
        { main: { name: 'Luigi', email: 'luigi@test.it' } },
      ],
    });

    assert.deepEqual(
      rowsWrittenTo(mockPg.calls, 'customer'),
      [{ name: 'Mario' }, { name: 'Luigi', email: 'luigi@test.it' }].map(canon).sort(),
    );
  });

  it('does not overwrite on upsert a column an item omits', async () => {
    const { mockPg, db } = createDb();
    const DbTables = createDbTables({ upsertMap: new Map([[customerSchema, ['id']]]) });

    await bulkUpsertEngine({
      db, tableConf: DbTables.customer, dbTables: DbTables, request: {},
      items: [
        { main: { id: 1, name: 'Mario', email: 'mario@test.it' } },
        { main: { id: 2, name: 'Luigi' } },
      ],
    });

    assert.deepEqual(
      rowsWrittenTo(mockPg.calls, 'customer'),
      [{ id: 1, name: 'Mario', email: 'mario@test.it' }, { id: 2, name: 'Luigi' }].map(canon).sort(),
    );
    const statementForLuigi = mockPg.calls.find((c) => insertedRows(c).some((r) => r.id === 2));
    assert.deepEqual(upsertUpdatedColumns(statementForLuigi), ['name']);
  });

  it('returns results in input order', async () => {
    const { db } = createDb();
    const DbTables = createDbTables();

    const results = await bulkUpsertEngine({
      db, tableConf: DbTables.customer, dbTables: DbTables, request: {},
      items: [
        { main: { name: 'a' } },
        { main: { name: 'b', email: 'b@test.it' } },
        { main: { name: 'c' } },
      ],
    });

    assert.deepEqual(results.map((r) => r.main.id), ['a', 'b', 'c']);
  });

  it('writes secondaries with different fields each with its own fields', async () => {
    const { mockPg, db } = createDb();
    const DbTables = createDbTables();

    await bulkUpsertEngine({
      db, tableConf: DbTables.customer, dbTables: DbTables, request: {},
      items: [{
        main: { name: 'Mario' },
        secondaries: { customer_order: [{ total: 50 }, { total: 75, status: 'shipped' }] },
      }],
    });

    assert.deepEqual(
      rowsWrittenTo(mockPg.calls, 'customer_order'),
      [
        { customer_id: 'Mario', total: 50 },
        { customer_id: 'Mario', total: 75, status: 'shipped' },
      ].map(canon).sort(),
    );
  });
});

describe('insertEngine - secondaries with different fields', () => {
  it('writes each secondary with its own fields', async () => {
    const { mockPg, db } = createDb();
    const DbTables = createDbTables();

    await insertEngine({
      db, tableConf: DbTables.customer, dbTables: DbTables, request: {},
      record: { name: 'Mario' },
      secondaries: { customer_order: [{ total: 50, status: 'shipped' }, { total: 75 }] },
    });

    assert.deepEqual(
      rowsWrittenTo(mockPg.calls, 'customer_order'),
      [
        { customer_id: 'Mario', total: 50, status: 'shipped' },
        { customer_id: 'Mario', total: 75 },
      ].map(canon).sort(),
    );
  });
});
