import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search.js'));
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

// Fixtures
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

function createTestDbTables(mockPg) {
  const customerSchema = createMockSchema('customer', customerFields);
  const orderSchema = createMockSchema('customer_order', orderFields);

  const customerInfo = exportTableInfo(customerSchema);
  const orderInfo = exportTableInfo(orderSchema);

  const DbTables = {
    customer: {
      primary: 'id',
      ...customerInfo,
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId'),
      ],
    },
    customer_order: {
      primary: 'id',
      ...orderInfo,
      defaultOrder: 'id',
    },
  };

  return { DbTables, db: new QueryClient(mockPg) };
}

describe('searchEngine - main query', () => {
  it('executes SELECT on main table', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
    });

    assert.equal(result.main.length, 1);
    assert.equal(result.main[0].id, 1);
    assert.equal(result.main[0].name, 'Mario');
    assert.ok(mockPg.calls[0].text.includes('FROM "customer"'));
    assert.ok(mockPg.calls[0].text.includes('ORDER BY'));
  });

  it('applies filters to WHERE clause', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      filters: { name: 'Mario' },
    });

    assert.ok(mockPg.calls[0].text.includes('name'));
    assert.ok(mockPg.calls[0].values.includes('Mario'));
  });

  it('applies custom orderBy', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      orderBy: 'name DESC',
    });

    assert.ok(mockPg.calls[0].text.includes('ORDER BY "name" DESC'));
  });

  it('applies multi-field orderBy', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      orderBy: 'id DESC, name ASC',
    });

    assert.ok(mockPg.calls[0].text.includes('ORDER BY "id" DESC, "name" ASC'));
  });

  it('rejects invalid orderBy field', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.customer,
        orderBy: 'nonExistent DESC',
      }),
      (err) => err.statusCode === 400 && err.message.includes('Unknown field')
    );
  });

  it('rejects SQL injection in orderBy', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.customer,
        orderBy: 'id; DROP TABLE customer; --',
      }),
      (err) => err.statusCode === 400
    );
  });

  it('returns no joins, joinGroups, pagination when not requested', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
    });

    assert.equal(result.joins, undefined);
    assert.equal(result.joinGroups, undefined);
    assert.equal(result.pagination, undefined);
  });
});

describe('searchEngine - pagination', () => {
  it('adds LIMIT/OFFSET and returns pagination', async () => {
    const mockPg = createMockPg([
      // Main query
      { rows: [{ id: 1, name: 'Mario', email: 'mario@test.it' }], affectedRows: 1 },
      // COUNT
      { rows: [{ total: '25' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      paginator: { page: 2, itemsPerPage: 10 },
    });

    // Main query should have LIMIT
    assert.ok(mockPg.calls[0].text.includes('LIMIT'));
    // COUNT query
    assert.ok(mockPg.calls[1].text.includes('COUNT(*)'));
    // Pagination result
    assert.ok(result.pagination);
    assert.equal(result.pagination.total, 25);
    assert.equal(result.pagination.pages, 3);
    assert.equal(result.pagination.paginator.page, 2);
    assert.equal(result.pagination.paginator.itemsPerPage, 10);
  });

  it('computes MIN/MAX/SUM/AVG when requested', async () => {
    const mockPg = createMockPg([
      // Main query
      { rows: [{ id: 1, name: 'A', email: 'a@t.it' }], affectedRows: 1 },
      // COUNT
      { rows: [{ total: '5' }], affectedRows: 1 },
      // MIN
      { rows: [{ value: 10 }], affectedRows: 1 },
      // MAX
      { rows: [{ value: 100 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      paginator: { page: 1, itemsPerPage: 10 },
      computeMin: 'id',
      computeMax: 'id',
    });

    assert.ok(result.pagination.computed);
    assert.ok(result.pagination.computed.min);
    assert.ok(result.pagination.computed.max);
    assert.equal(result.pagination.computed.min.id, 10);
    assert.equal(result.pagination.computed.max.id, 100);
  });
});

describe('searchEngine - no pagination', () => {
  it('does not add LIMIT/OFFSET without paginator', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
    });

    assert.ok(!mockPg.calls[0].text.includes('LIMIT'));
    assert.equal(mockPg.calls.length, 1); // no COUNT query
  });
});

describe('searchEngine - virtual joins', () => {
  it('executes SELECT IN for join table', async () => {
    const mockPg = createMockPg([
      // Main query: customer results
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }, { id: 2, name: 'Luigi', email: 'l@t.it' }], affectedRows: 2 },
      // Join query: orders
      { rows: [{ id: 10, customer_id: 1, total: 50, status: 'pending' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joins: { customer_order: {} },
    });

    // Join query should use IN
    const joinCall = mockPg.calls[1];
    assert.ok(joinCall.text.includes('IN'));
    assert.ok(joinCall.text.includes('customer_order'));
    assert.ok(result.joins.customer_order);
    assert.equal(result.joins.customer_order.length, 1);
  });

  it('returns empty array when main results have no matching IDs', async () => {
    const mockPg = createMockPg([
      // Main query: empty
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joins: { customer_order: {} },
    });

    assert.deepEqual(result.joins.customer_order, []);
    assert.equal(mockPg.calls.length, 1); // no join query
  });

  it('applies join filters', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joins: { customer_order: { filters: { status: 'pending' } } },
    });

    const joinCall = mockPg.calls[1];
    assert.ok(joinCall.values.includes('pending'));
  });
});

describe('searchEngine - joinGroups', () => {
  it('executes GROUP BY aggregation', async () => {
    const mockPg = createMockPg([
      // Main
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
      // JoinGroup aggregation
      { rows: [{ sum_total: 150 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinGroups: {
        customer_order: {
          aggregations: { sum: ['total'] },
        },
      },
    });

    const groupCall = mockPg.calls[1];
    assert.ok(groupCall.text.includes('SUM'));
    assert.ok(groupCall.text.includes('customer_order'));
    assert.ok(result.joinGroups.customer_order);
  });

  it('includes GROUP BY when "by" is specified', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
      { rows: [{ by: 'pending', sum_total: 100 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinGroups: {
        customer_order: {
          aggregations: { by: 'status', sum: ['total'] },
        },
      },
    });

    const groupCall = mockPg.calls[1];
    assert.ok(groupCall.text.includes('GROUP BY'));
  });
});
