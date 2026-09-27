// MySQL and MariaDB upsert by key explicitly (ADR 0021): `ON DUPLICATE KEY UPDATE` has no
// conflict target — it fires on ANY unique index, so a row could be updated through a key the
// caller never named. Per chunk: probe which keys exist, insert the rest, update the found rows
// by their key. PostgreSQL keeps `ON CONFLICT (key)`, which targets exactly the key.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockPg, insertedRows, answerPkLookup } from './_harness.js';

const { QueryClient, createQueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));

const isProbe = (call) => call.text.startsWith('SELECT');
const isInsert = (call) => call.text.startsWith('INSERT');
const isUpdate = (call) => call.text.startsWith('UPDATE');

/**
 * mysql mock over a table of existing rows keyed by `code`: the probe finds them, an INSERT
 * gets `insertId`, an UPDATE matches as many rows as it names.
 */
function mysqlTable(existing, { insertId = 100, updateMatches } = {}) {
  return createMockPg((call) => {
    if (isProbe(call)) return answerPkLookup(call, (k) => existing[k.code]);
    if (isInsert(call)) return { rows: [], affectedRows: insertedRows(call).length, insertId };
    const matched = updateMatches ?? (call.values.filter((v) => v in existing).length / 2);
    return { rows: [], affectedRows: matched };
  });
}

function upsert(mock, records, opts = {}) {
  return createQueryClient(mock, opts.dialect ?? 'mysql').bulkInsertOrUpdate(
    'tag', records, ['code'], 'id', undefined, opts.immutable ?? []
  );
}

describe('mysql upsert by key', () => {
  it('never uses ON DUPLICATE KEY', async () => {
    const mock = mysqlTable({ b: { id: 2 } });

    await upsert(mock, [{ code: 'a', label: 'A' }, { code: 'b', label: 'B' }]);

    assert.ok(mock.calls.every((c) => !c.text.includes('ON DUPLICATE KEY')), mock.calls.map((c) => c.text).join('\n'));
  });

  it('inserts the rows its key does not find and updates the others, PKs in input order', async () => {
    const mock = mysqlTable({ b: { id: 2 } });

    const result = await upsert(mock, [
      { code: 'a', label: 'A' }, { code: 'b', label: 'B' }, { code: 'c', label: 'C' },
    ]);

    assert.deepEqual(result, [{ id: 100 }, { id: 2 }, { id: 101 }]);
    assert.deepEqual(mock.calls.filter(isInsert).flatMap(insertedRows), [
      { code: 'a', label: 'A' }, { code: 'c', label: 'C' },
    ]);
    assert.equal(mock.calls.filter(isUpdate).length, 1);
  });

  it('updates a found row by its key, never through another column', async () => {
    const mock = mysqlTable({ b: { id: 2 } });

    await upsert(mock, [{ code: 'b', label: 'B2' }]);

    const update = mock.calls.find(isUpdate);
    assert.match(update.text, /WHERE \(`code` = \?\)$/);
    assert.ok(update.text.includes('`label` = CASE WHEN (`code` = ?) THEN ? END'), update.text);
    assert.deepEqual(update.values, ['b', 'B2', 'b']);
  });

  it('runs one probe, one insert and one update per chunk', async () => {
    const mock = mysqlTable({ b: { id: 2 }, d: { id: 4 } });

    await upsert(mock, [
      { code: 'a', label: 'A' }, { code: 'b', label: 'B' },
      { code: 'c', label: 'C' }, { code: 'd', label: 'D' },
    ]);

    assert.deepEqual(mock.calls.map((c) => c.text.split(' ')[0]), ['SELECT', 'INSERT', 'UPDATE']);
  });

  it('leaves an existing row alone when the record carries only its key', async () => {
    const mock = mysqlTable({ b: { id: 2 } });

    const result = await upsert(mock, [{ code: 'b' }]);

    assert.deepEqual(result, [{ id: 2 }]);
    assert.equal(mock.calls.filter((c) => isInsert(c) || isUpdate(c)).length, 0);
  });

  it('never updates an immutable column of an existing row', async () => {
    const mock = mysqlTable({ b: { id: 2 } });

    await upsert(mock, [{ code: 'b', label: 'B', organization_id: 7 }], { immutable: ['organization_id'] });

    assert.ok(!mock.calls.find(isUpdate).text.includes('organization_id'));
  });

  it('does not probe records that lack the key: they can only be inserted', async () => {
    const mock = mysqlTable({});

    const result = await createQueryClient(mock, 'mysql')
      .bulkInsertOrUpdate('tag', [{ label: 'A' }, { label: 'B' }], ['id'], 'id');

    assert.deepEqual(result, [{ id: 100 }, { id: 101 }]);
    assert.deepEqual(mock.calls.map((c) => c.text.split(' ')[0]), ['INSERT']);
  });

  it('refuses the chunk, before writing, when a key matches several rows', async () => {
    const mock = createMockPg((call) => {
      if (!isProbe(call)) return { rows: [], affectedRows: 1, insertId: 1 };
      const [row] = answerPkLookup(call, () => ({ id: 1 })).rows;
      return { rows: [row, { ...row, id: 2 }], affectedRows: 2 };
    });

    await assert.rejects(upsert(mock, [{ code: 'a', label: 'A' }]), /several rows.*not unique/);
    assert.equal(mock.calls.length, 1);
  });

  it('fails when a row it read is gone by the time it updates it', async () => {
    const mock = mysqlTable({ b: { id: 2 } }, { updateMatches: 0 });

    await assert.rejects(upsert(mock, [{ code: 'b', label: 'B' }]), /"tag".*not found/);
  });

  it('mariadb upserts by key too, taking inserted PKs from RETURNING', async () => {
    const mock = createMockPg((call) => {
      if (isProbe(call)) return answerPkLookup(call, (k) => ({ b: { id: 2 } })[k.code]);
      if (isInsert(call)) return { rows: [{ id: 30 }], affectedRows: 1 };
      return { rows: [], affectedRows: 1 };
    });

    const result = await upsert(mock, [{ code: 'a', label: 'A' }, { code: 'b', label: 'B' }], { dialect: 'mariadb' });

    assert.deepEqual(result, [{ id: 30 }, { id: 2 }]);
    assert.ok(mock.calls.every((c) => !c.text.includes('ON DUPLICATE KEY')));
  });
});

describe('postgres upsert keeps ON CONFLICT (key)', () => {
  it('runs one statement per chunk, targeting exactly the key', async () => {
    const mock = createMockPg((call) => ({ rows: insertedRows(call).map((_, i) => ({ id: i + 1 })), affectedRows: 2 }));

    await new QueryClient(mock).bulkInsertOrUpdate(
      'tag', [{ code: 'a', label: 'A' }, { code: 'b', label: 'B' }], ['code'], 'id'
    );

    assert.equal(mock.calls.length, 1);
    assert.ok(mock.calls[0].text.includes('ON CONFLICT ("code") DO UPDATE SET "label" = EXCLUDED."label"'));
  });
});
