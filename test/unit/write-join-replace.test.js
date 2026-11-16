// A write request names its child rows in one section per action (ADR 0029): `upsert` writes
// them and leaves the others, `delete` removes the ones named, `replace` takes the complete set
// — the rows sent are upserted on the relation's `upsertKey`, every other child row of the main
// row is deleted. The outcome keeps its nouns: `secondaries` (written) and `deletions` (removed),
// in the response and in the after-hooks, inside the write's transaction. In a bulk upsert, an
// item with a `replace` runs its child rows in a transaction of its own.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockPg, createMockSchema } from './_harness.js';

const {
  fastifyAutoSqlApi, defineTable, buildRelation, createSqlApi, createQueryClient, Type,
  buildAgentManifest, agentToolSchemas,
} = await import(path.join(ROOT, 'dist/index.js'));

const SchemaPost = {
  ...createMockSchema('post', { id: Type.Optional(Type.Integer()), title: Type.String() }),
  primaryKey: ['id'],
  uniqueKeys: [],
};
const SchemaPostTag = {
  ...createMockSchema('post_tag', { postId: Type.Integer(), tagId: Type.Integer(), orgId: Type.Optional(Type.Integer()) }),
  primaryKey: ['postId', 'tagId'],
  uniqueKeys: [],
};
const SchemaComment = { ...createMockSchema('comment', { id: Type.Integer(), postId: Type.Integer(), body: Type.String() }), primaryKey: ['id'] };

function tables({ post = {}, postTag } = {}) {
  return {
    post: defineTable({
      primary: 'id',
      schema: SchemaPost,
      writeJoins: [
        buildRelation(SchemaPost, 'id', SchemaPostTag, 'postId', { alias: 'tags', upsertKey: ['postId', 'tagId'] }),
        buildRelation(SchemaPost, 'id', SchemaComment, 'postId', { alias: 'comments' }),
      ],
      ...post,
    }),
    ...(postTag ? { post_tag: defineTable({ primary: ['postId', 'tagId'], schema: SchemaPostTag, ...postTag }) } : {}),
  };
}

/** A pool answering by statement: the replace DELETE reports `deleted` rows; counts the transactions. */
function pool(deleted = []) {
  const p = createMockPg(({ text }) => {
    if (/^UPDATE [`"]post[`"]/.test(text)) return { rows: [], rowCount: 1, affectedRows: 1 };
    if (/^INSERT INTO [`"]post[`"] /.test(text)) return { rows: [{ id: 1 }], rowCount: 1, affectedRows: 1, insertId: 1 };
    if (/^SELECT .* FROM `post_tag`/.test(text)) return { rows: deleted };
    if (/^DELETE FROM "post_tag"/.test(text)) return { rows: deleted, rowCount: deleted.length, affectedRows: deleted.length };
    if (/^DELETE FROM `post_tag`/.test(text)) return { rows: [], affectedRows: deleted.length };
    if (/INTO "post_tag"/.test(text)) return { rows: [{ post_id: 1, tag_id: 3 }], rowCount: 1, affectedRows: 1 };
    return { rows: [], rowCount: 0, affectedRows: 0 };
  });
  let connects = 0;
  const connect = p.connect.bind(p);
  p.connect = () => { connects++; return connect(); };
  Object.defineProperty(p, 'connects', { get: () => connects });
  return p;
}

const api = (p, t = tables(), options = {}) => createSqlApi(p, t, { dialect: 'postgres', ...options });
const replaceDelete = (p) => p.calls.find((c) => /^DELETE FROM ["`]post_tag["`] WHERE \(["`]post_id["`] = /.test(c.text));
const fieldsOf = (err) => err.validationErrors.map((f) => [f.path, f.code]);
const refused = (path, code) => (err) => {
  assert.equal(err.statusCode, 400);
  assert.deepEqual(fieldsOf(err), [[path, code]]);
  return true;
};

describe('replace: an update', () => {
  it('upserts the rows sent and deletes every other child row of the main row', async () => {
    const p = pool([{ post_id: 1, tag_id: 1 }, { post_id: 1, tag_id: 2 }]);
    const result = await api(p).update('post', { main: { id: 1, title: 'x' }, replace: { tags: [{ tagId: 3 }] } });

    const del = replaceDelete(p);
    assert.ok(del, p.calls.map((c) => c.text).join('\n'));
    assert.match(del.text, /^DELETE FROM "post_tag" WHERE \("post_id" = \$1 AND NOT COALESCE\(/, del.text);
    assert.match(del.text, /"post_id" = \$2 AND "tag_id" = \$3/, del.text);
    assert.deepEqual(del.values, [1, 1, 3]);
    assert.deepEqual(result.secondaries, { tags: [{ postId: 1, tagId: 3 }] });
    assert.deepEqual(result.deletions, { tags: [{ postId: 1, tagId: 1 }, { postId: 1, tagId: 2 }] });
  });

  it('runs the delete after the upsert, inside the update\'s transaction', async () => {
    const p = pool();
    await api(p).update('post', { main: { id: 1, title: 'x' }, replace: { tags: [{ tagId: 3 }] } });

    const upsertAt = p.calls.findIndex((c) => /INTO "post_tag"/.test(c.text));
    const deleteAt = p.calls.indexOf(replaceDelete(p));
    assert.ok(upsertAt !== -1 && deleteAt > upsertAt, p.calls.map((c) => c.text).join('\n'));
    assert.equal(p.connects, 1, 'one transaction for the whole write');
  });

  it('an empty list removes every child row, and writes none', async () => {
    const p = pool([{ post_id: 1, tag_id: 1 }]);
    const result = await api(p).update('post', { main: { id: 1, title: 'x' }, replace: { tags: [] } });

    const del = replaceDelete(p);
    assert.match(del.text, /^DELETE FROM "post_tag" WHERE \("post_id" = \$1\) RETURNING/, del.text);
    assert.deepEqual(del.values, [1]);
    assert.equal(p.calls.some((c) => /INTO "post_tag"/.test(c.text)), false);
    assert.deepEqual(result.deletions, { tags: [{ postId: 1, tagId: 1 }] });
  });

  it('upsert writes the rows sent and leaves the others alone', async () => {
    const p = pool();
    await api(p).update('post', { main: { id: 1, title: 'x' }, upsert: { tags: [{ tagId: 3 }] } });
    assert.ok(p.calls.some((c) => /INTO "post_tag"/.test(c.text)));
    assert.equal(replaceDelete(p), undefined);
  });

  it('replace on one alias and delete on another go together', async () => {
    const p = pool([{ post_id: 1, tag_id: 1 }]);
    const result = await api(p).update('post', {
      main: { id: 1, title: 'x' },
      replace: { tags: [{ tagId: 3 }] },
      delete: { comments: [{ id: 7 }] },
    });
    assert.ok(replaceDelete(p));
    assert.ok(p.calls.some((c) => /^DELETE FROM "comment"/.test(c.text)));
    assert.deepEqual(result.deletions.tags, [{ postId: 1, tagId: 1 }]);
  });

  it('hands afterUpdate the removed rows under deletions', async () => {
    let seen;
    const p = pool([{ post_id: 1, tag_id: 1 }]);
    await api(p, tables({ post: { afterUpdate: ({ deletions }) => { seen = deletions; } } }))
      .update('post', { main: { id: 1, title: 'x' }, replace: { tags: [{ tagId: 3 }] } });
    assert.deepEqual(seen, { tags: [{ postId: 1, tagId: 1 }] });
  });

  it('hands validate the replace section under its own name, for paths like replace.tags.0', async () => {
    let seen;
    const p = pool();
    await api(p, tables({ post: { validate: (ctx) => { seen = ctx; return []; } } }))
      .update('post', { main: { id: 1, title: 'x' }, replace: { tags: [{ tagId: 3 }] } });
    assert.deepEqual(seen.replace, { tags: [{ tagId: 3 }] });
    assert.equal(seen.upsert, undefined);
  });

  it('a child row of another tenant pointing at this main row is not deleted', async () => {
    const p = pool();
    await api(p, tables({ postTag: { tenantScope: { column: 'org_id' } } }), { getTenantId: () => 9 })
      .update('post', { main: { id: 1, title: 'x' }, replace: { tags: [{ tagId: 3 }] } }, { headers: {} });

    const del = replaceDelete(p);
    assert.match(del.text, /"org_id" IN \(\$\d+\)/, del.text);
    assert.ok(del.values.includes(9), JSON.stringify(del.values));
  });

  it('mysql: reads the rows to remove, then deletes them through the same WHERE', async () => {
    const p = pool([{ post_id: 1, tag_id: 1 }]);
    const result = await createSqlApi(createQueryClient(p, 'mysql'), tables())
      .update('post', { main: { id: 1, title: 'x' }, replace: { tags: [{ tagId: 3 }] } });

    const select = p.calls.find((c) => /^SELECT .* FROM `post_tag` WHERE \(`post_id` = \? AND NOT COALESCE\(/.test(c.text));
    const del = p.calls.find((c) => /^DELETE FROM `post_tag` WHERE \(`post_id` = \? AND NOT COALESCE\(/.test(c.text));
    assert.ok(select && del, p.calls.map((c) => c.text).join('\n'));
    assert.ok(p.calls.indexOf(select) < p.calls.indexOf(del));
    assert.deepEqual(result.deletions, { tags: [{ postId: 1, tagId: 1 }] });
  });
});

describe('replace: refused requests, before anything is written', () => {
  it('an alias in replace and in upsert is a 400 conflicting_alias: replace already names the set', async () => {
    const p = pool();
    await assert.rejects(
      () => api(p).update('post', { main: { id: 1, title: 'x' }, upsert: { tags: [{ tagId: 1 }] }, replace: { tags: [] } }),
      refused('replace.tags', 'conflicting_alias'),
    );
    assert.equal(p.calls.length, 0);
  });

  it('an alias in replace and in delete is a 400 conflicting_alias', async () => {
    const p = pool();
    await assert.rejects(
      () => api(p).update('post', { main: { id: 1, title: 'x' }, delete: { tags: [{ tagId: 1 }] }, replace: { tags: [] } }),
      refused('replace.tags', 'conflicting_alias'),
    );
    assert.equal(p.calls.length, 0);
  });

  it('replace on a relation without upsertKey is a 400: nothing tells its rows apart', async () => {
    const p = pool();
    await assert.rejects(
      () => api(p).update('post', { main: { id: 1, title: 'x' }, replace: { comments: [] } }),
      refused('replace.comments', 'unknown_field'),
    );
    assert.equal(p.calls.length, 0);
  });

  it('the pre-1.0 keys are a 400 retired_key naming the new section, in sqlApi', async () => {
    const p = pool();
    await assert.rejects(
      () => api(p).insert('post', { main: { title: 'x' }, secondaries: { tags: [{ tagId: 1 }] } }),
      (err) => refused('secondaries', 'retired_key')(err) && /'upsert'/.test(err.message),
    );
    await assert.rejects(
      () => api(p).update('post', { main: { id: 1, title: 'x' }, deletions: { tags: [{ tagId: 1 }] } }),
      (err) => refused('deletions', 'retired_key')(err) && /'delete'/.test(err.message),
    );
    await assert.rejects(
      () => api(p).bulkUpsert('post', [{ main: { title: 'a' } }, { main: { title: 'b' }, secondaries: {} }]),
      refused('1.secondaries', 'retired_key'),
    );
    assert.equal(p.calls.length, 0);
  });
});

describe('replace: an insert', () => {
  it('replaces the children too, and reports the removed rows to the response and afterInsert', async () => {
    let seen;
    const p = pool([{ post_id: 1, tag_id: 1 }]);
    const result = await api(p, tables({ post: { afterInsert: ({ deletions }) => { seen = deletions; } } }))
      .insert('post', { main: { title: 'x' }, replace: { tags: [{ tagId: 3 }] } });

    assert.ok(replaceDelete(p));
    assert.deepEqual(result.deletions, { tags: [{ postId: 1, tagId: 1 }] });
    assert.deepEqual(seen, { tags: [{ postId: 1, tagId: 1 }] });
  });
});

describe('replace: a bulk upsert', () => {
  it('an item with a replace runs its child rows in a transaction of its own; the batch stays without one', async () => {
    const p = createMockPg(({ text }) => {
      if (/INTO "post" /.test(text)) return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2, affectedRows: 2 };
      if (/INTO "post_tag"/.test(text)) return { rows: [{ post_id: 1, tag_id: 3 }], rowCount: 1, affectedRows: 1 };
      return { rows: [], rowCount: 0, affectedRows: 0 };
    });
    let connects = 0;
    const connect = p.connect.bind(p);
    p.connect = () => { connects++; return connect(); };

    await api(p).bulkUpsert('post', [
      { main: { title: 'a' }, replace: { tags: [{ tagId: 3 }] } },
      { main: { title: 'b' }, upsert: { tags: [{ tagId: 3 }] } },
    ]);
    assert.equal(connects, 1, 'only the item with a replace opens a transaction');
  });

  it('reports each item\'s removed rows under its own deletions', async () => {
    const p = createMockPg(({ text, values }) => {
      if (/INTO "post" /.test(text)) return { rows: [{ id: 1 }], rowCount: 1, affectedRows: 1 };
      if (/INTO "post_tag"/.test(text)) return { rows: [{ post_id: 1, tag_id: 3 }], rowCount: 1, affectedRows: 1 };
      if (/^DELETE FROM "post_tag"/.test(text)) return { rows: [{ post_id: values[0], tag_id: 9 }], rowCount: 1, affectedRows: 1 };
      return { rows: [], rowCount: 0, affectedRows: 0 };
    });
    const [item] = await api(p).bulkUpsert('post', [{ main: { title: 'a' }, replace: { tags: [{ tagId: 3 }] } }]);
    assert.deepEqual(item.deletions, { tags: [{ postId: 1, tagId: 9 }] });
  });
});

describe('replace: the HTTP contract and the agent surface', () => {
  async function app(p) {
    const a = Fastify();
    a.decorate('pg', p);
    await a.register(fastifyAutoSqlApi, { dbTables: tables() });
    return a;
  }

  it('the update response carries the written rows under secondaries and the removed ones under deletions', async () => {
    const p = pool([{ post_id: 1, tag_id: 1 }]);
    const a = await app(p);
    const res = await a.inject({ method: 'PUT', url: '/rest/post', payload: { main: { id: 1, title: 'x' }, replace: { tags: [{ tagId: 3 }] } } });
    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json().secondaries, { tags: [{ postId: 1, tagId: 3 }] });
    assert.deepEqual(res.json().deletions, { tags: [{ postId: 1, tagId: 1 }] });
    await a.close();
  });

  it('the insert response carries the removed rows too', async () => {
    const p = pool([{ post_id: 1, tag_id: 1 }]);
    const a = await app(p);
    const res = await a.inject({ method: 'POST', url: '/rest/post', payload: { main: { title: 'x' }, replace: { tags: [{ tagId: 3 }] } } });
    assert.equal(res.statusCode, 201, res.payload);
    assert.deepEqual(res.json().deletions, { tags: [{ postId: 1, tagId: 1 }] });
    await a.close();
  });

  it('a pre-1.0 key over HTTP is a 400 retired_key, never ignored', async () => {
    const a = await app(pool());
    const res = await a.inject({ method: 'PUT', url: '/rest/post', payload: { main: { id: 1, title: 'x' }, secondaries: { tags: [] } } });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(res.json().fields.map((f) => [f.path, f.code]), [['secondaries', 'retired_key']]);
    await a.close();
  });

  it('the update body offers upsert and delete for every alias, replace only where an upsertKey tells rows apart', () => {
    const body = agentToolSchemas(tables(), 'post').update.body;
    assert.deepEqual(Object.keys(body.properties.upsert.properties).sort(), ['comments', 'tags']);
    assert.deepEqual(Object.keys(body.properties.delete.properties).sort(), ['comments', 'tags']);
    assert.deepEqual(Object.keys(body.properties.replace.properties), ['tags']);
  });

  it('the insert body offers no delete', () => {
    const body = agentToolSchemas(tables(), 'post').insert.body;
    assert.ok(body.properties.upsert && body.properties.replace);
    assert.equal(body.properties.delete, undefined);
  });

  it('the manifest gives a write join its upsertKey, the mark of an alias replace can address', () => {
    const joins = buildAgentManifest(tables()).tables.post.writeJoins;
    assert.deepEqual(joins, [
      { alias: 'tags', table: 'post_tag', kind: '1:N', upsertKey: ['postId', 'tagId'] },
      { alias: 'comments', table: 'comment', kind: '1:N' },
    ]);
  });
});
