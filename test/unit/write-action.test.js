// A write that may be an upsert says what it did: every item of a bulk upsert response, and the
// single insert response, carry `action: 'inserted' | 'updated'`. On PostgreSQL the flag comes
// back with the upsert statement itself (`(xmax = 0)` in RETURNING); MySQL/MariaDB learn it from
// the probe their upsert-by-key starts with (ADR 0021). A plain insert is always 'inserted'.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, defineTable, exportTableInfo, buildUpsertRules, buildUpsertRule, Type } =
  await import(path.join(ROOT, 'dist/index.js'));

const SchemaTag = createMockSchema('tag', {
  id: Type.Optional(Type.Integer()),
  code: Type.String(),
  label: Type.Optional(Type.String()),
});
SchemaTag.primaryKey = ['id'];
SchemaTag.uniqueKeys = [['code']];

/** pg-shaped pool with transactions: BEGIN/COMMIT/ROLLBACK are answered, data statements recorded. */
function createMockPool(responses = []) {
  let callIndex = 0;
  const calls = [];
  const pool = {
    calls,
    query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      const response = responses[callIndex] || { rows: [], rowCount: 0 };
      callIndex++;
      return Promise.resolve(response);
    },
    connect() {
      return Promise.resolve({
        query: (text, values) => (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text)
          ? Promise.resolve({ rows: [], rowCount: 0 })
          : pool.query(text, values)),
        release() {},
      });
    },
  };
  return pool;
}

async function createApp(tableOverrides, pool) {
  const DbTables = {
    tag: defineTable({ primary: 'id', ...exportTableInfo(SchemaTag), insertExclude: ['id'], ...tableOverrides }),
  };
  const app = Fastify();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { DbTables });
  return app;
}

const upsertByCode = { upsertMap: buildUpsertRules(buildUpsertRule(SchemaTag, ['code'])) };

describe('write action — bulk upsert (postgres statement)', () => {
  it('reports inserted/updated per item from the RETURNING flag, and keeps the flag out of main', async () => {
    const pool = createMockPool([
      { rows: [{ id: 1, __inserted: false }, { id: 2, __inserted: true }], rowCount: 2 },
    ]);
    const app = await createApp(upsertByCode, pool);
    const res = await app.inject({
      method: 'PUT',
      url: '/bulk/tag',
      payload: [{ main: { code: 'a', label: 'A2' } }, { main: { code: 'c', label: 'C' } }],
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json(), [
      { main: { id: 1 }, action: 'updated' },
      { main: { id: 2 }, action: 'inserted' },
    ]);
    assert.match(pool.calls[0].text, /RETURNING "id", \(xmax = 0\) AS "__inserted"/, pool.calls[0].text);
    await app.close();
  });

  it('a table without an upsert rule reports inserted for every item', async () => {
    const pool = createMockPool([{ rows: [{ id: 5 }, { id: 6 }], rowCount: 2 }]);
    const app = await createApp({}, pool);
    const res = await app.inject({
      method: 'PUT',
      url: '/bulk/tag',
      payload: [{ main: { code: 'x' } }, { main: { code: 'y' } }],
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json().map((r) => r.action), ['inserted', 'inserted']);
    assert.doesNotMatch(pool.calls[0].text, /xmax/, 'a plain insert needs no flag');
    await app.close();
  });
});

describe('write action — single insert', () => {
  it('an upsert that lands on an existing row reports updated', async () => {
    const pool = createMockPool([{ rows: [{ id: 1, __inserted: false }], rowCount: 1 }]);
    const app = await createApp(upsertByCode, pool);
    const res = await app.inject({ method: 'POST', url: '/rest/tag', payload: { main: { code: 'a', label: 'A2' } } });
    assert.equal(res.statusCode, 201, res.payload);
    assert.deepEqual(res.json(), { main: { id: 1 }, action: 'updated' });
    await app.close();
  });

  it('a plain insert reports inserted', async () => {
    const pool = createMockPool([{ rows: [{ id: 9 }], rowCount: 1 }]);
    const app = await createApp({}, pool);
    const res = await app.inject({ method: 'POST', url: '/rest/tag', payload: { main: { code: 'z' } } });
    assert.equal(res.statusCode, 201, res.payload);
    assert.deepEqual(res.json(), { main: { id: 9 }, action: 'inserted' });
    await app.close();
  });
});

describe('write action — response schemas', () => {
  it('insert and bulk upsert responses declare action as an enum', async () => {
    const { InsertTableResponse } = await import(path.join(ROOT, 'dist/lib/schema/insert.js'));
    const { BulkUpsertTableResponse } = await import(path.join(ROOT, 'dist/lib/schema/bulk-upsert.js'));
    const DbTables = { tag: defineTable({ primary: 'id', ...exportTableInfo(SchemaTag) }) };
    const expected = ['inserted', 'updated'];
    const insert = InsertTableResponse(DbTables, 'tag').properties.action;
    const bulk = BulkUpsertTableResponse(DbTables, 'tag').items.properties.action;
    for (const schema of [insert, bulk]) {
      assert.ok(schema, 'action is declared');
      const literals = (schema.anyOf ?? []).map((s) => s.const);
      assert.deepEqual(literals.sort(), expected, JSON.stringify(schema));
    }
  });
});
