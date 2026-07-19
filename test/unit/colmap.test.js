import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { updateEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/update.js'));
const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { snakecaseRecord, camelcaseObject } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import('@sinclair/typebox');

// Schema with camelCase DB columns (like betterauth generates)
function createCamelCaseSchema(tableName, fields, colMap) {
  return {
    col: (f) => colMap[f] ?? f,
    colMap,
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}


const mockRequest = {};

// betterauth-style table: DB columns ARE camelCase
const userFields = {
  id: Type.String(),
  email: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
};

// colMap: field → actual DB column name (camelCase, NOT snake_case)
const userColMap = {
  id: 'id',
  email: 'email',
  createdAt: 'createdAt',      // DB column IS camelCase
  updatedAt: 'updatedAt',      // DB column IS camelCase
};

function createTestDbTables(mockPg) {
  const schema = createCamelCaseSchema('user', userFields, userColMap);
  const info = exportTableInfo(schema);

  const DbTables = {
    user: {
      primary: 'id',
      ...info,
      defaultOrder: 'id',
    },
  };

  return { DbTables, db: new QueryClient(mockPg), schema };
}

describe('colMap - snakecaseRecord with camelCase DB columns', () => {
  it('preserves camelCase column names when colMap is present', () => {
    const schema = createCamelCaseSchema('user', userFields, userColMap);
    const result = snakecaseRecord({ createdAt: '2024-01-01', email: 'test@test.it' }, schema);

    // Should NOT convert to created_at — the DB column IS createdAt
    assert.equal(result.createdAt, '2024-01-01');
    assert.equal(result.created_at, undefined);
    assert.equal(result.email, 'test@test.it');
  });

  it('falls back to toUnderscore without colMap', () => {
    const result = snakecaseRecord({ createdAt: '2024-01-01' });

    // Without colMap, traditional behavior
    assert.equal(result.created_at, '2024-01-01');
    assert.equal(result.createdAt, undefined);
  });
});

describe('colMap - camelcaseObject with camelCase DB columns', () => {
  it('maps camelCase DB columns back to field names', () => {
    const schema = createCamelCaseSchema('user', userFields, userColMap);
    const result = camelcaseObject({ createdAt: '2024-01-01', email: 'test@test.it' }, schema);

    // DB returns createdAt, field name is also createdAt — should stay
    assert.equal(result.createdAt, '2024-01-01');
    assert.equal(result.email, 'test@test.it');
  });

  it('falls back to toCamelCase without colMap', () => {
    const result = camelcaseObject({ created_at: '2024-01-01' });

    assert.equal(result.createdAt, '2024-01-01');
  });
});

describe('colMap - col() function', () => {
  it('returns actual DB column name for camelCase columns', () => {
    const schema = createCamelCaseSchema('user', userFields, userColMap);

    assert.equal(schema.col('createdAt'), 'createdAt');
    assert.equal(schema.col('updatedAt'), 'updatedAt');
    assert.equal(schema.col('id'), 'id');
  });
});

describe('colMap - insertEngine with camelCase DB columns', () => {
  it('sends camelCase column names to DB', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 'abc-123' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await insertEngine({
      db,
      tableConf: DbTables.user,
      dbTables: DbTables,
      request: mockRequest,
      record: { email: 'test@test.it', createdAt: '2024-01-01' },
    });

    const sql = mockPg.calls[0].text;
    // Should use createdAt, NOT created_at
    assert.ok(sql.includes('"createdAt"'), `SQL should contain "createdAt" but got: ${sql}`);
    assert.ok(!sql.includes('"created_at"'), `SQL should NOT contain "created_at" but got: ${sql}`);
  });
});

describe('colMap - updateEngine with camelCase DB columns', () => {
  it('sends camelCase column names in UPDATE', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await updateEngine({
      db,
      tableConf: DbTables.user,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 'abc-123', updatedAt: '2024-06-01' },
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('"updatedAt"'), `SQL should contain "updatedAt" but got: ${sql}`);
    assert.ok(!sql.includes('"updated_at"'), `SQL should NOT contain "updated_at" but got: ${sql}`);
  });
});
