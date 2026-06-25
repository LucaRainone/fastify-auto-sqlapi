import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { updateEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/update.js'));
const { bulkUpsertEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-upsert.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { createQueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import('@sinclair/typebox');

const norm = (t) => t.replace(/\s+/g, ' ').trim();

function createMockSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}

// Mock pool that ONLY returns what RETURNING asks for (realistic), or insertId for mysql.
function createMockPool(responses = []) {
  let i = 0;
  const calls = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text: norm(text), values });
      const r = responses[i++] || { rows: [], affectedRows: 0 };
      return Promise.resolve(r);
    },
  };
}

const infoFields = {
  bikeTypeId: Type.Number(),
  langId: Type.Number(),
  name: Type.String(),
};

function createDbTables() {
  const schema = createMockSchema('bike_type_info', infoFields);
  return {
    bike_type_info: {
      primary: ['bikeTypeId', 'langId'],
      ...exportTableInfo(schema),
      defaultOrder: 'bikeTypeId',
    },
  };
}

const mockRequest = {};

describe('composite PK — insert response includes ALL pk fields', () => {
  it('postgres: RETURNING lists every pk column', async () => {
    // Realistic pg mock: returns exactly the RETURNING columns.
    const pool = createMockPool([
      { rows: [{ bike_type_id: 7, lang_id: 2 }], affectedRows: 1 },
    ]);
    const db = createQueryClient(pool, 'postgres');
    const DbTables = createDbTables();

    const result = await insertEngine({
      db,
      tableConf: DbTables.bike_type_info,
      dbTables: DbTables,
      request: mockRequest,
      record: { bikeTypeId: 7, langId: 2, name: 'Mountain' },
    });

    assert.ok(
      pool.calls[0].text.includes('RETURNING "bike_type_id", "lang_id"'),
      `RETURNING must list both pk columns, got: ${pool.calls[0].text}`
    );
    assert.equal(result.main.bikeTypeId, 7);
    assert.equal(result.main.langId, 2, 'langId must be present in the response');
  });

  it('mysql: synthesizes every pk field from the input record (no RETURNING)', async () => {
    const pool = createMockPool([
      { rows: [], affectedRows: 1, insertId: 0 }, // mysql INSERT result
    ]);
    const db = createQueryClient(pool, 'mysql');
    const DbTables = createDbTables();

    const result = await insertEngine({
      db,
      tableConf: DbTables.bike_type_info,
      dbTables: DbTables,
      request: mockRequest,
      record: { bikeTypeId: 7, langId: 2, name: 'Mountain' },
    });

    assert.ok(!pool.calls[0].text.includes('RETURNING'), 'mysql must not use RETURNING');
    assert.equal(result.main.bikeTypeId, 7);
    assert.equal(result.main.langId, 2, 'langId must be present in the response (the reported 500)');
  });
});

describe('composite PK — bulk upsert response includes ALL pk fields', () => {
  it('mysql: every item returns both pk fields', async () => {
    const pool = createMockPool([
      { rows: [], affectedRows: 1, insertId: 0 },
    ]);
    const db = createQueryClient(pool, 'mysql');
    const DbTables = createDbTables();

    const results = await bulkUpsertEngine({
      db,
      tableConf: DbTables.bike_type_info,
      dbTables: DbTables,
      request: mockRequest,
      items: [{ main: { bikeTypeId: 7, langId: 2, name: 'Mountain' } }],
    });

    assert.equal(results[0].main.bikeTypeId, 7);
    assert.equal(results[0].main.langId, 2);
  });
});

describe('composite PK — update matches on ALL pk columns', () => {
  it('builds a WHERE on every pk column, not just the first', async () => {
    const pool = createMockPool([
      { rows: [], affectedRows: 1 }, // UPDATE
    ]);
    const db = createQueryClient(pool, 'postgres');
    const DbTables = createDbTables();

    const result = await updateEngine({
      db,
      tableConf: DbTables.bike_type_info,
      dbTables: DbTables,
      request: mockRequest,
      record: { bikeTypeId: 7, langId: 2, name: 'Enduro' },
    });

    const sql = pool.calls[0].text;
    assert.ok(sql.includes('"bike_type_id"'), `WHERE must include bike_type_id, got: ${sql}`);
    assert.ok(
      sql.includes('"lang_id"'),
      `WHERE must include lang_id too (else it updates every language!), got: ${sql}`
    );
    // Response carries the full composite PK
    assert.equal(result.main.bikeTypeId, 7);
    assert.equal(result.main.langId, 2);
  });
});
