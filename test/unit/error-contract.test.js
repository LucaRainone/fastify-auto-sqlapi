// The error envelope is one shape, whoever raised the error.
//
//   { statusCode, error, message, requestId, fields? }
//
// - `error` is the HTTP reason phrase of the status (never the JS error's class name).
// - `requestId` is on every error, not only on 500s: it is the log line's `reqId`.
// - every 400 carries `fields`, an array of { path, code, message }, whether the 400 comes
//   from the request schema (Ajv), from a table's `validate`, or from the engine. `path` is
//   the dot path into the request (`main.name`, `filters.status`, `conditions.0.params`,
//   `orderBy`), or '' when the error is not attributable to one input. `code` is stable.
// - other statuses carry no `fields`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, defineTable, exportTableInfo, Type } = await import(path.join(ROOT, 'dist/index.js'));

const SchemaItem = createMockSchema('item', {
  id: Type.Optional(Type.Integer()),
  name: Type.String(),
  ownerId: Type.Optional(Type.Integer()),
});

async function createApp({ tableOverrides = {}, pluginOverrides = {}, query } = {}) {
  const DbTables = {
    item: defineTable({
      primary: 'id',
      ...exportTableInfo(SchemaItem),
      insertExclude: ['id'],
      validate: async (_db, _req, main) => (main.name === 'bad' ? [['main.name', 'custom', 'nope']] : []),
      ...tableOverrides,
    }),
  };
  const app = Fastify();
  app.decorate('pg', { query: query ?? (async () => ({ rows: [], rowCount: 0 })) });
  await app.register(fastifyAutoSqlApi, { DbTables, ...pluginOverrides });
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
  it('renders the tuples as fields, verbatim', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'POST', url: '/rest/item', payload: { main: { name: 'bad' } } });
    assert.equal(res.statusCode, 400, res.payload);
    const body = res.json();
    assertEnvelope(body, 400, 'Bad Request');
    assert.equal(body.message, 'Validation failed');
    assert.deepEqual(body.fields, [{ path: 'main.name', code: 'custom', message: 'nope' }]);
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
    const res = await app.inject({ method: 'POST', url: '/search/item?orderBy=name;drop', payload: {} });
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
