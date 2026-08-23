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
// `schemaOverrides` narrows a type the DB introspection could only guess wide: a column
// Postgres calls `text` is an email, a date, a URL. That is a property of the field, not of
// the direction it travels — so the same declaration has to describe the response, or the
// generated Swagger documents a looser contract than the one the API actually honours.

const { SearchTableResponse } = await import(path.join(ROOT, 'dist/lib/schema/search.js'));
const { GetTableResponse } = await import(path.join(ROOT, 'dist/lib/schema/get.js'));
const { buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));

describe('schemaOverrides - SearchTableResponse', () => {
  it('applies the override to the main response item', () => {
    const dbTables = createDbTables({
      email: Type.String({ format: 'email' }),
    });

    const response = SearchTableResponse(dbTables, 'customer');
    const emailSchema = response.properties.main.items.properties.email;

    assert.equal(emailSchema.format, 'email');
  });

  it('leaves non-overridden fields alone', () => {
    const dbTables = createDbTables({
      email: Type.String({ format: 'email' }),
    });

    const response = SearchTableResponse(dbTables, 'customer');

    assert.equal(response.properties.main.items.properties.name.format, undefined);
  });

  it('applies the JOINED table\'s own override to join response items', () => {
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

    const response = SearchTableResponse(dbTables, 'customer');
    const itemSchema = response.properties.joinMultiple.properties.customer_order.items;

    assert.equal(itemSchema.properties.reference.format, 'uuid');
  });
});

describe('GetTableResponse', () => {
  it('applies the override to the returned record', () => {
    const dbTables = createDbTables({
      email: Type.String({ format: 'email' }),
    });

    const response = GetTableResponse(dbTables, 'customer');

    assert.equal(response.properties.main.properties.email.format, 'email');
  });

  it('omits read-excluded fields, like the search response does', () => {
    const dbTables = createDbTables();
    dbTables.customer.readExclude = ['email'];

    const response = GetTableResponse(dbTables, 'customer');

    assert.equal(response.properties.main.properties.email, undefined);
    assert.ok(response.properties.main.properties.name);
  });
});

// ─── What an override may and may not change ────────────────
//
// On the way IN an override is a validation rule the consumer writes, and it is honoured
// verbatim: no `Type.Optional` means mandatory, no `Nullable` means an explicit null is
// rejected — whatever the column allows. That is how a column the DB had to make nullable
// (a new column on a populated table) is made mandatory from now on.
//
// On the way OUT nothing is validated. Fastify serializes against the schema, so a `string`
// declaration facing a stored NULL does not refuse it — it writes `""`. A column that can hold
// NULL therefore keeps `null` in its response type however the override was written.

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

describe('schemaOverrides - a narrowing keeps the column\'s own facts', () => {
  it('keeps a nullable column nullable in the response', () => {
    const dbTables = createNullableDbTables({ email: Type.String({ format: 'email' }) });

    const item = SearchTableResponse(dbTables, 'customer').properties.main.items.properties.email;

    assert.equal(item.format, 'email', 'the narrowing still applies');
    assert.ok(admitsNull(item), 'NULL must stay serializable, or fast-json-stringify emits ""');
  });

  it('keeps a nullable column nullable in the get response', () => {
    const dbTables = createNullableDbTables({ email: Type.String({ format: 'email' }) });

    const field = GetTableResponse(dbTables, 'customer').properties.main.properties.email;

    assert.equal(field.format, 'email');
    assert.ok(admitsNull(field));
  });

  it('makes a DB-nullable column mandatory on write when the override says so', () => {
    // The migration case: a column added to a populated table is NULL for the existing rows,
    // so the DB cannot declare it NOT NULL — but every write from now on must carry it.
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

  it('still returns null for a mandatory-on-write column that is nullable in the DB', () => {
    // Same table as the migration case above: rows written before the column existed hold
    // NULL, and the response must say so rather than serialize them as "".
    const dbTables = createNullableDbTables({ email: Type.String({ format: 'email' }) });

    const item = SearchTableResponse(dbTables, 'customer').properties.main.items.properties.email;

    assert.equal(item.format, 'email');
    assert.ok(admitsNull(item));
  });

  it('leaves the primary key required on update', () => {
    const dbTables = createNullableDbTables({ id: Type.Integer({ minimum: 1 }) });

    const main = UpdateTableBody(dbTables, 'customer').properties.main;

    assert.equal(main.properties.id.minimum, 1);
    assert.deepEqual(main.required, ['id'], 'the PK identifies the row: it stays mandatory');
  });

  it('does not add nullability the column never had', () => {
    const dbTables = createNullableDbTables({ name: Type.String({ minLength: 3 }) });

    const field = InsertTableBody(dbTables, 'customer').properties.main.properties.name;

    assert.equal(field.minLength, 3);
    assert.equal(admitsNull(field), false);
    assert.ok((InsertTableBody(dbTables, 'customer').properties.main.required ?? []).includes('name'));
  });

  it('respects an override that spells out the nullability itself, on both sides', () => {
    const dbTables = createNullableDbTables({ email: Nullable(Type.String({ format: 'email' })) });

    const body = InsertTableBody(dbTables, 'customer').properties.main.properties.email;
    const item = SearchTableResponse(dbTables, 'customer').properties.main.items.properties.email;

    assert.equal(body.format, 'email');
    assert.deepEqual(body.type, ['string', 'null'], 'accepts an explicit null on write');
    assert.deepEqual(item.type, ['string', 'null'], 'no double wrapping on the response');
  });
});
