import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
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
  createdAt: Type.String(),
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
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
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

  it('returns no joins, joinGroup, pagination when not requested', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
    });

    assert.equal(result.joinMultiple, undefined);
    assert.equal(result.joinGroup, undefined);
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
      joinMultiple: { customer_order: {} },
    });

    // Join query should use IN
    const joinCall = mockPg.calls[1];
    assert.ok(joinCall.text.includes('IN'));
    assert.ok(joinCall.text.includes('customer_order'));
    assert.ok(result.joinMultiple.customer_order);
    assert.equal(result.joinMultiple.customer_order.length, 1);
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
      joinMultiple: { customer_order: {} },
    });

    assert.deepEqual(result.joinMultiple.customer_order, []);
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
      joinMultiple: { customer_order: { filters: { status: 'pending' } } },
    });

    const joinCall = mockPg.calls[1];
    assert.ok(joinCall.values.includes('pending'));
  });
});

describe('searchEngine - joinMustExist (EXISTS)', () => {
  it('adds EXISTS subquery to main WHERE', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinMustExist: {
        customer_order: { filters: { status: 'pending' } },
      },
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('EXISTS'));
    assert.ok(sql.includes('SELECT 1 FROM "customer_order"'));
    assert.ok(sql.includes('"customer_id" = "customer"."id"'));
    assert.ok(mockPg.calls[0].values.includes('pending'));
  });

  it('combines main filters with joinMustExist', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      filters: { name: 'Mario' },
      joinMustExist: {
        customer_order: { filters: { status: 'pending' } },
      },
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('name'));
    assert.ok(sql.includes('EXISTS'));
    assert.ok(mockPg.calls[0].values.includes('Mario'));
    assert.ok(mockPg.calls[0].values.includes('pending'));
  });

  it('parameter indices are correct with main filters + joinMustExist', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      filters: { name: 'Mario', email: 'test@test.it' },
      joinMustExist: {
        customer_order: { filters: { status: 'pending', total: 100 } },
      },
    });

    const values = mockPg.calls[0].values;
    // Main filters first, then joinFilter values
    assert.equal(values.length, 4);
    assert.ok(values.includes('Mario'));
    assert.ok(values.includes('test@test.it'));
    assert.ok(values.includes('pending'));
    assert.ok(values.includes(100));
  });

  it('rejects joinMustExist for unknown alias with 400', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.customer,
        joinMustExist: {
          nonexistent_table: { filters: { foo: 'bar' } },
        },
      }),
      (err) => err.statusCode === 400 && /Unknown join alias/.test(err.message)
    );
  });

  it('works with pagination and joinMustExist', async () => {
    const mockPg = createMockPg([
      // Main query
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
      // COUNT query
      { rows: [{ total: '1' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinMustExist: {
        customer_order: { filters: { status: 'pending' } },
      },
      paginator: { page: 1, itemsPerPage: 10 },
    });

    // Both main and COUNT queries should include EXISTS
    assert.ok(mockPg.calls[0].text.includes('EXISTS'));
    assert.ok(mockPg.calls[1].text.includes('EXISTS'));
    assert.ok(result.pagination);
    assert.equal(result.pagination.total, 1);
  });
});

describe('searchEngine - conditions (advanced filters)', () => {
  it('applies isGreater condition', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      conditions: [
        { field: 'id', method: 'isGreater', params: [5] },
      ],
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('>'));
    assert.ok(mockPg.calls[0].values.includes(5));
  });

  it('applies multiple conditions on same field', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      conditions: [
        { field: 'id', method: 'isGreater', params: [1] },
        { field: 'id', method: 'isLess', params: [100] },
      ],
    });

    assert.ok(mockPg.calls[0].values.includes(1));
    assert.ok(mockPg.calls[0].values.includes(100));
  });

  it('applies isILike condition', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      conditions: [
        { field: 'name', method: 'isILike', params: ['%mario%'] },
      ],
    });

    assert.ok(mockPg.calls[0].values.includes('%mario%'));
  });

  it('applies isNull condition', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      conditions: [
        { field: 'email', method: 'isNull', params: [] },
      ],
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('IS NULL'));
  });

  it('applies isIn condition', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      conditions: [
        { field: 'id', method: 'isIn', params: [[1, 2, 3]] },
      ],
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('IN'));
  });

  it('applies isBetween condition', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      conditions: [
        { field: 'id', method: 'isBetween', params: [10, 50] },
      ],
    });

    assert.ok(mockPg.calls[0].values.includes(10));
    assert.ok(mockPg.calls[0].values.includes(50));
  });

  it('combines filters and conditions', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      filters: { name: 'Mario' },
      conditions: [
        { field: 'id', method: 'isGreater', params: [5] },
      ],
    });

    assert.ok(mockPg.calls[0].values.includes('Mario'));
    assert.ok(mockPg.calls[0].values.includes(5));
  });

  it('rejects unknown method (prototype poisoning)', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.customer,
        conditions: [
          { field: 'id', method: 'constructor', params: [] },
        ],
      }),
      (err) => err.statusCode === 400 && err.message.includes('Invalid condition method')
    );
  });

  it('rejects raw method', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.customer,
        conditions: [
          { field: 'id', method: 'raw', params: ['1=1; DROP TABLE--', []] },
        ],
      }),
      (err) => err.statusCode === 400
    );
  });

  it('rejects unknown field', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.customer,
        conditions: [
          { field: 'nonExistent', method: 'isEqual', params: [1] },
        ],
      }),
      (err) => err.statusCode === 400 && err.message.includes('Unknown field')
    );
  });

  it('isBetween with undefined "from" becomes <= "to"', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      conditions: [
        { field: 'id', method: 'isBetween', params: [undefined, 100] },
      ],
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('<='), `expected <= in: ${sql}`);
    assert.ok(mockPg.calls[0].values.includes(100));
    assert.ok(!mockPg.calls[0].values.includes(undefined));
  });

  it('isBetween with undefined "to" becomes >= "from"', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      conditions: [
        { field: 'id', method: 'isBetween', params: [50, undefined] },
      ],
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('>='), `expected >= in: ${sql}`);
    assert.ok(mockPg.calls[0].values.includes(50));
  });

  it('isBetween with both undefined is a noop', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      conditions: [
        { field: 'id', method: 'isBetween', params: [undefined, undefined] },
      ],
    });

    // No values should be added — condition is TRUE (noop)
    assert.equal(mockPg.calls[0].values.length, 0);
  });

  it('isEqual with undefined is a noop', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      conditions: [
        { field: 'name', method: 'isEqual', params: [undefined] },
      ],
    });

    assert.equal(mockPg.calls[0].values.length, 0);
  });

  it('isIn with undefined is a noop', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      conditions: [
        { field: 'id', method: 'isIn', params: [undefined] },
      ],
    });

    assert.equal(mockPg.calls[0].values.length, 0);
  });
});

describe('searchEngine - joinGroup', () => {
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
      joinGroup: {
        customer_order: {
          aggregations: { sum: ['total'] },
        },
      },
    });

    const groupCall = mockPg.calls[1];
    assert.ok(groupCall.text.includes('SUM'));
    assert.ok(groupCall.text.includes('customer_order'));
    assert.ok(result.joinGroup.customer_order);
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
      joinGroup: {
        customer_order: {
          aggregations: { by: 'status', sum: ['total'] },
        },
      },
    });

    const groupCall = mockPg.calls[1];
    assert.ok(groupCall.text.includes('GROUP BY'));
  });

  it('supports truncate-by on a timestamp field (postgres dialect)', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
      { rows: [{ by: '2026-04-01', sum_total: 100 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.customer,
      joinGroup: {
        customer_order: {
          aggregations: {
            by: { field: 'createdAt', truncate: 'month' },
            sum: ['total'],
          },
        },
      },
    });

    const groupCall = mockPg.calls[1];
    // Postgres-style DATE_TRUNC + TO_CHAR producing ISO date string
    assert.ok(groupCall.text.includes("DATE_TRUNC('month'"));
    assert.ok(groupCall.text.includes("TO_CHAR"));
    assert.ok(groupCall.text.includes('GROUP BY'));
  });

  it('rejects invalid truncate unit with 400', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.customer,
        joinGroup: {
          customer_order: {
            aggregations: { by: { field: 'createdAt', truncate: 'fortnight' }, sum: ['total'] },
          },
        },
      }),
      (err) => err.statusCode === 400 && /Invalid truncate unit/.test(err.message)
    );
  });

  it('rejects truncate-by on unknown field with 400', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', email: 'm@t.it' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.customer,
        joinGroup: {
          customer_order: {
            aggregations: { by: { field: 'bogus', truncate: 'month' }, sum: ['total'] },
          },
        },
      }),
      (err) => err.statusCode === 400 && /Unknown field/.test(err.message)
    );
  });
});

// ─── joinLeft (N:1 parent) ───────────────────────────────────

const userFields = {
  id: Type.Number(),
  name: Type.String(),
  role: Type.String(),
};

const sessionFields = {
  id: Type.Number(),
  userId: Type.Number(),
  active: Type.Boolean(),
};

function createSessionDbTables(mockPg) {
  const userSchema = createMockSchema('user', userFields);
  const sessionSchema = createMockSchema('session', sessionFields);
  const userInfo = exportTableInfo(userSchema);
  const sessionInfo = exportTableInfo(sessionSchema);

  const DbTables = {
    session: {
      primary: 'id',
      ...sessionInfo,
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(sessionSchema, 'userId', userSchema, 'id', {
          alias: 'creator',
          unique: true,
        }),
        buildRelation(sessionSchema, 'userId', userSchema, 'id', {
          alias: 'updater',
          unique: true,
          selection: 'id,name',
        }),
      ],
    },
    user: { primary: 'id', ...userInfo, defaultOrder: 'id' },
  };

  return { DbTables, db: new QueryClient(mockPg) };
}

describe('searchEngine - joinLeft (N:1 parent)', () => {
  it('does NOT add LEFT JOIN when no filter or 2-parti orderBy is requested', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, user_id: 7, active: true }], affectedRows: 1 },
      { rows: [{ id: 7, name: 'Alice', role: 'admin' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createSessionDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.session,
      joinLeft: { creator: {} },
    });

    assert.ok(!mockPg.calls[0].text.includes('LEFT JOIN'), 'main query has no LEFT JOIN');
    assert.ok(mockPg.calls[1].text.includes('FROM "user"'));
    assert.ok(result.joinLeft);
    assert.equal(result.joinLeft.creator.length, 1);
    assert.equal(result.joinLeft.creator[0].name, 'Alice');
  });

  it('adds LEFT JOIN when filter on parent is requested', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, user_id: 7, active: true }], affectedRows: 1 },
      { rows: [{ id: 7, name: 'Alice', role: 'admin' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createSessionDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.session,
      joinLeft: { creator: { filters: { role: 'admin' } } },
    });

    const mainSql = mockPg.calls[0].text;
    assert.ok(mainSql.includes('LEFT JOIN "user" AS "creator"'));
    assert.ok(mainSql.includes('"creator"."role"'));
    assert.ok(mockPg.calls[0].values.includes('admin'));
  });

  it('adds LEFT JOIN when 2-parti orderBy uses joinLeft alias', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, user_id: 7, active: true }], affectedRows: 1 },
      { rows: [{ id: 7, name: 'Alice', role: 'admin' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createSessionDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.session,
      joinLeft: { creator: {} },
      orderBy: 'creator.name ASC',
    });

    const mainSql = mockPg.calls[0].text;
    assert.ok(mainSql.includes('LEFT JOIN "user" AS "creator"'));
    assert.ok(mainSql.includes('ORDER BY "creator"."name" ASC'));
  });

  it('rejects joinLeft on non-unique alias with 400', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.customer,
        joinLeft: { customer_order: {} },
      }),
      (err) => err.statusCode === 400 && /unique:true/.test(err.message)
    );
  });

  it('rejects joinMultiple on unique alias with 400', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createSessionDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.session,
        joinMultiple: { creator: {} },
      }),
      (err) => err.statusCode === 400 && /joinLeft/.test(err.message)
    );
  });

  it('supports multiple aliases on the same table', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, user_id: 7, active: true }], affectedRows: 1 },
      // creator side query
      { rows: [{ id: 7, name: 'Alice', role: 'admin' }], affectedRows: 1 },
      // updater side query
      { rows: [{ id: 7, name: 'Alice' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createSessionDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.session,
      joinLeft: {
        creator: {},
        updater: {},
      },
    });

    assert.ok(result.joinLeft.creator);
    assert.ok(result.joinLeft.updater);
  });

  it('respects per-request selection override', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, user_id: 7, active: true }], affectedRows: 1 },
      { rows: [{ id: 7, name: 'Alice' }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createSessionDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.session,
      joinLeft: { creator: { selection: 'id,name' } },
    });

    const sideSql = mockPg.calls[1].text;
    assert.ok(sideSql.includes('"id"'));
    assert.ok(sideSql.includes('"name"'));
    assert.ok(!sideSql.includes('"role"'));
  });
});
