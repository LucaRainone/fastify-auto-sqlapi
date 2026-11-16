import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { InsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/insert.js'));
const { UpdateTableBody } = await import(path.join(ROOT, 'dist/lib/schema/update.js'));
const { BulkUpsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/bulk-upsert.js'));
const { buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { Type } = await import(path.join(ROOT, 'dist/index.js'));

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

/**
 * The alias container is open: an alias the table does not declare must reach the engine,
 * which refuses it with a 400 `unknown_field` (write-join-alias-refused.test.js). Closed,
 * Fastify's default Ajv (`removeAdditional`) strips it, and the write answers success having
 * written none of its child rows.
 */
describe('write join body schemas leave the alias container open, for the engine to refuse', () => {
  const dbTables = createTestDbTables();

  it('insert: secondaries lists the declared aliases and lets another one through', () => {
    const body = InsertTableBody(dbTables, 'customer');
    assert.notEqual(body.properties.upsert.additionalProperties, false);
    assert.ok(body.properties.upsert.properties.customer_order, 'declared aliases are documented');
  });

  it('update: secondaries and deletions both let an undeclared alias through', () => {
    const body = UpdateTableBody(dbTables, 'customer');
    assert.notEqual(body.properties.upsert.additionalProperties, false);
    assert.notEqual(body.properties.delete.additionalProperties, false);
  });

  it('bulkUpsert: item secondaries and deletions both let an undeclared alias through', () => {
    const item = BulkUpsertTableBody(dbTables, 'customer').items;
    assert.notEqual(item.properties.upsert.additionalProperties, false);
    assert.notEqual(item.properties.delete.additionalProperties, false);
  });
});

/** A table with no write joins emits no alias container at all. */
describe('write join body schemas omit the sections when nothing is writable', () => {
  it('emits neither secondaries nor deletions', () => {
    const dbTables = createTestDbTables();
    delete dbTables.customer.writeJoins;

    const body = UpdateTableBody(dbTables, 'customer');
    assert.equal(body.properties.upsert, undefined);
    assert.equal(body.properties.delete, undefined);
  });
});
