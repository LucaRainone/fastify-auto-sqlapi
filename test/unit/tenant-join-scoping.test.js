import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import(path.join(ROOT, 'dist/index.js'));

function createMockSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}


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
 * customer and customer_order are BOTH tenant-scoped (direct, organization_id).
 * customer allows reading orders via joinMultiple/joinGroup/joinMustExist, and
 * customer_order allows reading its parent customer via joinLeft.
 */
function createTenantDbTables(mockPg) {
  const customerSchema = createMockSchema('customer', customerFields);
  const orderSchema = createMockSchema('customer_order', orderFields);

  const dbTables = {
    customer: {
      primary: 'id',
      schema: customerSchema,
      defaultOrder: 'id',
      tenantScope: { column: 'organization_id' },
      allowedReadJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
      ],
    },
    customer_order: {
      primary: 'id',
      schema: orderSchema,
      defaultOrder: 'id',
      tenantScope: { column: 'organization_id' },
      allowedReadJoins: [
        buildRelation(orderSchema, 'customerId', customerSchema, 'id', { alias: 'customer', unique: true }),
      ],
    },
  };

  return { dbTables, db: new QueryClient(mockPg) };
}

const TENANT = { ids: [9], scope: { column: 'organization_id' } };

describe('tenant scoping on join side-queries', () => {
  it('joinMultiple: scopes the join table query by tenant', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', organization_id: 9 }], affectedRows: 1 }, // main
      { rows: [], affectedRows: 0 },                                             // join side query
    ]);
    const { dbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(dbTables, {
      db,
      tableConf: dbTables.customer,
      joinMultiple: { customer_order: {} },
      tenant: TENANT,
    });

    const joinQuery = mockPg.calls[1];
    assert.ok(
      joinQuery.text.includes('organization_id'),
      `join query must filter by tenant column, got: ${joinQuery.text}`
    );
    assert.ok(joinQuery.values.includes(9), 'tenant id must be bound in the join query');
  });

  it('joinLeft: scopes the parent fetch by tenant', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 5, customer_id: 1, total: 10, organization_id: 9 }], affectedRows: 1 }, // main
      { rows: [], affectedRows: 0 },                                                         // parent fetch
    ]);
    const { dbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(dbTables, {
      db,
      tableConf: dbTables.customer_order,
      joinLeft: { customer: {} },
      tenant: TENANT,
    });

    const joinQuery = mockPg.calls[1];
    assert.ok(
      joinQuery.text.includes('organization_id'),
      `parent fetch must filter by tenant column, got: ${joinQuery.text}`
    );
    assert.ok(joinQuery.values.includes(9));
  });

  it('joinGroup: scopes the aggregation query by tenant', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', organization_id: 9 }], affectedRows: 1 }, // main
      { rows: [{ count_id: 3 }], affectedRows: 1 },                              // aggregation
    ]);
    const { dbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(dbTables, {
      db,
      tableConf: dbTables.customer,
      joinGroup: { customer_order: { count: ['id'] } },
      tenant: TENANT,
    });

    const aggQuery = mockPg.calls[1];
    assert.ok(
      aggQuery.text.includes('organization_id'),
      `aggregation query must filter by tenant column, got: ${aggQuery.text}`
    );
    assert.ok(aggQuery.values.includes(9));
  });

  it('joinMustExist: scopes the EXISTS subquery by tenant', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 }, // main with EXISTS
    ]);
    const { dbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(dbTables, {
      db,
      tableConf: dbTables.customer,
      joinMustExist: { customer_order: { filters: { total: 10 } } },
      tenant: TENANT,
    });

    const mainQuery = mockPg.calls[0];
    const existsPart = mainQuery.text.slice(mainQuery.text.indexOf('EXISTS'));
    assert.ok(
      existsPart.includes('organization_id'),
      `EXISTS subquery must filter by tenant column, got: ${existsPart}`
    );
  });

  it('does NOT add tenant conditions when the join table has no tenantScope', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', organization_id: 9 }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const { dbTables, db } = createTenantDbTables(mockPg);
    delete dbTables.customer_order.tenantScope;

    await searchEngine(dbTables, {
      db,
      tableConf: dbTables.customer,
      joinMultiple: { customer_order: {} },
      tenant: TENANT,
    });

    const joinQuery = mockPg.calls[1];
    assert.ok(
      !joinQuery.text.includes('organization_id'),
      `join table without tenantScope must not be filtered, got: ${joinQuery.text}`
    );
  });

  it('does NOT add tenant conditions without a tenant context (admin)', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', organization_id: 9 }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const { dbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(dbTables, {
      db,
      tableConf: dbTables.customer,
      joinMultiple: { customer_order: {} },
    });

    const joinQuery = mockPg.calls[1];
    assert.ok(!joinQuery.text.includes('organization_id'));
  });

  it('joinMultiple: supports an indirect tenantScope on the join table (through join)', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', organization_id: 9 }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const { dbTables, db } = createTenantDbTables(mockPg);
    const customerSchema = dbTables.customer.schema;
    dbTables.customer_order.tenantScope = {
      column: 'organization_id',
      through: { schema: customerSchema, localField: 'customer_id', foreignField: 'id' },
    };

    await searchEngine(dbTables, {
      db,
      tableConf: dbTables.customer,
      joinMultiple: { customer_order: {} },
      tenant: TENANT,
    });

    const joinQuery = mockPg.calls[1];
    assert.ok(
      joinQuery.text.includes('INNER JOIN "customer"'),
      `indirect scope must join the through table, got: ${joinQuery.text}`
    );
    assert.ok(
      joinQuery.text.includes('"customer"."organization_id"'),
      `indirect scope must filter on the through table tenant column, got: ${joinQuery.text}`
    );
    assert.ok(joinQuery.values.includes(9));
  });
});

// An indirect scope whose through table is NEITHER the main table nor the join table: the
// predicate cannot borrow a table that is already in the FROM, so every subquery family must
// bring the parent in on its own — a bare `"account"."organization_id"` would be an unknown
// reference at best, and a silent reference to the wrong table at worst.
describe('indirect join-table scope through a third table', () => {
  const accountFields = { id: Type.Number(), organizationId: Type.Number() };
  const orderWithAccountFields = { ...orderFields, accountId: Type.Number() };

  function createThirdTableDbTables(mockPg) {
    const customerSchema = createMockSchema('customer', customerFields);
    const orderSchema = createMockSchema('customer_order', orderWithAccountFields);
    const accountSchema = createMockSchema('account', accountFields);

    const dbTables = {
      customer: {
        primary: 'id',
        schema: customerSchema,
        defaultOrder: 'id',
        tenantScope: { column: 'organization_id' },
        allowedReadJoins: [
          buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
        ],
      },
      customer_order: {
        primary: 'id',
        schema: orderSchema,
        defaultOrder: 'id',
        tenantScope: {
          column: 'organization_id',
          through: { schema: accountSchema, localField: 'account_id', foreignField: 'id' },
        },
      },
      account: {
        primary: 'id',
        schema: accountSchema,
        defaultOrder: 'id',
        tenantScope: { column: 'organization_id' },
      },
    };
    return { dbTables, db: new QueryClient(mockPg) };
  }

  /** The scope reaches `account` and filters on its tenant column, in the given fragment. */
  function assertScopedThroughAccount(fragment) {
    assert.ok(fragment.includes('"account"'), `the through table must be brought in, got: ${fragment}`);
    assert.ok(
      fragment.includes('"account"."organization_id" IN'),
      `the predicate must sit on the through table tenant column, got: ${fragment}`
    );
  }

  it('joinMustExist: the EXISTS subquery reaches the through table', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { dbTables, db } = createThirdTableDbTables(mockPg);

    await searchEngine(dbTables, {
      db,
      tableConf: dbTables.customer,
      joinMustExist: { customer_order: { filters: { total: 10 } } },
      tenant: TENANT,
    });

    const sql = mockPg.calls[0].text;
    assertScopedThroughAccount(sql.slice(sql.indexOf('EXISTS')));
    assert.ok(mockPg.calls[0].values.includes(9));
  });

  it('joinGroup: the aggregation side query reaches the through table', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', organization_id: 9 }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const { dbTables, db } = createThirdTableDbTables(mockPg);

    await searchEngine(dbTables, {
      db,
      tableConf: dbTables.customer,
      joinGroup: { customer_order: { count: ['id'] } },
      tenant: TENANT,
    });

    assertScopedThroughAccount(mockPg.calls[1].text);
    assert.ok(mockPg.calls[1].values.includes(9));
  });

  it('dotted aggregation condition: the correlated subquery reaches the through table', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { dbTables, db } = createThirdTableDbTables(mockPg);

    await searchEngine(dbTables, {
      db,
      tableConf: dbTables.customer,
      joinGroup: { customer_order: { count: ['id'] } },
      conditions: [{ field: 'customer_order.count.id', method: 'isGreater', params: [0] }],
      tenant: TENANT,
    });

    const sql = mockPg.calls[0].text;
    assertScopedThroughAccount(sql.slice(sql.indexOf('COALESCE((SELECT')));
  });

  it('3-part orderBy: the correlated subquery reaches the through table', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { dbTables, db } = createThirdTableDbTables(mockPg);

    await searchEngine(dbTables, {
      db,
      tableConf: dbTables.customer,
      joinGroup: { customer_order: { sum: ['total'] } },
      orderBy: 'customer_order.sum.total',
      tenant: TENANT,
    });

    const sql = mockPg.calls[0].text;
    assertScopedThroughAccount(sql.slice(sql.indexOf('ORDER BY')));
  });
});
