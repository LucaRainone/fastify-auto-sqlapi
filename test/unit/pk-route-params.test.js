// `GET /rest/:table/:id` and `DELETE /rest/:table/:id` validate `:id` against the primary key
// field's own type. A path parameter is text on the wire, so the schema must coerce it: with
// an integer PK, `/rest/item/abc` is a structured 400 on `id`, never a driver error that
// surfaces as a 500, and `/rest/item/7` reaches SQL as the number 7.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT } from './_harness.js';

const { fastifyAutoSqlApi, Type, exportTableInfo } = await import(path.join(ROOT, 'dist/index.js'));

function mockSchema(tableName, fields) {
  return {
    col: (f) => f,
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Partial(Type.Object(fields)),
  };
}

async function createTestApp() {
  const DbTables = {
    // Serial PK as the generator emits it: Optional, because an insert may omit it.
    item: {
      primary: 'id',
      ...exportTableInfo(mockSchema('item', { id: Type.Optional(Type.Integer()), name: Type.String() })),
    },
    // Natural string PK, under a field that is not called `id`.
    doc: {
      primary: 'code',
      ...exportTableInfo(mockSchema('doc', { code: Type.String(), title: Type.String() })),
    },
  };

  const app = Fastify();
  const calls = [];
  app.decorate('pg', {
    query: async (text, values) => {
      calls.push({ text, values });
      return /^\s*DELETE/i.test(text)
        ? { rows: [], rowCount: 1 }
        : { rows: [{ id: 7, name: 'seven', code: 'abc', title: 'Doc' }], rowCount: 1 };
    },
  });
  await app.register(fastifyAutoSqlApi, { DbTables });
  return { app, calls };
}

for (const method of ['GET', 'DELETE']) {
  describe(`${method} /rest/:table/:id — :id typed as the primary key field`, () => {
    it('rejects a non-numeric id on an integer PK with a structured 400', async () => {
      const { app, calls } = await createTestApp();
      const res = await app.inject({ method, url: '/rest/item/abc' });
      assert.equal(res.statusCode, 400, res.payload);
      const body = res.json();
      assert.equal(body.message, 'Validation failed');
      assert.equal(body.fields[0].path, 'id', JSON.stringify(body.fields));
      assert.equal(calls.length, 0, 'no SQL runs for an invalid id');
      await app.close();
    });

    it('coerces a numeric id to a number before it reaches SQL', async () => {
      const { app, calls } = await createTestApp();
      const res = await app.inject({ method, url: '/rest/item/7' });
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(res.json().main.id, 7);
      assert.ok(calls.length >= 1);
      assert.ok(
        calls.some((c) => (c.values ?? []).includes(7)),
        `expected the number 7 among bound values: ${JSON.stringify(calls.map((c) => c.values))}`
      );
      await app.close();
    });

    it('accepts any text on a string PK', async () => {
      const { app } = await createTestApp();
      const res = await app.inject({ method, url: '/rest/doc/abc' });
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(res.json().main.code, 'abc');
      await app.close();
    });
  });
}
