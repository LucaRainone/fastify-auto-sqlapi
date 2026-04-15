import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIALECT, PG_CONNECTION_STRING, MYSQL_CONFIG } from './_helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { introspectTables } = await import(path.join(ROOT, 'dist/lib/cli/pg-introspect.js'));
const { introspectMysqlTables } = await import(path.join(ROOT, 'dist/lib/cli/mysql-introspect.js'));

async function introspect() {
  if (DIALECT === 'postgres') {
    return introspectTables(PG_CONNECTION_STRING, 'public');
  } else {
    return introspectMysqlTables(MYSQL_CONFIG, MYSQL_CONFIG.database);
  }
}

describe(`[${DIALECT}] introspectTables`, () => {
  it('finds all test tables', async () => {
    const rows = await introspect();

    assert.ok(rows.length > 0, 'should return columns');

    const tableNames = [...new Set(rows.map((r) => r.table_name))];
    assert.ok(tableNames.includes('customer'));
    assert.ok(tableNames.includes('product'));
    assert.ok(tableNames.includes('customer_order'));
  });

  it('returns correct column metadata', async () => {
    const rows = await introspect();

    const customerId = rows.find(
      (r) => r.table_name === 'customer' && r.column_name === 'id'
    );
    assert.ok(customerId);
    assert.equal(customerId.is_nullable, 'NO');
    // PG: int4, MySQL: mapped type (int varies)
    assert.ok(customerId.udt_name);
  });

  it('identifies string column types', async () => {
    const rows = await introspect();

    const customerName = rows.find(
      (r) => r.table_name === 'customer' && r.column_name === 'name'
    );
    assert.ok(customerName);
    // PG: varchar, MySQL: varchar
    assert.ok(
      customerName.udt_name.includes('varchar') || customerName.udt_name.includes('char'),
      `expected varchar-like type, got ${customerName.udt_name}`
    );
  });
});
