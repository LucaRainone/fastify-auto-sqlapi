import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { deleteEngine } = await import(path.join(ROOT, 'dist/lib/engine/delete.js'));
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
  const customerSchema = createMockSchema('customer', customerFields);
  const customerInfo = exportTableInfo(customerSchema);

  const tableConf = {
    primary: 'id',
    ...customerInfo,
    defaultOrder: 'id',
  };

  return { tableConf, db: new QueryClient(mockPg) };
}

describe('deleteEngine', () => {
  it('deletes record by PK and returns PK-only', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    const result = await deleteEngine({ db, tableConf, id: '1' });

    assert.equal(result.main.id, '1');
    assert.equal(result.main.name, undefined);
    assert.ok(mockPg.calls[0].text.includes('DELETE FROM "customer"'));
    assert.ok(mockPg.calls[0].text.includes('WHERE'));
    assert.ok(!mockPg.calls[0].text.includes('RETURNING'));
  });

  it('uses correct PK column in WHERE', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    await deleteEngine({ db, tableConf, id: '42' });

    assert.ok(mockPg.calls[0].text.includes('"id"'));
    assert.deepEqual(mockPg.calls[0].values, ['42']);
  });

  it('throws 404 when record not found', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    await assert.rejects(
      () => deleteEngine({ db, tableConf, id: '999' }),
      (err) => err.statusCode === 404
    );
  });

  it('executes exactly one query', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    await deleteEngine({ db, tableConf, id: '1' });

    assert.equal(mockPg.calls.length, 1);
  });
});
