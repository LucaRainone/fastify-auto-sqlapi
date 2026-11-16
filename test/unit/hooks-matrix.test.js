import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { updateEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/update.js'));
const { deleteEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/delete.js'));
const { bulkDeleteEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-delete.js'));
const { buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import(path.join(ROOT, 'dist/index.js'));

const norm = (text) => text.replace(/\s+/g, ' ').trim();

function createMockSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}


/** Tx-capable mock pool: data queries answered from `responses`, tx statements recorded. */
function createTxMockPool(responses = []) {
  const connCalls = [];
  let idx = 0;
  return {
    connCalls,
    query() {
      throw new Error('unexpected pool-level query');
    },
    connect() {
      return Promise.resolve({
        query(text, values) {
          const t = norm(text);
          connCalls.push({ text: t, values });
          if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') {
            return Promise.resolve({ rows: [], affectedRows: 0 });
          }
          const r = responses[idx++];
          if (r instanceof Error) return Promise.reject(r);
          return Promise.resolve(r || { rows: [], affectedRows: 0 });
        },
        release() {},
      });
    },
  };
}

const customerFields = { id: Type.Number(), name: Type.String() };
const orderFields = { id: Type.Number(), customerId: Type.Number(), total: Type.Number() };

function createTestDbTables() {
  const customerSchema = createMockSchema('customer', customerFields);
  const orderSchema = createMockSchema('customer_order', orderFields);

  return {
    customer: {
      primary: 'id',
      schema: customerSchema,
      defaultOrder: 'id',
      writeJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
      ],
    },
    customer_order: {
      primary: 'id',
      schema: orderSchema,
      defaultOrder: 'id',
    },
  };
}

const mockRequest = { url: '/test' };

describe('afterUpdate hook', () => {
  it('is called with the input record, secondaries and deletions results', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },           // UPDATE
      { rows: [{ id: 10 }], affectedRows: 1 }, // secondaries
      { rows: [], affectedRows: 1 },           // deletions
    ]);
    const db = new QueryClient(mockPg);
    const dbTables = createTestDbTables();
    let hookArgs = null;
    dbTables.customer.afterUpdate = async ({ db: hookDb, req, record, secondaries, deletions }) => {
      hookArgs = { req, record, secondaries, deletions };
    };

    await updateEngine({
      db,
      tableConf: dbTables.customer,
      dbTables: dbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
      upsert: { customer_order: [{ total: 100 }] },
      delete: { customer_order: [{ id: 5 }] },
    });

    assert.ok(hookArgs, 'afterUpdate must be called');
    assert.equal(hookArgs.req, mockRequest);
    assert.equal(hookArgs.record.id, 1);
    assert.equal(hookArgs.record.name, 'Mario');
    assert.equal(hookArgs.secondaries.customer_order.length, 1);
    assert.equal(hookArgs.deletions.customer_order.length, 1);
  });

  it('is not called when the update fails (404)', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 }, // UPDATE matches nothing
    ]);
    const db = new QueryClient(mockPg);
    const dbTables = createTestDbTables();
    let called = false;
    dbTables.customer.afterUpdate = async () => { called = true; };

    await assert.rejects(
      updateEngine({
        db,
        tableConf: dbTables.customer,
        dbTables: dbTables,
        request: mockRequest,
        record: { id: 1, name: 'Mario' },
      }),
      (err) => err.statusCode === 404
    );
    assert.equal(called, false);
  });

  it('rolls back the whole update when afterUpdate throws', async () => {
    const pool = createTxMockPool([
      { rows: [], affectedRows: 1 }, // UPDATE ok
    ]);
    const db = new QueryClient(pool);
    const dbTables = createTestDbTables();
    dbTables.customer.afterUpdate = async () => {
      throw new Error('afterUpdate failed');
    };

    await assert.rejects(
      updateEngine({
        db,
        tableConf: dbTables.customer,
        dbTables: dbTables,
        request: mockRequest,
        record: { id: 1, name: 'Mario' },
      }),
      /afterUpdate failed/
    );

    const texts = pool.connCalls.map((c) => c.text);
    assert.ok(texts.includes('ROLLBACK'), `expected ROLLBACK, got: ${texts.join(' | ')}`);
    assert.ok(!texts.includes('COMMIT'));
  });
});

describe('afterDelete hook', () => {
  it('is called with the deleted id after a successful delete', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const db = new QueryClient(mockPg);
    const dbTables = createTestDbTables();
    let hookArgs = null;
    dbTables.customer.afterDelete = async ({ db: hookDb, req, id }) => {
      hookArgs = { req, id };
    };

    await deleteEngine({
      db,
      tableConf: dbTables.customer,
      id: 7,
      request: mockRequest,
    });

    assert.ok(hookArgs, 'afterDelete must be called');
    assert.equal(hookArgs.id, 7);
    assert.equal(hookArgs.req, mockRequest);
  });

  it('is not called when the record does not exist (404)', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const db = new QueryClient(mockPg);
    const dbTables = createTestDbTables();
    let called = false;
    dbTables.customer.afterDelete = async () => { called = true; };

    await assert.rejects(
      deleteEngine({ db, tableConf: dbTables.customer, id: 7, request: mockRequest }),
      (err) => err.statusCode === 404
    );
    assert.equal(called, false);
  });
});

describe('afterBulkDelete hook', () => {
  it('is called ONCE with the ids that were actually deleted', async () => {
    // Request [1,2,3] but only [1,3] exist (partial delete via RETURNING).
    const mockPg = createMockPg([
      { rows: [{ id: 1 }, { id: 3 }], affectedRows: 2 },
    ]);
    const db = new QueryClient(mockPg);
    const dbTables = createTestDbTables();
    const invocations = [];
    dbTables.customer.afterBulkDelete = async ({ db: hookDb, req, ids: deletedIds }) => {
      invocations.push({ req, deletedIds });
    };

    await bulkDeleteEngine({
      db,
      tableConf: dbTables.customer,
      ids: [1, 2, 3],
      request: mockRequest,
    });

    assert.equal(invocations.length, 1, 'must be called once, not per id');
    assert.deepEqual(invocations[0].deletedIds, [1, 3]);
    assert.equal(invocations[0].req, mockRequest);
  });

  it('is not called when nothing was deleted', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const db = new QueryClient(mockPg);
    const dbTables = createTestDbTables();
    let called = false;
    dbTables.customer.afterBulkDelete = async () => { called = true; };

    await bulkDeleteEngine({
      db,
      tableConf: dbTables.customer,
      ids: [99],
      request: mockRequest,
    });

    assert.equal(called, false);
  });
});
