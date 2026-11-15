// `validate` and `validateBulk` return the same objects a 400 carries in `fields`: `{ path,
// code }`. The code is what the client translates, so a hook writes no prose — `message`
// mirrors the code. The pre-1.0 tuples (`[path, code, message?]`) are refused as a programming
// error naming the new shape, never read positionally, and nothing is written.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { createSqlApi, defineTable, Type } = await import(path.join(ROOT, 'dist/index.js'));

const schema = createMockSchema('customer', { id: Type.Number(), name: Type.String() });

function createMockPool() {
  const calls = [];
  const pool = {
    calls,
    async connect() {
      return { query: (text, values) => pool.query(text, values), release() {} };
    },
    async query(text, values) {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
      calls.push(sql);
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
  };
  return pool;
}

function api(hooks) {
  const pool = createMockPool();
  const dbTables = { customer: defineTable({ primary: 'id', schema, insertExclude: ['id'], ...hooks }) };
  return { pool, sqlApi: createSqlApi(pool, dbTables, { dialect: 'postgres' }) };
}

const insert = (sqlApi) => sqlApi.insert('customer', { main: { name: '' } });
const bulkUpsert = (sqlApi) => sqlApi.bulkUpsert('customer', [{ main: { name: '' } }]);

describe('validate and validateBulk return { path, code } objects', () => {
  it('validate: each object is a field of the 400, message mirroring the code', async () => {
    const { sqlApi, pool } = api({ validate: () => [{ path: 'main.name', code: 'required' }] });
    await assert.rejects(() => insert(sqlApi), (err) => {
      assert.equal(err.statusCode, 400);
      assert.deepEqual(err.validationErrors, [{ path: 'main.name', code: 'required', message: 'required' }]);
      return true;
    });
    assert.equal(pool.calls.length, 0);
  });

  it('validateBulk: the same objects', async () => {
    const { sqlApi, pool } = api({ validateBulk: () => [{ path: 'items.0.main.name', code: 'empty' }] });
    await assert.rejects(() => bulkUpsert(sqlApi), (err) => {
      assert.equal(err.statusCode, 400);
      assert.deepEqual(err.validationErrors, [{ path: 'items.0.main.name', code: 'empty', message: 'empty' }]);
      return true;
    });
    assert.equal(pool.calls.length, 0);
  });

  it('an empty array lets the write through', async () => {
    const { sqlApi, pool } = api({ validate: () => [] });
    await insert(sqlApi);
    assert.equal(pool.calls.length, 1);
  });
});

describe('anything else a hook returns is a programming error, not a 400', () => {
  const cases = [
    ['a pre-1.0 tuple', [['main.name', 'required']], /\[0\].*\{ path, code \}/s],
    ['a tuple with a message', [['main.name', 'required', 'Name is required']], /\[0\].*\{ path, code \}/s],
    ['an object carrying a message', [{ path: 'main.name', code: 'required', message: 'Name is required' }], /\[0\].*'message'/s],
    ['an object without a code', [{ path: 'main.name' }], /\[0\].*code/s],
    ['a path that is not a string', [{ path: 3, code: 'required' }], /\[0\].*path/s],
    ['not an array', { path: 'main.name', code: 'required' }, /array/],
  ];
  for (const [hook, call] of [['validate', insert], ['validateBulk', bulkUpsert]]) {
    for (const [label, returned, pattern] of cases) {
      it(`${hook} returning ${label}`, async () => {
        const { sqlApi, pool } = api({ [hook]: () => returned });
        await assert.rejects(() => call(sqlApi), (err) => {
          assert.notEqual(err.statusCode, 400, 'a malformed hook result must not look like a client error');
          assert.match(err.message, new RegExp(`${hook}`));
          assert.match(err.message, pattern);
          return true;
        });
        assert.equal(pool.calls.length, 0);
      });
    }
  }
});
