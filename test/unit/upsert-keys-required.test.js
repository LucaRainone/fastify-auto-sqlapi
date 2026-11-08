// Every upserted record must carry its key, checked on the record as it reaches the database —
// after hooks, tenant injection and the FK auto-fill of secondaries (ADR 0021):
// - a natural key: every field present and not null (a NULL never conflicts);
// - the primary key: absent altogether is a plain insert with a generated key, present only in
//   part or null is an error;
// - two records of one request with the same key are an error.
// All of it is a 400 before any SQL runs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockPg, createMockSchema, insertedRows } from './_harness.js';

const { bulkUpsertEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-upsert.js'));
const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import(path.join(ROOT, 'dist/index.js'));

const tagSchema = createMockSchema('tag', {
  id: Type.Optional(Type.Integer()),
  code: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
});
const contentSchema = createMockSchema('content', {
  id: Type.Optional(Type.Integer()),
  priority: Type.Optional(Type.Integer()),
});
const contentInfoSchema = createMockSchema('content_info', {
  contentId: Type.Optional(Type.Integer()),
  langId: Type.Optional(Type.Integer()),
  title: Type.Optional(Type.String()),
});

function tagTable(keys) {
  return {
    primary: 'id',
    ...exportTableInfo(tagSchema),
    defaultOrder: 'id',
    upsertMap: new Map([[tagSchema, keys]]),
  };
}

const contentTables = {
  content: {
    primary: 'id',
    ...exportTableInfo(contentSchema),
    defaultOrder: 'id',
    allowedWriteJoins: [
      buildRelation(contentSchema, 'id', contentInfoSchema, 'contentId', { alias: 'info' }),
    ],
    upsertMap: new Map([
      [contentSchema, ['id']],
      [contentInfoSchema, ['contentId', 'langId']],
    ]),
  },
};

/** Answers every INSERT with one sequential id per row. */
function createDb() {
  let nextId = 1;
  const mockPg = createMockPg((call) => {
    const rows = insertedRows(call).map((r) => ({ id: r.id ?? nextId++ }));
    return { rows, affectedRows: rows.length };
  });
  return { mockPg, db: new QueryClient(mockPg) };
}

function bulk(db, tableConf, items, dbTables = {}) {
  return bulkUpsertEngine({ db, tableConf, dbTables, request: {}, items });
}

const is400 = (pattern) => (err) => err.statusCode === 400 && pattern.test(err.message);

describe('upsert by a natural key - the key is required', () => {
  it('rejects a bulk item without the key, before any SQL', async () => {
    const { mockPg, db } = createDb();

    await assert.rejects(
      bulk(db, tagTable(['code']), [{ main: { code: 'a', label: 'A' } }, { main: { label: 'B' } }]),
      is400(/"tag".*\(code\).*index 1.*code/),
    );
    assert.equal(mockPg.calls.length, 0);
  });

  it('rejects a bulk item whose key is null', async () => {
    const { db } = createDb();

    await assert.rejects(
      bulk(db, tagTable(['code']), [{ main: { code: null, label: 'A' } }]),
      is400(/index 0.*code/),
    );
  });

  it('rejects a single insert without the key', async () => {
    const { mockPg, db } = createDb();

    await assert.rejects(
      insertEngine({ db, tableConf: tagTable(['code']), dbTables: {}, request: {}, record: { label: 'A' } }),
      is400(/"tag".*code/),
    );
    assert.equal(mockPg.calls.length, 0);
  });

  it('rejects two items with the same key, naming both', async () => {
    const { mockPg, db } = createDb();

    await assert.rejects(
      bulk(db, tagTable(['code']), [
        { main: { code: 'a', label: 'A' } },
        { main: { code: 'b', label: 'B' } },
        { main: { code: 'a', label: 'A2' } },
      ]),
      is400(/index 0 and 2/),
    );
    assert.equal(mockPg.calls.length, 0);
  });
});

describe('upsert by the primary key', () => {
  it('inserts an item without any PK field, with a generated key', async () => {
    const { db } = createDb();

    const results = await bulk(db, tagTable(['id']), [
      { main: { id: 7, code: 'a' } },
      { main: { code: 'b' } },
    ]);

    assert.equal(results.length, 2);
  });

  it('rejects two items with the same primary key', async () => {
    const { db } = createDb();

    await assert.rejects(
      bulk(db, tagTable(['id']), [{ main: { id: 7, code: 'a' } }, { main: { id: 7, code: 'b' } }]),
      is400(/index 0 and 1/),
    );
  });

  it('rejects a secondary whose composite PK is present only in part', async () => {
    const { mockPg, db } = createDb();

    await assert.rejects(
      insertEngine({
        db, tableConf: contentTables.content, dbTables: contentTables, request: {},
        record: { id: 99 },
        secondaries: { info: [{ langId: 1, title: 'it' }, { title: 'no lang' }] },
      }),
      is400(/"content_info".*\(contentId, langId\).*index 1.*langId/),
    );
    // The main row was written before the secondaries were checked, in the same transaction
    assert.ok(mockPg.calls.every((c) => !c.text.includes('"content_info"')));
  });

  it('accepts secondaries keyed by the FK auto-filled from the main row', async () => {
    const { mockPg, db } = createDb();

    await insertEngine({
      db, tableConf: contentTables.content, dbTables: contentTables, request: {},
      record: { id: 99 },
      secondaries: { info: [{ langId: 1, title: 'it' }, { langId: 2, title: 'en' }] },
    });

    const infoRows = mockPg.calls
      .filter((c) => c.text.startsWith('INSERT INTO "content_info"'))
      .flatMap(insertedRows);
    assert.deepEqual(infoRows.map((r) => [r.content_id, r.lang_id]), [[99, 1], [99, 2]]);
  });

  it('rejects two secondaries of one main row with the same key', async () => {
    const { db } = createDb();

    await assert.rejects(
      insertEngine({
        db, tableConf: contentTables.content, dbTables: contentTables, request: {},
        record: { id: 99 },
        secondaries: { info: [{ langId: 1, title: 'a' }, { langId: 1, title: 'b' }] },
      }),
      is400(/"content_info".*index 0 and 1/),
    );
  });
});
