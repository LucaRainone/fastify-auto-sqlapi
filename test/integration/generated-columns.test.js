// Columns the database computes, end to end on a real engine.
//
// The point of these tests is that both PostgreSQL and MySQL reject a write that so much as
// names such a column — the whole statement fails, not just that field — so anything the
// plugin offers as writable there can only ever become a driver error. They also pin the
// identity/AUTO_INCREMENT primary key, whose absent `column_default` used to make the
// generated schema declare it mandatory and the table impossible to insert into.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIALECT, PG_CONNECTION_STRING, MYSQL_CONFIG, createTestApp, cleanTables } from './_helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { introspectTables } = await import(path.join(ROOT, 'dist/lib/cli/pg-introspect.js'));
const { introspectMysqlTables } = await import(path.join(ROOT, 'dist/lib/cli/mysql-introspect.js'));
const { buildTableMap, generateSchemaFile } = await import(
  path.join(ROOT, 'dist/lib/cli/schema-codegen.js')
);
const { defineTable, exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { Type, Nullable } = await import(path.join(ROOT, 'dist/index.js'));

function introspect() {
  return DIALECT === 'postgres'
    ? introspectTables(PG_CONNECTION_STRING, 'public')
    : introspectMysqlTables(MYSQL_CONFIG, MYSQL_CONFIG.database);
}

describe(`[${DIALECT}] introspection of database-computed columns`, () => {
  it('flags a column generated from other columns', async () => {
    const rows = await introspect();
    const subtotal = rows.find(
      (r) => r.table_name === 'computed_line' && r.column_name === 'subtotal'
    );
    assert.ok(subtotal, 'subtotal column should be introspected');
    assert.equal(subtotal.is_generated, true);
  });

  it('flags a column generated from a JSON payload', async () => {
    const rows = await introspect();
    const statusCode = rows.find(
      (r) => r.table_name === 'computed_line' && r.column_name === 'status_code'
    );
    assert.equal(statusCode.is_generated, true);
  });

  it('leaves ordinary columns alone', async () => {
    const rows = await introspect();
    const qty = rows.find((r) => r.table_name === 'computed_line' && r.column_name === 'qty');
    assert.ok(!qty.is_generated);
  });

  // MySQL reports EXTRA='DEFAULT_GENERATED' for any default *expression*, so this column
  // looks generated to a substring match on 'generated' and stops being writable.
  it('leaves a column with a default expression writable', async () => {
    const rows = await introspect();
    const createdAt = rows.find(
      (r) => r.table_name === 'customer' && r.column_name === 'created_at'
    );
    assert.ok(createdAt, 'customer.created_at should be introspected');
    assert.ok(!createdAt.is_generated);
  });

  it('flags the auto-generated primary key even without a column_default', async () => {
    const rows = await introspect();
    const id = rows.find((r) => r.table_name === 'identity_row' && r.column_name === 'id');
    assert.equal(id.is_auto_increment, true);
  });
});

describe(`[${DIALECT}] generated schema for a table with computed columns`, () => {
  it('publishes the computed columns under generatedFields', async () => {
    const map = buildTableMap(await introspect());
    assert.deepEqual(map.SchemaComputedLine.generated, ['subtotal', 'statusCode']);
  });

  it('keeps them among the readable fields', async () => {
    const map = buildTableMap(await introspect());
    assert.ok(map.SchemaComputedLine.fields.subtotal);
    assert.ok(map.SchemaComputedLine.fields.statusCode);
  });

  it('never declares the auto-generated primary key mandatory', async () => {
    const map = buildTableMap(await introspect());
    assert.match(map.SchemaIdentityRow.fields.id, /^Type\.Optional\(/);
  });

  it('writes generatedFields into the schema file', async () => {
    const map = buildTableMap(await introspect());
    const t = map.SchemaComputedLine;
    const file = generateSchemaFile(
      'SchemaComputedLine', t.name, t.fields, t.colMap, t.primary, t.generated
    );
    assert.match(file, /generatedFields: \["subtotal","statusCode"\]/);
  });
});

// The Schema below mirrors what the generator emits for computed_line, so the routes are
// built from the same shape a consumer would get out of `sqlapi-generate-schema`.
const computedLineFields = {
  id: Type.Optional(Type.Integer()),
  payload: Type.Optional(Type.Any()),
  qty: Type.Optional(Type.Integer()),
  price: Type.Optional(Type.Integer()),
  subtotal: Type.Optional(Nullable(Type.Integer())),
  statusCode: Type.Optional(Nullable(Type.String())),
};
const computedLineColMap = {
  id: 'id', payload: 'payload', qty: 'qty', price: 'price',
  subtotal: 'subtotal', statusCode: 'status_code',
};
const SchemaComputedLine = {
  col: (f) => computedLineColMap[f] ?? f,
  colMap: computedLineColMap,
  fields: computedLineFields,
  validation: Type.Object(computedLineFields, { $id: 'SchemaComputedLine' }),
  partialValidation: Type.Object(computedLineFields, {
    additionalProperties: false, $id: 'PartialSchemaComputedLine',
  }),
  tableName: 'computed_line',
  primaryKey: ['id'],
  generatedFields: ['subtotal', 'statusCode'],
};

const DbTables = {
  computed_line: defineTable({
    primary: 'id',
    ...exportTableInfo(SchemaComputedLine),
    defaultOrder: 'id',
    excludeFromCreation: ['id'],
  }),
};

describe(`[${DIALECT}] writes against real computed columns`, () => {
  let app;
  let db;
  // A second app that keeps unknown body keys instead of stripping them, which is the only
  // way to observe the rejection: Fastify defaults to removeAdditional:true.
  let strictApp;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));
    ({ app: strictApp } = await createTestApp(
      DbTables,
      { prefix: '/auto' },
      { ajv: { customOptions: { removeAdditional: false } } }
    ));
    await cleanTables(db, ['computed_line']);
  });

  after(async () => {
    await app.close();
    await strictApp.close();
  });

  it('inserts a row and lets the database compute the derived columns', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/computed_line',
      payload: { main: { payload: JSON.stringify({ status: 'open' }), qty: 3, price: 10 } },
    });

    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().main.id;

    const read = await app.inject({ method: 'GET', url: `/auto/rest/computed_line/${id}` });
    assert.equal(Number(read.json().main.subtotal), 30);
    assert.equal(read.json().main.statusCode, 'open');
  });

  it('does not let an insert naming a computed column reach the driver', async () => {
    // The column is not in the body schema, so Fastify drops it before the engine ever runs.
    // Whatever the caller sent, the value stored is the one the database computed.
    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/computed_line',
      payload: { main: { payload: JSON.stringify({ status: 'open' }), qty: 2, price: 3, subtotal: 999 } },
    });

    assert.equal(res.statusCode, 201, res.body);
    const read = await app.inject({
      method: 'GET', url: `/auto/rest/computed_line/${res.json().main.id}`,
    });
    assert.equal(Number(read.json().main.subtotal), 6);
  });

  it('does not let an update naming a computed column reach the driver', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/auto/rest/computed_line',
      payload: { main: { payload: '{}', qty: 2, price: 2 } },
    });
    const id = created.json().main.id;

    const res = await app.inject({
      method: 'PUT',
      url: '/auto/rest/computed_line',
      payload: { main: { id, qty: 5, subtotal: 123 } },
    });

    assert.equal(res.statusCode, 200, res.body);
    const read = await app.inject({ method: 'GET', url: `/auto/rest/computed_line/${id}` });
    assert.equal(Number(read.json().main.subtotal), 10);
  });

  it('answers 400 on a computed column when unknown keys are kept', async () => {
    const res = await strictApp.inject({
      method: 'POST',
      url: '/auto/rest/computed_line',
      payload: { main: { payload: '{}', qty: 1, price: 1, subtotal: 999 } },
    });

    assert.equal(res.statusCode, 400, res.body);
  });

  it('updates the ordinary columns and lets the derived ones follow', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/auto/rest/computed_line',
      payload: { main: { payload: '{}', qty: 2, price: 4 } },
    });
    const id = created.json().main.id;

    const res = await app.inject({
      method: 'PUT',
      url: '/auto/rest/computed_line',
      payload: { main: { id, qty: 5 } },
    });
    assert.equal(res.statusCode, 200, res.body);

    const read = await app.inject({ method: 'GET', url: `/auto/rest/computed_line/${id}` });
    assert.equal(Number(read.json().main.subtotal), 20);
  });

  it('drops a computed column sent through sqlApi, which skips the body schema', async () => {
    // The HTTP schema is not in the way here, so this is the engine's own strip.
    const result = await app.sqlApi.insert('computed_line', {
      record: { payload: JSON.stringify({ status: 'via-api' }), qty: 2, price: 3, subtotal: 999 },
    });

    const read = await app.sqlApi.get('computed_line', result.main.id);
    assert.equal(Number(read.main.subtotal), 6);
    assert.equal(read.main.statusCode, 'via-api');
  });

  it('searches, filters and orders on a computed column like any other', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/computed_line?orderBy=subtotal DESC',
      payload: { conditions: [{ field: 'subtotal', method: 'isGreater', params: [0] }] },
    });

    assert.equal(res.statusCode, 200, res.body);
    const rows = res.json().main;
    assert.ok(rows.length > 1);
    const subtotals = rows.map((r) => Number(r.subtotal));
    assert.deepEqual(subtotals, [...subtotals].sort((a, b) => b - a));
  });
});
