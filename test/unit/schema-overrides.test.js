import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { InsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/insert.js'));
const { UpdateTableBody } = await import(path.join(ROOT, 'dist/lib/schema/update.js'));
const { BulkUpsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/bulk-upsert.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
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

const customerFields = {
  id: Type.Optional(Type.Integer()),
  name: Type.String(),
  email: Type.String(),
};

function createDbTables(overrides) {
  const schema = createMockSchema('customer', customerFields);
  const info = exportTableInfo(schema);
  return {
    customer: {
      primary: 'id',
      ...info,
      defaultOrder: 'id',
      excludeFromCreation: ['id'],
      ...(overrides ? { schemaOverrides: overrides } : {}),
    },
  };
}

describe('schemaOverrides - InsertTableBody', () => {
  it('applies format override to insert body', () => {
    const dbTables = createDbTables({
      email: Type.String({ format: 'email' }),
    });

    const body = InsertTableBody(dbTables, 'customer');
    const emailSchema = body.properties.main.properties.email;

    assert.equal(emailSchema.format, 'email');
  });

  it('applies minLength override to insert body', () => {
    const dbTables = createDbTables({
      name: Type.String({ minLength: 3 }),
    });

    const body = InsertTableBody(dbTables, 'customer');
    const nameSchema = body.properties.main.properties.name;

    assert.equal(nameSchema.minLength, 3);
  });

  it('does not affect non-overridden fields', () => {
    const dbTables = createDbTables({
      email: Type.String({ format: 'email' }),
    });

    const body = InsertTableBody(dbTables, 'customer');
    const nameSchema = body.properties.main.properties.name;

    assert.equal(nameSchema.format, undefined);
    assert.equal(nameSchema.type, 'string');
  });

  it('does not affect original schema fields object', () => {
    const dbTables = createDbTables({
      email: Type.String({ format: 'email' }),
    });

    InsertTableBody(dbTables, 'customer');

    // Original schema should be untouched
    const originalEmail = dbTables.customer.Schema.fields.email;
    assert.equal(originalEmail.format, undefined);
  });

  it('works without schemaOverrides', () => {
    const dbTables = createDbTables();

    const body = InsertTableBody(dbTables, 'customer');
    const emailSchema = body.properties.main.properties.email;

    assert.equal(emailSchema.type, 'string');
    assert.equal(emailSchema.format, undefined);
  });
});

describe('schemaOverrides - UpdateTableBody', () => {
  it('applies override and wraps in Optional for non-PK fields', () => {
    const dbTables = createDbTables({
      email: Type.String({ format: 'email' }),
    });

    const body = UpdateTableBody(dbTables, 'customer');
    const mainProps = body.properties.main;

    // email should be Optional (update = partial) but with format applied
    // In TypeBox, Optional fields are in the schema's required array absence
    // The field itself should have the format
    const emailKey = Object.keys(mainProps.properties).find(k => k === 'email');
    assert.ok(emailKey);

    // Check that format is present in the email schema
    const emailSchema = mainProps.properties.email;
    // For Optional fields, TypeBox wraps them - check inner or direct
    const format = emailSchema.format || emailSchema?.anyOf?.[0]?.format;
    assert.ok(format === 'email' || emailSchema.format === 'email',
      'email field should have format: email');
  });

  it('override does not leak into other fields', () => {
    const dbTables = createDbTables({
      email: Type.String({ format: 'email' }),
    });

    const body = UpdateTableBody(dbTables, 'customer');
    const mainSchema = body.properties.main;
    const nameSchema = mainSchema.properties.name;

    // name should not have format (only email was overridden)
    assert.equal(nameSchema.format, undefined);
  });
});

describe('schemaOverrides - BulkUpsertTableBody', () => {
  it('applies override to bulk upsert body', () => {
    const dbTables = createDbTables({
      email: Type.String({ format: 'email' }),
    });

    const body = BulkUpsertTableBody(dbTables, 'customer');
    // body is Type.Array(Type.Object({ main: Type.Partial(...) }))
    const itemSchema = body.items;
    const mainSchema = itemSchema.properties.main;

    // In Partial, all fields are optional. The email property should have format.
    const emailSchema = mainSchema.properties.email;
    assert.equal(emailSchema.format, 'email');
  });
});
