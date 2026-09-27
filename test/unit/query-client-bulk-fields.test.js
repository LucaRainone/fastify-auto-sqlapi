// A bulk write is N single writes issued efficiently (ADR 0003): each record writes exactly
// its own fields. A field a record omits must not be written for it — not dropped when only
// a later record has it, not bound as NULL when only an earlier record has it — so that an
// INSERT falls back to the column default and an upsert leaves the existing value untouched.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockPg, insertedRows, upsertUpdatedColumns, answerPkLookup } from './_harness.js';

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
    const ids = { 'x-code': 42, 'y-code': 43 };
    const mock = doNothingSkipsExisting((call) => answerPkLookup(call, (k) => ({ id: ids[k.code] })));
    const records = [{ code: 'x-code' }, { code: 'y-code' }];

    const result = await new QueryClient(mock).bulkInsertOrUpdate('tag', records, ['code'], 'id');

    assert.deepEqual(result, [{ id: 42 }, { id: 43 }]);
    const lookups = mock.calls.filter((c) => c.text.startsWith('SELECT'));
    assert.equal(lookups.length, 1);
    assert.ok(lookups[0].text.includes('"id" FROM "tag" WHERE "code" = $1'), lookups[0].text);
    assert.deepEqual(lookups[0].values, ['x-code', 'y-code']);
  });

  it('looks up every column of a composite PK by every conflict key', async () => {
    const mock = doNothingSkipsExisting((call) => answerPkLookup(call, (k) =>
      (k.code === 'k' && k.lang === 'it' ? { a_id: 1, b_id: 2 } : undefined)));

    const result = await new QueryClient(mock).bulkInsertOrUpdate(
      'link', [{ code: 'k', lang: 'it' }], ['code', 'lang'], ['a_id', 'b_id']
    );

    assert.deepEqual(result, [{ a_id: 1, b_id: 2 }]);
    const lookup = mock.calls.find((c) => c.text.startsWith('SELECT'));
    assert.ok(lookup.text.includes('"a_id", "b_id" FROM "link" WHERE "code" = $1 AND "lang" = $2'), lookup.text);
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
      ? answerPkLookup(call, () => ({ id: 42 }))
      : { rows: [], affectedRows: 0, insertId: 0 }));

    const result = await createQueryClient(mock, 'mysql')
      .bulkInsertOrUpdate('tag', [{ code: 'x-code' }], ['code'], 'id');

    assert.deepEqual(result, [{ id: 42 }]);
  });
});

// MySQL has no RETURNING: an upsert's PKs are synthesized from `insertId`, which counts only
// the rows the statement inserted. A row it updated through a conflict key that is not the PK
// has no PK in the record either, so it must be looked up — `insertId + n` names a row that
// may not even exist.
describe('QueryClient upsert on mysql - conflict key that is not the PK', () => {
  it('looks up the PK of a row updated through the conflict key', async () => {
    const ids = { new: 14, old: 13 };
    const mock = createMockPg((call) => (call.text.startsWith('SELECT')
      ? answerPkLookup(call, (k) => ({ id: ids[k.code] }))
      : { rows: [], affectedRows: 3, insertId: 14 }));
    const records = [{ code: 'new', label: 'New' }, { code: 'old', label: 'Renamed' }];

    const result = await createQueryClient(mock, 'mysql')
      .bulkInsertOrUpdate('tag', records, ['code'], 'id');

    assert.deepEqual(result, [{ id: 14 }, { id: 13 }]);
  });

  it('single insertOrUpdate looks up the PK of a row updated through the conflict key', async () => {
    const mock = createMockPg((call) => (call.text.startsWith('SELECT')
      ? answerPkLookup(call, () => ({ id: 13 }))
      : { rows: [], affectedRows: 2, insertId: 99 }));

    const result = await createQueryClient(mock, 'mysql')
      .insertOrUpdate('tag', { code: 'old', label: 'Renamed' }, ['code'], 'id');

    assert.deepEqual(result, { id: 13 });
  });

  it('takes the PK from the record when it holds it, without a lookup', async () => {
    const mock = createMockPg(() => ({ rows: [], affectedRows: 1, insertId: 0 }));

    const result = await createQueryClient(mock, 'mysql')
      .bulkInsertOrUpdate('tag', [{ id: 5, code: 'x', label: 'X' }], ['code'], 'id');

    assert.deepEqual(result, [{ id: 5 }]);
    assert.equal(mock.calls.filter((c) => c.text.startsWith('SELECT')).length, 0);
  });

  it('postgres needs no lookup: RETURNING yields updated rows too', async () => {
    const mock = createMockPg(() => ({ rows: [{ id: 14 }, { id: 13 }], affectedRows: 2 }));
    const records = [{ code: 'new', label: 'New' }, { code: 'old', label: 'Renamed' }];

    const result = await new QueryClient(mock).bulkInsertOrUpdate('tag', records, ['code'], 'id');

    assert.deepEqual(result, [{ id: 14 }, { id: 13 }]);
    assert.equal(mock.calls.length, 1);
  });
});

// A record missing a conflict key cannot conflict: it is a plain insert, and the statement
// result names its PK — `insertId` on mysql, RETURNING on postgres. There is nothing to look up.
describe('QueryClient upsert - records without the conflict keys', () => {
  it('mysql: takes the PKs of plain inserts from insertId', async () => {
    const mock = createMockPg(() => ({ rows: [], affectedRows: 2, insertId: 30 }));

    const result = await createQueryClient(mock, 'mysql')
      .bulkInsertOrUpdate('tag', [{ label: 'a' }, { label: 'b' }], ['id'], 'id');

    assert.deepEqual(result, [{ id: 30 }, { id: 31 }]);
    assert.equal(mock.calls.length, 1);
  });

  it('postgres: takes the PKs from RETURNING even when nothing would be updated', async () => {
    const mock = createMockPg(() => ({ rows: [{ id: 30 }], affectedRows: 1 }));

    const result = await new QueryClient(mock).bulkInsertOrUpdate(
      'customer', [{ organization_id: 3 }], ['id'], 'id', undefined, ['organization_id']
    );

    assert.deepEqual(result, [{ id: 30 }]);
    assert.equal(mock.calls.length, 1);
  });
});

describe('QueryClient upsert - PK lookup', () => {
  /** mysql mock: `insertId` names no updated row, so every natural-key record is looked up. */
  function mysqlWithLookup(resolve, { reverse = false } = {}) {
    return createMockPg((call) => {
      if (!call.text.startsWith('SELECT')) return { rows: [], affectedRows: 1, insertId: 0 };
      const response = answerPkLookup(call, resolve);
      if (reverse) response.rows.reverse();
      return response;
    });
  }
  const ids = { a: 1, b: 2, c: 3 };
  const records = [{ code: 'a', label: 'A' }, { code: 'b', label: 'B' }, { code: 'c', label: 'C' }];

  it('looks up every record of a chunk in one statement', async () => {
    const mock = mysqlWithLookup((k) => ({ id: ids[k.code] }));

    const result = await createQueryClient(mock, 'mysql')
      .bulkInsertOrUpdate('tag', records, ['code'], 'id', 2);

    assert.deepEqual(result, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    // 2 chunks → 2 upserts, each followed by one lookup
    assert.equal(mock.calls.filter((c) => c.text.startsWith('SELECT')).length, 2);
  });

  it('maps looked-up rows back by position, whatever order the database returns them in', async () => {
    const mock = mysqlWithLookup((k) => ({ id: ids[k.code] }), { reverse: true });

    const result = await createQueryClient(mock, 'mysql')
      .bulkInsertOrUpdate('tag', records, ['code'], 'id');

    assert.deepEqual(result, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('looks up only the records that do not carry their PK', async () => {
    const mock = mysqlWithLookup((k) => ({ id: ids[k.code] }));

    const result = await createQueryClient(mock, 'mysql').bulkInsertOrUpdate(
      'tag', [{ id: 9, code: 'z', label: 'Z' }, { code: 'b', label: 'B' }], ['code'], 'id'
    );

    assert.deepEqual(result, [{ id: 9 }, { id: 2 }]);
    const lookup = mock.calls.find((c) => c.text.startsWith('SELECT'));
    assert.deepEqual(lookup.values, ['b']);
  });

  it('fails naming the table when a looked-up row cannot be found', async () => {
    const mock = mysqlWithLookup(() => undefined);

    await assert.rejects(
      createQueryClient(mock, 'mysql').bulkInsertOrUpdate('tag', records, ['code'], 'id'),
      /Cannot resolve the primary key of an upserted "tag" row/,
    );
  });
});
