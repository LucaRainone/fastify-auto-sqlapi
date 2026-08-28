// `primary` is the one required key of a table config that nothing used to check.
//
// It matters most for views, which carry no PRIMARY KEY constraint: the generator now refuses
// to invent one and writes a TODO instead, and that TODO must be caught at startup rather than
// reaching a request and coming back as a raw SQL error (a 500, per ADR 0006).
//
// A search-only table is the deliberate exception: the engine reads `primary` only as the
// fallback for ordering, so a config that names an explicit `defaultOrder` and exposes nothing
// but `search` never touches it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { defineTable, exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { Type } = await import('@sinclair/typebox');

const fields = {
  id: Type.Optional(Type.Integer()),
  name: Type.String(),
  orderCount: Type.Optional(Type.Integer()),
};

const schema = {
  col: (f) => toUnderscore(f),
  fields,
  validation: Type.Object(fields),
  partialValidation: Type.Object(fields),
  tableName: 'customer_summary',
};

describe('defineTable validates the primary key', () => {
  it('accepts a primary key that names a schema field', () => {
    assert.doesNotThrow(() => defineTable({ primary: 'id', ...exportTableInfo(schema) }));
  });

  it('accepts every field of a composite primary key', () => {
    assert.doesNotThrow(
      () => defineTable({ primary: ['id', 'name'], ...exportTableInfo(schema) })
    );
  });

  it('rejects a primary key that is not a schema field', () => {
    assert.throws(
      () => defineTable({ primary: 'nope', ...exportTableInfo(schema) }),
      /primary key field 'nope' is not a schema field/
    );
  });

  it('rejects one bad field inside a composite primary key', () => {
    assert.throws(
      () => defineTable({ primary: ['id', 'nope'], ...exportTableInfo(schema) }),
      /primary key field 'nope' is not a schema field/
    );
  });

  it('allows an unresolved primary key on a search-only table with an explicit order', () => {
    assert.doesNotThrow(() => defineTable({
      primary: 'TODO_pick_a_unique_column',
      ...exportTableInfo(schema),
      operations: ['search'],
      defaultOrder: 'name',
    }));
  });

  it('rejects an unresolved primary key when search has no explicit order to fall back on', () => {
    // Without defaultOrder the search itself would ORDER BY a column that does not exist.
    assert.throws(
      () => defineTable({
        primary: 'TODO_pick_a_unique_column',
        ...exportTableInfo(schema),
        operations: ['search'],
      }),
      /defaultOrder/
    );
  });

  it('rejects an unresolved primary key as soon as an operation needs it', () => {
    assert.throws(
      () => defineTable({
        primary: 'TODO_pick_a_unique_column',
        ...exportTableInfo(schema),
        operations: ['search', 'get'],
        defaultOrder: 'name',
      }),
      /get/
    );
  });

  it('rejects an unresolved primary key when every operation is exposed by default', () => {
    assert.throws(
      () => defineTable({
        primary: 'TODO_pick_a_unique_column',
        ...exportTableInfo(schema),
        defaultOrder: 'name',
      }),
      /primary key field/
    );
  });
});
