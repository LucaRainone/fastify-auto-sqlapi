import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
  fastifyAutoSqlApi,
  agentToolSchemas,
  toUnderscore,
  Type,
} from '../../dist/index.js';

// A bulk delete names its rows the same way everywhere: `{ ids: [...] }` in the HTTP body, in
// `sqlApi.bulkDelete` and in the bulk delete hooks — whatever the primary key field is called.

const fields = { agentId: Type.Integer(), name: Type.String() };
const SchemaAgent = {
  col: (f) => toUnderscore(f),
  fields,
  validation: Type.Object(fields),
  tableName: 'agent',
  partialValidation: Type.Partial(Type.Object(fields)),
};
const dbTables = { agent: { primary: 'agentId', schema: SchemaAgent } };

// pg-shaped pool: { rows, rowCount } responses consumed in order, statements recorded
function createMockPool(responses = []) {
  let callIndex = 0;
  const calls = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      const response = responses[callIndex] || { rows: [], rowCount: 0 };
      callIndex++;
      return Promise.resolve(response);
    },
  };
}

async function buildApp(pool, pluginOptions = {}) {
  const app = Fastify();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { dbTables, ...pluginOptions });
  await app.ready();
  return app;
}

const bulkDelete = (app, payload) =>
  app.inject({ method: 'POST', url: '/bulk/agent/delete', payload });

describe('POST /bulk/:table/delete takes { ids }', () => {
  it('deletes the listed ids and answers the rows actually deleted', async () => {
    const pool = createMockPool([{ rows: [{ agent_id: 7 }], rowCount: 1 }]);
    const app = await buildApp(pool);

    const res = await bulkDelete(app, { ids: [7, 8] });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), [{ main: { agentId: 7 } }]);
    const del = pool.calls.find((c) => /DELETE/.test(c.text));
    assert.deepEqual(del.values, [7, 8]);
    await app.close();
  });

  it('the pre-1.0 array of { <pk>: value } objects is a 400, nothing deleted', async () => {
    const pool = createMockPool();
    const app = await buildApp(pool);

    const res = await bulkDelete(app, [{ agentId: 7 }]);
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(pool.calls.length, 0);
    await app.close();
  });

  it('an id that does not match the primary key type is a 400 at its index', async () => {
    const pool = createMockPool();
    const app = await buildApp(pool);

    const res = await bulkDelete(app, { ids: [7, 'abc'] });
    assert.equal(res.statusCode, 400, res.body);
    assert.ok(res.json().fields.some((f) => f.path === 'ids.1'), res.body);
    assert.equal(pool.calls.length, 0);
    await app.close();
  });

  it('maxBulkItems caps the number of ids', async () => {
    const pool = createMockPool();
    const app = await buildApp(pool, { maxBulkItems: 2 });

    const res = await bulkDelete(app, { ids: [1, 2, 3] });
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['ids', 'maxItems']]);
    await app.close();
  });

  it('a missing ids is a 400 naming it', async () => {
    const app = await buildApp(createMockPool());

    const res = await bulkDelete(app, {});
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['ids', 'required']]);
    await app.close();
  });

  it('the agent tool schema for bulk delete is the same { ids } body', () => {
    const schemas = agentToolSchemas(dbTables, 'agent', { maxBulkItems: 5 });
    const body = schemas.bulkDelete.body;
    assert.equal(body.type, 'object');
    assert.deepEqual(body.required, ['ids']);
    assert.equal(body.properties.ids.maxItems, 5);
    assert.equal(body.properties.ids.items.type, 'integer');
  });
});
