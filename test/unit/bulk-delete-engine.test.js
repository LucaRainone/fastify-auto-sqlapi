import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { bulkDeleteEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk-delete.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
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

function createMockPg(responses = []) {
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

const customerFields = {
  id: Type.Number(),
  name: Type.String(),
  email: Type.String(),
};

function createTestTableConf(mockPg) {
  const schema = createMockSchema('customer', customerFields);
  const info = exportTableInfo(schema);

  const tableConf = {
    primary: 'id',
    ...info,
    defaultOrder: 'id',
  };

  return { tableConf, db: new QueryClient(mockPg) };
}

describe('bulkDeleteEngine', () => {
  it('deletes multiple records and returns PK-only', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 2 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    const results = await bulkDeleteEngine({ db, tableConf, ids: [1, 3] });

    assert.equal(results.length, 2);
    assert.equal(results[0].main.id, 1);
    assert.equal(results[0].main.name, undefined);
    assert.equal(results[1].main.id, 3);
    assert.equal(mockPg.calls.length, 1);
    assert.ok(mockPg.calls[0].text.includes('DELETE FROM "customer"'));
    assert.ok(mockPg.calls[0].text.includes('IN ($1, $2)'));
    assert.deepEqual(mockPg.calls[0].values, [1, 3]);
  });

  it('returns PK-only results', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    const results = await bulkDeleteEngine({ db, tableConf, ids: [5] });

    assert.equal(results.length, 1);
    assert.equal(results[0].main.id, 5);
    // No other fields in response
    assert.equal(results[0].main.name, undefined);
  });

  it('returns empty array for empty ids', async () => {
    const mockPg = createMockPg([]);
    const { tableConf, db } = createTestTableConf(mockPg);

    const results = await bulkDeleteEngine({ db, tableConf, ids: [] });

    assert.equal(results.length, 0);
    assert.equal(mockPg.calls.length, 0);
  });

  it('uses correct PK column from tableConf.primary', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { tableConf, db } = createTestTableConf(mockPg);

    await bulkDeleteEngine({ db, tableConf, ids: [42] });

    assert.ok(mockPg.calls[0].text.includes('"id" IN'));
  });
});
