// Admin is declared, never inferred. `getTenantId` returning `null` or `undefined` used to mean
// "no filter": an auth hook that failed to run, a missing JWT claim, a typo in `req.user.orgId`
// each silently served the request as a superadmin. Now a scoped table answers 401 to an absent
// tenant, and cross-tenant access takes the exported `TENANT_ADMIN` sentinel. `[]` stays 403:
// an authenticated caller who belongs to no tenant. Unscoped tables never call `getTenantId`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { fastifyAutoSqlApi, createSqlApi, defineTable, exportTableInfo, TENANT_ADMIN, Type } =
  await import(path.join(ROOT, 'dist/index.js'));

const SchemaDoc = createMockSchema('doc', {
  id: Type.Integer(),
  title: Type.String(),
  organizationId: Type.Integer(),
});

function createMockPool() {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      return { rows: [], rowCount: 0 };
    },
  };
}

async function createApp(getTenantId, { scoped = true } = {}) {
  const DbTables = {
    doc: defineTable({
      primary: 'id',
      ...exportTableInfo(SchemaDoc),
      ...(scoped ? { tenantScope: { column: 'organization_id' } } : {}),
    }),
  };
  const app = Fastify();
  const pool = createMockPool();
  app.decorate('pg', pool);
  await app.register(fastifyAutoSqlApi, { DbTables, getTenantId });
  return { app, pool };
}

const search = (app) => app.inject({ method: 'POST', url: '/search/doc', payload: {} });

describe('tenant — an absent tenant on a scoped table is 401', () => {
  for (const [label, value] of [['null', null], ['undefined', undefined]]) {
    it(`getTenantId returning ${label} is Unauthorized, before any SQL`, async () => {
      const { app, pool } = await createApp(() => value);
      const res = await search(app);
      assert.equal(res.statusCode, 401, res.payload);
      assert.equal(res.json().error, 'Unauthorized');
      assert.equal(pool.calls.length, 0);
      await app.close();
    });
  }

  it('the same holds for sqlApi.* called with a request', async () => {
    const DbTables = {
      doc: defineTable({ primary: 'id', ...exportTableInfo(SchemaDoc), tenantScope: { column: 'organization_id' } }),
    };
    const api = createSqlApi(createMockPool(), DbTables, { getTenantId: () => null });
    await assert.rejects(api.search('doc', {}, { id: 'req-1' }), (err) => err.statusCode === 401);
  });

  it('an empty array stays 403: a caller with no tenant', async () => {
    const { app } = await createApp(() => []);
    const res = await search(app);
    assert.equal(res.statusCode, 403, res.payload);
    await app.close();
  });
});

describe('tenant — TENANT_ADMIN is the only way to skip the filter', () => {
  it('a search runs without a tenant predicate', async () => {
    const { app, pool } = await createApp(() => TENANT_ADMIN);
    const res = await search(app);
    assert.equal(res.statusCode, 200, res.payload);
    assert.doesNotMatch(pool.calls[0].text, /organization_id/, pool.calls[0].text);
    await app.close();
  });

  it('a real tenant id still filters', async () => {
    const { app, pool } = await createApp(() => 7);
    const res = await search(app);
    assert.equal(res.statusCode, 200, res.payload);
    assert.match(pool.calls[0].text, /"organization_id" IN/, pool.calls[0].text);
    await app.close();
  });

  it('is a symbol: no tenant id can collide with it', () => {
    assert.equal(typeof TENANT_ADMIN, 'symbol');
  });
});

describe('tenant — tables with no scope in reach', () => {
  it('never consult getTenantId, so an anonymous request still reads them', async () => {
    let calls = 0;
    const { app } = await createApp(() => { calls++; return null; }, { scoped: false });
    const res = await search(app);
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(calls, 0);
    await app.close();
  });
});
