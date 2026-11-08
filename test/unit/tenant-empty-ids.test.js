// A caller whose `getTenantId` yields an EMPTY list belongs to no tenant at all.
//
// That is not an admin (`null` / `undefined` is), and it must not become one by accident: an
// `IN ()` predicate is a syntax error on both dialects, so the request used to fail closed only
// through a 500 — and any builder that "optimises away" an empty IN would turn it into a leak.
// The contract is a deterministic 403 before any SQL is issued.
//
// `0` and `''` are legitimate tenant ids and must keep filtering.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { createSqlApi } = await import(path.join(ROOT, 'dist/lib/sql-api.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { Type, TENANT_ADMIN } = await import(path.join(ROOT, 'dist/index.js'));

const customerSchema = createMockSchema('customer', {
  id: Type.Number(),
  name: Type.String(),
  organizationId: Type.Number(),
});
const orderSchema = createMockSchema('customer_order', {
  id: Type.Number(),
  customerId: Type.Number(),
  total: Type.Number(),
  organizationId: Type.Number(),
});
const shiftSchema = createMockSchema('shift', { id: Type.Number(), day: Type.String() });

/** `customer` is scoped; `shift` is a public host whose only relation targets `customer`. */
function createDbTables() {
  return {
    customer: {
      primary: 'id',
      ...exportTableInfo(customerSchema),
      defaultOrder: 'id',
      tenantScope: { column: 'organization_id' },
      allowedWriteJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
      ],
    },
    customer_order: {
      primary: 'id',
      ...exportTableInfo(orderSchema),
      defaultOrder: 'id',
      tenantScope: { column: 'organization_id' },
    },
    shift: {
      primary: 'id',
      ...exportTableInfo(shiftSchema),
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(shiftSchema, 'id', customerSchema, 'id', { alias: 'customer' }),
      ],
    },
  };
}

const noTenant = { getTenantId: () => [] };
const is403 = (err) => err.statusCode === 403;

describe('a caller with an empty tenant list', () => {
  const operations = {
    search: (api) => api.search('customer', {}, {}),
    get: (api) => api.get('customer', '1', {}),
    insert: (api) => api.insert('customer', { record: { name: 'Mario' } }, {}),
    update: (api) => api.update('customer', { record: { id: 1, name: 'Mario' } }, {}),
    delete: (api) => api.delete('customer', '1', {}),
    bulkUpsert: (api) => api.bulkUpsert('customer', [{ main: { name: 'Mario' } }], {}),
    bulkDelete: (api) => api.bulkDelete('customer', [1], {}),
  };

  for (const [name, run] of Object.entries(operations)) {
    it(`${name}: is refused with 403 before any SQL runs`, async () => {
      const mockPg = createMockPg([{ rows: [{ id: 1, name: 'x', organization_id: 5 }], affectedRows: 1 }]);
      const api = createSqlApi(mockPg, createDbTables(), noTenant);

      await assert.rejects(() => run(api), is403, `${name} must answer 403 for a tenant-less caller`);
      assert.equal(mockPg.calls.length, 0, `${name} must not reach the database: ${JSON.stringify(mockPg.calls)}`);
    });
  }

  it('is refused when a public host reaches a scoped table through a relation', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }, { rows: [], affectedRows: 0 }]);
    const api = createSqlApi(mockPg, createDbTables(), noTenant);

    await assert.rejects(() => api.search('shift', { joinMultiple: { customer: {} } }, {}), is403);
    assert.equal(mockPg.calls.length, 0);
  });

  it('is not an admin: TENANT_ADMIN bypasses, [] never does', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const api = createSqlApi(mockPg, createDbTables(), { getTenantId: () => TENANT_ADMIN });

    await api.search('customer', {}, {});

    assert.ok(!mockPg.calls[0].text.includes('organization_id'));
  });
});

describe('falsy but real tenant ids keep filtering', () => {
  for (const id of [0, '']) {
    it(`getTenantId → ${JSON.stringify(id)} scopes the query on that value`, async () => {
      const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
      const api = createSqlApi(mockPg, createDbTables(), { getTenantId: () => id });

      await api.search('customer', {}, {});

      assert.ok(mockPg.calls[0].text.includes('"organization_id" IN ($1)'), mockPg.calls[0].text);
      assert.deepEqual(mockPg.calls[0].values, [id]);
    });
  }
});
