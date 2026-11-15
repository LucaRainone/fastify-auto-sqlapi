import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { createSqlApi } = await import(path.join(ROOT, 'dist/lib/sql-api.js'));
const { buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import(path.join(ROOT, 'dist/index.js'));

function createMockSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
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

  const dbTables = {
    customer: {
      primary: 'id',
      schema: customerSchema,
      defaultOrder: 'id',
      insertExclude: ['id'],
      readJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
      ],
      writeJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
      ],
    },
    customer_order: {
      primary: 'id',
      schema: orderSchema,
      defaultOrder: 'id',
      insertExclude: ['id'],
    },
  };

  const db = new QueryClient(mockPg);
  const sqlApi = createSqlApi(db, dbTables);
  return { sqlApi, mockPg, dbTables };
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

  it('searches with joinMustExist', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    const result = await sqlApi.search('customer', {
      joinMustExist: { customer_order: { filters: { status: 'pending' } } },
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
      main: { name: 'Mario', email: 'm@t.it' },
    });

    assert.ok(result.main);
    assert.equal(result.main.id, 1);
    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('INSERT'));
    assert.ok(sql.includes('customer'));
  });
});

describe('sqlApi writes take the HTTP body', () => {
  it('insert takes the main row as `main`, as POST /rest/:table does', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    const body = { main: { name: 'Mario', email: 'm@t.it' } };
    const result = await sqlApi.insert('customer', body);

    assert.equal(result.main.id, 1);
    assert.match(mockPg.calls[0].text, /INSERT/);
    assert.ok(mockPg.calls[0].values.includes('Mario'), 'the main row was not written');
  });

  it('update takes the main row as `main`, as PUT /rest/:table does', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    const result = await sqlApi.update('customer', { main: { id: 1, email: 'new@t.it' } });

    assert.equal(result.main.id, 1);
    const update = mockPg.calls.find((c) => /UPDATE/.test(c.text));
    assert.ok(update, 'no UPDATE was run');
    assert.ok(update.values.includes('new@t.it'), 'the main row was not written');
  });

  for (const method of ['insert', 'update']) {
    it(`${method} without \`main\` is refused, naming the key, before any SQL`, async () => {
      const mockPg = createMockPg([]);
      const { sqlApi } = createTestFixture(mockPg);

      await assert.rejects(
        () => sqlApi[method]('customer', { record: { id: 1, name: 'Mario' } }),
        /`main`/
      );
      assert.equal(mockPg.calls.length, 0);
    });
  }
});

describe('sqlApi.bulkDelete takes the HTTP body', () => {
  it('deletes the ids listed under `ids`, as POST /bulk/:table/delete does', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }, { id: 2 }], affectedRows: 2 },
    ]);
    const { sqlApi } = createTestFixture(mockPg);

    const result = await sqlApi.bulkDelete('customer', { ids: [1, 2] });

    assert.equal(result.length, 2);
    const del = mockPg.calls.find((c) => /DELETE/.test(c.text));
    assert.deepEqual(del.values, [1, 2]);
  });

  it('a bare array of ids is refused, naming `ids`, before any SQL', async () => {
    const mockPg = createMockPg([]);
    const { sqlApi } = createTestFixture(mockPg);

    await assert.rejects(() => sqlApi.bulkDelete('customer', [1, 2]), /`ids`/);
    assert.equal(mockPg.calls.length, 0);
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

    const result = await sqlApi.bulkDelete('customer', { ids: [1, 2] });
    assert.equal(result.length, 2);
  });
});

describe('SqlApi - error handling', () => {
  it('an unknown table name is a programming error, not a 400', async () => {
    const mockPg = createMockPg([]);
    const { sqlApi } = createTestFixture(mockPg);

    await assert.rejects(
      () => sqlApi.search('nonexistent'),
      (err) => err.statusCode === undefined && err.message.includes("'nonexistent' is not a key of dbTables")
    );
  });
});
