// Nullable columns are generated as Type.Optional(Nullable(T)) — the JSON-Schema
// type-array form ({ type: [..., 'null'] }). This is the only representation safe under
// Fastify defaults on BOTH sides:
//   - output: fast-json-stringify serializing NULL against a plain type coerces it
//     (0 / "" / false) — a NULL FK was served as 0;
//   - input: Ajv's coerceTypes corrupts anyOf unions (null -> 0 with the Null branch
//     last, 0 -> null with the Null branch first); with a type array no coercion
//     happens when the value already matches one of the listed types.
// Filters treat an explicit null as IS NULL (equality with NULL never matches, and
// dropping the filter silently would return unfiltered results).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { fastifyAutoSqlApi, Type, Nullable, exportTableInfo } =
  await import(path.join(ROOT, 'dist/index.js'));

describe('Nullable() helper', () => {
  it('produces the type-array form', () => {
    assert.deepEqual(Nullable(Type.Integer()).type, ['integer', 'null']);
    assert.deepEqual(Nullable(Type.String({ format: 'uuid' })).type, ['string', 'null']);
    assert.equal(Nullable(Type.String({ format: 'uuid' })).format, 'uuid');
  });

  it('leaves type-less schemas (Type.Any) unchanged — they already admit null', () => {
    const any = Type.Any();
    assert.equal(Nullable(any), any);
  });

  it('is idempotent', () => {
    assert.deepEqual(Nullable(Nullable(Type.Integer())).type, ['integer', 'null']);
  });
});

// Schema as the (fixed) generator emits it: nullable FK and nullable string.
const fields = {
  id: Type.Number(),
  name: Type.String(),
  parentId: Type.Optional(Nullable(Type.Number())),
  note: Type.Optional(Nullable(Type.String())),
};

function createTestApp(rows) {
  const schema = {
    col: (f) => f,
    fields,
    validation: Type.Object(fields),
    tableName: 'test_table',
    partialValidation: Type.Partial(Type.Object(fields)),
  };
  const DbTables = {
    test_table: {
      primary: 'id',
      ...exportTableInfo(schema),
      defaultOrder: 'id',
    },
  };

  const app = Fastify();
  const calls = [];
  app.decorate('pg', {
    query: async (text, values) => {
      calls.push({ text, values });
      if (/count/i.test(text)) return { rows: [{ total: rows.length }], rowCount: 1 };
      if (/^\s*INSERT/i.test(text)) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows, rowCount: rows.length };
    },
  });
  return app.register(fastifyAutoSqlApi, { DbTables }).then(() => ({ app, calls }));
}

describe('nullable fields — response serialization', () => {
  it('serializes NULL values as null, not 0 / ""', async () => {
    const { app } = await createTestApp([
      { id: 1, name: 'Mario', parentId: null, note: null },
      { id: 2, name: 'Luigi', parentId: 7, note: 'ok' },
    ]);

    const res = await app.inject({ method: 'POST', url: '/search/test_table', payload: {} });
    assert.equal(res.statusCode, 200, res.payload);
    const body = JSON.parse(res.payload);

    assert.strictEqual(body.main[0].parentId, null, 'NULL FK must stay null, not become 0');
    assert.strictEqual(body.main[0].note, null, 'NULL string must stay null, not become ""');
    assert.strictEqual(body.main[1].parentId, 7);
    assert.strictEqual(body.main[1].note, 'ok');
    await app.close();
  });
});

describe('nullable fields — filters', () => {
  it('an explicit null filters by IS NULL (not silently dropped)', async () => {
    const { app, calls } = await createTestApp([]);

    const res = await app.inject({
      method: 'POST',
      url: '/search/test_table',
      payload: { filters: { parentId: null } },
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.match(calls[0].text, /parent_?Id.*IS NULL/i, calls[0].text);
    await app.close();
  });

  it('a real value on a nullable field still filters by equality', async () => {
    const { app, calls } = await createTestApp([]);

    const res = await app.inject({
      method: 'POST',
      url: '/search/test_table',
      payload: { filters: { parentId: 7 } },
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.ok(calls[0].values.includes(7));
    assert.ok(!/IS NULL/i.test(calls[0].text));
    await app.close();
  });
});

describe('nullable fields — writes', () => {
  it('insert with an explicit null binds NULL (Ajv must not coerce it to 0)', async () => {
    const { app, calls } = await createTestApp([]);

    const res = await app.inject({
      method: 'POST',
      url: '/rest/test_table',
      payload: { main: { id: 1, name: 'Mario', parentId: null, note: null } },
    });
    assert.equal(res.statusCode, 201, res.payload);

    const insert = calls.find((c) => /^\s*INSERT/i.test(c.text));
    assert.ok(insert, 'an INSERT must have been issued');
    assert.ok(insert.values.includes(null), 'NULL must reach the SQL bind values');
    assert.ok(!insert.values.includes(0), 'null must NOT be coerced to 0');
    await app.close();
  });

  it('insert with 0 on a nullable number stays 0 (Ajv must not coerce it to null)', async () => {
    const { app, calls } = await createTestApp([]);

    const res = await app.inject({
      method: 'POST',
      url: '/rest/test_table',
      payload: { main: { id: 1, name: 'Mario', parentId: 0, note: '' } },
    });
    assert.equal(res.statusCode, 201, res.payload);

    const insert = calls.find((c) => /^\s*INSERT/i.test(c.text));
    assert.ok(insert.values.includes(0), '0 must survive as 0');
    assert.ok(insert.values.includes(''), 'empty string must survive as ""');
    await app.close();
  });
});
