// `writeExclude` — the write-side counterpart of `readExclude`: a field that is readable
// but that no write may ever carry.
//
// It exists for columns the database computes (`GENERATED ALWAYS AS ...`): those reject any
// value, whoever sets it, so the exclusion is a fact about the column and not a policy about
// the caller. That is what separates it from `excludeFromCreation`, which is an insert-time
// whitelist on CLIENT input and deliberately lets a hook assign the field (ADR 0005), and
// from per-caller field rules, which stay in `beforeUpdate` / `validate`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { updateEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/update.js'));
const { exportTableInfo, defineTable, buildRelation } = await import(
  path.join(ROOT, 'dist/lib/table-helpers.js')
);
const { InsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/insert.js'));
const { UpdateTableBody } = await import(path.join(ROOT, 'dist/lib/schema/update.js'));
const { BulkUpsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/bulk-upsert.js'));
const { buildAgentManifest } = await import(path.join(ROOT, 'dist/lib/agent/manifest.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import('@sinclair/typebox');

const mockRequest = {};

function createMockSchema(tableName, fields, generatedFields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
    ...(generatedFields ? { generatedFields } : {}),
  };
}

// `total` is a stored generated column: the database computes it from qty * price.
const invoiceFields = {
  id: Type.Optional(Type.Integer()),
  qty: Type.Integer(),
  price: Type.Number(),
  total: Type.Optional(Type.Number()),
  note: Type.Optional(Type.String()),
};
const lineFields = {
  id: Type.Optional(Type.Integer()),
  invoiceId: Type.Integer(),
  label: Type.String(),
  labelUpper: Type.Optional(Type.String()),
};

function createDbTables(mockPg, opts = {}) {
  const invoiceSchema = createMockSchema('invoice', invoiceFields, opts.declareGenerated === false ? undefined : ['total']);
  const lineSchema = createMockSchema('invoice_line', lineFields, ['labelUpper']);

  const DbTables = {
    invoice: defineTable({
      primary: 'id',
      ...exportTableInfo(invoiceSchema),
      defaultOrder: 'id',
      excludeFromCreation: ['id'],
      allowedWriteJoins: [
        buildRelation(invoiceSchema, 'id', lineSchema, 'invoiceId', { alias: 'invoice_line' }),
      ],
      ...(opts.writeExclude ? { writeExclude: opts.writeExclude } : {}),
      ...(opts.beforeInsert ? { beforeInsert: opts.beforeInsert } : {}),
      ...(opts.beforeUpdate ? { beforeUpdate: opts.beforeUpdate } : {}),
    }),
    invoice_line: defineTable({
      primary: 'id',
      ...exportTableInfo(lineSchema),
      defaultOrder: 'id',
      excludeFromCreation: ['id'],
    }),
  };

  return { DbTables, db: new QueryClient(mockPg), invoiceSchema, lineSchema };
}

describe('write body schemas exclude database-computed fields', () => {
  it('drops a generated field from the insert body', () => {
    const { DbTables } = createDbTables(createMockPg([]));
    const body = InsertTableBody(DbTables, 'invoice');
    assert.equal(body.properties.main.properties.total, undefined);
    assert.ok(body.properties.main.properties.qty, 'ordinary fields stay');
  });

  it('drops a generated field from the update body', () => {
    const { DbTables } = createDbTables(createMockPg([]));
    const body = UpdateTableBody(DbTables, 'invoice');
    assert.equal(body.properties.main.properties.total, undefined);
    assert.ok(body.properties.main.properties.id, 'the PK still identifies the row');
  });

  it('drops a generated field from the bulk-upsert body', () => {
    const { DbTables } = createDbTables(createMockPg([]));
    const body = BulkUpsertTableBody(DbTables, 'invoice');
    assert.equal(body.items.properties.main.properties.total, undefined);
  });

  it('drops the child table generated field from a secondaries body', () => {
    const { DbTables } = createDbTables(createMockPg([]));
    const body = InsertTableBody(DbTables, 'invoice');
    const line = body.properties.secondaries.properties.invoice_line.items;
    assert.equal(line.properties.labelUpper, undefined);
    assert.ok(line.properties.label);
  });

  it('drops a writeExclude field declared by the table config', () => {
    const { DbTables } = createDbTables(createMockPg([]), { writeExclude: ['note'] });
    const body = InsertTableBody(DbTables, 'invoice');
    assert.equal(body.properties.main.properties.note, undefined);
  });

  it('keeps every field when nothing is excluded', () => {
    const { DbTables } = createDbTables(createMockPg([]), { declareGenerated: false });
    const body = InsertTableBody(DbTables, 'invoice');
    assert.ok(body.properties.main.properties.total);
  });
});

describe('engines strip database-computed fields from the SQL', () => {
  it('leaves a generated field out of the INSERT even when the caller sends it', async () => {
    // sqlApi.* bypasses the HTTP body schema, so the engine has to strip it too.
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const { DbTables, db } = createDbTables(mockPg);

    await insertEngine({
      db,
      tableConf: DbTables.invoice,
      dbTables: DbTables,
      request: mockRequest,
      record: { qty: 2, price: 5, total: 999 },
    });

    assert.ok(!mockPg.calls[0].text.includes('"total"'), mockPg.calls[0].text);
    assert.ok(!mockPg.calls[0].values.includes(999));
  });

  it('leaves a generated field out of the UPDATE SET', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const { DbTables, db } = createDbTables(mockPg);

    await updateEngine({
      db,
      tableConf: DbTables.invoice,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, qty: 4, total: 123 },
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.startsWith('UPDATE'), sql);
    assert.ok(!sql.includes('"total"'), sql);
    assert.ok(sql.includes('"qty"'), sql);
  });

  it('strips AFTER beforeInsert — a hook cannot resurrect a column the DB computes', async () => {
    // This is the opposite of excludeFromCreation, which is stripped BEFORE the hook so a
    // hook-assigned value does reach the INSERT (ADR 0005).
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const { DbTables, db } = createDbTables(mockPg, {
      beforeInsert: async (_db, _req, record) => {
        record.total = 42;
      },
    });

    await insertEngine({
      db,
      tableConf: DbTables.invoice,
      dbTables: DbTables,
      request: mockRequest,
      record: { qty: 2, price: 5 },
    });

    assert.ok(!mockPg.calls[0].text.includes('"total"'), mockPg.calls[0].text);
    assert.ok(!mockPg.calls[0].values.includes(42));
  });

  it('strips AFTER beforeUpdate as well', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const { DbTables, db } = createDbTables(mockPg, {
      beforeUpdate: async (_db, _req, fields) => {
        fields.total = 42;
      },
    });

    await updateEngine({
      db,
      tableConf: DbTables.invoice,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, qty: 4 },
    });

    assert.ok(!mockPg.calls[0].text.includes('"total"'), mockPg.calls[0].text);
  });
});

describe('defineTable validates writeExclude', () => {
  const schema = createMockSchema('invoice', invoiceFields);

  it('rejects a field that is not in the schema', () => {
    assert.throws(
      () => defineTable({ primary: 'id', ...exportTableInfo(schema), writeExclude: ['nope'] }),
      /writeExclude field 'nope' is not a schema field/
    );
  });

  it('rejects the primary key — the update body needs it to identify the row', () => {
    assert.throws(
      () => defineTable({ primary: 'id', ...exportTableInfo(schema), writeExclude: ['id'] }),
      /writeExclude cannot cover the primary key/
    );
  });

  it('rejects a field that is also readExcluded — remove it from the Schema instead', () => {
    assert.throws(
      () => defineTable({
        primary: 'id',
        ...exportTableInfo(schema),
        readExclude: ['note'],
        writeExclude: ['note'],
      }),
      /neither readable nor writable/
    );
  });

  it('accepts a plain readable-but-not-writable field', () => {
    assert.doesNotThrow(
      () => defineTable({ primary: 'id', ...exportTableInfo(schema), writeExclude: ['note'] })
    );
  });
});

describe('agent manifest reports non-writable fields', () => {
  it('marks a generated field readOnly', () => {
    const { DbTables } = createDbTables(createMockPg([]));
    const manifest = buildAgentManifest(DbTables);
    const invoice = manifest.tables.invoice;
    assert.equal(invoice.fields.total.readOnly, true);
    assert.equal(invoice.fields.qty.readOnly, undefined);
  });
});
