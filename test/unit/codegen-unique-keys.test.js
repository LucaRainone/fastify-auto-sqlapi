// The generated Schema records the table's unique keys (ADR 0021): `defineTable` verifies an
// `upsertMap` rule against them, so an upsert can only target a key the database enforces.
// The property is emitted even when empty — its absence means "generated before unique keys
// were known", never "this table has none".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT } from './_harness.js';

const { buildTableMap, applyExcludeColumns, generateSchemaFile } =
  await import(path.join(ROOT, 'dist/lib/cli/schema-codegen.js'));

function col(table, column, extra = {}) {
  return {
    table_name: table,
    column_name: column,
    udt_name: 'varchar',
    column_default: null,
    is_nullable: 'NO',
    ...extra,
  };
}

const sampleRows = () => [
  col('sample', 'id', { is_primary: true }),
  col('sample', 'code', { unique_keys: ['sample_code_key'] }),
  col('sample', 'tenant_id', { unique_keys: ['sample_tenant_slug_key'] }),
  col('sample', 'slug', { unique_keys: ['sample_tenant_slug_key'] }),
  col('sample', 'note'),
];

describe('buildTableMap - unique keys', () => {
  it('collects each unique key as its camelCase fields', () => {
    const map = buildTableMap(sampleRows());
    assert.deepEqual(map.SchemaSample.uniqueKeys, [['code'], ['tenantId', 'slug']]);
  });

  it('records an empty list for a table without unique keys', () => {
    const map = buildTableMap([col('plain', 'id', { is_primary: true }), col('plain', 'name')]);
    assert.deepEqual(map.SchemaPlain.uniqueKeys, []);
  });

  it('keeps one entry for two indexes over the same columns', () => {
    const map = buildTableMap([
      col('twice', 'id', { is_primary: true }),
      col('twice', 'code', { unique_keys: ['twice_code_key', 'twice_code_idx'] }),
    ]);
    assert.deepEqual(map.SchemaTwice.uniqueKeys, [['code']]);
  });

  it('lists a column in every unique key it belongs to', () => {
    const map = buildTableMap([
      col('shared', 'id', { is_primary: true }),
      col('shared', 'tenant_id', { unique_keys: ['shared_a', 'shared_b'] }),
      col('shared', 'code', { unique_keys: ['shared_a'] }),
      col('shared', 'slug', { unique_keys: ['shared_b'] }),
    ]);
    assert.deepEqual(map.SchemaShared.uniqueKeys, [['tenantId', 'code'], ['tenantId', 'slug']]);
  });
});

describe('applyExcludeColumns - unique keys', () => {
  it('drops a unique key one of whose columns is excluded', () => {
    const map = buildTableMap(sampleRows());
    applyExcludeColumns(map, ['sample.slug']);
    assert.deepEqual(map.SchemaSample.uniqueKeys, [['code']]);
  });
});

describe('generateSchemaFile - unique keys', () => {
  const args = ['SchemaSample', 'sample', { id: 'Type.Integer()', code: 'Type.String()' },
    { id: 'id', code: 'code' }, ['id'], [], false];

  it('emits uniqueKeys in the Schema export', () => {
    const content = generateSchemaFile(...args, [['code'], ['tenantId', 'slug']]);
    assert.ok(content.includes('uniqueKeys: [["code"],["tenantId","slug"]],'), content);
  });

  it('emits an empty uniqueKeys when the table has none', () => {
    const content = generateSchemaFile(...args, []);
    assert.ok(content.includes('uniqueKeys: [],'), content);
  });
});
