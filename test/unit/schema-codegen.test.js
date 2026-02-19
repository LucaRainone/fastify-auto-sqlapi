import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { convertColType, buildTableMap, generateSchemaFile } = await import(
  path.join(ROOT, 'dist/lib/cli/schema-codegen.js')
);

const notNull = { column_default: null, is_nullable: 'NO' };
const nullable = { column_default: null, is_nullable: 'YES' };
const hasDefault = { column_default: 'now()', is_nullable: 'NO' };

describe('convertColType', () => {
  it('maps uuid', () => {
    assert.equal(convertColType('uuid', notNull), "Type.String({format: 'uuid'})");
  });

  it('maps bool', () => {
    assert.equal(convertColType('bool', notNull), 'Type.Boolean()');
  });

  it('maps integer types', () => {
    assert.equal(convertColType('int4', notNull), 'Type.Integer()');
    assert.equal(convertColType('int8', notNull), 'Type.Integer()');
  });

  it('maps float/numeric types', () => {
    assert.equal(convertColType('float8', notNull), 'Type.Number()');
    assert.equal(convertColType('numeric', notNull), 'Type.Number()');
  });

  it('maps string types', () => {
    assert.equal(convertColType('varchar', notNull), 'Type.String()');
    assert.equal(convertColType('text', notNull), 'Type.String()');
  });

  it('maps timestamp types', () => {
    assert.equal(convertColType('timestamptz', notNull), 'Type.String()');
  });

  it('maps date with format', () => {
    assert.equal(convertColType('date', notNull), "Type.String({format: 'date'})");
  });

  it('maps json/jsonb', () => {
    assert.equal(convertColType('jsonb', notNull), 'Type.Any()');
    assert.equal(convertColType('json', notNull), 'Type.Any()');
  });

  it('maps array types', () => {
    assert.equal(convertColType('_varchar', notNull), 'Type.Array(Type.String())');
    assert.equal(convertColType('_int4', notNull), 'Type.Array(Type.Integer())');
  });

  it('wraps nullable in Optional', () => {
    assert.equal(convertColType('int4', nullable), 'Type.Optional(Type.Integer())');
  });

  it('wraps column with default in Optional', () => {
    assert.equal(convertColType('timestamptz', hasDefault), 'Type.Optional(Type.String())');
  });
});

describe('buildTableMap', () => {
  it('groups columns by table with camelCase keys', () => {
    const rows = [
      { table_name: 'customer', column_name: 'id', udt_name: 'int4', column_default: null, is_nullable: 'NO' },
      { table_name: 'customer', column_name: 'full_name', udt_name: 'varchar', column_default: null, is_nullable: 'YES' },
      { table_name: 'product', column_name: 'id', udt_name: 'int4', column_default: null, is_nullable: 'NO' },
    ];

    const map = buildTableMap(rows);

    assert.ok(map.SchemaCustomer);
    assert.equal(map.SchemaCustomer.name, 'customer');
    assert.equal(map.SchemaCustomer.fields.id, 'Type.Integer()');
    assert.equal(map.SchemaCustomer.fields.fullName, 'Type.Optional(Type.String())');

    assert.ok(map.SchemaProduct);
    assert.equal(map.SchemaProduct.name, 'product');
  });
});

describe('generateSchemaFile', () => {
  it('generates valid TypeScript content', () => {
    const content = generateSchemaFile('SchemaCustomer', 'customer', {
      id: 'Type.Integer()',
      name: 'Type.Optional(Type.String())',
    });

    assert.ok(content.includes('import { Type, toUnderscore }'));
    assert.ok(content.includes('import type { Static }'));
    assert.ok(content.includes('id: Type.Integer()'));
    assert.ok(content.includes('name: Type.Optional(Type.String())'));
    assert.ok(content.includes('$id: "SchemaCustomer"'));
    assert.ok(content.includes('tableName: "customer"'));
    assert.ok(content.includes('export const SchemaCustomer = Schema'));
    assert.ok(content.includes('export type TypeSchemaCustomer = TypeSchema'));
  });
});
