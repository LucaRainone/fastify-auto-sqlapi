import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import('@sinclair/typebox');

const customerFields = {
  id: Type.Number(),
  name: Type.String(),
  organizationId: Type.Number(),
};
const orderFields = {
  id: Type.Number(),
  customerId: Type.Number(),
  total: Type.Number(),
  organizationId: Type.Number(),
};

/**
 * customer_order (main) reads its parent customer through the alias `parent`, so an
 * alias-qualified reference is distinguishable from a table-qualified one.
 */
function createTenantDbTables(mockPg, opts = {}) {
  const customerSchema = createMockSchema('customer', customerFields);
  const orderSchema = createMockSchema('customer_order', orderFields);

  const DbTables = {
    customer: {
      primary: 'id',
      ...exportTableInfo(customerSchema),
      defaultOrder: 'id',
      ...(opts.parentScope === null ? {} : { tenantScope: opts.parentScope || { column: 'organization_id' } }),
    },
    customer_order: {
      primary: 'id',
      ...exportTableInfo(orderSchema),
      defaultOrder: 'id',
      tenantScope: { column: 'organization_id' },
      allowedReadJoins: [
        buildRelation(orderSchema, 'customerId', customerSchema, 'id', { alias: 'parent', unique: true }),
      ],
    },
  };

  return { DbTables, db: new QueryClient(mockPg), customerSchema, orderSchema };
}

const TENANT = { ids: [9], scope: { column: 'organization_id' } };

/**
 * The ON clause of the LEFT JOIN: from `LEFT JOIN` to the statement's own WHERE. The scan
 * tracks parenthesis depth, because an indirect scope puts a WHERE inside its EXISTS subquery.
 */
function leftJoinClause(sql) {
  const start = sql.indexOf('LEFT JOIN');
  assert.notEqual(start, -1, `expected a LEFT JOIN in: ${sql}`);

  let depth = 0;
  for (let i = start; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
    else if (depth === 0 && sql.startsWith(' WHERE ', i)) return sql.slice(start, i);
  }
  return sql.slice(start);
}

describe('tenant scoping on the joinLeft LEFT JOIN', () => {
  it('scopes the joined parent in the ON clause when filtering on it', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 }, // main query with the LEFT JOIN
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer_order,
      joinLeft: { parent: { filters: { name: 'acme' } } },
      tenant: TENANT,
    });

    const on = leftJoinClause(mockPg.calls[0].text);
    assert.ok(
      on.includes('"parent"."organization_id"'),
      `the LEFT JOIN ON clause must scope the parent by tenant, got: ${on}`
    );
    assert.ok(mockPg.calls[0].values.includes(9), 'the tenant id must be bound');
  });

  it('keeps the tenant predicate out of the WHERE, so LEFT semantics survive', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer_order,
      joinLeft: { parent: { filters: { name: 'acme' } } },
      tenant: TENANT,
    });

    const sql = mockPg.calls[0].text;
    const whereOnwards = sql.slice(sql.indexOf(' WHERE '));
    assert.ok(
      !whereOnwards.includes('"parent"."organization_id"'),
      `scoping the parent in the WHERE would silently make the LEFT JOIN an INNER JOIN, got: ${whereOnwards}`
    );
  });

  it('scopes the LEFT JOIN forced by a 2-part orderBy', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer_order,
      orderBy: 'parent.name',
      tenant: TENANT,
    });

    const on = leftJoinClause(mockPg.calls[0].text);
    assert.ok(
      on.includes('"parent"."organization_id"'),
      `an orderBy-forced LEFT JOIN must be scoped too, got: ${on}`
    );
  });

  it('scopes the LEFT JOIN when the request puts conditions on the parent', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer_order,
      joinLeft: { parent: { conditions: [{ field: 'name', method: 'isLike', params: ['A%'] }] } },
      tenant: TENANT,
    });

    const on = leftJoinClause(mockPg.calls[0].text);
    assert.ok(on.includes('"parent"."organization_id"'), `got: ${on}`);
  });

  it('joins the through table with EXISTS when the parent has an indirect scope', async () => {
    const customerSchema = createMockSchema('customer', customerFields);
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createTenantDbTables(mockPg, {
      parentScope: {
        column: 'organization_id',
        through: { schema: customerSchema, localField: 'id', foreignField: 'id' },
      },
    });

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer_order,
      joinLeft: { parent: { filters: { name: 'acme' } } },
      tenant: TENANT,
    });

    const on = leftJoinClause(mockPg.calls[0].text);
    assert.ok(on.includes('EXISTS'), `an indirect parent scope must be enforced via EXISTS, got: ${on}`);
    assert.ok(on.includes('"organization_id"'), `got: ${on}`);
  });

  it('does not scope a parent table that declares no tenantScope', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createTenantDbTables(mockPg, { parentScope: null });

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer_order,
      joinLeft: { parent: { filters: { name: 'acme' } } },
      tenant: TENANT,
    });

    const on = leftJoinClause(mockPg.calls[0].text);
    assert.ok(!on.includes('"parent"."organization_id"'), `got: ${on}`);
  });

  it('does not scope the LEFT JOIN without a tenant context (admin)', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer_order,
      joinLeft: { parent: { filters: { name: 'acme' } } },
    });

    const on = leftJoinClause(mockPg.calls[0].text);
    assert.ok(!on.includes('organization_id'), `got: ${on}`);
  });
});

describe('tenant scoping on correlated aggregation subqueries', () => {
  function createAggDbTables(mockPg) {
    const customerSchema = createMockSchema('customer', customerFields);
    const orderSchema = createMockSchema('customer_order', orderFields);

    return {
      DbTables: {
        customer: {
          primary: 'id',
          ...exportTableInfo(customerSchema),
          defaultOrder: 'id',
          tenantScope: { column: 'organization_id' },
          allowedReadJoins: [
            buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
          ],
        },
        customer_order: {
          primary: 'id',
          ...exportTableInfo(orderSchema),
          defaultOrder: 'id',
          tenantScope: { column: 'organization_id' },
        },
      },
      db: new QueryClient(mockPg),
    };
  }

  /** The correlated subquery of a dotted aggregation reference. */
  function subquery(sql) {
    const start = sql.indexOf('COALESCE((SELECT');
    assert.notEqual(start, -1, `expected an aggregation subquery in: ${sql}`);
    return sql.slice(start, sql.indexOf('), 0)', start));
  }

  it('scopes the subquery of a HAVING-style dotted condition', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createAggDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinGroup: { customer_order: { aggregations: { count: ['id'] } } },
      conditions: [{ field: 'customer_order.count.id', method: 'isGreater', params: [0] }],
      tenant: TENANT,
    });

    const sub = subquery(mockPg.calls[0].text);
    assert.ok(
      sub.includes('organization_id'),
      `the aggregation subquery must be tenant-scoped, got: ${sub}`
    );
  });

  it('scopes the subquery of a 3-part orderBy', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createAggDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinGroup: { customer_order: { aggregations: { sum: ['total'] } } },
      orderBy: 'customer_order.sum.total',
      tenant: TENANT,
    });

    const sub = subquery(mockPg.calls[0].text);
    assert.ok(
      sub.includes('organization_id'),
      `the orderBy aggregation subquery must be tenant-scoped, got: ${sub}`
    );
  });

  it('does not scope the aggregation subquery without a tenant context (admin)', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createAggDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinGroup: { customer_order: { aggregations: { count: ['id'] } } },
      conditions: [{ field: 'customer_order.count.id', method: 'isGreater', params: [0] }],
    });

    const sub = subquery(mockPg.calls[0].text);
    assert.ok(!sub.includes('organization_id'), `got: ${sub}`);
  });
});
