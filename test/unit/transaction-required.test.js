// A write that must be atomic runs in a transaction, or not at all. `withTransaction` used to
// run its callback directly when the Queryable had no `connect()`: a custom adapter without
// it got every insert and update — main row, secondaries, deletions, after-hooks — executed
// as separate autocommitted statements, silently. It now fails with an error naming the fix.
// A nested call still joins the outer transaction: the connection it runs on has no
// `connect()` either, and that is the one case where "no connect" does not mean "no transaction".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, defineTable, exportTableInfo, QueryClient, Type } =
  await import(path.join(ROOT, 'dist/index.js'));

const norm = (t) => t.replace(/\s+/g, ' ').trim();

/** A Queryable without connect(): the legacy custom adapter. */
function plainQueryable() {
  const calls = [];
  return { calls, async query(text, values) { calls.push({ text: norm(text), values }); return { rows: [], affectedRows: 0 }; } };
}

/** A Queryable with connect(): what the built-in adapters produce from a pool. */
function transactionalQueryable() {
  const connCalls = [];
  return {
    connCalls,
    async query() { return { rows: [], affectedRows: 0 }; },
    async connect() {
      return {
        async query(text, values) { connCalls.push({ text: norm(text), values }); return { rows: [{ id: 1 }], affectedRows: 1 }; },
        release() {},
      };
    },
  };
}

describe('QueryClient.withTransaction without connect()', () => {
  it('throws instead of running the callback unprotected, and runs nothing', async () => {
    const pool = plainQueryable();
    const db = new QueryClient(pool);
    let ran = false;
    await assert.rejects(
      db.withTransaction(async (tx) => { ran = true; await tx.query('SELECT 1'); }),
      (err) => /connect\(\)/.test(err.message) && /transaction/i.test(err.message),
    );
    assert.equal(ran, false);
    assert.equal(pool.calls.length, 0);
  });

  it('a nested call still joins the outer transaction', async () => {
    const pool = transactionalQueryable();
    const db = new QueryClient(pool);
    const out = await db.withTransaction(async (tx) => {
      await tx.query('SELECT 1');
      return tx.withTransaction(async (inner) => { await inner.query('SELECT 2'); return 'ok'; });
    });
    assert.equal(out, 'ok');
    assert.deepEqual(pool.connCalls.map((c) => c.text), ['BEGIN', 'SELECT 1', 'SELECT 2', 'COMMIT']);
  });
});

describe('plugin with a database client that has no connect()', () => {
  const SchemaItem = createMockSchema('item', { id: Type.Optional(Type.Integer()), name: Type.String() });

  async function createApp(pg) {
    const DbTables = { item: defineTable({ primary: 'id', ...exportTableInfo(SchemaItem), insertExclude: ['id'] }) };
    const app = Fastify();
    app.decorate('pg', pg);
    await app.register(fastifyAutoSqlApi, { DbTables });
    return app;
  }

  it('an insert is a 500, and the row is not written', async () => {
    const pg = plainQueryable();
    const app = await createApp(pg);
    const res = await app.inject({ method: 'POST', url: '/rest/item', payload: { main: { name: 'x' } } });
    assert.equal(res.statusCode, 500, res.payload);
    assert.equal(pg.calls.length, 0, 'no statement ran outside a transaction');
    await app.close();
  });

  it('a search still works: reads need no transaction', async () => {
    const app = await createApp(plainQueryable());
    const res = await app.inject({ method: 'POST', url: '/search/item', payload: {} });
    assert.equal(res.statusCode, 200, res.payload);
    await app.close();
  });
});
