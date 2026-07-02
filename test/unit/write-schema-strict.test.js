import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { InsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/insert.js'));
const { UpdateTableBody } = await import(path.join(ROOT, 'dist/lib/schema/update.js'));
const { BulkUpsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/bulk-upsert.js'));
const { BulkDeleteTableBody } = await import(path.join(ROOT, 'dist/lib/schema/bulk-delete.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
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

function createDbTables() {
  const customerSchema = createMockSchema('customer', {
    id: Type.Number(), name: Type.String(), email: Type.String(),
  });
  const orderSchema = createMockSchema('customer_order', {
    id: Type.Number(), customerId: Type.Number(), total: Type.Number(),
  });
  return {
    customer: {
      primary: 'id',
      ...exportTableInfo(customerSchema),
      defaultOrder: 'id',
      allowedWriteJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
      ],
    },
    customer_order: { primary: 'id', ...exportTableInfo(orderSchema), defaultOrder: 'id' },
  };
}

describe('write body schemas reject unknown properties (mass-assignment guard)', () => {
  it('insert main is additionalProperties:false', () => {
    const schema = InsertTableBody(createDbTables(), 'customer');
    assert.equal(schema.properties.main.additionalProperties, false);
  });

  it('update main is additionalProperties:false', () => {
    const schema = UpdateTableBody(createDbTables(), 'customer');
    assert.equal(schema.properties.main.additionalProperties, false);
  });

  it('bulk-upsert item main is additionalProperties:false', () => {
    const schema = BulkUpsertTableBody(createDbTables(), 'customer');
    // schema is Type.Array(item); item.properties.main is Partial(Object(..))
    assert.equal(schema.items.properties.main.additionalProperties, false);
  });

  it('secondaries items are additionalProperties:false on write bodies', () => {
    const schema = InsertTableBody(createDbTables(), 'customer');
    const secondaryItem = schema.properties.secondaries.properties.customer_order.items;
    assert.equal(secondaryItem.additionalProperties, false);
  });
});

describe('bulk body schemas enforce maxItems (DoS guard)', () => {
  it('bulk-upsert array carries the provided maxItems', () => {
    const schema = BulkUpsertTableBody(createDbTables(), 'customer', 250);
    assert.equal(schema.maxItems, 250);
  });

  it('bulk-delete array carries the provided maxItems', () => {
    const schema = BulkDeleteTableBody(createDbTables(), 'customer', 250);
    assert.equal(schema.maxItems, 250);
  });

  it('omitting maxItems leaves the array uncapped (backward compatible)', () => {
    const schema = BulkUpsertTableBody(createDbTables(), 'customer');
    assert.equal(schema.maxItems, undefined);
  });
});
