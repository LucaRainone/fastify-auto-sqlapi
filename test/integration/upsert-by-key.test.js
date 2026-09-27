// An upsert writes only the row its declared key names — on both dialects (ADR 0021). MySQL's
// `ON DUPLICATE KEY UPDATE` fired on ANY unique index, so a row carrying another row's unique
// value updated that other row in silence, where PostgreSQL refused the write. Both now refuse.

import { describe, it, before, after, beforeEach } from 'node:test';
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

const tagSchema = {
  col: (f) => toUnderscore(f),
  fields: {
    id: Type.Optional(Type.Integer()),
    code: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
  },
  tableName: 'tag',
};
tagSchema.validation = Type.Object(tagSchema.fields);
tagSchema.partialValidation = Type.Object(tagSchema.fields);

function tagTable(keys) {
  return {
    tag: {
      primary: 'id',
      ...exportTableInfo(tagSchema),
      defaultOrder: 'id',
      upsertMap: new Map([[tagSchema, keys]]),
    },
  };
}

async function tags(db) {
  const res = await db.query(
    `SELECT ${db.qi('id')} AS id, ${db.qi('code')} AS code, ${db.qi('label')} AS label ` +
    `FROM ${db.qi('tag')} ORDER BY ${db.qi('code')}`
  );
  return res.rows;
}

for (const keys of [['id'], ['code']]) {
  describe(`[${DIALECT}] upsert by (${keys.join(', ')}) writes only the row its key names`, () => {
    let app;
    let db;
    let seeded;

    before(async () => {
      ({ app, db } = await createTestApp(tagTable(keys), { prefix: '/auto' }));
    });

    beforeEach(async () => {
      await cleanTables(db, ['tag']);
      await seedRows(db, 'tag', [{ code: 'a', label: 'A' }, { code: 'b', label: 'B' }]);
      seeded = await tags(db);
    });

    after(async () => {
      await app.close();
    });

    it('refuses a row whose other unique column belongs to another row', async () => {
      // By id: a new id carrying the code of row "a". By code: row "b" carrying the id of row "a".
      const item = keys[0] === 'id'
        ? { id: 999999, code: 'a', label: 'hijacked' }
        : { id: seeded[0].id, code: 'b', label: 'hijacked' };

      const res = await app.inject({ method: 'PUT', url: '/auto/bulk/tag', payload: [{ main: item }] });

      assert.equal(res.statusCode, 500, res.payload);
      assert.deepEqual(await tags(db), seeded, 'no row may change');
    });

    it('updates the row its key names', async () => {
      // An upsert row must be insertable: on PostgreSQL the NOT NULL `code` is checked before
      // the conflict, so the by-id item carries it too.
      const item = keys[0] === 'id'
        ? { id: seeded[1].id, code: 'b', label: 'B2' }
        : { code: 'b', label: 'B2' };

      const res = await app.inject({ method: 'PUT', url: '/auto/bulk/tag', payload: [{ main: item }] });

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(JSON.parse(res.payload)[0].main.id, seeded[1].id);
      assert.deepEqual(await tags(db), [seeded[0], { ...seeded[1], label: 'B2' }]);
    });
  });
}
