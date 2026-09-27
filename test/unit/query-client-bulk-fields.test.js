// A bulk write is N single writes issued efficiently (ADR 0003): each record writes exactly
// its own fields. A field a record omits must not be written for it — not dropped when only
// a later record has it, not bound as NULL when only an earlier record has it — so that an
// INSERT falls back to the column default and an upsert leaves the existing value untouched.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockPg, insertedRows, upsertUpdatedColumns } from './_harness.js';

const { QueryClient, createQueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));

/** Order-insensitive comparable form of a row: a record omitting a key differs from one holding undefined. */
const canon = (row) => JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]));

function allInsertedRows(calls) {
  return calls.flatMap(insertedRows);
}

function assertEachRecordWritesOwnFields(calls, records) {
  assert.deepEqual(
    allInsertedRows(calls).map(canon).sort(),
    records.map(canon).sort(),
  );
}

/** Postgres mock answering RETURNING with the `name` of each inserted row as its id. */
function namesAsIds() {
  return createMockPg((call) => {
    const rows = insertedRows(call).map((r) => ({ id: r.name }));
    return { rows, affectedRows: rows.length };
  });
}

describe('QueryClient.bulkInsert - records with different fields', () => {
  it('writes a field present only on a later record', async () => {
    const mock = namesAsIds();
    const records = [{ name: 'A' }, { name: 'B', email: 'b@test.it' }];

    await new QueryClient(mock).bulkInsert('customer', records, 'id');

    assertEachRecordWritesOwnFields(mock.calls, records);
  });

  it('does not write NULL into a field a later record omits', async () => {
    const mock = namesAsIds();
    const records = [{ name: 'A', email: 'a@test.it' }, { name: 'B' }];

    await new QueryClient(mock).bulkInsert('customer', records, 'id');

    assertEachRecordWritesOwnFields(mock.calls, records);
  });

  it('returns the PKs in input order when records have different fields', async () => {
    const mock = namesAsIds();
    const records = [
      { name: 'a' },
      { name: 'b', email: 'b@test.it' },
      { name: 'c' },
      { name: 'd', email: 'd@test.it' },
    ];

    const result = await new QueryClient(mock).bulkInsert('customer', records, 'id');

    assert.deepEqual(result.map((r) => r.id), ['a', 'b', 'c', 'd']);
  });

  it('writes records with the same fields in a different key order in one statement', async () => {
    const mock = namesAsIds();
    const records = [{ name: 'a', email: 'a@test.it' }, { email: 'b@test.it', name: 'b' }];

    const result = await new QueryClient(mock).bulkInsert('customer', records, 'id');

    assert.equal(mock.calls.length, 1);
    assertEachRecordWritesOwnFields(mock.calls, records);
    assert.deepEqual(result.map((r) => r.id), ['a', 'b']);
  });

  it('chunks each group of records sharing the same fields', async () => {
    const mock = namesAsIds();
    const records = [
      { name: 'a' }, { name: 'b', email: 'b@test.it' }, { name: 'c' },
      { name: 'd', email: 'd@test.it' }, { name: 'e' },
    ];

    const result = await new QueryClient(mock).bulkInsert('customer', records, 'id', 2);

    // 3 records with {name} → 2 chunks; 2 records with {name, email} → 1 chunk
    assert.equal(mock.calls.length, 3);
    assertEachRecordWritesOwnFields(mock.calls, records);
    assert.deepEqual(result.map((r) => r.id), ['a', 'b', 'c', 'd', 'e']);
  });

  it('synthesizes mysql PKs per statement, in input order', async () => {
    // No RETURNING on mysql: each statement's insertId is the first id of ITS rows.
    let nextInsertId = 100;
    const mock = createMockPg((call) => {
      const n = insertedRows(call).length;
      const insertId = nextInsertId;
      nextInsertId += 100;
      return { rows: [], affectedRows: n, insertId };
    });
    const records = [{ name: 'a' }, { name: 'b', email: 'b@test.it' }, { name: 'c' }];

    const result = await createQueryClient(mock, 'mysql').bulkInsert('customer', records, 'id');

    assertEachRecordWritesOwnFields(mock.calls, records);
    // {name} rows go first (ids 100, 101), then the {name, email} row (id 200)
    assert.deepEqual(result.map((r) => r.id), [100, 200, 101]);
  });
});

describe('QueryClient.bulkInsertOrUpdate - records with different fields', () => {
  it('writes a field present only on a later record', async () => {
    const mock = namesAsIds();
    const records = [{ id: 1, name: 'A' }, { id: 2, name: 'B', price: 20 }];

    await new QueryClient(mock).bulkInsertOrUpdate('product', records, ['id'], 'id');

    assertEachRecordWritesOwnFields(mock.calls, records);
  });

  it('leaves a column untouched on an existing row whose record omits it', async () => {
    const mock = namesAsIds();
    const records = [{ id: 1, name: 'A', price: 10 }, { id: 2, name: 'B' }];

    await new QueryClient(mock).bulkInsertOrUpdate('product', records, ['id'], 'id');

    assertEachRecordWritesOwnFields(mock.calls, records);
    const statementForB = mock.calls.find((c) => insertedRows(c).some((r) => r.id === 2));
    assert.deepEqual(upsertUpdatedColumns(statementForB), ['name']);
  });

  it('returns the PKs in input order when records have different fields', async () => {
    const mock = namesAsIds();
    const records = [
      { id: 1, name: 'a', price: 1 },
      { id: 2, name: 'b' },
      { id: 3, name: 'c', price: 3 },
    ];

    const result = await new QueryClient(mock).bulkInsertOrUpdate('product', records, ['id'], 'id');

    assert.deepEqual(result.map((r) => r.id), ['a', 'b', 'c']);
  });

  it('keeps immutable columns out of the update set of every statement', async () => {
    const mock = namesAsIds();
    const records = [
      { id: 1, name: 'a', organization_id: 7 },
      { id: 2, name: 'b', email: 'b@test.it', organization_id: 7 },
    ];

    await new QueryClient(mock).bulkInsertOrUpdate(
      'customer', records, ['id'], 'id', undefined, ['organization_id']
    );

    assert.equal(mock.calls.length, 2);
    for (const call of mock.calls) {
      assert.ok(!upsertUpdatedColumns(call).includes('organization_id'), call.text);
    }
  });
});

// An upsert record holding only its conflict keys has nothing to update: the statement leaves
// an existing row untouched (postgres `DO NOTHING`), and RETURNING yields no row for it. Its
// PK must still come back, in position — from the record when it holds the PK, otherwise
// looked up by the conflict keys.
describe('QueryClient upsert - records holding only the conflict keys', () => {
  /** Postgres mock: `DO NOTHING` returns no row (the existing row is left alone). */
  function doNothingSkipsExisting(lookup = () => ({ rows: [], affectedRows: 0 })) {
    return createMockPg((call) => {
      if (call.text.startsWith('SELECT')) return lookup(call);
      if (call.text.includes('DO NOTHING')) return { rows: [], affectedRows: 0 };
      const rows = insertedRows(call).map((r) => ({ id: r.id }));
      return { rows, affectedRows: rows.length };
    });
  }

  it('returns the PK of an untouched row from the record that holds it', async () => {
    const mock = doNothingSkipsExisting();
    const records = [{ id: 1, name: 'a' }, { id: 2 }, { id: 3, name: 'c' }];

    const result = await new QueryClient(mock).bulkInsertOrUpdate('product', records, ['id'], 'id');

    assert.deepEqual(result, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('looks up the PK of an untouched row when the conflict key is not the PK', async () => {
    const mock = doNothingSkipsExisting((call) => ({
      rows: [{ id: { 'x-code': 42, 'y-code': 43 }[call.values[0]] }],
      affectedRows: 1,
    }));
    const records = [{ code: 'x-code' }, { code: 'y-code' }];

    const result = await new QueryClient(mock).bulkInsertOrUpdate('tag', records, ['code'], 'id');

    assert.deepEqual(result, [{ id: 42 }, { id: 43 }]);
    const lookups = mock.calls.filter((c) => c.text.startsWith('SELECT'));
    assert.deepEqual(
      lookups.map((c) => [c.text, c.values]),
      [
        ['SELECT "id" FROM "tag" WHERE "code" = $1', ['x-code']],
        ['SELECT "id" FROM "tag" WHERE "code" = $1', ['y-code']],
      ],
    );
  });

  it('looks up every column of a composite PK by every conflict key', async () => {
    const mock = doNothingSkipsExisting(() => ({ rows: [{ a_id: 1, b_id: 2 }], affectedRows: 1 }));

    const result = await new QueryClient(mock).bulkInsertOrUpdate(
      'link', [{ code: 'k', lang: 'it' }], ['code', 'lang'], ['a_id', 'b_id']
    );

    assert.deepEqual(result, [{ a_id: 1, b_id: 2 }]);
    const lookup = mock.calls.find((c) => c.text.startsWith('SELECT'));
    assert.equal(lookup.text, 'SELECT "a_id", "b_id" FROM "link" WHERE "code" = $1 AND "lang" = $2');
    assert.deepEqual(lookup.values, ['k', 'it']);
  });

  it('treats a record holding only conflict keys and immutable columns as untouched', async () => {
    const mock = doNothingSkipsExisting();

    const result = await new QueryClient(mock).bulkInsertOrUpdate(
      'customer', [{ id: 7, organization_id: 3 }], ['id'], 'id', undefined, ['organization_id']
    );

    assert.deepEqual(result, [{ id: 7 }]);
  });

  it('single insertOrUpdate returns the PK of an untouched row', async () => {
    const mock = doNothingSkipsExisting();

    const result = await new QueryClient(mock).insertOrUpdate('product', { id: 5 }, ['id'], 'id');

    assert.deepEqual(result, { id: 5 });
  });

  it('looks up the PK on mysql too, where insertId says nothing about an untouched row', async () => {
    const mock = createMockPg((call) => (call.text.startsWith('SELECT')
      ? { rows: [{ id: 42 }], affectedRows: 1 }
      : { rows: [], affectedRows: 0, insertId: 0 }));

    const result = await createQueryClient(mock, 'mysql')
      .bulkInsertOrUpdate('tag', [{ code: 'x-code' }], ['code'], 'id');

    assert.deepEqual(result, [{ id: 42 }]);
  });
});
