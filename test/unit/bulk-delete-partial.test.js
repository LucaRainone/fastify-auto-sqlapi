import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { bulkDeleteEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-delete.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { createQueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import('@sinclair/typebox');

function createMockSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}

function createMockPool(responses = []) {
  let callIndex = 0;
  const calls = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      const response = responses[callIndex] || { rows: [], affectedRows: 0 };
      callIndex++;
      return Promise.resolve(response);
    },
  };
}

function createTestTableConf() {
  const schema = createMockSchema('customer', {
    id: Type.Number(),
    name: Type.String(),
  });
  return {
    primary: 'id',
    ...exportTableInfo(schema),
    defaultOrder: 'id',
  };
}

describe('bulkDeleteEngine - partial delete returns the ACTUALLY deleted ids', () => {
  it('postgres: uses RETURNING and reports the real ids on partial delete', async () => {
    // Request [1,2,3,4] but only 1 and 3 exist: the engine must report [1,3], not [1,2].
    const pool = createMockPool([
      { rows: [{ id: 1 }, { id: 3 }], affectedRows: 2 },
    ]);
    const db = createQueryClient(pool, 'postgres');
    const tableConf = createTestTableConf();

    const results = await bulkDeleteEngine({ db, tableConf, ids: [1, 2, 3, 4] });

    assert.ok(pool.calls[0].text.includes('RETURNING "id"'), `expected RETURNING, got: ${pool.calls[0].text}`);
    assert.deepEqual(
      results.map((r) => r.main.id),
      [1, 3],
      'must report the ids that were actually deleted'
    );
  });

  it('postgres: full delete still returns all requested ids', async () => {
    const pool = createMockPool([
      { rows: [{ id: 1 }, { id: 2 }], affectedRows: 2 },
    ]);
    const db = createQueryClient(pool, 'postgres');
    const tableConf = createTestTableConf();

    const results = await bulkDeleteEngine({ db, tableConf, ids: [1, 2] });

    assert.deepEqual(results.map((r) => r.main.id), [1, 2]);
  });

  it('mysql: pre-selects existing pks (no RETURNING support) and reports the real ids', async () => {
    const pool = createMockPool([
      { rows: [{ pk: 1 }, { pk: 3 }], affectedRows: 2 }, // pre-delete SELECT
      { rows: [], affectedRows: 2 },                     // DELETE
    ]);
    const db = createQueryClient(pool, 'mysql');
    const tableConf = createTestTableConf();

    const results = await bulkDeleteEngine({ db, tableConf, ids: [1, 2, 3, 4] });

    assert.equal(pool.calls.length, 2);
    assert.ok(pool.calls[0].text.startsWith('SELECT'), `first query must be the pre-delete SELECT, got: ${pool.calls[0].text}`);
    assert.ok(pool.calls[1].text.startsWith('DELETE'), `second query must be the DELETE, got: ${pool.calls[1].text}`);
    assert.ok(!pool.calls[1].text.includes('RETURNING'), 'mysql DELETE must not use RETURNING');
    assert.deepEqual(results.map((r) => r.main.id), [1, 3]);
  });

  it('mysql: full delete returns all requested ids', async () => {
    const pool = createMockPool([
      { rows: [{ pk: 1 }, { pk: 2 }], affectedRows: 2 },
      { rows: [], affectedRows: 2 },
    ]);
    const db = createQueryClient(pool, 'mysql');
    const tableConf = createTestTableConf();

    const results = await bulkDeleteEngine({ db, tableConf, ids: [1, 2] });

    assert.deepEqual(results.map((r) => r.main.id), [1, 2]);
  });
});
