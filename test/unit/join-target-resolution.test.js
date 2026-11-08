// Which TableConfig governs the target of a relation.
//
// A relation is declared against a Schema, while `dbTables` is keyed by route name, and one
// physical table may sit under several keys (route-url-key.test.js). The target's config is
// what carries `readExclude`, `tenantScope`, `afterRead`, computed fields and the write-side
// rules, so the resolution must be a single rule shared by the body schemas and the engines:
//   - exactly one key over the joined table → that config, whatever the key is called;
//   - several keys → the relation must name one with `target`, else startup fails;
//   - `target` must name a key whose Schema is the joined table.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, buildRelation, createSqlApi, exportTableInfo, Type } =
  await import(path.join(ROOT, 'dist/index.js'));

const SchemaConversation = createMockSchema('conversation', {
  id: Type.Integer(),
  title: Type.String(),
});
const SchemaMessage = createMockSchema('message', {
  id: Type.Integer(),
  conversationId: Type.Integer(),
  body: Type.String(),
  secret: Type.String(),
});

function conversationConf(relationOptions = {}, lists = ['allowedReadJoins']) {
  const relation = buildRelation(SchemaConversation, 'id', SchemaMessage, 'conversationId', {
    alias: 'messages',
    ...relationOptions,
  });
  const conf = { primary: 'id', ...exportTableInfo(SchemaConversation) };
  for (const list of lists) conf[list] = [relation];
  return conf;
}

function messageConf(overrides = {}) {
  return { primary: 'id', ...exportTableInfo(SchemaMessage), ...overrides };
}

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

const MAIN_ROWS = { rows: [{ id: 1, title: 'Hello' }], rowCount: 1 };
const MESSAGE_ROWS = { rows: [{ id: 10, conversation_id: 1, body: 'hi', secret: 's3cr3t' }], rowCount: 1 };

async function buildApp(DbTables, pool = createMockPool()) {
  const app = Fastify();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { DbTables });
  await app.ready();
  return app;
}

async function searchWithMessages(app, extra = {}) {
  return app.inject({
    method: 'POST',
    url: '/search/chat',
    payload: { joinMultiple: { messages: { ...extra } } },
  });
}

describe('join target resolution — one key over the joined table, named differently', () => {
  // `dbTables.msg` is the only config over `message`: it governs the relation even though the
  // key is not the table name. A lookup by `dbTables[joinSchema.tableName]` would miss it and
  // run the join with no config at all, which is how `readExclude` leaks through a join.
  const DbTables = () => ({
    chat: conversationConf(),
    msg: messageConf({ readExclude: ['secret'] }),
  });

  it("applies the target's readExclude to the joined rows", async () => {
    const pool = createMockPool([MAIN_ROWS, MESSAGE_ROWS]);
    const app = await buildApp(DbTables(), pool);
    const res = await searchWithMessages(app);
    assert.equal(res.statusCode, 200, res.payload);
    const [message] = res.json().joinMultiple.messages;
    assert.equal(message.body, 'hi');
    assert.equal('secret' in message, false, `secret leaked: ${res.payload}`);
    assert.doesNotMatch(pool.calls[1].text, /secret/, 'the hidden column is not even selected');
    await app.close();
  });

  it("rejects a filter on the target's excluded field with 400", async () => {
    const app = await buildApp(DbTables(), createMockPool([MAIN_ROWS]));
    const res = await searchWithMessages(app, { filters: { secret: 'x' } });
    assert.equal(res.statusCode, 400, res.payload);
    await app.close();
  });
});

describe('join target resolution — several keys over the joined table', () => {
  it('fails at startup when the relation does not name its target', async () => {
    const app = Fastify();
    app.decorate('pg', createMockPool());
    await assert.rejects(
      async () => app.register(fastifyAutoSqlApi, {
        DbTables: {
          chat: conversationConf(),
          msgAdmin: messageConf(),
          msgPublic: messageConf({ readExclude: ['secret'] }),
        },
      }),
      (err) =>
        /messages/.test(err.message) &&
        /msgAdmin/.test(err.message) &&
        /msgPublic/.test(err.message) &&
        /target/.test(err.message),
    );
    await app.close();
  });

  it('fails the same way for a write join', async () => {
    const app = Fastify();
    app.decorate('pg', createMockPool());
    await assert.rejects(
      async () => app.register(fastifyAutoSqlApi, {
        DbTables: {
          chat: conversationConf({}, ['allowedWriteJoins']),
          msgAdmin: messageConf(),
          msgPublic: messageConf(),
        },
      }),
      /target/,
    );
    await app.close();
  });

  it('fails the same way when createSqlApi is used standalone', () => {
    assert.throws(
      () => createSqlApi(createMockPool(), {
        chat: conversationConf(),
        msgAdmin: messageConf(),
        msgPublic: messageConf(),
      }, { dialect: 'postgres' }),
      /target/,
    );
  });

  it("uses the config the relation's `target` names", async () => {
    // msgAdmin comes first and hides nothing: a first-match lookup would pick it.
    const pool = createMockPool([MAIN_ROWS, MESSAGE_ROWS]);
    const app = await buildApp({
      chat: conversationConf({ target: 'msgPublic' }),
      msgAdmin: messageConf(),
      msgPublic: messageConf({ readExclude: ['secret'] }),
    }, pool);
    const res = await searchWithMessages(app);
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal('secret' in res.json().joinMultiple.messages[0], false, res.payload);
    await app.close();
  });

  it('rejects a target that is not a key of dbTables', async () => {
    const app = Fastify();
    app.decorate('pg', createMockPool());
    await assert.rejects(
      async () => app.register(fastifyAutoSqlApi, {
        DbTables: { chat: conversationConf({ target: 'nope' }), msg: messageConf() },
      }),
      /nope/,
    );
    await app.close();
  });

  it('rejects a target whose Schema is not the joined table', async () => {
    const app = Fastify();
    app.decorate('pg', createMockPool());
    await assert.rejects(
      async () => app.register(fastifyAutoSqlApi, {
        DbTables: { chat: conversationConf({ target: 'chat' }), msg: messageConf() },
      }),
      (err) => /chat/.test(err.message) && /conversation/.test(err.message) && /message/.test(err.message),
    );
    await app.close();
  });
});
