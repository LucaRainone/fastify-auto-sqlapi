// Integration test for DB with camelCase column names (betterauth-style).
// Verifies that colMap-based conversion works end-to-end: search filters,
// orderBy, insert, update, hooks (camelCase to the user, camelCase to DB).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALECT,
  createTestApp,
  cleanTables,
  seedRows,
  exportTableInfo,
  Type,
} from './_helpers.js';

// Schema with a colMap that maps field names → actual camelCase DB column names.
// This mimics what the CLI generates when introspecting a DB whose columns are
// already camelCase. The field names in the schema ARE the DB column names.
const userAccountFields = {
  id: Type.String(),
  userId: Type.String(),
  providerId: Type.String(),
  accountId: Type.String(),
  accessToken: Type.Optional(Type.String()),
  createdAt: Type.Optional(Type.String()),
  updatedAt: Type.Optional(Type.String()),
};

const userAccountColMap = {
  id: 'id',
  userId: 'userId',
  providerId: 'providerId',
  accountId: 'accountId',
  accessToken: 'accessToken',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

const userAccountSchema = {
  col: (f) => userAccountColMap[f] ?? f,
  colMap: userAccountColMap,
  fields: userAccountFields,
  validation: Type.Object(userAccountFields),
  tableName: 'userAccount',
  partialValidation: Type.Object(userAccountFields),
};

const DbTables = {
  userAccount: {
    primary: 'id',
    ...exportTableInfo(userAccountSchema),
    defaultOrder: 'id',
  },
};

describe(`[${DIALECT}] camelCase DB columns — end-to-end`, () => {
  let app;
  let db;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, { prefix: '/auto' }));
    await cleanTables(db, ['userAccount']);

    await seedRows(db, 'userAccount', [
      { id: 'a1', userId: 'u_alpha', providerId: 'github',  accountId: 'gh_1' },
      { id: 'a2', userId: 'u_alpha', providerId: 'google',  accountId: 'gg_1' },
      { id: 'a3', userId: 'u_beta',  providerId: 'github',  accountId: 'gh_2' },
    ]);
  });

  after(async () => {
    await app.close();
  });

  it('search returns all rows with camelCase keys in response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/userAccount',
      payload: {},
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 3);
    // Response fields use camelCase (same as DB since they match)
    assert.ok(body.main.every((r) => typeof r.userId === 'string'));
    assert.ok(body.main.every((r) => typeof r.providerId === 'string'));
  });

  it('search filters by camelCase column', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/userAccount',
      payload: { filters: { userId: 'u_alpha' } },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 2);
    assert.ok(body.main.every((r) => r.userId === 'u_alpha'));
  });

  it('search conditions with rich methods on camelCase column', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/userAccount',
      payload: {
        conditions: [
          { field: 'providerId', method: 'isIn', params: [['github', 'google']] },
        ],
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.length, 3);
  });

  it('orderBy works on camelCase column (no case folding)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/search/userAccount?orderBy=userId%20DESC,%20id%20ASC',
      payload: {},
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    // u_beta comes before u_alpha on DESC
    assert.equal(body.main[0].userId, 'u_beta');
    assert.equal(body.main[1].userId, 'u_alpha');
    assert.equal(body.main[2].userId, 'u_alpha');
  });

  it('insert accepts camelCase body and persists to camelCase columns', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auto/rest/userAccount',
      payload: {
        main: {
          id: 'a_new',
          userId: 'u_gamma',
          providerId: 'github',
          accountId: 'gh_new',
          accessToken: 'tok_xyz',
        },
      },
    });

    assert.equal(res.statusCode, 201);

    // Verify via raw query using actual DB column names
    const check = await db.query(
      `SELECT ${db.qi('userId')}, ${db.qi('providerId')}, ${db.qi('accessToken')} FROM ${db.qi('userAccount')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
      ['a_new']
    );
    assert.equal(check.rows.length, 1);
    assert.equal(check.rows[0].userId, 'u_gamma');
    assert.equal(check.rows[0].providerId, 'github');
    assert.equal(check.rows[0].accessToken, 'tok_xyz');
  });

  it('update accepts camelCase body', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/rest/userAccount',
      payload: {
        main: { id: 'a1', accessToken: 'updated_tok' },
      },
    });

    assert.equal(res.statusCode, 200);

    const check = await db.query(
      `SELECT ${db.qi('accessToken')} FROM ${db.qi('userAccount')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
      ['a1']
    );
    assert.equal(check.rows[0].accessToken, 'updated_tok');
  });

  it('get by PK returns camelCase response', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auto/rest/userAccount/a2',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.main.id, 'a2');
    assert.equal(body.main.userId, 'u_alpha');
    assert.equal(body.main.providerId, 'google');
  });

  it('delete by PK works', async () => {
    // Seed a removable row
    await seedRows(db, 'userAccount', [
      { id: 'del_me', userId: 'u_x', providerId: 'gh', accountId: 'x' },
    ]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/auto/rest/userAccount/del_me',
    });

    assert.equal(res.statusCode, 200);

    const check = await db.query(
      `SELECT ${db.qi('id')} FROM ${db.qi('userAccount')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
      ['del_me']
    );
    assert.equal(check.rows.length, 0);
  });

  it('beforeInsert hook receives camelCase record and mutations propagate', async () => {
    let hookReceived = null;
    const hookedDbTables = {
      userAccount: {
        ...DbTables.userAccount,
        beforeInsert: async (_db, _req, record) => {
          hookReceived = { ...record };
          record.accessToken = 'injected_by_hook';
        },
      },
    };

    const { app: hookedApp, db: hookedDb } = await createTestApp(hookedDbTables, { prefix: '/auto' });
    try {
      const res = await hookedApp.inject({
        method: 'POST',
        url: '/auto/rest/userAccount',
        payload: {
          main: {
            id: 'hook_test',
            userId: 'u_hook',
            providerId: 'github',
            accountId: 'gh_hook',
          },
        },
      });

      assert.equal(res.statusCode, 201);

      // Hook received camelCase
      assert.equal(hookReceived.userId, 'u_hook');
      assert.equal(hookReceived.providerId, 'github');

      // Mutation reached the DB
      const check = await hookedDb.query(
        `SELECT ${hookedDb.qi('accessToken')} FROM ${hookedDb.qi('userAccount')} WHERE ${hookedDb.qi('id')} = ${hookedDb.ph(1)}`,
        ['hook_test']
      );
      assert.equal(check.rows[0].accessToken, 'injected_by_hook');
    } finally {
      await hookedDb.delete('userAccount', { id: 'hook_test' });
      await hookedApp.close();
    }
  });

  it('validate receives camelCase record', async () => {
    let validatedMain = null;
    const validatedDbTables = {
      userAccount: {
        ...DbTables.userAccount,
        validate: async (_db, _req, main) => {
          validatedMain = { ...main };
          return [];
        },
      },
    };

    const { app: vApp, db: vDb } = await createTestApp(validatedDbTables, { prefix: '/auto' });
    try {
      await vApp.inject({
        method: 'POST',
        url: '/auto/rest/userAccount',
        payload: {
          main: {
            id: 'val_test',
            userId: 'u_val',
            providerId: 'github',
            accountId: 'gh_val',
          },
        },
      });

      assert.equal(validatedMain.userId, 'u_val');
      assert.equal(validatedMain.providerId, 'github');
    } finally {
      await vDb.delete('userAccount', { id: 'val_test' });
      await vApp.close();
    }
  });
});
