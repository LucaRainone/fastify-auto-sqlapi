// Regression test for the excludeFromCreation × beforeInsert ordering bug.
//
// A TEXT primary key with no DB default, listed in excludeFromCreation and
// generated server-side by beforeInsert, must reach the INSERT: before the fix
// the exclusion was applied after the hook, the generated id was stripped and
// the insert failed with a not-null violation. Uses the userAccount table
// (TEXT/VARCHAR PK, no default) — the exact consumer scenario.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALECT,
  createTestApp,
  cleanTables,
  exportTableInfo,
  Type,
} from './_helpers.js';

const userAccountFields = {
  id: Type.String(),
  userId: Type.String(),
  providerId: Type.String(),
  accountId: Type.String(),
  accessToken: Type.Optional(Type.String()),
  createdAt: Type.Optional(Type.String()),
  updatedAt: Type.Optional(Type.String()),
};

// DB columns are camelCase: identity colMap (same setup as camelcase-db.test.js)
const userAccountColMap = Object.fromEntries(
  Object.keys(userAccountFields).map((k) => [k, k])
);

const userAccountSchema = {
  col: (f) => userAccountColMap[f] ?? f,
  colMap: userAccountColMap,
  fields: userAccountFields,
  validation: Type.Object(userAccountFields),
  tableName: 'userAccount',
  partialValidation: Type.Object(userAccountFields),
};

let idCounter = 0;

const DbTables = {
  userAccount: {
    primary: 'id',
    ...exportTableInfo(userAccountSchema),
    defaultOrder: 'id',
    excludeFromCreation: ['id'],
    beforeInsert: async (_db, _req, record) => {
      // The consumer pattern: generate the id server-side when missing.
      // With the exclusion applied before the hook, it is always missing here.
      if (!record.id) record.id = `gen_${++idCounter}`;
    },
  },
};

describe(`[${DIALECT}] excludeFromCreation + beforeInsert-generated PK`, () => {
  let app;
  let db;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));
    await cleanTables(db, ['userAccount']);
  });

  after(async () => {
    await app.close();
  });

  async function countRowsById(id) {
    const res = await db.query(
      `SELECT ${db.qi('id')} FROM ${db.qi('userAccount')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
      [id]
    );
    return res.rows.length;
  }

  it('single insert without id succeeds with the hook-generated id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/userAccount',
      payload: {
        main: { userId: 'u_alpha', providerId: 'github', accountId: 'gh_1' },
      },
    });

    assert.equal(res.statusCode, 201, res.payload);
    const body = JSON.parse(res.payload);
    assert.match(body.main.id, /^gen_/, 'response must return the hook-generated id');
    assert.equal(await countRowsById(body.main.id), 1, 'row must exist with the generated id');
  });

  it('single insert with a client-supplied id ignores it and uses the hook id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/userAccount',
      payload: {
        main: { id: 'client_id', userId: 'u_beta', providerId: 'google', accountId: 'gg_1' },
      },
    });

    assert.equal(res.statusCode, 201, res.payload);
    const body = JSON.parse(res.payload);
    assert.match(body.main.id, /^gen_/);
    assert.notEqual(body.main.id, 'client_id');
    assert.equal(await countRowsById('client_id'), 0, 'client id must never reach the DB');
  });

  it('bulk upsert generates an id for every item and ignores client-supplied ones', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/bulk/userAccount',
      payload: [
        { main: { userId: 'u_gamma', providerId: 'github', accountId: 'gh_2' } },
        { main: { id: 'evil_id', userId: 'u_delta', providerId: 'google', accountId: 'gg_2' } },
      ],
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = JSON.parse(res.payload);
    assert.equal(body.length, 2);

    const ids = body.map((r) => r.main.id);
    for (const id of ids) {
      assert.match(id, /^gen_/, 'every item must get a hook-generated id');
      assert.equal(await countRowsById(id), 1, `row ${id} must exist`);
    }
    assert.equal(new Set(ids).size, 2, 'generated ids must be distinct');
    assert.equal(await countRowsById('evil_id'), 0, 'client id must never reach the DB');
  });
});
