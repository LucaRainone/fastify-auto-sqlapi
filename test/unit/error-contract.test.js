// The error envelope is one shape, whoever raised the error.
//
//   { statusCode, error, message, requestId, fields? }
//
// - `error` is the HTTP reason phrase of the status (never the JS error's class name).
// - `requestId` is on every error, not only on 500s: it is the log line's `reqId`.
// - every 400 carries `fields`, an array of { path, code, message? }, whether the 400 comes
//   from the request schema (Ajv), from a table's `validate`, or from the engine. `path` is
//   the dot path into the request (`main.name`, `filters.status`, `conditions.0.params`,
//   `orderBy`), or '' when the error is not attributable to one input. `code` is stable.
// - other statuses carry no `fields`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, defineTable, Type } = await import(path.join(ROOT, 'dist/index.js'));

const SchemaItem = createMockSchema('item', {
  id: Type.Optional(Type.Integer()),
  name: Type.String(),
  ownerId: Type.Optional(Type.Integer()),
});

async function createApp({ tableOverrides = {}, pluginOverrides = {}, query } = {}) {
  const dbTables = {
    item: defineTable({
      primary: 'id',
      schema: SchemaItem,
      insertExclude: ['id'],
      validate: async ({ main }) => (main.name === 'bad' ? [{ path: 'main.name', code: 'custom' }] : []),
      ...tableOverrides,
    }),
  };
  const app = Fastify();
  app.decorate('pg', { query: query ?? (async () => ({ rows: [], rowCount: 0 })) });
  await app.register(fastifyAutoSqlApi, { dbTables, ...pluginOverrides });
  return app;
}

function assertEnvelope(body, statusCode, error) {
  assert.equal(body.statusCode, statusCode);
  assert.equal(body.error, error);
  assert.equal(typeof body.message, 'string');
  assert.equal(typeof body.requestId, 'string', `requestId missing: ${JSON.stringify(body)}`);
  assert.ok(body.requestId.length > 0);
}

describe('error envelope — 400 from the request schema (Ajv)', () => {
  it('has fields with the request path and the Ajv keyword as code', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'POST', url: '/rest/item', payload: { main: {} } });
    assert.equal(res.statusCode, 400, res.payload);
    const body = res.json();
    assertEnvelope(body, 400, 'Bad Request');
    assert.equal(body.message, 'Validation failed');
    assert.deepEqual(
      body.fields.map((f) => [f.path, f.code]),
      [['main.name', 'required']],
      res.payload,
    );
    await app.close();
  });
});

describe('error envelope — 400 from a table validate hook', () => {
  it('renders the returned objects as fields, as is: no message', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'POST', url: '/rest/item', payload: { main: { name: 'bad' } } });
    assert.equal(res.statusCode, 400, res.payload);
    const body = res.json();
    assertEnvelope(body, 400, 'Bad Request');
    assert.equal(body.message, 'Validation failed');
    assert.deepEqual(body.fields, [{ path: 'main.name', code: 'custom' }]);
    await app.close();
  });
});

describe('error envelope — 400 from the engine', () => {
  it('an unknown filter key: path filters.<key>, code unknown_field', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'POST', url: '/search/item', payload: { filters: { nope: 1 } } });
    assert.equal(res.statusCode, 400, res.payload);
    const body = res.json();
    assertEnvelope(body, 400, 'Bad Request');
    assert.match(body.message, /nope/);
    assert.deepEqual(body.fields, [{ path: 'filters.nope', code: 'unknown_field', message: body.message }]);
    await app.close();
  });

  it('a malformed orderBy: path orderBy, code invalid_order_by', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'POST', url: '/search/item', payload: { orderBy: 'name;drop' } });
    assert.equal(res.statusCode, 400, res.payload);
    const body = res.json();
    assertEnvelope(body, 400, 'Bad Request');
    assert.equal(body.fields.length, 1, res.payload);
    assert.equal(body.fields[0].path, 'orderBy');
    assert.equal(body.fields[0].code, 'invalid_order_by');
    await app.close();
  });

  it('a condition with too few params: path conditions.<i>.params, code invalid_params', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/search/item',
      payload: { conditions: [{ field: 'name', method: 'isEqual', params: ['x'] }, { field: 'name', method: 'isBetween', params: [1] }] },
    });
    assert.equal(res.statusCode, 400, res.payload);
    const body = res.json();
    assertEnvelope(body, 400, 'Bad Request');
    assert.deepEqual(body.fields.map((f) => [f.path, f.code]), [['conditions.1.params', 'invalid_params']], res.payload);
    await app.close();
  });

  it('an unknown join alias: path <family>.<alias>, code unknown_alias', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'POST', url: '/search/item', payload: { joinMultiple: { ghosts: {} } } });
    assert.equal(res.statusCode, 400, res.payload);
    const body = res.json();
    assert.deepEqual(body.fields.map((f) => [f.path, f.code]), [['joinMultiple.ghosts', 'unknown_alias']], res.payload);
    await app.close();
  });
});

describe('error envelope — other statuses', () => {
  it('404 carries the reason phrase and requestId, and no fields', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/rest/item/99' });
    assert.equal(res.statusCode, 404, res.payload);
    const body = res.json();
    assertEnvelope(body, 404, 'Not Found');
    assert.equal('fields' in body, false, res.payload);
    await app.close();
  });

  it('403 carries the reason phrase and requestId, and no fields', async () => {
    const app = await createApp({
      tableOverrides: { tenantScope: { column: 'owner_id' } },
      pluginOverrides: { getTenantId: () => [] },
    });
    const res = await app.inject({ method: 'POST', url: '/search/item', payload: {} });
    assert.equal(res.statusCode, 403, res.payload);
    const body = res.json();
    assertEnvelope(body, 403, 'Forbidden');
    assert.equal('fields' in body, false, res.payload);
    await app.close();
  });

  it('500 keeps its sanitized shape, and no fields', async () => {
    const app = await createApp({ query: async () => { throw new Error('relation "item" does not exist'); } });
    const res = await app.inject({ method: 'POST', url: '/search/item', payload: {} });
    assert.equal(res.statusCode, 500, res.payload);
    const body = res.json();
    assertEnvelope(body, 500, 'Internal Server Error');
    assert.equal(body.message, 'Internal Server Error');
    assert.equal('fields' in body, false, res.payload);
    await app.close();
  });
});

// The routes answer through their own error handler, registered in the plugin's scope: an
// application `setErrorHandler` is never reached by them, so it cannot reshape the envelope.
// Fastify's `onError` hooks are inherited instead, so an application hook added before the
// plugin sees every route error — the place for logging and error reporting.
describe('error envelope — the application error handler and onError hooks', () => {
  async function appWithObservers(query) {
    const seen = { handler: 0, hook: [] };
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      seen.handler++;
      reply.status(418).send({ mine: true });
    });
    app.addHook('onError', async (_request, _reply, error) => { seen.hook.push(error); });
    app.decorate('pg', { query });
    await app.register(fastifyAutoSqlApi, {
      dbTables: { item: defineTable({ primary: 'id', schema: SchemaItem }) },
    });
    return { app, seen };
  }

  it('an application setErrorHandler does not answer the routes\' errors', async () => {
    const { app, seen } = await appWithObservers(async () => ({ rows: [], rowCount: 0 }));
    const res = await app.inject({ method: 'POST', url: '/search/item', payload: { filters: { nope: 1 } } });
    assert.equal(res.statusCode, 400, res.payload);
    assertEnvelope(res.json(), 400, 'Bad Request');
    assert.equal(seen.handler, 0);
    await app.close();
  });

  it('an application onError hook sees a 4xx the routes raise', async () => {
    const { app, seen } = await appWithObservers(async () => ({ rows: [], rowCount: 0 }));
    await app.inject({ method: 'POST', url: '/search/item', payload: { filters: { nope: 1 } } });
    assert.equal(seen.hook.length, 1);
    assert.equal(seen.hook[0].statusCode, 400);
    await app.close();
  });

  it('an application onError hook sees a driver error, the original under cause', async () => {
    const driverError = new Error('relation "item" does not exist');
    const { app, seen } = await appWithObservers(async () => { throw driverError; });
    const res = await app.inject({ method: 'POST', url: '/search/item', payload: {} });
    assert.equal(res.statusCode, 500, res.payload);
    assert.equal(seen.hook.length, 1);
    assert.equal(seen.hook[0].statusCode, 500);
    assert.equal(seen.hook[0].cause, driverError);
    await app.close();
  });
});
