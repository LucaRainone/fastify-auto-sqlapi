import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { introspectTables } = await import(
  path.join(ROOT, 'dist/lib/cli/pg-introspect.js')
);

const connectionString = 'postgres://test:test@127.0.0.1:5433/testdb';

describe('introspectTables', () => {
  it('finds all test tables', async () => {
    const rows = await introspectTables(connectionString, 'public');

    assert.ok(rows.length > 0, 'should return columns');

    const tableNames = [...new Set(rows.map((r) => r.table_name))];
    assert.ok(tableNames.includes('customer'));
    assert.ok(tableNames.includes('product'));
    assert.ok(tableNames.includes('customer_order'));
  });

  it('returns correct column metadata', async () => {
    const rows = await introspectTables(connectionString, 'public');

    const customerId = rows.find(
      (r) => r.table_name === 'customer' && r.column_name === 'id'
    );
    assert.ok(customerId);
    assert.equal(customerId.udt_name, 'int4');
    assert.equal(customerId.is_nullable, 'NO');

    const productUuid = rows.find(
      (r) => r.table_name === 'product' && r.column_name === 'uuid'
    );
    assert.ok(productUuid);
    assert.equal(productUuid.udt_name, 'uuid');

    const productTags = rows.find(
      (r) => r.table_name === 'product' && r.column_name === 'tags'
    );
    assert.ok(productTags);
    assert.equal(productTags.udt_name, '_varchar');
  });
});
