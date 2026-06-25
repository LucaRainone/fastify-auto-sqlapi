import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { createSqlApi } = await import(path.join(ROOT, 'dist/lib/sql-api.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { Type } = await import('@sinclair/typebox');

function createMockSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}

function createMockPool(responses = []) {
  let callIndex = 0;
  const calls = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      const response = responses[callIndex] || { rows: [], affectedRows: 0 };
      callIndex++;
      return Promise.resolve(response);
    },
  };
}

function createDbTables() {
  const customerSchema = createMockSchema('customer', {
    id: Type.Number(),
    name: Type.String(),
  });
  return {
    customer: {
      primary: 'id',
      ...exportTableInfo(customerSchema),
      defaultOrder: 'id',
    },
  };
}

describe('per-instance dialect isolation', () => {
  it('a mysql SqlApi keeps mysql quoting after a postgres SqlApi is created', async () => {
    const mysqlPool = createMockPool([{ rows: [], affectedRows: 0 }]);
    const pgPool = createMockPool();

    const mysqlApi = createSqlApi(mysqlPool, createDbTables(), { dialect: 'mysql' });
    // Creating a second instance with a different dialect must NOT affect the first one.
    createSqlApi(pgPool, createDbTables(), { dialect: 'postgres' });

    await mysqlApi.search('customer', { filters: { name: 'Mario' } });

    const sql = mysqlPool.calls[0].text;
    assert.ok(
      sql.includes('`name`'),
      `mysql instance must quote identifiers with backticks, got: ${sql}`
    );
    assert.ok(!sql.includes('"name"'), `mysql instance must not use postgres quoting, got: ${sql}`);
  });

  it('a postgres SqlApi keeps postgres quoting after a mysql SqlApi is created', async () => {
    const pgPool = createMockPool([{ rows: [], affectedRows: 0 }]);
    const mysqlPool = createMockPool();

    const pgApi = createSqlApi(pgPool, createDbTables(), { dialect: 'postgres' });
    createSqlApi(mysqlPool, createDbTables(), { dialect: 'mysql' });

    await pgApi.search('customer', { filters: { name: 'Mario' } });

    const sql = pgPool.calls[0].text;
    assert.ok(
      sql.includes('"name"'),
      `postgres instance must quote identifiers with double quotes, got: ${sql}`
    );
    assert.ok(!sql.includes('`name`'), `postgres instance must not use mysql quoting, got: ${sql}`);
  });
});
