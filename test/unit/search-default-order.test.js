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


const articleFields = {
  id: Type.Number(),
  title: Type.String(),
  createdAt: Type.String(),
  squadIndex: Type.Number(),
};

function createDbTables(tableOverrides = {}) {
  const schema = createMockSchema('article', articleFields);
  return {
    article: {
      primary: 'id',
      ...exportTableInfo(schema),
      ...tableOverrides,
    },
  };
}

describe('searchEngine - defaultOrder camelCase mapping', () => {
  it('maps a camelCase defaultOrder field to its DB column', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const DbTables = createDbTables({ defaultOrder: 'squadIndex' });

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.article,
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('ORDER BY "squad_index"'), `expected mapped column in: ${sql}`);
  });

  it('maps multi-field defaultOrder with directions', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const DbTables = createDbTables({ defaultOrder: 'createdAt DESC, id ASC' });

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.article,
    });

    const sql = mockPg.calls[0].text;
    assert.ok(
      sql.includes('ORDER BY "created_at" DESC, "id" ASC'),
      `expected mapped multi-field order in: ${sql}`
    );
  });

  it('passes raw SQL fragments through unchanged (backward compatibility)', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const DbTables = createDbTables({ defaultOrder: 'created_at DESC' });

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.article,
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('ORDER BY created_at DESC'), `expected raw passthrough in: ${sql}`);
  });

  it('maps the camelCase primary-key fallback when defaultOrder is absent', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const schema = createMockSchema('squad_member', {
      squadIndex: Type.Number(),
      name: Type.String(),
    });
    const DbTables = {
      squad_member: {
        primary: 'squadIndex',
        ...exportTableInfo(schema),
      },
    };

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.squad_member,
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('ORDER BY "squad_index"'), `expected mapped PK fallback in: ${sql}`);
  });

  it('supports computed fields (without bound values) in defaultOrder', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const DbTables = createDbTables({
      defaultOrder: 'upperTitle DESC',
      computedFields: {
        upperTitle: ({ qiCol }) => ({
          expr: `UPPER(${qiCol('title')})`,
          values: [],
          type: Type.String(),
        }),
      },
    });

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.article,
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('ORDER BY UPPER("title") DESC'), `expected computed expr in: ${sql}`);
  });

  it('request orderBy still takes precedence over defaultOrder', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const DbTables = createDbTables({ defaultOrder: 'squadIndex' });

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.article,
      orderBy: 'title DESC',
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('ORDER BY "title" DESC'), `expected request orderBy in: ${sql}`);
    assert.ok(!sql.includes('squad_index'), 'defaultOrder must not leak into the query');
  });
});
