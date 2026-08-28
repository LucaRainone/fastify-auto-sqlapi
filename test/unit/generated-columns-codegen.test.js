// The generator must recognise columns the database computes by itself:
//   - GENERATED ALWAYS AS (<expr>) — Postgres STORED, MySQL VIRTUAL/STORED
//   - GENERATED ALWAYS AS IDENTITY — Postgres, which has no column_default to give it away
// Both are rejected by the database when a write names them, so a schema that presents them
// as ordinary writable fields turns a client mistake into a 500.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { convertColType, buildTableMap, generateSchemaFile } = await import(
  path.join(ROOT, 'dist/lib/cli/schema-codegen.js')
);
const { generateSingleTableFile, parseSchemaFile } = await import(
  path.join(ROOT, 'dist/lib/cli/tables-codegen.js')
);

function col(overrides) {
  return {
    table_name: 'gen_probe',
    column_name: 'x',
    udt_name: 'int4',
    column_default: null,
    is_nullable: 'NO',
    ...overrides,
  };
}

describe('convertColType - database-computed columns', () => {
  it('makes a generated column optional even when the column is NOT NULL', () => {
    // Without this the write body would demand a value the database refuses to accept.
    const t = convertColType('int4', col({ is_generated: true }));
    assert.equal(t, 'Type.Optional(Type.Integer())');
  });

  it('keeps a generated nullable column both optional and nullable', () => {
    const t = convertColType('text', col({ is_generated: true, is_nullable: 'YES' }));
    assert.equal(t, 'Type.Optional(Nullable(Type.String()))');
  });

  it('treats an identity column as auto-generated (no column_default to reveal it)', () => {
    // `id INT GENERATED ALWAYS AS IDENTITY` reports no default: without is_auto_increment
    // the field is emitted as mandatory and the table becomes un-insertable.
    const t = convertColType('int4', col({ column_name: 'id', is_auto_increment: true }));
    assert.equal(t, 'Type.Optional(Type.Integer())');
  });
});

describe('buildTableMap - generated field collection', () => {
  const rows = [
    col({ column_name: 'id', is_primary: true, is_auto_increment: true }),
    col({ column_name: 'payload', udt_name: 'jsonb' }),
    col({ column_name: 'status', udt_name: 'text', is_generated: true, is_nullable: 'YES' }),
    col({ column_name: 'qty' }),
    col({ column_name: 'total_amount', udt_name: 'numeric', is_generated: true, is_nullable: 'YES' }),
  ];

  it('lists generated columns as camelCase field names', () => {
    const map = buildTableMap(rows);
    assert.deepEqual(map.SchemaGenProbe.generated, ['status', 'totalAmount']);
  });

  it('keeps generated columns in fields — they are readable, only never writable', () => {
    const map = buildTableMap(rows);
    assert.ok(map.SchemaGenProbe.fields.status);
    assert.equal(map.SchemaGenProbe.colMap.totalAmount, 'total_amount');
  });

  it('reports an empty list when no column is generated', () => {
    const map = buildTableMap([col({ column_name: 'id', is_primary: true })]);
    assert.deepEqual(map.SchemaGenProbe.generated, []);
  });
});

describe('generateSchemaFile - generatedFields', () => {
  const fields = { id: 'Type.Optional(Type.Integer())', status: 'Type.Optional(Type.String())' };
  const colMap = { id: 'id', status: 'status' };

  it('publishes the generated columns on the Schema object', () => {
    const out = generateSchemaFile('SchemaGenProbe', 'gen_probe', fields, colMap, ['id'], ['status']);
    assert.match(out, /generatedFields: \["status"\]/);
  });

  it('omits the key entirely when the table has no generated column', () => {
    const out = generateSchemaFile('SchemaGenProbe', 'gen_probe', fields, colMap, ['id'], []);
    assert.doesNotMatch(out, /generatedFields/);
  });
});

describe('generateSingleTableFile - generated columns are surfaced in the template', () => {
  it('names the generated columns in a comment above writeExclude', () => {
    const parsed = {
      schemaName: 'SchemaGenProbe',
      tableName: 'gen_probe',
      fields: ['id', 'payload', 'status', 'qty', 'totalAmount'],
      fieldTypes: {
        id: 'Type.Optional(Type.Integer())',
        payload: 'Type.Optional(Type.Any())',
        status: 'Type.Optional(Nullable(Type.String()))',
        qty: 'Type.Integer()',
        totalAmount: 'Type.Optional(Nullable(Type.Number()))',
      },
      primary: ['id'],
      generated: ['status', 'totalAmount'],
    };
    const out = generateSingleTableFile(parsed, [parsed]);
    assert.match(out, /status, totalAmount/);
    assert.match(out, /writeExclude/);
  });
});

describe('parseSchemaFile - generatedFields round-trip', () => {
  it('reads back the generated columns the schema generator wrote', () => {
    const content = generateSchemaFile(
      'SchemaGenProbe',
      'gen_probe',
      { id: 'Type.Optional(Type.Integer())', status: 'Type.Optional(Type.String())' },
      { id: 'id', status: 'status' },
      ['id'],
      ['status']
    );
    const parsed = parseSchemaFile(content);
    assert.deepEqual(parsed.generated, ['status']);
  });

  it('leaves the list empty for a schema without generated columns', () => {
    const content = generateSchemaFile(
      'SchemaPlain',
      'plain',
      { id: 'Type.Optional(Type.Integer())' },
      { id: 'id' },
      ['id'],
      []
    );
    assert.deepEqual(parseSchemaFile(content).generated ?? [], []);
  });
});
