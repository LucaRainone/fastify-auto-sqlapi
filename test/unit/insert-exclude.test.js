// `insertExclude` is the name of the client-input whitelist on insert that used to be called
// `excludeFromCreation`: same semantics (ADR 0005), aligned with `readExclude`/`writeExclude`
// and with the library's "insert" vocabulary. The old name keeps working, deprecated; naming
// both on one table is ambiguous and refused.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, insertedRows, ROOT } from './_harness.js';

const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type, defineTable, exportTableInfo, buildRelation, InsertTableBody, buildAgentManifest } =
  await import(path.join(ROOT, 'dist/index.js'));

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
      ...exportTableInfo(customerSchema),
      allowedWriteJoins: [buildRelation(customerSchema, 'id', orderSchema, 'customerId')],
      ...customer,
    },
    customer_order: {
      primary: 'id',
      ...exportTableInfo(orderSchema),
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
        beforeInsert: (_db, _req, record) => {
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
      secondaries: { customer_order: [{ id: 999, total: 5 }] },
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

describe('excludeFromCreation keeps working as the deprecated name of insertExclude', () => {
  it('drops the client value before the INSERT', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const dbTables = createDbTables({ customer: { excludeFromCreation: ['createdAt'] } });

    await insertCustomer(dbTables, mockPg, { record: { name: 'Ada', createdAt: '1999-01-01' } });

    assert.deepEqual(insertedRows(mockPg.calls[0]), [{ name: 'Ada' }]);
  });

  it('defineTable refuses a table naming both, even with the same fields', () => {
    assert.throws(
      () => defineTable({
        primary: 'id',
        ...exportTableInfo(customerSchema),
        insertExclude: ['id'],
        excludeFromCreation: ['id'],
      }),
      /insertExclude.*excludeFromCreation|excludeFromCreation.*insertExclude/,
    );
  });
});
