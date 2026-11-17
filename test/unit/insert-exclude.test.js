// `insertExclude` is the client-input whitelist on insert (ADR 0005), named like
// `readExclude`/`writeExclude` and after the library's "insert" vocabulary. Until 0.6.0 it was
// called `excludeFromCreation`; that name is now refused rather than ignored.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, insertedRows, ROOT } from './_harness.js';

const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type, defineTable, buildRelation, buildAgentManifest } =
  await import(path.join(ROOT, 'dist/index.js'));
const { InsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/insert.js'));

const customerSchema = createMockSchema('customer', {
  id: Type.Number(),
  name: Type.String(),
  createdAt: Type.String(),
});
const orderSchema = createMockSchema('customer_order', {
  id: Type.Number(),
  customerId: Type.Number(),
  total: Type.Number(),
});

function createDbTables({ customer = {}, order = {} } = {}) {
  return {
    customer: {
      primary: 'id',
      schema: customerSchema,
      writeJoins: [buildRelation(customerSchema, 'id', orderSchema, 'customerId')],
      ...customer,
    },
    customer_order: {
      primary: 'id',
      schema: orderSchema,
      ...order,
    },
  };
}

function insertCustomer(dbTables, mockPg, params) {
  return insertEngine({
    db: new QueryClient(mockPg),
    tableConf: dbTables.customer,
    dbTables,
    request: {},
    ...params,
  });
}

describe('insertExclude whitelists client input on insert', () => {
  it('drops the client value before the INSERT', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const dbTables = createDbTables({ customer: { insertExclude: ['createdAt'] } });

    await insertCustomer(dbTables, mockPg, { record: { name: 'Ada', createdAt: '1999-01-01' } });

    assert.deepEqual(insertedRows(mockPg.calls[0]), [{ name: 'Ada' }]);
  });

  it('lets beforeInsert assign the field after the client value is gone', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 42 }], affectedRows: 1 }]);
    const dbTables = createDbTables({
      customer: {
        insertExclude: ['id'],
        beforeInsert: ({ record }) => {
          assert.equal(record.id, undefined, 'the client id is stripped before the hook runs');
          record.id = 42;
        },
      },
    });

    await insertCustomer(dbTables, mockPg, { record: { id: 999, name: 'Ada' } });

    assert.deepEqual(insertedRows(mockPg.calls[0]), [{ id: 42, name: 'Ada' }]);
  });

  it('applies to the rows written as secondaries of another table', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [{ id: 10 }], affectedRows: 1 },
    ]);
    const dbTables = createDbTables({ order: { insertExclude: ['id'] } });

    await insertCustomer(dbTables, mockPg, {
      record: { name: 'Ada' },
      upsert: { customer_order: [{ id: 999, total: 5 }] },
    });

    assert.deepEqual(insertedRows(mockPg.calls[1]), [{ total: 5, customer_id: 1 }]);
  });

  it('makes the field optional in the insert body', () => {
    const dbTables = createDbTables({ customer: { insertExclude: ['createdAt'] } });

    const body = InsertTableBody(dbTables, 'customer');

    assert.ok(!(body.properties.main.required ?? []).includes('createdAt'));
    assert.ok((body.properties.main.required ?? []).includes('name'), 'other fields keep their requiredness');
  });

  it('is listed as server-generated in the agent manifest', () => {
    const dbTables = createDbTables({ customer: { insertExclude: ['id'] } });

    assert.deepEqual(buildAgentManifest(dbTables).tables.customer.serverGenerated, ['id']);
  });
});

describe('excludeFromCreation, the name insertExclude had before 0.6.0', () => {
  // Dropping the key silently would let clients write the fields it used to protect.
  it('is refused by defineTable, pointing to insertExclude', () => {
    assert.throws(
      () => defineTable({
        primary: 'id',
        schema: customerSchema,
        excludeFromCreation: ['id'],
      }),
      /excludeFromCreation.*insertExclude/,
    );
  });
});

// The CLI lists every generated primary key under `insertExclude`, so `upsertKey: ['id']` on a
// generated table meets it: the key there names the row to update, and stripping it as client
// input turned every update into the insert of a copy. The key stays, but may only name a row
// that exists — the client still never picks the key of a new row.
describe('an upsert key under insertExclude addresses an existing row', () => {
  const upsertById = () => createDbTables({ customer: { insertExclude: ['id'], upsertKey: ['id'] } });
  const isProbe = (call) => /^SELECT "id" FROM "customer" WHERE/.test(call.text);

  it('keeps the client key, so the upsert updates the row it names', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 7 }], affectedRows: 1 },
      { rows: [{ id: 7, __inserted: false }], affectedRows: 1 },
    ]);

    const result = await insertCustomer(upsertById(), mockPg, { record: { id: 7, name: 'Ada' } });

    assert.ok(isProbe(mockPg.calls[0]), mockPg.calls[0].text);
    assert.deepEqual(insertedRows(mockPg.calls[1]), [{ id: 7, name: 'Ada' }]);
    assert.deepEqual(result, { main: { id: 7 }, action: 'updated' });
  });

  it('answers 400 not_found at main.<key> when no row has it, before the upsert runs', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);

    await assert.rejects(
      insertCustomer(upsertById(), mockPg, { record: { id: 999, name: 'Ada' } }),
      (err) => err.statusCode === 400
        && err.validationErrors.length === 1
        && err.validationErrors[0].path === 'main.id'
        && err.validationErrors[0].code === 'not_found'
    );
    assert.equal(mockPg.calls.length, 1, 'only the probe ran');
  });

  it('inserts a row without the key, unprobed', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 8, __inserted: true }], affectedRows: 1 }]);

    await insertCustomer(upsertById(), mockPg, { record: { name: 'Ada' } });

    assert.deepEqual(insertedRows(mockPg.calls[0]), [{ name: 'Ada' }]);
  });

  it('does not probe a key beforeInsert assigned: it names a new row', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 42, __inserted: true }], affectedRows: 1 }]);
    const dbTables = upsertById();
    dbTables.customer.beforeInsert = ({ record }) => { record.id = 42; };

    await insertCustomer(dbTables, mockPg, { record: { name: 'Ada' } });

    assert.equal(mockPg.calls.length, 1, mockPg.calls.map((c) => c.text).join('\n'));
    assert.deepEqual(insertedRows(mockPg.calls[0]), [{ id: 42, name: 'Ada' }]);
  });

  it('applies to a child row, at upsert.<alias>.<i>.<key>', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const dbTables = createDbTables({ order: { insertExclude: ['id'] } });
    dbTables.customer.writeJoins = [
      buildRelation(customerSchema, 'id', orderSchema, 'customerId', { upsertKey: ['id'] }),
    ];

    await assert.rejects(
      insertCustomer(dbTables, mockPg, { record: { name: 'Ada' }, upsert: { customer_order: [{ id: 999, total: 5 }] } }),
      (err) => err.validationErrors?.[0]?.path === 'upsert.customer_order.0.id'
        && err.validationErrors[0].code === 'not_found'
    );
  });
});
