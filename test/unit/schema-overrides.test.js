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

// ─── Read side ──────────────────────────────────────────────
//
// `schemaOverrides` does NOT narrow the response, on purpose. An override rules what this API
// accepts from now on, while the rows already stored predate it: a column narrowed to
// `format: 'email'` today holds whatever was accepted last year, and one made mandatory today
// is NULL on every pre-existing row. Nothing would break at runtime — Fastify does not validate
// responses, `fast-json-stringify` ignores every validation keyword and acts only on `type` —
// but the published contract would promise something no one can retroactively make true.

const { SearchTableResponse } = await import(path.join(ROOT, 'dist/lib/schema/search.js'));
const { GetTableResponse } = await import(path.join(ROOT, 'dist/lib/schema/get.js'));
const { buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { Nullable } = await import(path.join(ROOT, 'dist/lib/nullable.js'));

const nullableCustomerFields = {
  id: Type.Optional(Type.Integer()),
  name: Type.String(),
  email: Type.Optional(Nullable(Type.String())),
};

function createNullableDbTables(overrides) {
  const schema = createMockSchema('customer', nullableCustomerFields);
  return {
    customer: {
      primary: 'id',
      ...exportTableInfo(schema),
      defaultOrder: 'id',
      excludeFromCreation: ['id'],
      ...(overrides ? { schemaOverrides: overrides } : {}),
    },
  };
}

const admitsNull = (s) => Array.isArray(s.type) && s.type.includes('null');

describe('schemaOverrides - responses keep the generated type', () => {
  it('does not narrow the search response', () => {
    const dbTables = createDbTables({ email: Type.String({ format: 'email' }) });

    const item = SearchTableResponse(dbTables, 'customer').properties.main.items.properties.email;

    assert.equal(item.format, undefined, 'rows written before the rule cannot be promised to honour it');
    assert.equal(item.type, 'string');
  });

  it('does not narrow the get response', () => {
    const dbTables = createDbTables({ email: Type.String({ format: 'email' }) });

    const field = GetTableResponse(dbTables, 'customer').properties.main.properties.email;

    assert.equal(field.format, undefined);
    assert.equal(field.type, 'string');
  });

  it('does not narrow join response items either', () => {
    const customerSchema = createMockSchema('customer', customerFields);
    const orderFields = {
      id: Type.Optional(Type.Integer()),
      customerId: Type.Integer(),
      reference: Type.String(),
    };
    const orderSchema = createMockSchema('customer_order', orderFields);

    const dbTables = {
      customer: {
        primary: 'id',
        ...exportTableInfo(customerSchema),
        defaultOrder: 'id',
        allowedReadJoins: [
          buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
        ],
      },
      customer_order: {
        primary: 'id',
        ...exportTableInfo(orderSchema),
        defaultOrder: 'id',
        schemaOverrides: { reference: Type.String({ format: 'uuid' }) },
      },
    };

    const item = SearchTableResponse(dbTables, 'customer')
      .properties.joinMultiple.properties.customer_order.items;

    assert.equal(item.properties.reference.format, undefined);
  });

  it('keeps a nullable column nullable in the response, whatever the override says', () => {
    // The reason the two directions cannot share a schema: a response is serialized, not
    // validated, so a non-nullable declaration would not reject a stored NULL — it would
    // serialize it as "".
    const dbTables = createNullableDbTables({ email: Type.String({ format: 'email' }) });

    const item = SearchTableResponse(dbTables, 'customer').properties.main.items.properties.email;

    assert.ok(admitsNull(item));
  });
});

describe('GetTableResponse', () => {
  it('omits read-excluded fields, like the search response does', () => {
    const dbTables = createDbTables();
    dbTables.customer.readExclude = ['email'];

    const response = GetTableResponse(dbTables, 'customer');

    assert.equal(response.properties.main.properties.email, undefined);
    assert.ok(response.properties.main.properties.name);
  });
});

// ─── Write side: the override is the rule, verbatim ─────────
//
// No `Type.Optional` means mandatory, no `Nullable` rejects an explicit null — whatever the
// column allows. That is how a column the DB had to leave nullable (a new column added to a
// populated table) is made mandatory from now on.

describe('schemaOverrides - the write body takes the override verbatim', () => {
  it('makes a DB-nullable column mandatory on write when the override says so', () => {
    const withOverride = createNullableDbTables({ email: Type.String({ format: 'email' }) });
    const without = createNullableDbTables();

    const insert = InsertTableBody(withOverride, 'customer').properties.main;
    const baseline = InsertTableBody(without, 'customer').properties.main;

    assert.equal(insert.properties.email.format, 'email');
    assert.ok(insert.required.includes('email'), 'no Type.Optional in the override: mandatory');
    assert.ok(!(baseline.required ?? []).includes('email'), 'and optional without one');
    assert.equal(admitsNull(insert.properties.email), false, 'no Nullable: an explicit null is rejected');
  });

  it('keeps a field optional on write when the override says so', () => {
    const dbTables = createNullableDbTables({
      email: Type.Optional(Type.String({ format: 'email' })),
    });

    const insert = InsertTableBody(dbTables, 'customer').properties.main;

    assert.equal(insert.properties.email.format, 'email');
    assert.ok(!(insert.required ?? []).includes('email'));
  });

  it('accepts an explicit null when the override spells the nullability out', () => {
    const dbTables = createNullableDbTables({ email: Nullable(Type.String({ format: 'email' })) });

    const field = InsertTableBody(dbTables, 'customer').properties.main.properties.email;

    assert.equal(field.format, 'email');
    assert.deepEqual(field.type, ['string', 'null']);
  });

  it('leaves the primary key required on update', () => {
    const dbTables = createNullableDbTables({ id: Type.Integer({ minimum: 1 }) });

    const main = UpdateTableBody(dbTables, 'customer').properties.main;

    assert.equal(main.properties.id.minimum, 1);
    assert.deepEqual(main.required, ['id'], 'the PK identifies the row: it stays mandatory');
  });
});
