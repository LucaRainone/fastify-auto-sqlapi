import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
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

  const DbTables = {
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
      allowedReadJoins: [
        buildRelation(orderSchema, 'customerId', customerSchema, 'id', { alias: 'customer', unique: true }),
      ],
    },
  };

  return { DbTables, db: new QueryClient(mockPg) };
}

const TENANT = { ids: [9], scope: { column: 'organization_id' } };

describe('tenant scoping on join side-queries', () => {
  it('joinMultiple: scopes the join table query by tenant', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', organization_id: 9 }], affectedRows: 1 }, // main
      { rows: [], affectedRows: 0 },                                             // join side query
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
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
    const { DbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer_order,
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
    const { DbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinGroup: { customer_order: { aggregations: { count: ['id'] } } },
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
    const { DbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
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
    const { DbTables, db } = createTenantDbTables(mockPg);
    delete DbTables.customer_order.tenantScope;

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
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
    const { DbTables, db } = createTenantDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
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
    const { DbTables, db } = createTenantDbTables(mockPg);
    const customerSchema = DbTables.customer.Schema;
    DbTables.customer_order.tenantScope = {
      column: 'organization_id',
      through: { schema: customerSchema, localField: 'customer_id', foreignField: 'id' },
    };

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
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
