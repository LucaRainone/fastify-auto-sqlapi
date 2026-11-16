// Bulk delete on a composite primary key: each id is an object naming every key field,
// `{ ids: [{ postId: 1, tagId: 2 }] }`, as an update names its row in `main` (ADR 0026). The
// statement matches every key column of each id, never one column alone, so a link table
// (M:N) is managed without a custom route. A single-column key keeps its scalar ids.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockPg, createMockSchema } from './_harness.js';

const {
  fastifyAutoSqlApi, defineTable, createSqlApi, createQueryClient, Type, buildAgentManifest, agentToolSchemas,
} = await import(path.join(ROOT, 'dist/index.js'));

const SchemaPostTag = createMockSchema('post_tag', {
  postId: Type.Integer(),
  tagId: Type.Integer(),
  orgId: Type.Integer(),
});

function postTag(extra = {}) {
  return { post_tag: defineTable({ primary: ['postId', 'tagId'], schema: SchemaPostTag, ...extra }) };
}

const IDS = [{ postId: 1, tagId: 2 }, { postId: 1, tagId: 3 }];

async function buildApp(pool, tables = postTag()) {
  const app = Fastify();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { dbTables: tables });
  await app.ready();
  return app;
}

const bulkDelete = (app, payload) => app.inject({ method: 'POST', url: '/bulk/post_tag/delete', payload });
const fieldErrors = (res) => res.json().fields.map((f) => [f.path, f.code]);

describe('bulk delete on a composite primary key, over HTTP', () => {
  it('is registered, and matches every key column of each id', async () => {
    const pool = createMockPg([{ rows: [], rowCount: 2 }]);
    const app = await buildApp(pool);
    const res = await bulkDelete(app, { ids: IDS });

    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json(), [{ main: IDS[0] }, { main: IDS[1] }]);
    assert.equal(pool.calls.length, 1);
    const { text, values } = pool.calls[0];
    assert.match(
      text,
      /^DELETE FROM "post_tag" WHERE \(\("post_id" = \$1 AND "tag_id" = \$2\) OR \("post_id" = \$3 AND "tag_id" = \$4\)\)/,
      text,
    );
    assert.deepEqual(values, [1, 2, 1, 3]);
    await app.close();
  });

  it('a partial delete answers the ids RETURNING reported, as schema fields', async () => {
    const pool = createMockPg([{ rows: [{ post_id: 1, tag_id: 3 }], rowCount: 1 }]);
    const app = await buildApp(pool);
    const res = await bulkDelete(app, { ids: IDS });

    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json(), [{ main: { postId: 1, tagId: 3 } }]);
    assert.match(pool.calls[0].text, /RETURNING "post_id", "tag_id"$/);
    await app.close();
  });

  it('an id missing a key field is a 400 at ids.<i>.<field>', async () => {
    const pool = createMockPg([]);
    const app = await buildApp(pool);
    const res = await bulkDelete(app, { ids: [{ postId: 1, tagId: 2 }, { postId: 1 }] });

    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(fieldErrors(res), [['ids.1.tagId', 'required']]);
    assert.equal(pool.calls.length, 0);
    await app.close();
  });

  it('a scalar id is a 400: one column alone could match several rows', async () => {
    const pool = createMockPg([]);
    const app = await buildApp(pool);
    const res = await bulkDelete(app, { ids: [1] });

    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(fieldErrors(res), [['ids.0', 'type']]);
    assert.equal(pool.calls.length, 0);
    await app.close();
  });

  it('a field outside the key never reaches the match: the id object is a closed schema', async () => {
    // Fastify's default Ajv strips it (`removeAdditional`), as in every write body; with
    // `removeAdditional: false` it is a 400 `additionalProperties` instead.
    const pool = createMockPg([{ rows: [], rowCount: 1 }]);
    const app = await buildApp(pool);
    const res = await bulkDelete(app, { ids: [{ postId: 1, tagId: 2, orgId: 9 }] });

    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(pool.calls[0].values, [1, 2]);
    assert.doesNotMatch(pool.calls[0].text, /org_id/);
    await app.close();
  });

  it('get and delete by :id stay unregistered: a path segment carries one value', async () => {
    const app = await buildApp(createMockPg([]));
    assert.equal(app.hasRoute({ method: 'POST', url: '/bulk/post_tag/delete' }), true);
    assert.equal(app.hasRoute({ method: 'GET', url: '/rest/post_tag/:id' }), false);
    assert.equal(app.hasRoute({ method: 'DELETE', url: '/rest/post_tag/:id' }), false);
    await app.close();
  });

  it('may be listed in operations', async () => {
    const app = await buildApp(createMockPg([]), postTag({ operations: ['search', 'bulkDelete'] }));
    assert.equal(app.hasRoute({ method: 'POST', url: '/bulk/post_tag/delete' }), true);
    await app.close();
  });
});

describe('bulk delete on a composite primary key, through sqlApi', () => {
  it('checks the key fields itself: sqlApi does not run the HTTP body schema', async () => {
    const pool = createMockPg([]);
    const sqlApi = createSqlApi(pool, postTag(), { dialect: 'postgres' });

    await assert.rejects(() => sqlApi.bulkDelete('post_tag', { ids: [{ postId: 1 }] }), (err) => {
      assert.equal(err.statusCode, 400);
      assert.deepEqual(err.validationErrors.map((f) => [f.path, f.code]), [['ids.0.tagId', 'required']]);
      return true;
    });
    await assert.rejects(() => sqlApi.bulkDelete('post_tag', { ids: [7] }), (err) => {
      assert.equal(err.statusCode, 400);
      assert.deepEqual(err.validationErrors.map((f) => [f.path, f.code]), [['ids.0', 'type']]);
      return true;
    });
    await assert.rejects(() => sqlApi.bulkDelete('post_tag', { ids: [{ postId: 1, tagId: 2, orgId: 9 }] }), (err) => {
      assert.equal(err.statusCode, 400);
      assert.deepEqual(err.validationErrors.map((f) => [f.path, f.code]), [['ids.0.orgId', 'additionalProperties']]);
      return true;
    });
    assert.equal(pool.calls.length, 0);
  });

  it('hands the hooks the key objects: requested before, deleted after', async () => {
    const seen = {};
    const pool = createMockPg([{ rows: [{ post_id: 1, tag_id: 2 }], affectedRows: 1 }]);
    const sqlApi = createSqlApi(pool, postTag({
      beforeBulkDelete: ({ ids }) => { seen.before = ids; },
      afterBulkDelete: ({ ids }) => { seen.after = ids; },
    }), { dialect: 'postgres' });

    await sqlApi.bulkDelete('post_tag', { ids: IDS });
    assert.deepEqual(seen.before, IDS);
    assert.deepEqual(seen.after, [{ postId: 1, tagId: 2 }]);
  });

  it('mysql: looks the existing keys up first, then deletes through the same WHERE', async () => {
    const pool = createMockPg([{ rows: [{ post_id: 1, tag_id: 2 }] }, { rows: [], affectedRows: 1 }]);
    const sqlApi = createSqlApi(createQueryClient(pool, 'mysql'), postTag());
    const result = await sqlApi.bulkDelete('post_tag', { ids: IDS });

    assert.deepEqual(result, [{ main: { postId: 1, tagId: 2 } }]);
    assert.match(pool.calls[0].text, /^SELECT `post_id`, `tag_id` FROM `post_tag` WHERE \(\(`post_id` = \? AND `tag_id` = \?\) OR/);
    assert.match(pool.calls[1].text, /^DELETE FROM `post_tag` WHERE \(\(`post_id` = \? AND `tag_id` = \?\) OR/);
    assert.ok(!pool.calls[1].text.includes('RETURNING'));
  });

  it('tenant: the key match and the tenant predicate both bind the DELETE', async () => {
    const pool = createMockPg([{ rows: [], affectedRows: 2 }]);
    const sqlApi = createSqlApi(pool, postTag({ tenantScope: { column: 'org_id' } }), {
      dialect: 'postgres',
      getTenantId: () => 9,
    });
    await sqlApi.bulkDelete('post_tag', { ids: IDS }, { headers: {} });

    const { text, values } = pool.calls[0];
    assert.match(text, /\(\("post_id" = \$1 AND "tag_id" = \$2\) OR \("post_id" = \$3 AND "tag_id" = \$4\)\) AND .*"org_id" IN \(\$5\)/, text);
    assert.deepEqual(values, [1, 2, 1, 3, 9]);
  });

  it('tenant: a key the caller does not own refuses the batch before the hook', async () => {
    let hookRan = false;
    const pool = createMockPg([{ rows: [{ post_id: 1, tag_id: 2 }] }]);
    const sqlApi = createSqlApi(pool, postTag({
      tenantScope: { column: 'org_id' },
      beforeBulkDelete: () => { hookRan = true; },
    }), { dialect: 'postgres', getTenantId: () => 9 });

    await assert.rejects(() => sqlApi.bulkDelete('post_tag', { ids: IDS }, { headers: {} }), (err) => err.statusCode === 404);
    assert.equal(hookRan, false);
    assert.equal(pool.calls.length, 1, 'only the ownership SELECT ran');
  });
});

describe('bulk delete on a composite primary key, for agent clients', () => {
  it('the manifest lists bulkDelete among the operations, get and delete still left out', () => {
    const manifest = buildAgentManifest(postTag());
    assert.deepEqual(manifest.tables.post_tag.operations, ['search', 'insert', 'update', 'bulkUpsert', 'bulkDelete']);
  });

  it('the tool schema takes one object per id, every key field required', () => {
    const body = agentToolSchemas(postTag(), 'post_tag').bulkDelete.body;
    const item = body.properties.ids.items;
    assert.equal(item.type, 'object');
    assert.deepEqual([...item.required].sort(), ['postId', 'tagId']);
    assert.equal(item.additionalProperties, false);
  });
});
