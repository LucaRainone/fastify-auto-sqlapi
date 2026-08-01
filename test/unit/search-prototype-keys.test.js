import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import('@sinclair/typebox');

const customerFields = { id: Type.Number(), name: Type.String() };
const orderFields = { id: Type.Number(), customerId: Type.Number(), total: Type.Number() };

function createTestDbTables(mockPg) {
  const customerSchema = createMockSchema('customer', customerFields);
  const orderSchema = createMockSchema('customer_order', orderFields);

  const DbTables = {
    customer: {
      primary: 'id',
      ...exportTableInfo(customerSchema),
      defaultOrder: 'id',
      computedFields: {
        upperName: ({ qiCol }) => ({ expr: `UPPER(${qiCol('name')})`, values: [], type: Type.String() }),
      },
      allowedReadJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
      ],
    },
    customer_order: {
      primary: 'id',
      ...exportTableInfo(orderSchema),
      defaultOrder: 'id',
    },
  };

  return { DbTables, db: new QueryClient(mockPg) };
}

/**
 * The field allowlists test membership with `in` and index computed fields with `?.[key]`, both
 * of which walk Object.prototype. `constructor`, `toString`, `valueOf` and friends therefore
 * survive every "unknown field" check and reach the SQL builders, where they render as
 * `undefined` or a bogus column and surface as a 500. `assertKnownFilterKeys` exists precisely
 * so a key the engine will not honour is refused, so these must be 400s like any other unknown
 * field.
 */
const PROTOTYPE_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

describe('search rejects prototype-chain keys like any unknown field', () => {
  for (const key of PROTOTYPE_KEYS) {
    it(`rejects '${key}' as a filter key`, async () => {
      const mockPg = createMockPg([{ rows: [] }]);
      const { DbTables, db } = createTestDbTables(mockPg);

      await assert.rejects(
        () => searchEngine(DbTables, { db, tableConf: DbTables.customer, filters: { [key]: 1 } }),
        (err) => err.statusCode === 400,
        `'${key}' must be reported as an unknown filter field`
      );
    });

    it(`rejects '${key}' as a condition field`, async () => {
      const mockPg = createMockPg([{ rows: [] }]);
      const { DbTables, db } = createTestDbTables(mockPg);

      await assert.rejects(
        () => searchEngine(DbTables, {
          db,
          tableConf: DbTables.customer,
          conditions: [{ field: key, method: 'isEqual', params: [1] }],
        }),
        (err) => err.statusCode === 400
      );
    });

    it(`rejects '${key}' in orderBy`, async () => {
      const mockPg = createMockPg([{ rows: [] }]);
      const { DbTables, db } = createTestDbTables(mockPg);

      await assert.rejects(
        () => searchEngine(DbTables, { db, tableConf: DbTables.customer, orderBy: key }),
        (err) => err.statusCode === 400
      );
    });

    it(`rejects '${key}' in selectComputed`, async () => {
      const mockPg = createMockPg([{ rows: [] }]);
      const { DbTables, db } = createTestDbTables(mockPg);

      await assert.rejects(
        () => searchEngine(DbTables, { db, tableConf: DbTables.customer, selectComputed: [key] }),
        (err) => err.statusCode === 400
      );
    });
  }

  it('still accepts a real schema field', async () => {
    const mockPg = createMockPg([{ rows: [] }]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      filters: { name: 'Mario' },
      orderBy: 'name',
    });
    assert.equal(mockPg.calls.length, 1);
  });

  it('still accepts a declared computed field', async () => {
    const mockPg = createMockPg([{ rows: [] }]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      selectComputed: ['upperName'],
    });
    assert.ok(mockPg.calls[0].text.includes('UPPER'), mockPg.calls[0].text);
  });
});
