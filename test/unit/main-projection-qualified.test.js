// The main query's projection is always table-qualified. A filtered joinLeft, a parent
// `orderBy` and an indirect tenant scope add a JOIN to the main statement; with a bare `*`
// the joined table's columns land in the row too, and on a name clash (`id`, `name`,
// `createdAt`…) the driver keeps the LAST value read — the parent's. Every main row then
// carries the parent's id. `db.select` already qualifies a bare `*`; the `selectComputed`
// path built `*, <expr> AS "x"` by hand and slipped past it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import(path.join(ROOT, 'dist/index.js'));

const customerSchema = createMockSchema('customer', { id: Type.Integer(), name: Type.String(), orgId: Type.Integer() });
const hourSchema = createMockSchema('hour', { id: Type.Integer(), customerId: Type.Integer(), note: Type.String() });

function createDbTables() {
  return {
    hour: {
      primary: 'id',
      ...exportTableInfo(hourSchema),
      defaultOrder: 'id',
      computedFields: {
        upperNote: ({ qiCol }) => ({ expr: `UPPER(${qiCol('note')})`, values: [], type: Type.String() }),
      },
      allowedReadJoins: [
        buildRelation(hourSchema, 'customerId', customerSchema, 'id', { alias: 'customer', unique: true }),
      ],
    },
    hourScoped: {
      primary: 'id',
      ...exportTableInfo(hourSchema),
      defaultOrder: 'id',
      computedFields: {
        upperNote: ({ qiCol }) => ({ expr: `UPPER(${qiCol('note')})`, values: [], type: Type.String() }),
      },
      tenantScope: { column: 'org_id', through: { schema: customerSchema, localField: 'customer_id', foreignField: 'id' } },
    },
    customer: { primary: 'id', ...exportTableInfo(customerSchema), defaultOrder: 'id' },
  };
}

/** The main statement must project the main table only, never a bare `*`. */
function assertMainProjection(sql) {
  assert.match(sql, /^SELECT "hour"\.\*/, sql);
  assert.doesNotMatch(sql, /SELECT \*/, sql);
}

const joinLeftFilter = { customer: { conditions: [{ field: 'name', method: 'isILike', params: ['%acme%'] }] } };

describe('main projection stays table-qualified when the main query carries a JOIN', () => {
  it('filtered joinLeft + selectComputed', async () => {
    const mockPg = createMockPg([{ rows: [] }, { rows: [] }]);
    const dbTables = createDbTables();
    await searchEngine(dbTables, {
      db: new QueryClient(mockPg), tableConf: dbTables.hour,
      selectComputed: ['upperNote'], joinLeft: joinLeftFilter,
    });
    assertMainProjection(mockPg.calls[0].text);
    assert.match(mockPg.calls[0].text, /LEFT JOIN "customer"/);
    assert.match(mockPg.calls[0].text, /UPPER\("hour"\."note"\) AS "upperNote"/);
  });

  it('parent orderBy + selectComputed', async () => {
    const mockPg = createMockPg([{ rows: [] }, { rows: [] }]);
    const dbTables = createDbTables();
    await searchEngine(dbTables, {
      db: new QueryClient(mockPg), tableConf: dbTables.hour,
      selectComputed: ['upperNote'], orderBy: 'customer.name', joinLeft: { customer: {} },
    });
    assertMainProjection(mockPg.calls[0].text);
    assert.match(mockPg.calls[0].text, /LEFT JOIN "customer"/);
  });

  it('indirect tenant scope (INNER JOIN through the parent) + selectComputed', async () => {
    const mockPg = createMockPg([{ rows: [] }]);
    const dbTables = createDbTables();
    await searchEngine(dbTables, {
      db: new QueryClient(mockPg), tableConf: dbTables.hourScoped,
      selectComputed: ['upperNote'],
      tenant: { ids: [7], scope: dbTables.hourScoped.tenantScope },
    });
    assertMainProjection(mockPg.calls[0].text);
    assert.match(mockPg.calls[0].text, /INNER JOIN "customer"/);
  });

  it('filtered joinLeft without selectComputed (already qualified by db.select, kept as a guard)', async () => {
    const mockPg = createMockPg([{ rows: [] }, { rows: [] }]);
    const dbTables = createDbTables();
    await searchEngine(dbTables, { db: new QueryClient(mockPg), tableConf: dbTables.hour, joinLeft: joinLeftFilter });
    assertMainProjection(mockPg.calls[0].text);
  });
});
