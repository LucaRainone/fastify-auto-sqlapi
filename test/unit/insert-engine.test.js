import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/insert.js'));
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

// Fixtures
const customerFields = {
  id: Type.Number(),
  name: Type.String(),
  email: Type.String(),
  createdAt: Type.String(),
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
      allowedWriteJoins: opts.allowedWriteJoins || [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId'),
      ],
      ...(opts.upsertMap ? { upsertMap: opts.upsertMap } : {}),
      ...(opts.beforeInsert ? { beforeInsert: opts.beforeInsert } : {}),
      ...(opts.afterInsert ? { afterInsert: opts.afterInsert } : {}),
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

describe('insertEngine - main insert', () => {
  it('inserts main record with snake_case fields', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], rowCount: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario', email: 'mario@test.it' },
    });

    assert.equal(result.main.id, 1);
    assert.equal(result.main.name, 'Mario');
    assert.ok(mockPg.calls[0].text.includes('INSERT INTO "customer"'));
    assert.ok(mockPg.calls[0].text.includes('RETURNING *'));
  });

  it('returns camelCase result', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], rowCount: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario', email: 'mario@test.it' },
    });

    assert.equal(result.main.createdAt, '2024-01-01');
    assert.equal(result.main.created_at, undefined);
  });

  it('removes excludeFromCreation fields', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], rowCount: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      excludeFromCreation: ['createdAt'],
    });

    await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario', email: 'mario@test.it', createdAt: '2024-01-01' },
    });

    // created_at should NOT be in the INSERT values
    assert.ok(!mockPg.calls[0].text.includes('created_at'));
  });

  it('does not include secondaries in result when not requested', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], rowCount: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario', email: 'mario@test.it' },
    });

    assert.equal(result.secondaries, undefined);
  });
});

describe('insertEngine - hooks', () => {
  it('calls beforeInsert hook', async () => {
    let hookCalled = false;
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], rowCount: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      beforeInsert: async (_db, _req, record) => {
        hookCalled = true;
        assert.ok(record.name, 'record should have name');
      },
    });

    await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario', email: 'mario@test.it' },
    });

    assert.ok(hookCalled, 'beforeInsert should have been called');
  });

  it('calls afterInsert hook with secondaryRecords', async () => {
    let hookArgs = null;
    const mockPg = createMockPg([
      // Main insert
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], rowCount: 1 },
      // Bulk insert secondaries
      { rows: [{ id: 10, customer_id: 1, total: 100, status: 'pending' }], rowCount: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      afterInsert: async (_db, _req, record, secondaryRecords) => {
        hookArgs = { record, secondaryRecords };
      },
    });

    await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario', email: 'mario@test.it' },
      secondaries: {
        customer_order: [{ total: 100, status: 'pending' }],
      },
    });

    assert.ok(hookArgs, 'afterInsert should have been called');
    assert.equal(hookArgs.record.id, 1);
    assert.ok(hookArgs.secondaryRecords.customer_order);
    assert.equal(hookArgs.secondaryRecords.customer_order.length, 1);
  });
});

describe('insertEngine - secondaries', () => {
  it('inserts secondary records with FK auto-fill', async () => {
    const mockPg = createMockPg([
      // Main insert
      { rows: [{ id: 42, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], rowCount: 1 },
      // Bulk insert orders
      { rows: [
        { id: 10, customer_id: 42, total: 100, status: 'pending' },
        { id: 11, customer_id: 42, total: 200, status: 'completed' },
      ], rowCount: 2 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario', email: 'mario@test.it' },
      secondaries: {
        customer_order: [
          { total: 100, status: 'pending' },
          { total: 200, status: 'completed' },
        ],
      },
    });

    // Verify bulk insert was called
    const bulkCall = mockPg.calls[1];
    assert.ok(bulkCall.text.includes('INSERT INTO "customer_order"'));
    // FK auto-fill: customer_id should be 42
    assert.ok(bulkCall.values.includes(42));

    // Verify result
    assert.ok(result.secondaries);
    assert.equal(result.secondaries.customer_order.length, 2);
    assert.equal(result.secondaries.customer_order[0].customerId, 42);
  });

  it('ignores secondaries not in allowedWriteJoins', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], rowCount: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      allowedWriteJoins: [], // no write joins allowed
    });

    const result = await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario', email: 'mario@test.it' },
      secondaries: {
        customer_order: [{ total: 100, status: 'pending' }],
      },
    });

    // Only main insert, no bulk insert
    assert.equal(mockPg.calls.length, 1);
    assert.equal(result.secondaries, undefined);
  });

  it('removes excludeFromCreation from secondary records', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], rowCount: 1 },
      { rows: [{ id: 10, customer_id: 1, total: 100, status: 'pending' }], rowCount: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      secondaryExclude: ['id'],
    });

    await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario', email: 'mario@test.it' },
      secondaries: {
        customer_order: [{ id: 999, total: 100, status: 'pending' }],
      },
    });

    const bulkCall = mockPg.calls[1];
    // id should NOT be in the insert
    assert.ok(!bulkCall.text.includes('"id"'));
  });
});

describe('insertEngine - upsert', () => {
  it('uses insertOrUpdate for main when upsertMap matches', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], rowCount: 1 },
    ]);
    const { DbTables, db, customerSchema } = createTestDbTables(mockPg);

    // Set upsertMap using the same schema instance
    DbTables.customer.upsertMap = new Map([[customerSchema, ['email']]]);

    await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario', email: 'mario@test.it' },
    });

    assert.ok(mockPg.calls[0].text.includes('ON CONFLICT'));
  });

  it('uses bulkInsertOrUpdate for secondaries when upsertMap matches', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], rowCount: 1 },
      { rows: [{ id: 10, customer_id: 1, total: 100, status: 'pending' }], rowCount: 1 },
    ]);
    const { DbTables, db, orderSchema } = createTestDbTables(mockPg);

    // Set upsertMap using the same schema instance from the join definition
    DbTables.customer.upsertMap = new Map([[orderSchema, ['customerId', 'status']]]);

    await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario', email: 'mario@test.it' },
      secondaries: {
        customer_order: [{ total: 100, status: 'pending' }],
      },
    });

    const bulkCall = mockPg.calls[1];
    assert.ok(bulkCall.text.includes('ON CONFLICT'));
  });
});
