// `createSqlApi` has one source for its dialect. A QueryClient carries its own, so a `dialect`
// option beside it is ambiguous and refused; a raw pool takes it from the option, `postgres`
// by default as in the plugin. The global ConditionBuilder dialect — the one an
// `extendedCondition` building its own builders gets — follows the dialect in effect.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, createMockSchema } from './_harness.js';

const { createSqlApi, createQueryClient, defineTable, ConditionBuilder, Type } =
  await import(path.join(ROOT, 'dist/index.js'));

const dbTables = {
  customer: defineTable({ primary: 'id', schema: createMockSchema('customer', { id: Type.Number(), name: Type.String() }) }),
};

function createMockPool() {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push(text.replace(/\s+/g, ' ').trim());
      return { rows: [], rowCount: 0 };
    },
  };
}

afterEach(() => { ConditionBuilder.DIALECT = 'postgres'; });

describe('createSqlApi — the dialect of a QueryClient', () => {
  it('comes from the client, and sets the global ConditionBuilder dialect', async () => {
    ConditionBuilder.DIALECT = 'postgres';
    const pool = createMockPool();
    const api = createSqlApi(createQueryClient(pool, 'mysql'), dbTables);
    assert.equal(ConditionBuilder.DIALECT, 'mysql');
    await api.search('customer', {});
    assert.match(pool.calls[0], /FROM `customer`/);
  });

  it('a dialect option beside it is refused, even when it agrees', () => {
    for (const dialect of ['postgres', 'mysql']) {
      assert.throws(
        () => createSqlApi(createQueryClient(createMockPool(), 'mysql'), dbTables, { dialect }),
        (err) => err instanceof TypeError && /QueryClient.*dialect/s.test(err.message)
      );
    }
  });
});

describe('createSqlApi — the dialect of a raw pool', () => {
  it('comes from the option', async () => {
    const pool = createMockPool();
    const api = createSqlApi(pool, dbTables, { dialect: 'mysql' });
    assert.equal(ConditionBuilder.DIALECT, 'mysql');
    await api.search('customer', {});
    assert.match(pool.calls[0], /FROM `customer`/);
  });

  it('is postgres without one, as in the plugin', async () => {
    ConditionBuilder.DIALECT = 'mysql';
    const pool = createMockPool();
    const api = createSqlApi(pool, dbTables);
    assert.equal(ConditionBuilder.DIALECT, 'postgres');
    await api.search('customer', {});
    assert.match(pool.calls[0], /FROM "customer"/);
  });

  it('an unknown dialect throws', () => {
    assert.throws(() => createSqlApi(createMockPool(), dbTables, { dialect: 'oracle' }), /dialect.*oracle/is);
  });
});
