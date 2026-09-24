import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
  fastifyAutoSqlApi,
  exportTableInfo,
  toUnderscore,
  buildAgentManifest,
  Type,
} from '../../dist/index.js';

// The route URL names the dbTables KEY, not the physical table (Schema.tableName).
// Several table configs over the same physical table must each get their own routes,
// and every URL must match the key the manifest advertises to clients.

const fields = { id: Type.Number(), title: Type.String(), shared: Type.Boolean() };
const SchemaConversation = {
  col: (f) => toUnderscore(f),
  fields,
  validation: Type.Object(fields),
  tableName: 'conversation',
  partialValidation: Type.Partial(Type.Object(fields)),
};

function tableConf(overrides = {}) {
  return { primary: 'id', ...exportTableInfo(SchemaConversation), ...overrides };
}

// pg-shaped pool: { rows, rowCount } responses, consumed in order
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

async function buildApp(DbTables, pool = createMockPool()) {
  const app = Fastify();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { DbTables });
  await app.ready();
  return app;
}

describe('route URL is the dbTables key', () => {
  it('a key that differs from the table name is served under the key', async () => {
    const app = await buildApp({ chat: tableConf() });

    assert.equal(app.hasRoute({ method: 'POST', url: '/search/chat' }), true);
    assert.equal(app.hasRoute({ method: 'GET', url: '/rest/chat/:id' }), true);
    assert.equal(app.hasRoute({ method: 'POST', url: '/rest/chat' }), true);
    assert.equal(app.hasRoute({ method: 'PUT', url: '/rest/chat' }), true);
    assert.equal(app.hasRoute({ method: 'DELETE', url: '/rest/chat/:id' }), true);
    assert.equal(app.hasRoute({ method: 'PUT', url: '/bulk/chat' }), true);
    assert.equal(app.hasRoute({ method: 'POST', url: '/bulk/chat/delete' }), true);
    assert.equal(
      app.hasRoute({ method: 'POST', url: '/search/conversation' }),
      false,
      'the physical table name must not become a route'
    );

    await app.close();
  });

  it('several table configs over the same table register side by side', async () => {
    const app = await buildApp({
      conversation: tableConf({ operations: ['search', 'update', 'delete'] }),
      openConversation: tableConf({ operations: ['get'] }),
      sharedConversation: tableConf({ operations: ['search'] }),
      conversationHistory: tableConf({ operations: [] }),
    });

    assert.equal(app.hasRoute({ method: 'POST', url: '/search/conversation' }), true);
    assert.equal(app.hasRoute({ method: 'PUT', url: '/rest/conversation' }), true);
    assert.equal(app.hasRoute({ method: 'GET', url: '/rest/conversation/:id' }), false);
    assert.equal(app.hasRoute({ method: 'GET', url: '/rest/openConversation/:id' }), true);
    assert.equal(app.hasRoute({ method: 'POST', url: '/search/openConversation' }), false);
    assert.equal(app.hasRoute({ method: 'POST', url: '/search/sharedConversation' }), true);
    assert.equal(app.hasRoute({ method: 'POST', url: '/search/conversationHistory' }), false);

    await app.close();
  });

  it('each key runs its own table config against the shared physical table', async () => {
    const pool = createMockPool([
      { rows: [{ id: 1, title: 'Hi', shared: true }], rowCount: 1 }, // main
      { rows: [{ total: '1' }], rowCount: 1 },                       // pagination COUNT
    ]);
    const blocked = async (_request, reply) => reply.code(403).send({ message: 'owner only' });
    const app = await buildApp({
      conversation: tableConf({ operations: ['search'], onRequests: [blocked] }),
      sharedConversation: tableConf({ operations: ['search'] }),
    }, pool);

    const denied = await app.inject({ method: 'POST', url: '/search/conversation', payload: {} });
    assert.equal(denied.statusCode, 403, 'the conversation key keeps its own onRequests');

    const res = await app.inject({ method: 'POST', url: '/search/sharedConversation', payload: {} });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    assert.match(pool.calls[0].text, /FROM "conversation"/, 'SQL still targets the physical table');

    await app.close();
  });

  it('search response names the key in "table"', async () => {
    const pool = createMockPool([
      { rows: [{ id: 1, title: 'Hi', shared: true }], rowCount: 1 },
      { rows: [{ total: '1' }], rowCount: 1 },
    ]);
    const app = await buildApp({ sharedConversation: tableConf({ operations: ['search'] }) }, pool);

    const res = await app.inject({ method: 'POST', url: '/search/sharedConversation', payload: {} });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal(res.json().table, 'sharedConversation');

    await app.close();
  });

  it('every manifest key has its routes under that key', async () => {
    const DbTables = {
      chat: tableConf({ operations: ['search', 'get'] }),
      sharedChat: tableConf({ operations: ['search'] }),
    };
    const app = await buildApp(DbTables);

    for (const [key, entry] of Object.entries(buildAgentManifest(DbTables).tables)) {
      if (entry.operations.includes('search')) {
        assert.equal(app.hasRoute({ method: 'POST', url: `/search/${key}` }), true, `search for ${key}`);
      }
      if (entry.operations.includes('get')) {
        assert.equal(app.hasRoute({ method: 'GET', url: `/rest/${key}/:id` }), true, `get for ${key}`);
      }
    }

    await app.close();
  });
});
