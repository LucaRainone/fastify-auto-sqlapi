import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { updateEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/update.js'));
const { bulkUpsertEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-upsert.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import(path.join(ROOT, 'dist/index.js'));

const mockRequest = {};

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
 * customer (main) and customer_order (secondary) are BOTH tenant-scoped on organization_id.
 * customer_order is writable as a secondary of customer.
 */
function createTenantDbTables(mockPg, opts = {}) {
  const customerSchema = createMockSchema('customer', customerFields);
  const orderSchema = createMockSchema('customer_order', orderFields);

  const DbTables = {
    customer: {
      primary: 'id',
      ...exportTableInfo(customerSchema),
      defaultOrder: 'id',
      tenantScope: { column: 'organization_id' },
      allowedWriteJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
      ],
      ...(opts.upsertMap ? { upsertMap: opts.upsertMap } : {}),
    },
    customer_order: {
      primary: 'id',
      ...exportTableInfo(orderSchema),
      defaultOrder: 'id',
      ...(opts.secondaryScope === null ? {} : { tenantScope: opts.secondaryScope || { column: 'organization_id' } }),
    },
  };

  return { DbTables, db: new QueryClient(mockPg), customerSchema, orderSchema };
}

const TENANT = { ids: [7], scope: { column: 'organization_id' } };

describe('tenant enforcement on secondaries (write joins)', () => {
  it('insert: rejects a secondary carrying another tenant value', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 }, // main insert
      { rows: [{ id: 10 }], affectedRows: 1 }, // secondary insert
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        record: { name: 'Mario' },
        secondaries: { customer_order: [{ total: 5, organizationId: 999 }] },
        tenant: TENANT,
      }),
      (err) => err.statusCode === 403,
      'a secondary row addressed to a foreign tenant must be refused'
    );
  });

  it('insert: injects the tenant value into secondaries that omit it', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [{ id: 10 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario' },
      secondaries: { customer_order: [{ total: 5 }] },
      tenant: TENANT,
    });

    const secondaryInsert = mockPg.calls[1];
    assert.ok(
      secondaryInsert.text.includes('organization_id'),
      `secondary insert must carry the tenant column, got: ${secondaryInsert.text}`
    );
    assert.ok(
      secondaryInsert.values.includes(7),
      `secondary insert must bind the caller's tenant id, got: ${JSON.stringify(secondaryInsert.values)}`
    );
  });

  it('insert: accepts a secondary whose tenant value matches the caller', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [{ id: 10 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    const result = await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario' },
      secondaries: { customer_order: [{ total: 5, organizationId: 7 }] },
      tenant: TENANT,
    });

    assert.deepEqual(result.main, { id: 1 });
  });

  it('insert: leaves secondaries untouched when the child table has no tenantScope', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [{ id: 10 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg, { secondaryScope: null });

    await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario' },
      secondaries: { customer_order: [{ total: 5 }] },
      tenant: TENANT,
    });

    assert.ok(
      !mockPg.calls[1].text.includes('organization_id'),
      `a child table without tenantScope must not be scoped, got: ${mockPg.calls[1].text}`
    );
  });

  it('insert: leaves secondaries untouched without a tenant context (admin)', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [{ id: 10 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario' },
      secondaries: { customer_order: [{ total: 5, organizationId: 999 }] },
    });

    assert.ok(mockPg.calls[1].values.includes(999), 'admin writes are not tenant-filtered');
  });

  it('insert: guards the conflict target when the secondary is upserted', async () => {
    const orderSchemaHolder = {};
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },  // main insert
      { rows: [{ x: 1 }], affectedRows: 1 },   // conflict probe finds a foreign-owned row
    ]);
    const { DbTables, db, orderSchema } = createTenantDbTables(mockPg);
    orderSchemaHolder.schema = orderSchema;
    DbTables.customer.upsertMap = new Map([[orderSchema, ['total']]]);

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        record: { name: 'Mario' },
        secondaries: { customer_order: [{ total: 5 }] },
        tenant: TENANT,
      }),
      (err) => err.statusCode === 403,
      'an upserted secondary must not hijack a row owned by another tenant'
    );
  });

  it('update: rejects a secondary carrying another tenant value', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },           // main update
      { rows: [{ id: 10 }], affectedRows: 1 }, // secondary insert
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await assert.rejects(
      () => updateEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        record: { id: 1, name: 'Mario' },
        secondaries: { customer_order: [{ total: 5, organizationId: 999 }] },
        tenant: TENANT,
      }),
      (err) => err.statusCode === 403
    );
  });

  it('bulkUpsert: rejects a secondary carrying another tenant value', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },  // bulk main insert
      { rows: [{ id: 10 }], affectedRows: 1 }, // secondary insert
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await assert.rejects(
      () => bulkUpsertEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        items: [{
          main: { name: 'Mario' },
          secondaries: { customer_order: [{ total: 5, organizationId: 999 }] },
        }],
        tenant: TENANT,
      }),
      (err) => err.statusCode === 403
    );
  });

  it('insert: validates the through-FK when the child has an indirect tenantScope', async () => {
    const customerSchema = createMockSchema('customer', customerFields);
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },  // main insert
      { rows: [{ id: 4 }], affectedRows: 1 },  // FK probe finds a foreign-owned parent
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg, {
      secondaryScope: {
        column: 'organization_id',
        through: { schema: customerSchema, localField: 'customer_id', foreignField: 'id' },
      },
    });

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        record: { name: 'Mario' },
        secondaries: { customer_order: [{ total: 5 }] },
        tenant: TENANT,
      }),
      (err) => err.statusCode === 403
    );
  });
});

describe('tenant enforcement on deletions (write joins)', () => {
  it('update: scopes the child DELETE by tenant', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 }, // main update
      { rows: [], affectedRows: 1 }, // child delete
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
      deletions: { customer_order: [{ id: 10 }] },
      tenant: TENANT,
    });

    const del = mockPg.calls[1];
    assert.ok(del.text.startsWith('DELETE FROM'), `expected the child delete, got: ${del.text}`);
    assert.ok(
      del.text.includes('organization_id'),
      `child DELETE must be tenant-scoped, got: ${del.text}`
    );
    assert.ok(del.values.includes(7), 'child DELETE must bind the caller tenant id');
  });

  it('update: does not scope the child DELETE without a tenant context (admin)', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
      deletions: { customer_order: [{ id: 10 }] },
    });

    assert.ok(!mockPg.calls[1].text.includes('organization_id'));
  });
});

// A child row is reachable through a write join only as a child of THE main row being written.
// The row id alone must never be enough: without the FK bound to the main id, an unscoped child
// under a scoped parent would be deletable by anyone who owns any parent at all.
describe('deletions are bound to the main row, not just to the child id', () => {
  const mainRowDelete = (call) =>
    /"customer_id" = \$\d+/.test(call.text) && call.values.includes(1);

  it('update: an unscoped child under a scoped parent is deleted only under the main id', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 }, // main update
      { rows: [], affectedRows: 1 }, // child delete
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg, { secondaryScope: null });

    await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
      deletions: { customer_order: [{ id: 10 }] },
      tenant: TENANT,
    });

    const del = mockPg.calls[1];
    assert.ok(del.text.startsWith('DELETE FROM'), del.text);
    assert.ok(mainRowDelete(del), `child DELETE must bind the main row FK, got: ${del.text} ${JSON.stringify(del.values)}`);
  });

  it('update: a scoped child is deleted under the main id AND the tenant', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
      deletions: { customer_order: [{ id: 10 }] },
      tenant: TENANT,
    });

    const del = mockPg.calls[1];
    assert.ok(mainRowDelete(del), `got: ${del.text}`);
    assert.ok(del.text.includes('organization_id') && del.values.includes(7), `got: ${del.text}`);
  });

  it('bulkUpsert: per-item deletions are bound to that item main id and the tenant', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 }, // bulk main insert
      { rows: [], affectedRows: 1 },          // child delete
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await bulkUpsertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      items: [{ main: { name: 'Mario' }, deletions: { customer_order: [{ id: 10 }] } }],
      tenant: TENANT,
    });

    const del = mockPg.calls[1];
    assert.ok(del.text.startsWith('DELETE FROM'), del.text);
    assert.ok(mainRowDelete(del), `got: ${del.text}`);
    assert.ok(del.text.includes('organization_id') && del.values.includes(7), `got: ${del.text}`);
  });

  it('update: a child with an indirect scope is deleted through the parent tenant column', async () => {
    const customerSchema = createMockSchema('customer', customerFields);
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 }, // main update
      { rows: [], affectedRows: 1 }, // child delete
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg, {
      secondaryScope: {
        column: 'organization_id',
        through: { schema: customerSchema, localField: 'customer_id', foreignField: 'id' },
      },
    });

    await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
      deletions: { customer_order: [{ id: 10 }] },
      tenant: TENANT,
    });

    const del = mockPg.calls.find((c) => c.text.startsWith('DELETE FROM'));
    assert.ok(del, `expected a child DELETE, got: ${mockPg.calls.map((c) => c.text).join('\n')}`);
    assert.ok(
      del.text.includes('"customer"."organization_id"') && del.values.includes(7),
      `an indirect child scope must reach the parent tenant column, got: ${del.text}`
    );
  });

  it('update: a child with an anyOf scope is deleted under the OR predicate', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg, {
      secondaryScope: { anyOf: ['organization_id', 'customer_id'] },
    });

    await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
      deletions: { customer_order: [{ id: 10 }] },
      tenant: TENANT,
    });

    const del = mockPg.calls[1];
    assert.ok(
      /"organization_id" IN \(\$\d+\) OR .*"customer_id" IN \(\$\d+\)/.test(del.text),
      `anyOf child DELETE must carry the OR predicate, got: ${del.text}`
    );
  });
});

// The FK a secondary carries is not the client's to choose: it is the id of the main row just
// written. Honouring a payload FK would let a caller attach a child to another tenant's parent
// through a child table that declares no scope of its own.
describe('a secondary cannot be re-parented by the payload FK', () => {
  it('insert: the main id wins over a client-supplied customerId', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [{ id: 10 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg, { secondaryScope: null });

    await insertEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Mario' },
      secondaries: { customer_order: [{ customerId: 999, total: 5 }] },
      tenant: TENANT,
    });

    const child = mockPg.calls[1];
    assert.ok(!child.values.includes(999), `foreign FK must not be written, got: ${JSON.stringify(child.values)}`);
    assert.ok(child.values.includes(1), 'the main id must be the FK');
  });

  it('update: the main id wins over a client-supplied customerId', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
      { rows: [{ id: 10 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg, { secondaryScope: null });

    await updateEngine({
      db,
      tableConf: DbTables.customer,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Mario' },
      secondaries: { customer_order: [{ customerId: 999, total: 5 }] },
      tenant: TENANT,
    });

    const child = mockPg.calls[1];
    assert.ok(!child.values.includes(999), `foreign FK must not be written, got: ${JSON.stringify(child.values)}`);
    assert.ok(child.values.includes(1));
  });
});

describe('upserted secondaries are conflict-guarded on every write path', () => {
  it('update: rejects 403 when the secondary upsert lands on a foreign-owned row', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },        // main update
      { rows: [{ x: 1 }], affectedRows: 1 }, // conflict probe finds a foreign-owned row
    ]);
    const { DbTables, db, orderSchema } = createTenantDbTables(mockPg);
    DbTables.customer.upsertMap = new Map([[orderSchema, ['total']]]);

    await assert.rejects(
      () => updateEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        record: { id: 1, name: 'Mario' },
        secondaries: { customer_order: [{ total: 5 }] },
        tenant: TENANT,
      }),
      (err) => err.statusCode === 403
    );
    assert.ok(!mockPg.calls.some((c) => c.text.includes('ON CONFLICT')), 'no upsert may run after a failed probe');
  });

  it('bulkUpsert: rejects 403 when the secondary upsert lands on a foreign-owned row', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 }, // bulk main insert
      { rows: [{ x: 1 }], affectedRows: 1 },  // conflict probe finds a foreign-owned row
    ]);
    const { DbTables, db, orderSchema } = createTenantDbTables(mockPg);
    DbTables.customer.upsertMap = new Map([[orderSchema, ['total']]]);

    await assert.rejects(
      () => bulkUpsertEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        items: [{ main: { name: 'Mario' }, secondaries: { customer_order: [{ total: 5 }] } }],
        tenant: TENANT,
      }),
      (err) => err.statusCode === 403
    );
    assert.ok(!mockPg.calls.some((c) => c.text.includes('ON CONFLICT')), 'no upsert may run after a failed probe');
  });
});

describe('a multi-tenant caller writing secondaries', () => {
  it('insert: a secondary that names no tenant is ambiguous (400) and is never written', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [{ id: 10 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTenantDbTables(mockPg);

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: DbTables.customer,
        dbTables: DbTables,
        request: mockRequest,
        record: { name: 'Mario', organizationId: 7 },
        secondaries: { customer_order: [{ total: 5 }] },
        tenant: { ids: [7, 8], scope: { column: 'organization_id' } },
      }),
      (err) => err.statusCode === 400
    );
    assert.ok(
      !mockPg.calls.some((c) => c.text.includes('INSERT INTO "customer_order"')),
      'an unanchored child must not be inserted under a guessed tenant'
    );
  });
});
