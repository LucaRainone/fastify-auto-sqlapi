import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { bulkUpsertEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk-upsert.js'));
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

function createMockPg(responses = []) {
  let callIndex = 0;
  const calls = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      const response = responses[callIndex] || { rows: [], affectedRows: 0 };
      callIndex++;
      return Promise.resolve(response);
    },
  };
}

const mockRequest = {};

const customerFields = {
  id: Type.Number(),
  name: Type.String(),
  email: Type.String(),
};

const orderFields = {
  id: Type.Number(),
  customerId: Type.Number(),
  total: Type.Number(),
  status: Type.String(),
};

function createTestDbTables(mockPg, opts = {}) {
  const customerSchema = createMockSchema('customer', customerFields);
  const orderSchema = createMockSchema('customer_order', orderFields);

  const customerInfo = exportTableInfo(customerSchema);
  const orderInfo = exportTableInfo(orderSchema);

  const DbTables = {
    customer: {
      primary: 'id',
      ...customerInfo,
      defaultOrder: 'id',
      excludeFromCreation: opts.excludeFromCreation || [],
      allowedWriteJoins: opts.allowedWriteJoins ?? [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId'),
      ],
      ...(opts.upsertMap ? { upsertMap: opts.upsertMap } : {}),
    },
    customer_order: {
      primary: 'id',
      ...orderInfo,
      defaultOrder: 'id',
      excludeFromCreation: opts.secondaryExclude || [],
    },
  };

  return { DbTables, db: new QueryClient(mockPg), customerSchema, orderSchema };
}

describe('bulkUpsertEngine - bulk insert (no upsertMap)', () => {
  it('inserts all mains in a single bulkInsert query, returns PK-only', async () => {
    const mockPg = createMockPg([
      // Single bulk insert for both mains (PK-only)
      { rows: [
        { id: 1 },
        { id: 2 },
      ], affectedRows: 2 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const results = await bulkUpsertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      items: [
        { main: { name: 'Mario', email: 'mario@test.it' } },
        { main: { name: 'Luigi', email: 'luigi@test.it' } },
      ],
    });

    assert.equal(results.length, 2);
    assert.equal(results[0].main.id, 1);
    assert.equal(results[0].main.name, undefined);
    assert.equal(results[1].main.id, 2);
    // Only 1 SQL call for both mains
    assert.equal(mockPg.calls.length, 1);
    assert.ok(mockPg.calls[0].text.includes('INSERT INTO "customer"'));
  });

  it('returns PK-only results without secondaries/deletions', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const results = await bulkUpsertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      items: [{ main: { name: 'Mario', email: 'mario@test.it' } }],
    });

    assert.equal(results[0].main.id, 1);
    assert.equal(results[0].secondaries, undefined);
    assert.equal(results[0].deletions, undefined);
  });
});

describe('bulkUpsertEngine - bulk upsert with upsertMap', () => {
  it('uses bulkInsertOrUpdate with ON CONFLICT', async () => {
    const mockPg = createMockPg([
      { rows: [
        { id: 1 },
        { id: 2 },
      ], affectedRows: 2 },
    ]);
    const { DbTables, db, customerSchema } = createTestDbTables(mockPg);
    DbTables.customer.upsertMap = new Map([[customerSchema, ['email']]]);

    const results = await bulkUpsertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      items: [
        { main: { name: 'Mario', email: 'mario@test.it' } },
        { main: { name: 'Luigi', email: 'luigi@test.it' } },
      ],
    });

    assert.equal(mockPg.calls.length, 1);
    assert.ok(mockPg.calls[0].text.includes('ON CONFLICT'));
    assert.equal(results.length, 2);
  });
});

describe('bulkUpsertEngine - with secondaries', () => {
  it('processes secondaries with FK auto-fill per item after bulk main', async () => {
    const mockPg = createMockPg([
      // Bulk insert mains (PK-only)
      { rows: [
        { id: 10 },
        { id: 20 },
      ], affectedRows: 2 },
      // Item 1: secondary bulk insert (PK-only)
      { rows: [{ id: 100 }], affectedRows: 1 },
      // Item 2: secondary bulk insert (PK-only)
      { rows: [{ id: 101 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const results = await bulkUpsertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      items: [
        {
          main: { name: 'Mario', email: 'mario@test.it' },
          secondaries: { customer_order: [{ total: 50, status: 'pending' }] },
        },
        {
          main: { name: 'Luigi', email: 'luigi@test.it' },
          secondaries: { customer_order: [{ total: 75, status: 'new' }] },
        },
      ],
    });

    assert.equal(results.length, 2);
    assert.ok(results[0].secondaries);
    assert.ok(results[1].secondaries);
    // 1 bulk main + 2 secondary inserts = 3 queries total
    assert.equal(mockPg.calls.length, 3);
    // FK auto-fill: item 1 → customer_id = 10, item 2 → customer_id = 20
    assert.ok(mockPg.calls[1].values.includes(10));
    assert.ok(mockPg.calls[2].values.includes(20));
  });
});

describe('bulkUpsertEngine - with deletions', () => {
  it('processes deletions per item', async () => {
    const mockPg = createMockPg([
      // Bulk insert mains (PK-only)
      { rows: [{ id: 1 }], affectedRows: 1 },
      // Deletion (affectedRows)
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const results = await bulkUpsertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      items: [
        {
          main: { name: 'Mario', email: 'mario@test.it' },
          deletions: { customer_order: [{ id: 5 }] },
        },
      ],
    });

    assert.equal(results.length, 1);
    assert.ok(results[0].deletions);
    assert.ok(mockPg.calls[1].text.includes('DELETE FROM "customer_order"'));
  });
});

describe('bulkUpsertEngine - hooks', () => {
  it('calls beforeInsert for each record before bulk query', async () => {
    const hookCalls = [];
    const mockPg = createMockPg([
      { rows: [
        { id: 1 },
        { id: 2 },
      ], affectedRows: 2 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);
    DbTables.customer.beforeInsert = async (_db, _req, record) => {
      hookCalls.push({ ...record });
    };

    await bulkUpsertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      items: [
        { main: { name: 'Mario', email: 'mario@test.it' } },
        { main: { name: 'Luigi', email: 'luigi@test.it' } },
      ],
    });

    assert.equal(hookCalls.length, 2);
    assert.equal(hookCalls[0].name, 'Mario');
    assert.equal(hookCalls[1].name, 'Luigi');
  });

  it('beforeInsert can mutate records before bulk insert', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);
    DbTables.customer.beforeInsert = async (_db, _req, record) => {
      record.status = 'active';
    };

    await bulkUpsertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      items: [{ main: { name: 'Mario', email: 'mario@test.it' } }],
    });

    // The INSERT should include the mutated field
    assert.ok(mockPg.calls[0].values.includes('active'));
  });

  it('calls afterInsert for each item with merged record', async () => {
    const hookCalls = [];
    const mockPg = createMockPg([
      { rows: [
        { id: 10 },
        { id: 20 },
      ], affectedRows: 2 },
      // Item 1: secondary (PK-only)
      { rows: [{ id: 100 }], affectedRows: 1 },
      // Item 2: no secondaries
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);
    DbTables.customer.afterInsert = async (_db, _req, record, secondaryRecords) => {
      hookCalls.push({ record: { ...record }, secondaryRecords });
    };

    await bulkUpsertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      items: [
        {
          main: { name: 'Mario', email: 'mario@test.it' },
          secondaries: { customer_order: [{ total: 50, status: 'pending' }] },
        },
        { main: { name: 'Luigi', email: 'luigi@test.it' } },
      ],
    });

    assert.equal(hookCalls.length, 2);
    // Item 1: has secondaries, merged record has PK + input
    assert.equal(hookCalls[0].record.id, 10);
    assert.equal(hookCalls[0].record.name, 'Mario');
    assert.ok(hookCalls[0].secondaryRecords);
    assert.equal(hookCalls[0].secondaryRecords.customer_order.length, 1);
    // Item 2: no secondaries, merged record
    assert.equal(hookCalls[1].record.id, 20);
    assert.equal(hookCalls[1].secondaryRecords, undefined);
  });
});

describe('bulkUpsertEngine - mixed items', () => {
  it('handles items with and without secondaries/deletions', async () => {
    const mockPg = createMockPg([
      // Bulk insert both mains (PK-only)
      { rows: [
        { id: 1 },
        { id: 2 },
      ], affectedRows: 2 },
      // Item 2: secondary (PK-only)
      { rows: [{ id: 100 }], affectedRows: 1 },
      // Item 2: deletion (affectedRows)
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const results = await bulkUpsertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      items: [
        { main: { name: 'Mario', email: 'mario@test.it' } },
        {
          main: { name: 'Luigi', email: 'luigi@test.it' },
          secondaries: { customer_order: [{ total: 99, status: 'new' }] },
          deletions: { customer_order: [{ id: 50 }] },
        },
      ],
    });

    assert.equal(results.length, 2);
    assert.equal(results[0].secondaries, undefined);
    assert.equal(results[0].deletions, undefined);
    assert.ok(results[1].secondaries);
    assert.ok(results[1].deletions);
  });

  it('returns empty array for empty items', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const results = await bulkUpsertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      items: [],
    });

    assert.equal(results.length, 0);
    assert.equal(mockPg.calls.length, 0);
  });
});
