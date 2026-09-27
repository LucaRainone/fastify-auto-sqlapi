// `defineTable` refuses an `upsertMap` rule that is not a unique key the database enforces
// (ADR 0021): on PostgreSQL it would fail every write, on MySQL it would duplicate rows or
// update a row matched through another key — in silence. The check reads the Schema, so a
// child table written only through a write join needs no `defineTable` of its own.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { defineTable, exportTableInfo, buildRelation, buildUpsertRules, buildUpsertRule } =
  await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { Type } = await import('@sinclair/typebox');

/** A Schema as the CLI generates it: primaryKey and uniqueKeys introspected from the DB. */
function generatedSchema(tableName, fields, meta) {
  return { ...createMockSchema(tableName, fields), ...meta };
}

const tagSchema = generatedSchema(
  'tag',
  { id: Type.Integer(), code: Type.String(), tenantId: Type.Integer(), slug: Type.String(), label: Type.String() },
  { primaryKey: ['id'], uniqueKeys: [['code'], ['tenantId', 'slug']] },
);
const contentSchema = generatedSchema(
  'content', { id: Type.Integer(), priority: Type.Integer() }, { primaryKey: ['id'], uniqueKeys: [] },
);
const contentInfoSchema = generatedSchema(
  'content_info',
  { contentId: Type.Integer(), langId: Type.Integer(), title: Type.String() },
  { primaryKey: ['contentId', 'langId'], uniqueKeys: [] },
);

function tagTable(...rules) {
  return {
    primary: 'id',
    ...exportTableInfo(tagSchema),
    defaultOrder: 'id',
    upsertMap: buildUpsertRules(...rules.map((keys) => buildUpsertRule(tagSchema, keys))),
  };
}

describe('defineTable - upsertMap names a verified unique key', () => {
  it('accepts the primary key', () => {
    assert.doesNotThrow(() => defineTable(tagTable(['id'])));
  });

  it('accepts a unique key, in any field order', () => {
    assert.doesNotThrow(() => defineTable(tagTable(['code'])));
    assert.doesNotThrow(() => defineTable(tagTable(['slug', 'tenantId'])));
  });

  it('accepts a write-join child keyed on its composite primary key, with no defineTable of its own', () => {
    assert.doesNotThrow(() => defineTable({
      primary: 'id',
      ...exportTableInfo(contentSchema),
      defaultOrder: 'id',
      allowedWriteJoins: [
        buildRelation(contentSchema, 'id', contentInfoSchema, 'contentId', { alias: 'info' }),
      ],
      upsertMap: buildUpsertRules(buildUpsertRule(contentInfoSchema, ['contentId', 'langId'])),
    }));
  });

  it('rejects fields that are no unique key, naming the keys available', () => {
    assert.throws(
      () => defineTable(tagTable(['label'])),
      (err) => /upsertMap/.test(err.message)
        && /'tag'/.test(err.message)
        && /\(label\)/.test(err.message)
        && /\(id\)/.test(err.message)
        && /\(code\)/.test(err.message)
        && /\(tenantId, slug\)/.test(err.message),
    );
  });

  it('rejects a superset of a unique key', () => {
    assert.throws(() => defineTable(tagTable(['code', 'label'])), /upsertMap/);
  });

  it('rejects a subset of a composite unique key', () => {
    assert.throws(() => defineTable(tagTable(['tenantId'])), /upsertMap/);
  });

  it('rejects a natural key on a Schema generated before unique keys were known', () => {
    const legacy = generatedSchema('tag', tagSchema.fields, { primaryKey: ['id'] });
    assert.throws(
      () => defineTable({
        primary: 'id',
        ...exportTableInfo(legacy),
        defaultOrder: 'id',
        upsertMap: buildUpsertRules(buildUpsertRule(legacy, ['code'])),
      }),
      /regenerate/,
    );
  });

  it('still accepts the primary key on a Schema generated before unique keys were known', () => {
    const legacy = generatedSchema('tag', tagSchema.fields, { primaryKey: ['id'] });
    assert.doesNotThrow(() => defineTable({
      primary: 'id',
      ...exportTableInfo(legacy),
      defaultOrder: 'id',
      upsertMap: buildUpsertRules(buildUpsertRule(legacy, ['id'])),
    }));
  });

  it('rejects any rule on a hand-written Schema that declares no keys', () => {
    const handWritten = createMockSchema('tag', tagSchema.fields);
    assert.throws(
      () => defineTable({
        primary: 'id',
        ...exportTableInfo(handWritten),
        defaultOrder: 'id',
        upsertMap: buildUpsertRules(buildUpsertRule(handWritten, ['id'])),
      }),
      /regenerate/,
    );
  });

  it('rejects an upsert rule on a view', () => {
    const view = generatedSchema(
      'tag_view', { id: Type.Integer(), code: Type.String() }, { isView: true, uniqueKeys: [] },
    );
    assert.throws(
      () => defineTable({
        primary: 'id',
        ...exportTableInfo(view),
        defaultOrder: 'id',
        upsertMap: buildUpsertRules(buildUpsertRule(view, ['id'])),
      }),
      /view/,
    );
  });
});
