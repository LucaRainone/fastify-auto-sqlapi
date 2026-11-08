// `action: 'inserted' | 'updated'` on bulk upsert items and on the single insert, against the
// real databases: PostgreSQL reads it off the upsert statement, MySQL/MariaDB off the probe
// their upsert-by-key starts with (ADR 0021). Covers the key being the PK, a natural key, and
// an upsert with nothing to update (the DO NOTHING path on PostgreSQL).

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
  primaryKey: ['id'],
  uniqueKeys: [['code']],
};
tagSchema.validation = Type.Object(tagSchema.fields);
tagSchema.partialValidation = Type.Object(tagSchema.fields);

function tagTable(keys) {
  return {
    tag: {
      primary: 'id',
      ...exportTableInfo(tagSchema),
      defaultOrder: 'id',
      ...(keys ? { upsertMap: new Map([[tagSchema, keys]]) } : {}),
    },
  };
}

for (const keys of [['code'], ['id'], undefined]) {
  const label = keys ? `upsert by (${keys.join(', ')})` : 'no upsert rule';
  describe(`[${DIALECT}] write action — ${label}`, () => {
    let app;
    let db;
    let seeded;

    before(async () => {
      ({ app, db } = await createTestApp(tagTable(keys), { prefix: '/auto' }));
    });

    beforeEach(async () => {
      await cleanTables(db, ['tag']);
      seeded = await seedRows(db, 'tag', [{ code: 'a', label: 'A' }, { code: 'b', label: 'B' }]);
    });

    after(async () => {
      await app.close();
    });

    const existing = (item) => (keys?.[0] === 'id' ? { id: seeded[0].id, ...item } : item);

    it('bulk: an existing row is updated, a new one inserted', async () => {
      // Without a rule a second 'a' would collide on the unique code: send a fresh one instead.
      const first = keys ? existing({ code: 'a', label: 'A2' }) : { code: 'x', label: 'X' };
      const res = await app.inject({
        method: 'PUT',
        url: '/auto/bulk/tag',
        payload: [{ main: first }, { main: { code: 'c', label: 'C' } }],
      });
      assert.equal(res.statusCode, 200, res.payload);
      const [firstResult, second] = res.json();
      if (keys) {
        assert.equal(firstResult.action, 'updated');
        assert.equal(firstResult.main.id, seeded[0].id);
      } else {
        assert.equal(firstResult.action, 'inserted');
      }
      assert.equal(second.action, 'inserted');
      assert.ok(second.main.id);
    });

    it('single insert: reports what the statement did', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auto/rest/tag',
        payload: { main: keys ? existing({ code: 'a', label: 'A3' }) : { code: 'd', label: 'D' } },
      });
      assert.equal(res.statusCode, 201, res.payload);
      assert.equal(res.json().action, keys ? 'updated' : 'inserted');
    });
  });
}

describe(`[${DIALECT}] write action — an upsert with nothing to update`, () => {
  let app;
  let db;
  let seeded;

  before(async () => {
    ({ app, db } = await createTestApp(tagTable(['code']), { prefix: '/auto' }));
  });

  beforeEach(async () => {
    await cleanTables(db, ['tag']);
    seeded = await seedRows(db, 'tag', [{ code: 'a', label: 'A' }]);
  });

  after(async () => {
    await app.close();
  });

  it('reports updated for the row it left untouched and inserted for the new one', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auto/bulk/tag',
      payload: [{ main: { code: 'a' } }, { main: { code: 'z' } }],
    });
    assert.equal(res.statusCode, 200, res.payload);
    const [kept, added] = res.json();
    assert.deepEqual(kept, { main: { id: seeded[0].id }, action: 'updated' });
    assert.equal(added.action, 'inserted');
    assert.notEqual(added.main.id, seeded[0].id);
  });
});
