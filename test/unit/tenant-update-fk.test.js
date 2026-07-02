import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { enforceTenantFKOnUpdate } = await import(path.join(ROOT, 'dist/lib/tenant.js'));
const { updateEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/update.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { getDialect } = await import(path.join(ROOT, 'dist/lib/dialect.js'));
const { Type } = await import('@sinclair/typebox');

const DIALECTS = ['postgres', 'mysql'];

function createMockSchema(tableName, fields) {
  return { col: (f) => toUnderscore(f), fields, validation: Type.Object(fields), tableName, partialValidation: Type.Object(fields) };
}

function createMockPg(responses = []) {
  let i = 0;
  const calls = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      const r = responses[i] || { rows: [], affectedRows: 0 };
      i++;
      return Promise.resolve(r);
    },
  };
}

const orderSchema = createMockSchema('customer_order', { id: Type.Number(), customerId: Type.Number(), total: Type.Number() });
const customerSchema = createMockSchema('customer', { id: Type.Number(), organizationId: Type.Number() });
const indirectScope = { column: 'organization_id', through: { schema: customerSchema, localField: 'customer_id', foreignField: 'id' } };
const indirectTenant = { ids: [42], scope: indirectScope };
const tableConf = { primary: 'id', ...exportTableInfo(orderSchema), defaultOrder: 'id', tenantScope: indirectScope };

for (const dialect of DIALECTS) {
  const client = (mockPg) => new QueryClient(mockPg, getDialect(dialect));

  describe(`enforceTenantFKOnUpdate [${dialect}]`, () => {
    it('no-op for direct/no-tenant scopes', async () => {
      const mockPg = createMockPg();
      await enforceTenantFKOnUpdate(client(mockPg), undefined, { customer_id: 1 });
      await enforceTenantFKOnUpdate(client(mockPg), { ids: [1], scope: { column: 'organization_id' } }, { customer_id: 1 });
      assert.equal(mockPg.calls.length, 0);
    });

    it('no-op when the through-FK is not part of the update', async () => {
      const mockPg = createMockPg();
      await enforceTenantFKOnUpdate(client(mockPg), indirectTenant, { total: 10 });
      assert.equal(mockPg.calls.length, 0);
    });

    it('validates the new FK against the tenant when it is being changed', async () => {
      const mockPg = createMockPg([{ rows: [] }]);
      await enforceTenantFKOnUpdate(client(mockPg), indirectTenant, { customer_id: 500 });
      assert.equal(mockPg.calls.length, 1);
      assert.ok(/NOT IN/.test(mockPg.calls[0].text));
      assert.deepEqual(mockPg.calls[0].values, [500, 42]);
    });

    it('throws 403 when the new FK belongs to another tenant', async () => {
      const mockPg = createMockPg([{ rows: [{ id: 500 }] }]);
      await assert.rejects(
        () => enforceTenantFKOnUpdate(client(mockPg), indirectTenant, { customer_id: 500 }),
        (err) => err.statusCode === 403
      );
    });
  });

  describe(`updateEngine indirect tenant — FK reassignment guard [${dialect}]`, () => {
    it('rejects (403) moving an owned record to another tenant via the through-FK', async () => {
      const mockPg = createMockPg([
        { rows: [{ x: 1 }] }, // assertTenantOwnership: record exists & owned
        { rows: [{ id: 500 }] }, // validateTenantFK: new FK owned by another tenant
      ]);
      await assert.rejects(
        () => updateEngine({ db: client(mockPg), tableConf, dbTables: {}, request: {}, record: { id: 1, customerId: 500 }, tenant: indirectTenant }),
        (err) => err.statusCode === 403
      );
      assert.equal(mockPg.calls.length, 2);
      assert.ok(!mockPg.calls.some((c) => c.text.startsWith('UPDATE')));
    });

    it('allows changing the through-FK to another value the tenant owns', async () => {
      const mockPg = createMockPg([
        { rows: [{ x: 1 }] }, // ownership: owned
        { rows: [] },         // validateTenantFK: clean
        { rows: [], affectedRows: 1 }, // UPDATE
      ]);
      const res = await updateEngine({ db: client(mockPg), tableConf, dbTables: {}, request: {}, record: { id: 1, customerId: 500 }, tenant: indirectTenant });
      assert.equal(res.main.id, 1);
      assert.ok(mockPg.calls.some((c) => c.text.startsWith('UPDATE')));
    });
  });
}
