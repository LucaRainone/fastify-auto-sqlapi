import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Expression } = await import('node-condition-builder');

function createMockClient() {
  const calls = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      return Promise.resolve({ rows: [{ id: 1 }], affectedRows: 1 });
    },
  };
}

describe('QueryClient.insert', () => {
  it('builds parameterized INSERT with RETURNING pk', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);

    await db.insert('customer', { name: 'Mario', email: 'mario@test.it' }, 'id');

    assert.ok(mock.calls[0].text.includes('"name", "email"'));
    assert.ok(mock.calls[0].text.includes('$1, $2'));
    assert.ok(mock.calls[0].text.includes('RETURNING "id"'));
    assert.deepEqual(mock.calls[0].values, ['Mario', 'mario@test.it']);
  });

  it('throws on empty values', async () => {
    const db = new QueryClient(createMockClient());
    await assert.rejects(() => db.insert('t', {}, 'id'), /empty insert/);
  });

  it('handles Expression as raw SQL', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);

    await db.insert('customer', {
      name: 'Mario',
      created_at: new Expression('NOW()'),
    }, 'id');

    assert.ok(mock.calls[0].text.includes('$1, NOW()'));
    assert.deepEqual(mock.calls[0].values, ['Mario']);
  });
});

describe('QueryClient.insert - composite PK', () => {
  it('RETURNING lists all composite PK columns', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);

    await db.insert('agent_team_link', { agent_id: 1, team_id: 2 }, ['agent_id', 'team_id']);

    assert.ok(mock.calls[0].text.includes('RETURNING "agent_id", "team_id"'));
  });

  it('returns composite PK result from RETURNING', async () => {
    const mock = {
      query(text, values) {
        return Promise.resolve({ rows: [{ agent_id: 1, team_id: 2 }], affectedRows: 1 });
      },
    };
    const db = new QueryClient(mock);

    const result = await db.insert('agent_team_link', { agent_id: 1, team_id: 2 }, ['agent_id', 'team_id']);

    assert.deepEqual(result, { agent_id: 1, team_id: 2 });
  });
});

describe('QueryClient.insertOrUpdate', () => {
  it('uses EXCLUDED for SET clause', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);

    await db.insertOrUpdate('customer', { id: 1, name: 'Mario' }, ['id'], 'id');

    assert.ok(mock.calls[0].text.includes('ON CONFLICT ("id")'));
    assert.ok(mock.calls[0].text.includes('"name" = EXCLUDED."name"'));
    assert.ok(!mock.calls[0].text.includes('"id" = EXCLUDED."id"'));
  });

  it('uses DO NOTHING when only conflict keys', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);

    await db.insertOrUpdate('customer', { id: 1 }, ['id'], 'id');

    assert.ok(mock.calls[0].text.includes('DO NOTHING'));
  });
});

describe('QueryClient.bulkInsert', () => {
  it('builds multi-row VALUES', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);

    await db.bulkInsert('product', [
      { name: 'A', price: 10 },
      { name: 'B', price: 20 },
    ], 'id');

    assert.ok(mock.calls[0].text.includes('($1, $2), ($3, $4)'));
    assert.deepEqual(mock.calls[0].values, ['A', 10, 'B', 20]);
  });

  it('returns empty array for empty input', async () => {
    const db = new QueryClient(createMockClient());
    const result = await db.bulkInsert('t', [], 'id');
    assert.deepEqual(result, []);
  });

  it('chunks large batches', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);
    const records = Array.from({ length: 5 }, (_, i) => ({ name: `r${i}` }));

    await db.bulkInsert('t', records, 'id', 2);

    assert.equal(mock.calls.length, 3); // 2+2+1
  });
});

describe('QueryClient.bulkInsert - composite PK', () => {
  it('RETURNING lists all composite PK columns', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);

    await db.bulkInsert('agent_team_link', [
      { agent_id: 1, team_id: 2 },
      { agent_id: 3, team_id: 4 },
    ], ['agent_id', 'team_id']);

    assert.ok(mock.calls[0].text.includes('RETURNING "agent_id", "team_id"'));
  });
});

describe('QueryClient.bulkInsertOrUpdate', () => {
  it('builds multi-row UPSERT with EXCLUDED', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);

    await db.bulkInsertOrUpdate(
      'product',
      [
        { id: 1, name: 'A', price: 10 },
        { id: 2, name: 'B', price: 20 },
      ],
      ['id'],
      'id'
    );

    assert.ok(mock.calls[0].text.includes('ON CONFLICT ("id")'));
    assert.ok(mock.calls[0].text.includes('"name" = EXCLUDED."name"'));
    assert.ok(mock.calls[0].text.includes('"price" = EXCLUDED."price"'));
  });
});

describe('QueryClient.update', () => {
  it('builds parameterized UPDATE and returns affectedRows', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);

    const result = await db.update('customer', { name: 'Luigi' }, { id: 1 });

    assert.ok(mock.calls[0].text.includes('SET "name" = $1'));
    assert.ok(mock.calls[0].text.includes('WHERE "id" = $2'));
    assert.deepEqual(mock.calls[0].values, ['Luigi', 1]);
    assert.equal(result, 1);
  });

  it('does not include RETURNING', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);

    await db.update('customer', { name: 'Luigi' }, { id: 1 });

    assert.ok(!mock.calls[0].text.includes('RETURNING'));
  });
});

describe('QueryClient.delete', () => {
  it('builds parameterized DELETE and returns affectedRows', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);

    const result = await db.delete('customer', { id: 1 });

    assert.ok(mock.calls[0].text.includes('DELETE FROM "customer"'));
    assert.ok(mock.calls[0].text.includes('"id" = $1'));
    assert.ok(!mock.calls[0].text.includes('RETURNING'));
    assert.equal(result, 1);
  });
});

describe('QueryClient.select', () => {
  it('builds SELECT with parts', async () => {
    const mock = createMockClient();
    const db = new QueryClient(mock);

    await db.select({
      tableName: 'customer',
      where: '1=1',
      values: [],
      orderBy: 'name ASC',
      limit: '10',
      distinct: true,
    });

    assert.ok(mock.calls[0].text.includes('SELECT DISTINCT'));
    assert.ok(mock.calls[0].text.includes('ORDER BY name ASC'));
    assert.ok(mock.calls[0].text.includes('LIMIT 10'));
  });
});
