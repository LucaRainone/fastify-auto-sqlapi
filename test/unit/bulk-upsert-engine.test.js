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
      const response = responses[callIndex] || { rows: [], rowCount: 0 };
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
  it('inserts all mains in a single bulkInsert query', async () => {
    const mockPg = createMockPg([
      // Single bulk insert for both mains
      { rows: [
        { id: 1, name: 'Mario', email: 'mario@test.it' },
        { id: 2, name: 'Luigi', email: 'luigi@test.it' },
      ], rowCount: 2 },
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
    assert.equal(results[0].main.name, 'Mario');
    assert.equal(results[1].main.name, 'Luigi');
    // Only 1 SQL call for both mains
    assert.equal(mockPg.calls.length, 1);
    assert.ok(mockPg.calls[0].text.includes('INSERT INTO "customer"'));
  });

  it('returns camelCase results without secondaries/deletions', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it' }], rowCount: 1 },
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
        { id: 1, name: 'Mario', email: 'mario@test.it' },
        { id: 2, name: 'Luigi', email: 'luigi@test.it' },
      ], rowCount: 2 },
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
      // Bulk insert mains
      { rows: [
        { id: 10, name: 'Mario', email: 'mario@test.it' },
        { id: 20, name: 'Luigi', email: 'luigi@test.it' },
      ], rowCount: 2 },
      // Item 1: secondary bulk insert
      { rows: [{ id: 100, customer_id: 10, total: 50, status: 'pending' }], rowCount: 1 },
      // Item 2: secondary bulk insert
      { rows: [{ id: 101, customer_id: 20, total: 75, status: 'new' }], rowCount: 1 },
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
      // Bulk insert mains
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it' }], rowCount: 1 },
      // Deletion
      { rows: [{ id: 5, customer_id: 1, total: 50, status: 'old' }], rowCount: 1 },
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

describe('bulkUpsertEngine - mixed items', () => {
  it('handles items with and without secondaries/deletions', async () => {
    const mockPg = createMockPg([
      // Bulk insert both mains
      { rows: [
        { id: 1, name: 'Mario', email: 'mario@test.it' },
        { id: 2, name: 'Luigi', email: 'luigi@test.it' },
      ], rowCount: 2 },
      // Item 2: secondary
      { rows: [{ id: 100, customer_id: 2, total: 99, status: 'new' }], rowCount: 1 },
      // Item 2: deletion
      { rows: [{ id: 50, customer_id: 2, total: 10, status: 'old' }], rowCount: 1 },
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
