// The tenant scope of a standalone `createSqlApi` (AGENTS_BACKEND.md, "sqlApi").
//
// `app.sqlApi` gets the plugin's `getTenantId`. A standalone SqlApi has only its own option:
// without `getTenantId`, a request passed in resolves no tenant and a scoped table is not
// filtered — the request alone does not scope anything.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockPg, createMockSchema } from './_harness.js';

const { createSqlApi, defineTable, Type } = await import(path.join(ROOT, 'dist/index.js'));

const SchemaItem = createMockSchema('item', {
  id: Type.Optional(Type.Integer()),
  orgId: Type.Integer(),
});

const dbTables = () => ({
  item: defineTable({ primary: 'id', schema: SchemaItem, tenantScope: { column: 'orgId' } }),
});

describe('createSqlApi and the tenant scope', () => {
  it('without getTenantId, a scoped table is searched unfiltered even when a request is passed', async () => {
    const pool = createMockPg([{ rows: [] }]);
    await createSqlApi(pool, dbTables()).search('item', {}, { headers: {} });
    assert.doesNotMatch(pool.calls[0].text, /org_id/);
  });

  it('with getTenantId, the same search is filtered to the tenant', async () => {
    const pool = createMockPg([{ rows: [] }]);
    await createSqlApi(pool, dbTables(), { getTenantId: () => 9 }).search('item', {}, { headers: {} });
    assert.match(pool.calls[0].text, /"org_id" IN \(\$1\)/);
    assert.deepEqual(pool.calls[0].values, [9]);
  });
});
