import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { InsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/insert.js'));
const { UpdateTableBody } = await import(path.join(ROOT, 'dist/lib/schema/update.js'));
const { BulkUpsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/bulk-upsert.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { Type } = await import('@sinclair/typebox');

const customerFields = { id: Type.Number(), name: Type.String() };
const orderFields = { id: Type.Number(), customerId: Type.Number(), total: Type.Number() };

function createTestDbTables() {
  const customerSchema = createMockSchema('customer', customerFields);
  const orderSchema = createMockSchema('customer_order', orderFields);

  return {
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
}

/**
 * The engines skip an alias the table does not declare (see the "ignores secondaries/deletions
 * not in allowedWriteJoins" specs), so the request schema is what has to fail closed: without
 * `additionalProperties:false` on the alias container a typo'd alias validates, reaches the
 * engine, is dropped there, and the request still answers 200 having written nothing.
 */
describe('write join body schemas close the alias container', () => {
  const dbTables = createTestDbTables();

  it('insert: secondaries rejects an undeclared alias', () => {
    const body = InsertTableBody(dbTables, 'customer');
    assert.equal(body.properties.secondaries.additionalProperties, false);
    assert.ok(body.properties.secondaries.properties.customer_order, 'declared aliases stay allowed');
  });

  it('update: secondaries and deletions both reject an undeclared alias', () => {
    const body = UpdateTableBody(dbTables, 'customer');
    assert.equal(body.properties.secondaries.additionalProperties, false);
    assert.equal(body.properties.deletions.additionalProperties, false);
  });

  it('bulkUpsert: item secondaries and deletions both reject an undeclared alias', () => {
    const item = BulkUpsertTableBody(dbTables, 'customer').items;
    assert.equal(item.properties.secondaries.additionalProperties, false);
    assert.equal(item.properties.deletions.additionalProperties, false);
  });
});

/** A table with no write joins emits no alias container at all. */
describe('write join body schemas omit the sections when nothing is writable', () => {
  it('emits neither secondaries nor deletions', () => {
    const dbTables = createTestDbTables();
    delete dbTables.customer.allowedWriteJoins;

    const body = UpdateTableBody(dbTables, 'customer');
    assert.equal(body.properties.secondaries, undefined);
    assert.equal(body.properties.deletions, undefined);
  });
});
