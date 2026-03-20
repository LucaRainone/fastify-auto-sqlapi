import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { createSqlApi } = await import(path.join(ROOT, 'dist/lib/sql-api.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
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

function createMockPg(responses = []) {
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

const customerFields = {
  id: Type.Number(),
  name: Type.String(),
  email: Type.String(),
};

const orderFields = {
  id: Type.Number(),
  customerId: Type.Number(),
  total: Type.Number(),
  status: Type.String(),
};

function createTestFixture(mockPg) {
  const customerSchema = createMockSchema('customer', customerFields);
  const orderSchema = createMockSchema('customer_order', orderFields);

  const DbTables = {
    customer: {
      primary: 'id',
      ...exportTableInfo(customerSchema),
      defaultOrder: 'id',
      excludeFromCreation: ['id'],
      allowedReadJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId'),
      ],
      allowedWriteJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId'),
      ],
    },
    customer_order: {
      primary: 'id',
      ...exportTableInfo(orderSchema),
      defaultOrder: 'id',
      excludeFromCreation: ['id'],
    },
  };

  const db = new QueryClient(mockPg);
  const sqlApi = createSqlApi(db, DbTables);
  return { sqlApi, mockPg, DbTables };
}

describe('SqlApi.search', () => {
  it('searches with filters', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    const result = await sqlApi.search('customer', {
      filters: { name: 'Mario' },
    });

    assert.equal(result.main.length, 1);
    assert.equal(result.main[0].name, 'Mario');
    assert.ok(mockPg.calls[0].values.includes('Mario'));
  });

  it('searches with joinFilters', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    const result = await sqlApi.search('customer', {
      joinFilters: { customer_order: { status: 'pending' } },
    });

    assert.equal(result.main.length, 1);
    assert.ok(mockPg.calls[0].text.includes('EXISTS'));
    assert.ok(mockPg.calls[0].values.includes('pending'));
  });

  it('searches with pagination', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
      { rows: [{ total: '10' }], affectedRows: 1 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    const result = await sqlApi.search('customer', {
      paginator: { page: 1, itemsPerPage: 5 },
    });

    assert.ok(result.pagination);
    assert.equal(result.pagination.total, 10);
  });

  it('returns all records with empty params', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }, { id: 2 }], affectedRows: 2 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    const result = await sqlApi.search('customer');
    assert.equal(result.main.length, 2);
  });
});

describe('SqlApi.get', () => {
  it('gets a record by PK', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    const result = await sqlApi.get('customer', 1);
    assert.equal(result.main.id, 1);
    assert.equal(result.main.name, 'Mario');
  });

  it('throws 404 when not found', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    await assert.rejects(
      () => sqlApi.get('customer', 999),
      (err) => err.statusCode === 404
    );
  });
});

describe('SqlApi.insert', () => {
  it('inserts a record', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    const result = await sqlApi.insert('customer', {
      record: { name: 'Mario', email: 'm@t.it' },
    });

    assert.ok(result.main);
    assert.equal(result.main.id, 1);
    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('INSERT'));
    assert.ok(sql.includes('customer'));
  });
});

describe('SqlApi.delete', () => {
  it('deletes a record by PK', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    const result = await sqlApi.delete('customer', 1);
    assert.ok(result.main);
  });
});

describe('SqlApi.bulkDelete', () => {
  it('deletes multiple records', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 2 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    const result = await sqlApi.bulkDelete('customer', [1, 2]);
    assert.equal(result.length, 2);
  });
});

describe('SqlApi - error handling', () => {
  it('throws 400 for unknown table name', async () => {
    const mockPg = createMockPg([]);
    const { sqlApi } = createTestFixture(mockPg);

    await assert.rejects(
      () => sqlApi.search('nonexistent'),
      (err) => err.statusCode === 400 && err.message.includes('not found')
    );
  });
});
