// A write join runs the child table's `validate` on every child row it writes (ADR 0030): the
// rows of `upsert` and `replace`, before any SQL, after the host's `validate`. The child sees
// its row as `main` — with the FK to the main row when the request names the main row's key —
// and `parent: { alias, main }`, absent on its own routes. Its paths are answered in the
// request's grammar. A child declaring `validateBulk` gets the rows of one alias at once.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockPg, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, defineTable, buildRelation, createSqlApi, Type } =
  await import(path.join(ROOT, 'dist/index.js'));

const SchemaArticle = {
  ...createMockSchema('article', { id: Type.Optional(Type.Integer()), name: Type.String(), status: Type.Optional(Type.String()) }),
  primaryKey: ['id'],
  uniqueKeys: [],
};
const SchemaArticleInfo = {
  ...createMockSchema('article_info', {
    articleId: Type.Integer(), lang: Type.String(), title: Type.Optional(Type.String()), slug: Type.Optional(Type.String()),
  }),
  primaryKey: ['articleId', 'lang'],
  uniqueKeys: [],
};

function tables({ article = {}, info = {} } = {}) {
  return {
    article: defineTable({
      primary: 'id',
      schema: SchemaArticle,
      writeJoins: [
        buildRelation(SchemaArticle, 'id', SchemaArticleInfo, 'articleId', { alias: 'info', upsertKey: ['articleId', 'lang'] }),
      ],
      ...article,
    }),
    article_info: defineTable({ primary: ['articleId', 'lang'], schema: SchemaArticleInfo, ...info }),
  };
}

const pool = () => createMockPg(({ text }) => {
  if (/^INSERT INTO "article" /.test(text)) return { rows: [{ id: 1 }], rowCount: 1, affectedRows: 1 };
  if (/INTO "article_info"/.test(text)) return { rows: [{ article_id: 1, lang: 'it' }], rowCount: 1, affectedRows: 1 };
  return { rows: [], rowCount: 1, affectedRows: 1 };
});
const api = (p, t) => createSqlApi(p, t, { dialect: 'postgres' });
const fieldsOf = (err) => err.validationErrors.map((f) => [f.path, f.code]);

/** article_info's validate, as in ADR 0030: input rules, the FK guarded with `parent`. */
function infoValidate(seen = []) {
  return (ctx) => {
    seen.push(ctx);
    const { main, parent } = ctx;
    const errors = [];
    if (!main.title) errors.push({ path: 'main.title', code: 'required' });
    if (!parent && !main.articleId) errors.push({ path: 'main.articleId', code: 'required' });
    if (parent?.main.status === 'published' && !main.slug) errors.push({ path: 'main.slug', code: 'required' });
    return errors;
  };
}

describe('a child row is validated by its own table', () => {
  it('upsert: the child\'s errors come back at the request\'s paths, every row at once, nothing written', async () => {
    const p = pool();
    await assert.rejects(
      () => api(p, tables({ info: { validate: infoValidate() } })).insert('article', {
        main: { name: 'Bike' },
        upsert: { info: [{ lang: 'it', title: 'Bici' }, { lang: 'en' }, { lang: 'de' }] },
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.deepEqual(fieldsOf(err), [['upsert.info.1.title', 'required'], ['upsert.info.2.title', 'required']]);
        return true;
      },
    );
    assert.equal(p.calls.length, 0);
  });

  it('replace rows are validated too, at replace.<alias>.<i>', async () => {
    const p = pool();
    await assert.rejects(
      () => api(p, tables({ info: { validate: infoValidate() } })).update('article', {
        main: { id: 1, name: 'Bike' }, replace: { info: [{ lang: 'it' }] },
      }),
      (err) => assert.deepEqual(fieldsOf(err), [['replace.info.0.title', 'required']]) ?? true,
    );
    assert.equal(p.calls.length, 0);
  });

  it('delete rows are not validated: deleting renders no verdict', async () => {
    const seen = [];
    await api(pool(), tables({ info: { validate: infoValidate(seen) } })).update('article', {
      main: { id: 1, name: 'Bike' }, delete: { info: [{ lang: 'it' }] },
    });
    assert.equal(seen.length, 0);
  });

  it('the child sees parent { alias, main } and its row as sent; no FK while the parent key is generated', async () => {
    const seen = [];
    await api(pool(), tables({ info: { validate: infoValidate(seen) } })).insert('article', {
      main: { name: 'Bike', status: 'draft' }, upsert: { info: [{ lang: 'it', title: 'Bici' }] },
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].main, { lang: 'it', title: 'Bici' });
    assert.deepEqual(seen[0].parent, { alias: 'info', main: { name: 'Bike', status: 'draft' } });
  });

  it('the child sees the FK when the request names the parent key', async () => {
    const seen = [];
    await api(pool(), tables({ info: { validate: infoValidate(seen) } })).update('article', {
      main: { id: 7, name: 'Bike' }, upsert: { info: [{ lang: 'it', title: 'Bici', articleId: 999 }] },
    });
    assert.equal(seen[0].main.articleId, 7, 'the engine\'s FK, over the client\'s');
  });

  it('a rule on the parent\'s fields needs no FK', async () => {
    await assert.rejects(
      () => api(pool(), tables({ info: { validate: infoValidate() } })).insert('article', {
        main: { name: 'Bike', status: 'published' }, upsert: { info: [{ lang: 'it', title: 'Bici' }] },
      }),
      (err) => assert.deepEqual(fieldsOf(err), [['upsert.info.0.slug', 'required']]) ?? true,
    );
  });

  it('runs after the host\'s validate: a host error answers alone', async () => {
    const seen = [];
    await assert.rejects(
      () => api(pool(), tables({
        article: { validate: () => [{ path: 'main.name', code: 'taken' }] },
        info: { validate: infoValidate(seen) },
      })).insert('article', { main: { name: 'Bike' }, upsert: { info: [{ lang: 'it' }] } }),
      (err) => assert.deepEqual(fieldsOf(err), [['main.name', 'taken']]) ?? true,
    );
    assert.equal(seen.length, 0);
  });

  it('a child validate answering a path outside its grammar is a programming error, not a 400', async () => {
    await assert.rejects(
      () => api(pool(), tables({ info: { validate: () => [{ path: 'title', code: 'required' }] } })).insert('article', {
        main: { name: 'Bike' }, upsert: { info: [{ lang: 'it' }] },
      }),
      (err) => err.statusCode === undefined && /article_info.*validate.*'title'/s.test(err.message),
    );
  });

  it('on its own routes, the child sees no parent', async () => {
    const seen = [];
    await api(pool(), tables({ info: { validate: infoValidate(seen) } }))
      .insert('article_info', { main: { articleId: 1, lang: 'it', title: 'Bici' } });
    assert.equal(seen[0].parent, undefined);
  });
});

describe('a child row in a bulk upsert', () => {
  it('is validated per item, at <item>.upsert.<alias>.<i>, even when the host has validateBulk', async () => {
    const p = pool();
    await assert.rejects(
      () => api(p, tables({ article: { validateBulk: () => [] }, info: { validate: infoValidate() } })).bulkUpsert('article', [
        { main: { name: 'A' }, upsert: { info: [{ lang: 'it', title: 'ok' }] } },
        { main: { name: 'B' }, upsert: { info: [{ lang: 'en' }] } },
      ]),
      (err) => assert.deepEqual(fieldsOf(err), [['1.upsert.info.0.title', 'required']]) ?? true,
    );
    assert.equal(p.calls.length, 0);
  });
});

describe('a child declaring validateBulk', () => {
  it('gets the rows of one alias at once, with the parent, and its items paths are re-rooted', async () => {
    const calls = [];
    const validateBulk = ({ items, parent }) => {
      calls.push({ items, parent });
      const slugs = items.map((it) => it.main.slug);
      return items.flatMap((it, j) => (slugs.indexOf(it.main.slug) !== j ? [{ path: `items.${j}.main.slug`, code: 'duplicate' }] : []));
    };
    const perRow = [];
    await assert.rejects(
      () => api(pool(), tables({ info: { validateBulk, validate: infoValidate(perRow) } })).insert('article', {
        main: { name: 'Bike' },
        upsert: { info: [{ lang: 'it', title: 'a', slug: 'bike' }, { lang: 'en', title: 'b', slug: 'bike' }] },
      }),
      (err) => assert.deepEqual(fieldsOf(err), [['upsert.info.1.slug', 'duplicate']]) ?? true,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].parent, { alias: 'info', main: { name: 'Bike' } });
    assert.equal(calls[0].items.length, 2);
    assert.equal(perRow.length, 0, 'validateBulk replaces the per-row validate');
  });
});

describe('over HTTP', () => {
  it('the 400 carries the child\'s fields at the request\'s paths', async () => {
    const app = Fastify();
    app.decorate('pg', pool());
    await app.register(fastifyAutoSqlApi, { dbTables: tables({ info: { validate: infoValidate() } }) });
    const res = await app.inject({
      method: 'POST', url: '/rest/article', payload: { main: { name: 'Bike' }, upsert: { info: [{ lang: 'it' }] } },
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.deepEqual(res.json().fields, [{ path: 'upsert.info.0.title', code: 'required' }]);
    await app.close();
  });
});
