// One word for the projection: `select`. On the main table it lists schema fields and
// computed fields alike (their names cannot collide); on a join reference and in
// `buildRelation` it is the same array. The pre-1.0 keys — `selectComputed` and a join's
// `selection` — are a 400 `retired_key` (an error at startup in `buildRelation`), not
// silently ignored.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, buildRelation, defineTable, createSqlApi, Type } =
  await import(path.join(ROOT, 'dist/index.js'));
const { SearchTableBodyPost } = await import(path.join(ROOT, 'dist/lib/schema/search.js'));

const SchemaConversation = createMockSchema('conversation', {
  id: Type.Integer(),
  title: Type.String(),
  creatorId: Type.Integer(),
});
const SchemaUser = createMockSchema('user', { id: Type.Integer(), name: Type.String(), email: Type.String() });
const SchemaMessage = createMockSchema('message', {
  id: Type.Integer(),
  conversationId: Type.Integer(),
  body: Type.String(),
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

function dbTables(messageOptions = {}) {
  return {
    chat: defineTable({
      primary: 'id',
      schema: SchemaConversation,
      computedFields: {
        loudTitle: ({ qiCol }) => ({ expr: `UPPER(${qiCol('title')})`, values: [], type: Type.String() }),
        titleLike: ({ qiCol }) => ({ expr: `${qiCol('title')} LIKE ?`, values: ['a%'], type: Type.Boolean() }),
      },
      readJoins: [
        buildRelation(SchemaConversation, 'creatorId', SchemaUser, 'id', { alias: 'creator', unique: true }),
        buildRelation(SchemaConversation, 'id', SchemaMessage, 'conversationId', { alias: 'messages', ...messageOptions }),
      ],
    }),
    user: defineTable({ primary: 'id', schema: SchemaUser }),
    message: defineTable({ primary: 'id', schema: SchemaMessage }),
  };
}

async function search(payload, pool = createMockPool(), tables = dbTables()) {
  const app = Fastify();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { dbTables: tables });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/search/chat', payload });
  await app.close();
  return res;
}

/** The SELECT list of a recorded statement. */
const selectList = (sql) => /^SELECT (.*?) FROM/.exec(sql)?.[1] ?? '';
const fieldErrors = (res) => res.json().fields.map((f) => [f.path, f.code]);

const MAIN = { rows: [{ id: 1, title: 'hello', creator_id: 7, loudTitle: 'HELLO' }], rowCount: 1 };

describe('select lists schema fields and computed fields alike', () => {
  it('a computed field in select is projected next to the listed columns, and nothing else', async () => {
    const pool = createMockPool([{ rows: [{ id: 1, title: 'hello', loudTitle: 'HELLO' }], rowCount: 1 }]);
    const res = await search({ select: ['title', 'loudTitle'] }, pool);

    assert.equal(res.statusCode, 200, res.body);
    const list = selectList(pool.calls[0].text);
    assert.match(list, /"conversation"\."title"/, list);
    assert.match(list, /UPPER\("conversation"\."title"\) AS "loudTitle"/, list);
    assert.doesNotMatch(list, /creator_id/, 'a column the request did not list was projected');
    assert.deepEqual(res.json().main, [{ id: 1, title: 'hello', loudTitle: 'HELLO' }]);
  });

  it('without select: every readable column and no computed field', async () => {
    const pool = createMockPool([MAIN]);
    const res = await search({}, pool);

    assert.equal(res.statusCode, 200, res.body);
    assert.doesNotMatch(selectList(pool.calls[0].text), /loudTitle/);
  });

  it('an unknown name in select is a 400 at its index', async () => {
    const res = await search({ select: ['title', 'nope'] });
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(fieldErrors(res), [['select.1', 'unknown_field']]);
  });

  it('a computed field with bound values is a 400 at its index in select', async () => {
    const res = await search({ select: ['titleLike'] });
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(fieldErrors(res), [['select.0', 'bound_values_not_allowed']]);
  });

  it('sqlApi.search takes computed fields in select too', async () => {
    const pool = createMockPool([MAIN]);
    const sqlApi = createSqlApi(pool, dbTables(), { dialect: 'postgres' });
    const result = await sqlApi.search('chat', { select: ['loudTitle'] });
    assert.match(selectList(pool.calls[0].text), /AS "loudTitle"/);
    assert.equal(result.main[0].loudTitle, 'HELLO');
  });
});

describe('select "*": the default projection, plus the computed fields listed next to it', () => {
  it('projects every readable column, as a search without select does, plus the computed field', async () => {
    const plain = createMockPool([MAIN]);
    await search({}, plain);
    const pool = createMockPool([MAIN]);
    const res = await search({ select: ['*', 'loudTitle'] }, pool);

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(
      selectList(pool.calls[0].text),
      `${selectList(plain.calls[0].text)}, UPPER("conversation"."title") AS "loudTitle"`,
    );
    assert.equal(res.json().main[0].loudTitle, 'HELLO');
  });

  it('keeps readExclude out, as the default projection does', async () => {
    const tables = dbTables();
    tables.chat = defineTable({ ...tables.chat, readExclude: ['creatorId'] });
    const pool = createMockPool([MAIN]);
    const res = await search({ select: ['*', 'loudTitle'] }, pool, tables);

    assert.equal(res.statusCode, 200, res.body);
    assert.doesNotMatch(selectList(pool.calls[0].text), /creator_id/);
  });

  it('may stand anywhere in the list, and a schema field next to it adds nothing', async () => {
    const first = createMockPool([MAIN]);
    await search({ select: ['*', 'loudTitle'] }, first);
    const pool = createMockPool([MAIN]);
    const res = await search({ select: ['loudTitle', 'title', '*'] }, pool);

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(selectList(pool.calls[0].text), selectList(first.calls[0].text));
  });

  it('still validates every other name at its index', async () => {
    const res = await search({ select: ['*', 'nope'] });
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(fieldErrors(res), [['select.1', 'unknown_field']]);
  });

  it('is the main projection only: in a join select it is an unknown field', async () => {
    const res = await search({ joinMultiple: { messages: { select: ['*'] } } }, createMockPool([MAIN]));
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(fieldErrors(res), [['joinMultiple.messages.select.0', 'unknown_field']]);
  });

  it('sqlApi.search takes it too', async () => {
    const pool = createMockPool([MAIN]);
    const sqlApi = createSqlApi(pool, dbTables(), { dialect: 'postgres' });
    const result = await sqlApi.search('chat', { select: ['*', 'loudTitle'] });
    assert.match(selectList(pool.calls[0].text), /AS "loudTitle"/);
    assert.equal(result.main[0].loudTitle, 'HELLO');
  });
});

describe('select on a join reference and in buildRelation', () => {
  it('joinMultiple takes select', async () => {
    const pool = createMockPool([MAIN, { rows: [{ id: 10, conversation_id: 1, body: 'hi' }], rowCount: 1 }]);
    const res = await search({ joinMultiple: { messages: { select: ['id', 'body'] } } }, pool);

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(selectList(pool.calls[1].text), '"message"."id", "message"."body"');
  });

  it('joinLeft takes select', async () => {
    const pool = createMockPool([MAIN, { rows: [{ id: 7, name: 'Mario' }], rowCount: 1 }]);
    const res = await search({ joinLeft: { creator: { select: ['id', 'name'] } } }, pool);

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(selectList(pool.calls[1].text), '"user"."id", "user"."name"');
  });

  it('an unknown name in a join select is a 400 at its index', async () => {
    const res = await search({ joinMultiple: { messages: { select: ['id', 'nope'] } } }, createMockPool([MAIN]));
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(fieldErrors(res), [['joinMultiple.messages.select.1', 'unknown_field']]);
  });

  it("buildRelation's select is the relation's default projection", async () => {
    const tables = dbTables({ select: ['id', 'body'] });
    assert.deepEqual(tables.chat.readJoins[1].select, ['id', 'body']);

    const pool = createMockPool([MAIN, { rows: [{ id: 10, conversation_id: 1, body: 'hi' }], rowCount: 1 }]);
    const res = await search({ joinMultiple: { messages: {} } }, pool, tables);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(selectList(pool.calls[1].text), '"message"."id", "message"."body"');
  });

  it('buildRelation with no select leaves the default projection to every readable field', () => {
    assert.equal(dbTables().chat.readJoins[1].select, undefined);
  });

  it('buildRelation rejects a select naming a field the joined schema does not have', () => {
    assert.throws(
      () => buildRelation(SchemaConversation, 'id', SchemaMessage, 'conversationId', { select: ['id', 'nope'] }),
      /select.*'nope'/
    );
  });

  it('buildRelation rejects a comma-separated string: select is an array', () => {
    assert.throws(
      () => buildRelation(SchemaConversation, 'id', SchemaMessage, 'conversationId', { select: 'id,body' }),
      TypeError
    );
  });
});

describe('the pre-1.0 projection keys are rejected, not ignored', () => {
  it('selectComputed is a 400 retired_key, nothing queried', async () => {
    const pool = createMockPool([MAIN]);
    const res = await search({ selectComputed: ['loudTitle'] }, pool);
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(fieldErrors(res), [['selectComputed', 'retired_key']]);
    assert.equal(pool.calls.length, 0);
  });

  it('selectComputed in sqlApi.search is a 400 retired_key', async () => {
    const sqlApi = createSqlApi(createMockPool([MAIN]), dbTables(), { dialect: 'postgres' });
    await assert.rejects(
      () => sqlApi.search('chat', { selectComputed: ['loudTitle'] }),
      (err) => err.statusCode === 400 &&
        JSON.stringify(err.validationErrors.map((f) => [f.path, f.code])) === '[["selectComputed","retired_key"]]'
    );
  });

  it("a join's selection is a 400 retired_key at its path", async () => {
    const res = await search({ joinMultiple: { messages: { selection: ['id'] } } }, createMockPool([MAIN]));
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(fieldErrors(res), [['joinMultiple.messages.selection', 'retired_key']]);
  });

  it("joinLeft's selection is a 400 retired_key at its path", async () => {
    const res = await search({ joinLeft: { creator: { selection: 'id,name' } } }, createMockPool([MAIN]));
    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(fieldErrors(res), [['joinLeft.creator.selection', 'retired_key']]);
  });

  it('buildRelation with selection throws at startup naming select', () => {
    assert.throws(
      () => buildRelation(SchemaConversation, 'id', SchemaMessage, 'conversationId', { selection: 'id,body' }),
      /select/
    );
  });

  it('the search body schema has no selectComputed and the join entries no selection', () => {
    const body = SearchTableBodyPost(dbTables(), 'chat');
    assert.equal(body.properties.selectComputed, undefined);
    assert.equal(body.properties.joinMultiple.properties.messages.properties.selection, undefined);
    assert.equal(body.properties.joinMultiple.properties.messages.properties.select.type, 'array');
    assert.equal(body.properties.joinLeft.properties.creator.properties.select.type, 'array');
  });
});
