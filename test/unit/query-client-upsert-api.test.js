// The QueryClient has one method per upsert, named as the route is: `upsert` and `bulkUpsert`,
// both answering what they did to each row (`{ pk, action }`), the bulk options in an object.
// The pre-1.0 `insertOrUpdate`, `bulkInsertOrUpdate` and their `*WithAction` twins are gone.
// And `sqlApi` named with a table it does not know is the caller's bug, not a client's 400.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockPg, createMockSchema } from './_harness.js';

const { QueryClient, createSqlApi, defineTable, Type } = await import(path.join(ROOT, 'dist/index.js'));

/** pg mock answering an upsert's RETURNING: one row per VALUES tuple, all inserted. */
function pgUpsertMock() {
  let id = 0;
  return createMockPg((call) => {
    const values = call.text.split('VALUES')[1]?.split('ON CONFLICT')[0] ?? '';
    const tuples = (values.match(/\)\s*,\s*\(/g)?.length ?? 0) + 1;
    return { rows: Array.from({ length: tuples }, () => ({ id: ++id, __inserted: true })), affectedRows: tuples };
  });
}

describe('QueryClient upsert methods', () => {
  it('upsert answers { pk, action }', async () => {
    const mock = pgUpsertMock();
    const written = await new QueryClient(mock).upsert('tag', { code: 'a', label: 'A' }, ['code'], 'id');
    assert.deepEqual(written, { pk: { id: 1 }, action: 'inserted' });
    assert.match(mock.calls[0].text, /ON CONFLICT \("code"\)/);
  });

  it('bulkUpsert answers { pk, action } per record, in input order', async () => {
    const mock = pgUpsertMock();
    const written = await new QueryClient(mock).bulkUpsert(
      'tag', [{ code: 'a', label: 'A' }, { code: 'b', label: 'B' }], ['code'], 'id'
    );
    assert.deepEqual(written, [{ pk: { id: 1 }, action: 'inserted' }, { pk: { id: 2 }, action: 'inserted' }]);
  });

  it('bulkUpsert takes chunkSize and immutableCols in an options object', async () => {
    const mock = pgUpsertMock();
    await new QueryClient(mock).bulkUpsert(
      'tag',
      [{ code: 'a', label: 'A', org_id: 1 }, { code: 'b', label: 'B', org_id: 1 }],
      ['code'], 'id',
      { chunkSize: 1, immutableCols: ['org_id'] }
    );
    assert.equal(mock.calls.length, 2, 'chunkSize 1 → one statement per record');
    for (const { text } of mock.calls) {
      const updateSet = text.split('DO UPDATE SET')[1] ?? '';
      assert.match(updateSet, /"label"/);
      assert.doesNotMatch(updateSet, /"org_id"/, 'an immutable column is never in the update set');
    }
  });

  it('a positional chunkSize is refused, pointing at the options object', async () => {
    await assert.rejects(
      () => new QueryClient(pgUpsertMock()).bulkUpsert('tag', [{ code: 'a' }], ['code'], 'id', 500),
      (err) => err instanceof TypeError && /options.*chunkSize/s.test(err.message)
    );
  });

  it('a positional immutableCols after it is refused, not dropped', async () => {
    await assert.rejects(
      () => new QueryClient(pgUpsertMock()).bulkUpsert('tag', [{ code: 'a' }], ['code'], 'id', undefined, ['org_id']),
      (err) => err instanceof TypeError && /options.*immutableCols/s.test(err.message)
    );
  });

  it('the pre-1.0 names are gone', () => {
    for (const name of ['insertOrUpdate', 'insertOrUpdateWithAction', 'bulkInsertOrUpdate', 'bulkInsertOrUpdateWithAction']) {
      assert.equal(name in QueryClient.prototype, false, name);
    }
  });
});

describe('sqlApi with a table it does not know', () => {
  it('is a programming error naming the known tables, not a 400', async () => {
    const dbTables = {
      customer: defineTable({ primary: 'id', schema: createMockSchema('customer', { id: Type.Number() }) }),
    };
    const sqlApi = createSqlApi(createMockPg([]), dbTables, { dialect: 'postgres' });
    await assert.rejects(
      () => sqlApi.search('custmer', {}),
      (err) => err.statusCode === undefined && /'custmer'.*customer/s.test(err.message)
    );
  });
});
