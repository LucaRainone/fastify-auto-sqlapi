import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { getEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/get.js'));
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
  createdAt: Type.String(),
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

describe('getEngine', () => {
  it('fetches record by PK and returns camelCase result', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], affectedRows: 1 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    const result = await getEngine({ db, tableConf, id: '1' });

    assert.equal(result.main.id, 1);
    assert.equal(result.main.name, 'Mario');
    assert.equal(result.main.createdAt, '2024-01-01');
    assert.equal(result.main.created_at, undefined);
  });

  it('builds correct SELECT with PK WHERE and LIMIT 1', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 42, name: 'Luigi', email: 'luigi@test.it', created_at: '2024-02-01' }], affectedRows: 1 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    await getEngine({ db, tableConf, id: '42' });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('SELECT'));
    assert.ok(sql.includes('"customer"'));
    assert.ok(sql.includes('"id" = $1'));
    assert.ok(sql.includes('LIMIT 1'));
    assert.deepEqual(mockPg.calls[0].values, ['42']);
  });

  it('throws 404 when record not found', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    await assert.rejects(
      () => getEngine({ db, tableConf, id: '999' }),
      (err) => err.statusCode === 404
    );
  });

  it('executes exactly one query', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it', created_at: '2024-01-01' }], affectedRows: 1 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    await getEngine({ db, tableConf, id: '1' });

    assert.equal(mockPg.calls.length, 1);
  });
});
