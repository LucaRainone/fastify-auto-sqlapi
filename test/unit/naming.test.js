import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { toCamelCase, toUnderscore, toSchemaName } = await import(
  path.join(ROOT, 'dist/lib/naming.js')
);

describe('toCamelCase', () => {
  it('converts snake_case', () => {
    assert.equal(toCamelCase('customer_order'), 'customerOrder');
    assert.equal(toCamelCase('created_at'), 'createdAt');
    assert.equal(toCamelCase('tax_number'), 'taxNumber');
  });

  it('keeps single words unchanged', () => {
    assert.equal(toCamelCase('id'), 'id');
    assert.equal(toCamelCase('name'), 'name');
  });
});

describe('toUnderscore', () => {
  it('converts camelCase', () => {
    assert.equal(toUnderscore('customerOrder'), 'customer_order');
    assert.equal(toUnderscore('createdAt'), 'created_at');
    assert.equal(toUnderscore('taxNumber'), 'tax_number');
  });

  it('keeps single words unchanged', () => {
    assert.equal(toUnderscore('id'), 'id');
    assert.equal(toUnderscore('name'), 'name');
  });
});

describe('toSchemaName', () => {
  it('generates Schema prefix with PascalCase', () => {
    assert.equal(toSchemaName('customer'), 'SchemaCustomer');
    assert.equal(toSchemaName('customer_order'), 'SchemaCustomerOrder');
    assert.equal(toSchemaName('product'), 'SchemaProduct');
  });
});
