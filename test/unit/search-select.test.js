// `select`: the main row's projection. Without it a search returns every readable column;
// with it, only the listed schema fields — plus the primary key, the fields the requested
// joins correlate on, and (with `distinctResults`) the ORDER BY fields, which the database
// needs in the SELECT list. Unknown or hidden names are a 400 at `select.<i>`.
//
// `selection` on a join reference accepts an array as well as the comma-separated string,
// in the request and in `buildRelation`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, buildRelation, defineTable, exportTableInfo, Type } =
  await import(path.join(ROOT, 'dist/index.js'));

const SchemaConversation = createMockSchema('conversation', {
  id: Type.Integer(),
  title: Type.String(),
  creatorId: Type.Integer(),
  secret: Type.String(),
});
const SchemaUser = createMockSchema('user', { id: Type.Integer(), name: Type.String(), email: Type.String() });
const SchemaMessage = createMockSchema('message', {
  id: Type.Integer(),
  conversationId: Type.Integer(),
  body: Type.String(),
  secret: Type.String(),
});

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

async function buildApp({ conversation = {}, messageSelection } = {}, pool = createMockPool()) {
  const DbTables = {
    chat: defineTable({
      primary: 'id',
      ...exportTableInfo(SchemaConversation),
      readExclude: ['secret'],
      allowedReadJoins: [
        buildRelation(SchemaConversation, 'creatorId', SchemaUser, 'id', { alias: 'creator', unique: true }),
        buildRelation(SchemaConversation, 'id', SchemaMessage, 'conversationId', {
          alias: 'messages',
          ...(messageSelection ? { selection: messageSelection } : {}),
        }),
      ],
      ...conversation,
    }),
    user: defineTable({ primary: 'id', ...exportTableInfo(SchemaUser) }),
    message: defineTable({ primary: 'id', ...exportTableInfo(SchemaMessage) }),
  };
  const app = Fastify();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { DbTables });
  return app;
}

const MAIN = { rows: [{ id: 1, title: 'Hello', creator_id: 7 }], rowCount: 1 };

/** The SELECT list of the first statement, as a trimmed string. */
function selectList(sql) {
  return /^SELECT (DISTINCT )?(.*?) FROM /i.exec(sql)[2];
}

describe('search select — main projection', () => {
  it('projects only the listed fields plus the primary key', async () => {
    const pool = createMockPool([MAIN]);
    const app = await buildApp({}, pool);
    const res = await app.inject({ method: 'POST', url: '/search/chat', payload: { select: ['title'] } });
    assert.equal(res.statusCode, 200, res.payload);
    const list = selectList(pool.calls[0].text);
    assert.match(list, /"conversation"\."title"/);
    assert.match(list, /"conversation"\."id"/, 'the primary key is always projected');
    assert.doesNotMatch(list, /creator_id|secret|\*/, list);
    await app.close();
  });

  it('rejects an unknown field at select.<i> with unknown_field', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/search/chat', payload: { select: ['title', 'nope'] } });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['select.1', 'unknown_field']]);
    await app.close();
  });

  it('rejects a readExclude field with not_readable', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/search/chat', payload: { select: ['secret'] } });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['select.0', 'not_readable']]);
    await app.close();
  });

  it('keeps the field a requested join correlates on', async () => {
    const pool = createMockPool([MAIN, { rows: [{ id: 7, name: 'Alice', email: 'a@x' }], rowCount: 1 }]);
    const app = await buildApp({}, pool);
    const res = await app.inject({
      method: 'POST',
      url: '/search/chat',
      payload: { select: ['title'], joinLeft: { creator: { selection: 'id,name' } } },
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.match(selectList(pool.calls[0].text), /"conversation"\."creator_id"/, pool.calls[0].text);
    assert.equal(res.json().joinLeft.creator[0].name, 'Alice');
    await app.close();
  });

  it('with distinctResults, keeps the ORDER BY fields in the SELECT list', async () => {
    const pool = createMockPool([MAIN]);
    const app = await buildApp({ conversation: { distinctResults: true } }, pool);
    const res = await app.inject({
      method: 'POST',
      url: '/search/chat?orderBy=title DESC',
      payload: { select: ['id'] },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const sql = pool.calls[0].text;
    assert.match(sql, /^SELECT DISTINCT /);
    assert.match(selectList(sql), /"conversation"\."title"/, sql);
    await app.close();
  });

  it('with distinctResults and no orderBy, keeps the configured default order field', async () => {
    const pool = createMockPool([MAIN]);
    const app = await buildApp({ conversation: { distinctResults: true, defaultOrder: 'title ASC' } }, pool);
    const res = await app.inject({ method: 'POST', url: '/search/chat', payload: { select: ['id'] } });
    assert.equal(res.statusCode, 200, res.payload);
    assert.match(selectList(pool.calls[0].text), /"conversation"\."title"/, pool.calls[0].text);
    await app.close();
  });

  it('is advertised in the search body schema', async () => {
    const { SearchTableBodyPost } = await import(path.join(ROOT, 'dist/lib/schema/search.js'));
    const app = await buildApp();
    await app.close();
    const DbTables = { chat: defineTable({ primary: 'id', ...exportTableInfo(SchemaConversation) }) };
    const body = SearchTableBodyPost(DbTables, 'chat');
    assert.equal(body.properties.select?.type, 'array', JSON.stringify(body.properties.select));
  });
});

describe('join selection — string or array', () => {
  it('accepts an array in the request', async () => {
    const pool = createMockPool([MAIN, { rows: [{ id: 10, conversation_id: 1, body: 'hi' }], rowCount: 1 }]);
    const app = await buildApp({}, pool);
    const res = await app.inject({
      method: 'POST',
      url: '/search/chat',
      payload: { joinMultiple: { messages: { selection: ['id', 'body'] } } },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const list = selectList(pool.calls[1].text);
    assert.match(list, /"message"\."id", "message"\."body"/, pool.calls[1].text);
    assert.doesNotMatch(list, /secret/);
    await app.close();
  });

  it('accepts an array in buildRelation', () => {
    const rel = buildRelation(SchemaConversation, 'id', SchemaMessage, 'conversationId', {
      alias: 'messages',
      selection: ['id', 'body'],
    });
    assert.equal(rel.selection, 'id,body');
  });

  it('a relation default given as an array drives the side query', async () => {
    const pool = createMockPool([MAIN, { rows: [{ id: 10, conversation_id: 1, body: 'hi' }], rowCount: 1 }]);
    const app = await buildApp({ messageSelection: ['id', 'body'] }, pool);
    const res = await app.inject({ method: 'POST', url: '/search/chat', payload: { joinMultiple: { messages: {} } } });
    assert.equal(res.statusCode, 200, res.payload);
    assert.match(selectList(pool.calls[1].text), /"message"\."id", "message"\."body"/, pool.calls[1].text);
    await app.close();
  });
});
