// The engines are tenant-tested one by one; this file pins the seam above them. A route or a
// `SqlApi` method that forgot to resolve and forward the tenant would leave every engine test
// green while the HTTP surface leaked, so every operation is driven end-to-end here and its
// SQL is checked for the caller's tenant id.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Fastify from 'fastify';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { fastifyAutoSqlApi } = await import(path.join(ROOT, 'dist/index.js'));
const { createSqlApi } = await import(path.join(ROOT, 'dist/lib/sql-api.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { Type } = await import('@sinclair/typebox');

// `id` is optional so the same schema validates an insert body (no id yet) and an update body;
// the tenant column is optional so the body can leave it to the engine's injection.
const customerSchema = createMockSchema('customer', {
  id: Type.Optional(Type.Number()),
  name: Type.String(),
  organizationId: Type.Optional(Type.Number()),
});

function createDbTables() {
  return {
    customer: {
      primary: 'id',
      ...exportTableInfo(customerSchema),
      defaultOrder: 'id',
      tenantScope: { column: 'organization_id' },
    },
  };
}

const TENANT_ID = 7;
const bindsTenant = (call) => (call.values ?? []).includes(TENANT_ID);
const describeCalls = (mockPg) => mockPg.calls.map((c) => `${c.text} ${JSON.stringify(c.values)}`).join('\n');

describe('every HTTP route forwards the caller tenant to its engine', () => {
  // The pg adapter reads `rowCount`, so route-level responses carry it alongside `rows`.
  const owned = { rows: [{ id: 1, name: 'Mario', organization_id: TENANT_ID }], rowCount: 1 };
  const written = { rows: [{ id: 1 }], rowCount: 1 };
  const touched = { rows: [], rowCount: 1 };

  const routes = [
    ['search', { method: 'POST', url: '/search/customer', payload: {} }, [owned, { rows: [{ total: '1' }], rowCount: 1 }]],
    ['get', { method: 'GET', url: '/rest/customer/1' }, [owned]],
    ['insert', { method: 'POST', url: '/rest/customer', payload: { main: { name: 'Mario' } } }, [written]],
    ['update', { method: 'PUT', url: '/rest/customer', payload: { main: { id: 1, name: 'Mario' } } }, [touched]],
    ['delete', { method: 'DELETE', url: '/rest/customer/1' }, [touched]],
    ['bulk upsert', { method: 'PUT', url: '/bulk/customer', payload: [{ main: { name: 'Mario' } }] }, [written]],
    ['bulk delete', { method: 'POST', url: '/bulk/customer/delete', payload: [{ id: 1 }] }, [{ rows: [{ pk: 1 }], rowCount: 1 }, touched]],
  ];

  for (const [name, request, responses] of routes) {
    it(`${name}: every statement binds the tenant id`, async () => {
      const mockPg = createMockPg(responses);
      const app = Fastify();
      app.decorate('pg', mockPg);
      await app.register(fastifyAutoSqlApi, { DbTables: createDbTables(), getTenantId: () => TENANT_ID });
      await app.ready();

      const res = await app.inject(request);
      await app.close();

      assert.ok(res.statusCode < 300, `${name} answered ${res.statusCode}: ${res.body}`);
      assert.ok(mockPg.calls.length > 0, `${name} issued no SQL`);
      assert.ok(
        mockPg.calls.every(bindsTenant),
        `${name}: a statement ran without the tenant id:\n${describeCalls(mockPg)}`
      );
    });
  }
});

describe('every SqlApi method forwards the caller tenant to its engine', () => {
  const options = { getTenantId: () => TENANT_ID };
  const owned = { rows: [{ id: 1, name: 'Mario', organization_id: TENANT_ID }], affectedRows: 1 };
  const written = { rows: [{ id: 1 }], affectedRows: 1 };
  const touched = { rows: [], affectedRows: 1 };

  const methods = [
    ['search', (api) => api.search('customer', {}, {}), [owned]],
    ['get', (api) => api.get('customer', '1', {}), [owned]],
    ['insert', (api) => api.insert('customer', { record: { name: 'Mario' } }, {}), [written]],
    ['update', (api) => api.update('customer', { record: { id: 1, name: 'Mario' } }, {}), [touched]],
    ['delete', (api) => api.delete('customer', '1', {}), [touched]],
    ['bulkUpsert', (api) => api.bulkUpsert('customer', [{ main: { name: 'Mario' } }], {}), [written]],
    ['bulkDelete', (api) => api.bulkDelete('customer', [1], {}), [{ rows: [{ pk: 1 }], affectedRows: 1 }, touched]],
  ];

  for (const [name, run, responses] of methods) {
    it(`${name}: every statement binds the tenant id`, async () => {
      const mockPg = createMockPg(responses);
      const api = createSqlApi(mockPg, createDbTables(), options);

      await run(api);

      assert.ok(mockPg.calls.length > 0, `${name} issued no SQL`);
      assert.ok(
        mockPg.calls.every(bindsTenant),
        `${name}: a statement ran without the tenant id:\n${describeCalls(mockPg)}`
      );
    });
  }
});
