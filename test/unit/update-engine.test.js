import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { updateEngine } = await import(path.join(ROOT, 'dist/lib/engine/update.js'));
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
      allowedWriteJoins: opts.allowedWriteJoins ?? [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId'),
      ],
      ...(opts.beforeUpdate ? { beforeUpdate: opts.beforeUpdate } : {}),
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

describe('updateEngine - main update', () => {
  it('updates main record by PK and returns PK-only', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario Updated' },
    });

    assert.equal(result.main.id, 1);
    assert.equal(result.main.name, undefined);
    assert.ok(mockPg.calls[0].text.includes('UPDATE "customer"'));
    assert.ok(mockPg.calls[0].text.includes('WHERE'));
    assert.ok(!mockPg.calls[0].text.includes('RETURNING'));
  });

  it('does not include PK in SET clause', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Updated' },
    });

    const sql = mockPg.calls[0].text;
    // SET should NOT contain "id"
    const setPart = sql.split('SET')[1].split('WHERE')[0];
    assert.ok(!setPart.includes('"id"'));
  });

  it('throws 400 when PK is missing', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => updateEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        record: { name: 'No PK' },
      }),
      (err) => err.statusCode === 400
    );
  });

  it('throws 404 when record not found', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => updateEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        record: { id: 999, name: 'Not found' },
      }),
      (err) => err.statusCode === 404
    );
  });

  it('returns PK-only result', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
    });

    assert.equal(result.main.id, 1);
    assert.equal(result.secondaries, undefined);
    assert.equal(result.deletions, undefined);
  });
});

describe('updateEngine - beforeUpdate hook', () => {
  it('calls beforeUpdate with update fields', async () => {
    let hookFields = null;
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      beforeUpdate: async (_db, _req, fields) => {
        hookFields = fields;
      },
    });

    await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Updated' },
    });

    assert.ok(hookFields);
    assert.equal(hookFields.name, 'Updated');
    // PK should not be in update fields
    assert.equal(hookFields.id, undefined);
  });
});

describe('updateEngine - secondaries', () => {
  it('inserts secondary records with FK auto-fill', async () => {
    const mockPg = createMockPg([
      // Main update
      { rows: [], affectedRows: 1 },
      // Bulk insert orders (PK-only)
      { rows: [{ id: 10 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 42, name: 'Mario' },
      secondaries: {
        customer_order: [{ total: 100, status: 'pending' }],
      },
    });

    const bulkCall = mockPg.calls[1];
    assert.ok(bulkCall.text.includes('INSERT INTO "customer_order"'));
    assert.ok(bulkCall.values.includes(42));
    assert.ok(result.secondaries);
    assert.equal(result.secondaries.customer_order.length, 1);
  });
});

describe('updateEngine - deletions', () => {
  it('deletes secondary records', async () => {
    const mockPg = createMockPg([
      // Main update
      { rows: [], affectedRows: 1 },
      // Delete order (affectedRows)
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
      deletions: {
        customer_order: [{ id: 5 }],
      },
    });

    const deleteCall = mockPg.calls[1];
    assert.ok(deleteCall.text.includes('DELETE FROM "customer_order"'));
    assert.ok(result.deletions);
    assert.equal(result.deletions.customer_order.length, 1);
    assert.equal(result.deletions.customer_order[0].id, 5);
  });

  it('ignores deletions not in allowedWriteJoins', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      allowedWriteJoins: [],
    });

    const result = await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
      deletions: {
        customer_order: [{ id: 5 }],
      },
    });

    assert.equal(mockPg.calls.length, 1); // only main update
    assert.equal(result.deletions, undefined);
  });

  it('handles secondaries + deletions together', async () => {
    const mockPg = createMockPg([
      // Main update
      { rows: [], affectedRows: 1 },
      // Bulk insert (secondary, PK-only)
      { rows: [{ id: 20 }], affectedRows: 1 },
      // Delete (affectedRows)
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
      secondaries: {
        customer_order: [{ total: 200, status: 'new' }],
      },
      deletions: {
        customer_order: [{ id: 5 }],
      },
    });

    assert.ok(result.secondaries);
    assert.ok(result.deletions);
    assert.equal(result.secondaries.customer_order.length, 1);
    assert.equal(result.deletions.customer_order.length, 1);
  });
});
