// `defaultOrder` has the grammar of a 1-part request `orderBy`: `field [ASC|DESC]`, comma
// separated, each field a schema field or a computed field. Checked by `defineTable`, so a typo
// fails at startup instead of being a 500 on every search; nothing reaches the SQL as written —
// an expression is declared as a computed field. The dotted notations stay request-only: the
// default applies to requests that carry no join.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockSchema, createMockPg } from './_harness.js';

const { defineTable, buildRelation, Type } = await import(path.join(ROOT, 'dist/index.js'));
const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));

const articleSchema = createMockSchema('article', {
  id: Type.Number(),
  title: Type.String(),
  createdAt: Type.String(),
  authorId: Type.Number(),
});
const authorSchema = createMockSchema('author', { id: Type.Number(), name: Type.String() });

const upperTitle = ({ qiCol }) => ({ expr: `UPPER(${qiCol('title')})`, values: [], type: Type.String() });

const article = (defaultOrder, extra = {}) =>
  defineTable({ primary: 'id', schema: articleSchema, defaultOrder, ...extra });

describe('defaultOrder — accepted', () => {
  it('fields and computed fields, with or without a direction, any case', () => {
    assert.doesNotThrow(() => article('createdAt DESC, id asc, upperTitle', { computedFields: { upperTitle } }));
  });
});

describe('defaultOrder — refused at startup', () => {
  it('a field the table does not have', () => {
    assert.throws(() => article('nmae'), /defaultOrder.*'nmae'.*'article'/s);
  });

  it('a DB column name, pointing at its field', () => {
    assert.throws(() => article('created_at DESC'), /defaultOrder.*'created_at'.*'createdAt'/s);
  });

  it('an SQL expression, pointing at computedFields', () => {
    assert.throws(() => article('LOWER(title)'), /defaultOrder.*'LOWER\(title\)'.*computedFields/s);
  });

  it('a dotted notation, even on a declared relation', () => {
    const readJoins = [buildRelation(articleSchema, 'authorId', authorSchema, 'id', { alias: 'author', unique: true })];
    assert.throws(() => article('author.name', { readJoins }), /defaultOrder.*'author\.name'.*dotted/s);
  });

  it('a direction other than ASC or DESC', () => {
    assert.throws(() => article('title UP'), /defaultOrder.*'title UP'/s);
  });

  it('an empty term', () => {
    assert.throws(() => article('title,'), /defaultOrder/);
  });

  it('a value that is not a non-empty string', () => {
    assert.throws(() => article(''), TypeError);
    assert.throws(() => article(['title']), TypeError);
  });
});

describe('defaultOrder — never raw SQL at runtime', () => {
  it('a config written by hand, past defineTable, fails the search instead of running the token', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const dbTables = { article: { primary: 'id', schema: articleSchema, defaultOrder: 'created_at DESC' } };
    await assert.rejects(
      () => searchEngine(dbTables, { db: new QueryClient(mockPg), tableConf: dbTables.article }),
      /defaultOrder.*'created_at'/s
    );
    assert.equal(mockPg.calls.length, 0);
  });
});
