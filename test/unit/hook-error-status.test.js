// What a client gets when a hook throws an error carrying a status (AGENTS_BACKEND.md, the error
// envelope paragraph under defineTable).
//
// A 4xx is the hook's answer to the client: rendered with its status and message, and with
// `fields` when `httpError` was given a code. A 5xx is a server failure like any other: it is
// sanitized into the fixed 500, whose message never comes from the code that failed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, defineTable, httpError, Type } = await import(path.join(ROOT, 'dist/index.js'));

const SchemaItem = createMockSchema('item', {
  id: Type.Optional(Type.Integer()),
  name: Type.String(),
});

async function appWithHookThrowing(error) {
  const app = Fastify();
  app.decorate('pg', { query: async () => ({ rows: [{ id: 1 }], rowCount: 1 }) });
  await app.register(fastifyAutoSqlApi, {
    dbTables: {
      item: defineTable({
        primary: 'id', schema: SchemaItem, insertExclude: ['id'],
        beforeInsert: async () => { throw error; },
      }),
    },
  });
  return app;
}

const insert = (app) => app.inject({ method: 'POST', url: '/rest/item', payload: { main: { name: 'x' } } });

describe('a hook throwing an error with a status', () => {
  it('a 4xx httpError with a code answers with its status, its message and fields', async () => {
    const app = await appWithHookThrowing(httpError(409, 'Order is closed', { code: 'closed', path: 'main.name' }));
    const res = await insert(app);
    assert.equal(res.statusCode, 409, res.payload);
    const body = res.json();
    assert.equal(body.error, 'Conflict');
    assert.equal(body.message, 'Order is closed');
    assert.deepEqual(body.fields.map((f) => [f.path, f.code]), [['main.name', 'closed']]);
    await app.close();
  });

  it('a 4xx httpError without a code answers with its status and message, and no fields', async () => {
    const app = await appWithHookThrowing(httpError(422, 'Not now'));
    const res = await insert(app);
    assert.equal(res.statusCode, 422, res.payload);
    assert.equal(res.json().message, 'Not now');
    assert.equal('fields' in res.json(), false, res.payload);
    await app.close();
  });

  it('a 5xx httpError is the sanitized 500: its status and message do not reach the client', async () => {
    const app = await appWithHookThrowing(httpError(503, 'payment provider down: key sk_live_123', { code: 'unavailable' }));
    const res = await insert(app);
    assert.equal(res.statusCode, 500, res.payload);
    const body = res.json();
    assert.equal(body.message, 'Internal Server Error');
    assert.equal('fields' in body, false, res.payload);
    assert.doesNotMatch(res.payload, /sk_live_123/);
    await app.close();
  });
});
