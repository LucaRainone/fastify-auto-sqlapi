// A view is a table config like any other — the plugin has one concept for "a relation with
// columns you can query" and a view is that. What differs is what the generator may assume:
// a view carries no PRIMARY KEY constraint, so the primary key cannot be guessed in silence,
// and an aggregating view refuses every write.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { buildTableMap, generateSchemaFile } = await import(
  path.join(ROOT, 'dist/lib/cli/schema-codegen.js')
);
const { generateSingleTableFile, parseSchemaFile } = await import(
  path.join(ROOT, 'dist/lib/cli/tables-codegen.js')
);

function col(table, name, overrides = {}) {
  return {
    table_name: table,
    column_name: name,
    udt_name: 'int4',
    column_default: null,
    is_nullable: 'YES',
    ...overrides,
  };
}

describe('buildTableMap - views', () => {
  it('marks a relation introspected as a view', () => {
    const map = buildTableMap([
      col('customer_summary', 'id', { is_view: true }),
      col('customer_summary', 'order_count', { is_view: true }),
    ]);
    assert.equal(map.SchemaCustomerSummary.isView, true);
  });

  it('leaves a base table unmarked', () => {
    const map = buildTableMap([col('customer', 'id', { is_primary: true })]);
    assert.equal(map.SchemaCustomer.isView, false);
  });

  it('records no primary key for a view — views carry no PK constraint', () => {
    const map = buildTableMap([col('customer_summary', 'id', { is_view: true })]);
    assert.deepEqual(map.SchemaCustomerSummary.primary, []);
  });
});

describe('generateSchemaFile - views', () => {
  const fields = { id: 'Type.Optional(Type.Integer())' };
  const colMap = { id: 'id' };

  it('publishes isView on the Schema object', () => {
    const out = generateSchemaFile('SchemaV', 'v', fields, colMap, [], [], true);
    assert.match(out, /isView: true/);
  });

  it('omits the key for a base table', () => {
    const out = generateSchemaFile('SchemaT', 't', fields, colMap, ['id'], [], false);
    assert.doesNotMatch(out, /isView/);
  });

  it('round-trips through parseSchemaFile', () => {
    const out = generateSchemaFile('SchemaV', 'v', fields, colMap, [], [], true);
    assert.equal(parseSchemaFile(out).isView, true);
    const base = generateSchemaFile('SchemaT', 't', fields, colMap, ['id'], [], false);
    assert.ok(!parseSchemaFile(base).isView);
  });
});

function viewSchema(fields, extra = {}) {
  return {
    schemaName: 'SchemaCustomerSummary',
    tableName: 'customer_summary',
    fields,
    fieldTypes: Object.fromEntries(fields.map((f) => [f, 'Type.Optional(Type.Integer())'])),
    isView: true,
    ...extra,
  };
}

describe('generateSingleTableFile - views', () => {
  it('restricts the generated routes to reads', () => {
    // Not a change to the runtime default (ADR 0002): this is the starting point written into
    // a file the developer owns, and an aggregating view cannot serve a write at all.
    const out = generateSingleTableFile(viewSchema(['id', 'name', 'orderCount']), []);
    assert.match(out, /operations: \['search', 'get'\]/);
  });

  it('says the primary key was inferred, not read from the database', () => {
    const out = generateSingleTableFile(viewSchema(['id', 'name']), []);
    assert.match(out, /primary: 'id'/);
    assert.match(out, /no PRIMARY KEY/i);
  });

  it('refuses to invent a primary key when the view has no obvious one', () => {
    const out = generateSingleTableFile(viewSchema(['month', 'revenue']), []);
    assert.match(out, /primary: 'TODO/);
    // Search must still work as generated, which means ordering cannot fall back to the PK.
    assert.match(out, /defaultOrder: 'month'/);
    assert.match(out, /operations: \['search'\]/);
  });

  it('does not emit excludeFromCreation for a view', () => {
    const out = generateSingleTableFile(viewSchema(['id', 'name']), []);
    assert.doesNotMatch(out, /^\s*excludeFromCreation:/m);
  });

  it('leaves a base table template untouched', () => {
    const base = {
      schemaName: 'SchemaCustomer',
      tableName: 'customer',
      fields: ['id', 'name'],
      fieldTypes: { id: 'Type.Optional(Type.Integer())', name: 'Type.String()' },
      primary: ['id'],
    };
    const out = generateSingleTableFile(base, []);
    assert.match(out, /excludeFromCreation: \['id'\]/);
    assert.doesNotMatch(out, /operations:/);
    assert.doesNotMatch(out, /TODO/);
  });
});
