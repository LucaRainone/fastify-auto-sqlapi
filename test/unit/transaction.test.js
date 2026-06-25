import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { updateEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/update.js'));
const { bulkUpsertEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-upsert.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import('@sinclair/typebox');

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

/**
 * Mock pool WITH transaction support (`connect()`).
 * `responses` feed the data queries issued on the connection (BEGIN/COMMIT/ROLLBACK
 * are answered automatically and recorded). An Error entry makes that query reject.
 */
function createTxMockPool(responses = []) {
  const poolCalls = [];
  const connCalls = [];
  const state = { released: 0 };
  let idx = 0;

  return {
    poolCalls,
    connCalls,
    state,
    query(text, values) {
      poolCalls.push({ text: norm(text), values });
      return Promise.resolve({ rows: [], affectedRows: 0 });
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
        release() {
          state.released++;
        },
      });
    },
  };
}

/** Mock pool WITHOUT connect(): legacy custom adapters. */
function createPlainMockPool(responses = []) {
  const calls = [];
  let idx = 0;
  return {
    calls,
    query(text, values) {
      calls.push({ text: norm(text), values });
      const r = responses[idx++];
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r || { rows: [], affectedRows: 0 });
    },
  };
}

const customerFields = {
  id: Type.Number(),
  name: Type.String(),
};
const orderFields = {
  id: Type.Number(),
  customerId: Type.Number(),
  total: Type.Number(),
};

function createTestDbTables() {
  const customerSchema = createMockSchema('customer', customerFields);
  const orderSchema = createMockSchema('customer_order', orderFields);

  const DbTables = {
    customer: {
      primary: 'id',
      ...exportTableInfo(customerSchema),
      defaultOrder: 'id',
      allowedWriteJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
      ],
    },
    customer_order: {
      primary: 'id',
      ...exportTableInfo(orderSchema),
      defaultOrder: 'id',
    },
  };

  return DbTables;
}

const mockRequest = {};

describe('QueryClient.withTransaction', () => {
  it('wraps fn in BEGIN/COMMIT on a dedicated connection and releases it', async () => {
    const pool = createTxMockPool([{ rows: [{ x: 1 }], affectedRows: 1 }]);
    const db = new QueryClient(pool);

    const out = await db.withTransaction(async (tx) => {
      await tx.query('SELECT 1');
      return 'done';
    });

    assert.equal(out, 'done');
    assert.deepEqual(pool.connCalls.map((c) => c.text), ['BEGIN', 'SELECT 1', 'COMMIT']);
    assert.equal(pool.state.released, 1);
    assert.equal(pool.poolCalls.length, 0, 'queries must run on the connection, not the pool');
  });

  it('rolls back and rethrows when fn throws', async () => {
    const pool = createTxMockPool([new Error('boom')]);
    const db = new QueryClient(pool);

    await assert.rejects(
      db.withTransaction((tx) => tx.query('SELECT 1')),
      /boom/
    );
    assert.deepEqual(pool.connCalls.map((c) => c.text), ['BEGIN', 'SELECT 1', 'ROLLBACK']);
    assert.equal(pool.state.released, 1);
  });

  it('runs fn directly when the pool has no connect() (legacy adapters)', async () => {
    const pool = createPlainMockPool([{ rows: [], affectedRows: 0 }]);
    const db = new QueryClient(pool);

    await db.withTransaction((tx) => tx.query('SELECT 1'));

    assert.deepEqual(pool.calls.map((c) => c.text), ['SELECT 1'], 'no BEGIN/COMMIT expected');
  });

  it('joins the outer transaction when nested', async () => {
    const pool = createTxMockPool([{ rows: [], affectedRows: 0 }]);
    const db = new QueryClient(pool);

    await db.withTransaction(async (tx) => {
      await tx.withTransaction((inner) => inner.query('SELECT 1'));
    });

    const begins = pool.connCalls.filter((c) => c.text === 'BEGIN');
    assert.equal(begins.length, 1, 'nested withTransaction must not open a second transaction');
  });
});

describe('insertEngine - transactional atomicity', () => {
  it('rolls back the main insert when secondaries fail', async () => {
    const pool = createTxMockPool([
      { rows: [{ id: 42 }], affectedRows: 1 }, // main INSERT ok
      new Error('secondary insert failed'),    // secondaries INSERT fails
    ]);
    const db = new QueryClient(pool);
    const DbTables = createTestDbTables();

    await assert.rejects(
      insertEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        record: { name: 'Mario' },
        secondaries: { customer_order: [{ total: 100 }] },
      }),
      /secondary insert failed/
    );

    const texts = pool.connCalls.map((c) => c.text);
    assert.ok(texts.includes('BEGIN'), `expected BEGIN, got: ${texts.join(' | ')}`);
    assert.ok(texts.includes('ROLLBACK'), `expected ROLLBACK, got: ${texts.join(' | ')}`);
    assert.ok(!texts.includes('COMMIT'), 'must not COMMIT on failure');
    assert.equal(pool.state.released, 1);
  });

  it('commits main + secondaries on success', async () => {
    const pool = createTxMockPool([
      { rows: [{ id: 42 }], affectedRows: 1 },
      { rows: [{ id: 10 }], affectedRows: 1 },
    ]);
    const db = new QueryClient(pool);
    const DbTables = createTestDbTables();

    const result = await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario' },
      secondaries: { customer_order: [{ total: 100 }] },
    });

    assert.equal(result.main.id, 42);
    const texts = pool.connCalls.map((c) => c.text);
    assert.equal(texts[0], 'BEGIN');
    assert.equal(texts[texts.length - 1], 'COMMIT');
    assert.ok(texts.some((t) => t.includes('INSERT INTO "customer"')));
    assert.ok(texts.some((t) => t.includes('INSERT INTO "customer_order"')));
  });

  it('rolls back the main insert when afterInsert throws', async () => {
    const pool = createTxMockPool([
      { rows: [{ id: 42 }], affectedRows: 1 },
    ]);
    const db = new QueryClient(pool);
    const DbTables = createTestDbTables();
    DbTables.customer.afterInsert = async () => {
      throw new Error('afterInsert failed');
    };

    await assert.rejects(
      insertEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        record: { name: 'Mario' },
      }),
      /afterInsert failed/
    );

    const texts = pool.connCalls.map((c) => c.text);
    assert.ok(texts.includes('ROLLBACK'), `expected ROLLBACK, got: ${texts.join(' | ')}`);
    assert.ok(!texts.includes('COMMIT'));
  });

  it('still works with a pool without connect() (no transaction)', async () => {
    const pool = createPlainMockPool([
      { rows: [{ id: 42 }], affectedRows: 1 },
    ]);
    const db = new QueryClient(pool);
    const DbTables = createTestDbTables();

    const result = await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario' },
    });

    assert.equal(result.main.id, 42);
    assert.ok(!pool.calls.some((c) => c.text === 'BEGIN'));
  });
});

describe('updateEngine - transactional atomicity', () => {
  it('rolls back update + secondaries when deletions fail', async () => {
    const pool = createTxMockPool([
      { rows: [], affectedRows: 1 },           // UPDATE main ok
      { rows: [{ id: 10 }], affectedRows: 1 }, // secondaries INSERT ok
      new Error('deletion failed'),            // DELETE fails
    ]);
    const db = new QueryClient(pool);
    const DbTables = createTestDbTables();

    await assert.rejects(
      updateEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        record: { id: 1, name: 'Mario' },
        secondaries: { customer_order: [{ total: 100 }] },
        deletions: { customer_order: [{ id: 5 }] },
      }),
      /deletion failed/
    );

    const texts = pool.connCalls.map((c) => c.text);
    assert.ok(texts.includes('BEGIN'), `expected BEGIN, got: ${texts.join(' | ')}`);
    assert.ok(texts.includes('ROLLBACK'), `expected ROLLBACK, got: ${texts.join(' | ')}`);
    assert.ok(!texts.includes('COMMIT'));
  });

  it('commits update + secondaries + deletions on success', async () => {
    const pool = createTxMockPool([
      { rows: [], affectedRows: 1 },
      { rows: [{ id: 10 }], affectedRows: 1 },
      { rows: [], affectedRows: 1 },
    ]);
    const db = new QueryClient(pool);
    const DbTables = createTestDbTables();

    const result = await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
      secondaries: { customer_order: [{ total: 100 }] },
      deletions: { customer_order: [{ id: 5 }] },
    });

    assert.equal(result.main.id, 1);
    const texts = pool.connCalls.map((c) => c.text);
    assert.equal(texts[0], 'BEGIN');
    assert.equal(texts[texts.length - 1], 'COMMIT');
  });
});

describe('bulk engines - intentionally NOT transactional', () => {
  it('bulkUpsertEngine does not open a transaction (bulk is a shortcut for single ops)', async () => {
    const pool = createTxMockPool([]);
    // Bulk goes through the pool directly: no BEGIN must ever be issued.
    pool.query = (text, values) => {
      pool.poolCalls.push({ text: norm(text), values });
      return Promise.resolve({ rows: [{ id: 1 }], affectedRows: 1 });
    };
    const db = new QueryClient(pool);
    const DbTables = createTestDbTables();

    await bulkUpsertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      items: [{ main: { name: 'Mario' } }],
    });

    assert.equal(pool.connCalls.length, 0, 'bulk upsert must not use a transaction connection');
    assert.ok(!pool.poolCalls.some((c) => c.text === 'BEGIN'));
  });
});
