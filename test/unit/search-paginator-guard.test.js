import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { SearchTableBodyPost, SearchTableQuery } = await import(path.join(ROOT, 'dist/lib/schema/search.js'));
const { MAX_CONDITIONS, MAX_ORDER_BY_LENGTH } = await import(path.join(ROOT, 'dist/lib/condition-methods.js'));
const { Type } = await import('@sinclair/typebox');

const schema = createMockSchema('customer', { id: Type.Number(), name: Type.String() });
const tableConf = { primary: 'id', ...exportTableInfo(schema), defaultOrder: 'id' };
const dbTables = { customer: tableConf };

/**
 * `paginator` reaches LIMIT/OFFSET as raw SQL text, and `Paginator` is only a TypeScript type:
 * `fastify.sqlApi.search()` is a documented public API, so a consumer forwarding an unvalidated
 * `request.query` must not be able to inject. Types never replace a runtime check.
 */
describe('searchEngine — paginator is validated at runtime', () => {
  const bad = [
    ['a SQL fragment as itemsPerPage', { page: 1, itemsPerPage: '10; DROP TABLE customer --' }],
    ['a SQL fragment as page', { page: '1 UNION SELECT 1', itemsPerPage: 10 }],
    ['a numeric string as itemsPerPage', { page: 1, itemsPerPage: '10' }],
    ['a fractional itemsPerPage', { page: 1, itemsPerPage: 10.5 }],
    ['a zero itemsPerPage', { page: 1, itemsPerPage: 0 }],
    ['a negative itemsPerPage', { page: 1, itemsPerPage: -5 }],
    ['a zero page', { page: 0, itemsPerPage: 10 }],
    ['a negative page', { page: -1, itemsPerPage: 10 }],
    ['a NaN page', { page: NaN, itemsPerPage: 10 }],
    ['a missing itemsPerPage', { page: 1 }],
    ['a null itemsPerPage', { page: 1, itemsPerPage: null }],
  ];

  for (const [label, paginator] of bad) {
    it(`rejects ${label} with 400`, async () => {
      const mockPg = createMockPg([{ rows: [] }, { rows: [{ total: '0' }] }]);
      await assert.rejects(
        () => searchEngine(dbTables, { db: new QueryClient(mockPg), tableConf, paginator }),
        (err) => err.statusCode === 400,
        `${label} must be refused before it reaches the LIMIT clause`
      );
      assert.equal(mockPg.calls.length, 0, 'no query may run for an invalid paginator');
    });
  }

  it('accepts a well-formed paginator', async () => {
    const mockPg = createMockPg([{ rows: [] }, { rows: [{ total: '0' }] }]);
    await searchEngine(dbTables, {
      db: new QueryClient(mockPg),
      tableConf,
      paginator: { page: 2, itemsPerPage: 20 },
    });
    assert.ok(mockPg.calls[0].text.includes('LIMIT 20 OFFSET 20'), mockPg.calls[0].text);
  });
});

/**
 * Each dotted condition and each 3-part orderBy token becomes one correlated subquery, so an
 * uncapped list maps N request tokens onto N subqueries. `maxItemsPerPage` bounds the rows
 * returned, not the work done to find them.
 */
describe('searchEngine — request complexity is bounded', () => {
  it('rejects a conditions array beyond the cap', async () => {
    const mockPg = createMockPg([{ rows: [] }]);
    const conditions = Array.from({ length: 300 }, () => ({
      field: 'id', method: 'isEqual', params: [1],
    }));

    await assert.rejects(
      () => searchEngine(dbTables, { db: new QueryClient(mockPg), tableConf, conditions }),
      (err) => err.statusCode === 400
    );
  });

  it('rejects an orderBy with more tokens than the cap', async () => {
    const mockPg = createMockPg([{ rows: [] }]);
    const orderBy = Array.from({ length: 60 }, () => 'id').join(',');

    await assert.rejects(
      () => searchEngine(dbTables, { db: new QueryClient(mockPg), tableConf, orderBy }),
      (err) => err.statusCode === 400
    );
  });

  it('accepts a conditions array within the cap', async () => {
    const mockPg = createMockPg([{ rows: [] }]);
    const conditions = Array.from({ length: 10 }, () => ({
      field: 'id', method: 'isEqual', params: [1],
    }));
    await searchEngine(dbTables, { db: new QueryClient(mockPg), tableConf, conditions });
    assert.equal(mockPg.calls.length, 1);
  });

  it('accepts a short orderBy', async () => {
    const mockPg = createMockPg([{ rows: [] }]);
    await searchEngine(dbTables, { db: new QueryClient(mockPg), tableConf, orderBy: 'id DESC,name' });
    assert.equal(mockPg.calls.length, 1);
  });
});

/**
 * The engine backstop covers programmatic callers; the request schema has to carry the same
 * caps so an HTTP client gets a validation error naming the offending field instead of a
 * generic engine 400.
 */
describe('search request schema declares the complexity caps', () => {
  it('exports both caps as numbers', () => {
    assert.equal(typeof MAX_CONDITIONS, 'number');
    assert.equal(typeof MAX_ORDER_BY_LENGTH, 'number');
  });

  it('caps the top-level conditions array', () => {
    const body = SearchTableBodyPost(dbTables, 'customer');
    assert.equal(body.properties.conditions.maxItems, MAX_CONDITIONS);
  });

  it('caps the conditions array of every join section', () => {
    const body = SearchTableBodyPost(dbTables, 'customer');
    for (const section of ['joinMustExist', 'joinMultiple', 'joinGroup']) {
      const entry = body.properties[section];
      if (!entry) continue;
      for (const alias of Object.values(entry.properties ?? {})) {
        assert.equal(alias.properties.conditions.maxItems, MAX_CONDITIONS, section);
      }
    }
  });

  it('caps the orderBy string', () => {
    const query = SearchTableQuery();
    assert.equal(query.properties.orderBy.maxLength, MAX_ORDER_BY_LENGTH);
  });
});

/**
 * `params` is optional in the request schema, so a condition that omits it is well-formed
 * input — it must be a 400, never an unhandled TypeError surfacing as 500.
 */
describe('searchEngine — condition params are validated, not assumed', () => {
  it('rejects a condition with no params instead of throwing a TypeError', async () => {
    const mockPg = createMockPg([{ rows: [] }]);
    await assert.rejects(
      () => searchEngine(dbTables, {
        db: new QueryClient(mockPg),
        tableConf,
        conditions: [{ field: 'id', method: 'isEqual' }],
      }),
      (err) => err.statusCode === 400,
      'a missing params must be a client error, not a 500'
    );
  });

  it('rejects isIn with a non-array params', async () => {
    const mockPg = createMockPg([{ rows: [] }]);
    await assert.rejects(
      () => searchEngine(dbTables, {
        db: new QueryClient(mockPg),
        tableConf,
        conditions: [{ field: 'id', method: 'isIn', params: 5 }],
      }),
      (err) => err.statusCode === 400
    );
  });

  it('rejects isBetween with too few params', async () => {
    const mockPg = createMockPg([{ rows: [] }]);
    await assert.rejects(
      () => searchEngine(dbTables, {
        db: new QueryClient(mockPg),
        tableConf,
        conditions: [{ field: 'id', method: 'isBetween', params: [1] }],
      }),
      (err) => err.statusCode === 400
    );
  });
});
