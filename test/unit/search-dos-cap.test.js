import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { getDialect } = await import(path.join(ROOT, 'dist/lib/dialect.js'));
const { Type } = await import('@sinclair/typebox');

const DIALECTS = ['postgres', 'mysql'];

function createMockSchema(tableName, fields) {
  return { col: (f) => toUnderscore(f), fields, validation: Type.Object(fields), tableName, partialValidation: Type.Object(fields) };
}


const schema = createMockSchema('customer', { id: Type.Number(), name: Type.String() });
const tableConf = { primary: 'id', ...exportTableInfo(schema), defaultOrder: 'id' };
const dbTables = { customer: tableConf };

for (const dialect of DIALECTS) {
  const client = (mockPg) => new QueryClient(mockPg, getDialect(dialect));

  describe(`searchEngine — no-paginator row cap (maxRows) [${dialect}]`, () => {
    it('applies LIMIT <maxRows> when no paginator is supplied', async () => {
      const mockPg = createMockPg([{ rows: [] }]);
      await searchEngine(dbTables, { db: client(mockPg), tableConf, maxRows: 50 });
      assert.ok(mockPg.calls[0].text.includes('LIMIT 50'), mockPg.calls[0].text);
    });

    it('does NOT cap when no maxRows is supplied (programmatic callers stay unbounded)', async () => {
      const mockPg = createMockPg([{ rows: [] }]);
      await searchEngine(dbTables, { db: client(mockPg), tableConf });
      assert.ok(!mockPg.calls[0].text.includes('LIMIT'), mockPg.calls[0].text);
    });

    it('a paginator governs the LIMIT and maxRows is ignored', async () => {
      const mockPg = createMockPg([{ rows: [] }, { rows: [{ total: '0' }] }]);
      await searchEngine(dbTables, { db: client(mockPg), tableConf, maxRows: 50, paginator: { page: 1, itemsPerPage: 20 } });
      assert.ok(mockPg.calls[0].text.includes('LIMIT 20'), mockPg.calls[0].text);
      assert.ok(!mockPg.calls[0].text.includes('LIMIT 50'));
    });
  });
}
