// Direct (single-column) tenantScope against a real database: an upsert must not be able to
// claim a row whose owner column is NULL. The unit test pins the SQL; this pins what the
// database actually does — a NULL owner is nobody's, so it must be flagged as a foreign
// conflict (403), never silently claimed and overwritten by the caller.
//
// Mirrors the anyOf integration test's NULL coverage, for the single-column path.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALECT,
  createTestApp,
  cleanTables,
  seedRows,
  exportTableInfo,
  toUnderscore,
  Type,
} from './_helpers.js';

function createSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}

const customerSchema = createSchema('customer', {
  id: Type.Optional(Type.Integer()),
  name: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
  organizationId: Type.Optional(Type.Integer()),
});

const DbTables = {
  customer: {
    primary: 'id',
    ...exportTableInfo(customerSchema),
    defaultOrder: 'id',
    tenantScope: { column: 'organization_id' },
    // Conflict on the primary key: it has a real UNIQUE index, so a colliding insert reaches
    // ON CONFLICT (id) DO UPDATE and would genuinely claim/overwrite the existing row unless the
    // ownership probe stops it first.
    upsertMap: new Map([[customerSchema, ['id']]]),
  },
};

const ORPHAN_ID = 4242;

// `x-org: admin` (or absent) is the admin bypass; otherwise the header is the caller's org id.
const pluginOpts = {
  prefix: '/auto',
  getTenantId: (request) => {
    const header = request.headers['x-org'];
    if (!header || header === 'admin') return null;
    return Number(header);
  },
};

const as = (org, payload) => ({
  headers: org ? { 'x-org': String(org) } : {},
  payload,
});

describe(`[${DIALECT}] tenantScope direct — upsert cannot claim a NULL-owner row`, () => {
  let app;
  let db;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, pluginOpts));
    // customer_order FKs to customer, so the child must be cleared first.
    await cleanTables(db, ['customer_order', 'customer']);
    // An orphan row: it belongs to no tenant (organization_id IS NULL) and is therefore
    // invisible to every tenant on reads.
    await seedRows(db, 'customer', [
      { id: ORPHAN_ID, name: 'Orphan', email: 'orphan@example.com', organization_id: null },
    ]);
  });

  after(async () => {
    await app.close();
  });

  it('rejects (403) an upsert whose conflict target is an unowned (NULL-owner) row', async () => {
    // Without the fix the ownership probe misses the NULL owner, the upsert reaches
    // ON CONFLICT (id) DO UPDATE and claims the row → 200. It must be rejected instead.
    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/customer',
      ...as(42, { main: { id: ORPHAN_ID, name: 'Claimed' } }),
    });
    assert.equal(res.statusCode, 403, res.body);
  });

  it('leaves the NULL-owner row untouched after the rejected upsert', async () => {
    const { rows } = await db.query(
      `SELECT organization_id, name FROM ${db.qi('customer')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
      [ORPHAN_ID],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].organization_id, null, 'the orphan row must not have been claimed');
    assert.equal(rows[0].name, 'Orphan', 'the orphan row must not have been overwritten');
  });
});
