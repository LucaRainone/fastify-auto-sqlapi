import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg } from './_harness.js';

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


const userFields = {
  id: Type.Number(),
  name: Type.String(),
  active: Type.Boolean(),
};

const sessionFields = {
  id: Type.Number(),
  userId: Type.Number(),
  duration: Type.Number(),
  status: Type.String(),
};

function createTestDbTables(mockPg, opts = {}) {
  const userSchema = createMockSchema('user', userFields);
  const sessionSchema = createMockSchema('session', sessionFields);

  const userInfo = exportTableInfo(userSchema);
  const sessionInfo = exportTableInfo(sessionSchema);

  const DbTables = {
    user: {
      primary: 'id',
      ...userInfo,
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(userSchema, 'id', sessionSchema, 'userId', { alias: 'session' }),
      ],
      ...(opts.distinctResults ? { distinctResults: true } : {}),
    },
    session: {
      primary: 'id',
      ...sessionInfo,
      defaultOrder: 'id',
    },
  };

  return { DbTables, db: new QueryClient(mockPg) };
}

describe('orderBy - aggregation on joinGroup', () => {
  it('generates scalar subquery for simple sum aggregation', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 }, // main query
      { rows: [{ sum_duration: 300 }], affectedRows: 0 }, // joinGroup
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      orderBy: 'session.sum.duration DESC',
      joinGroup: {
        session: { aggregations: { sum: ['duration'] } },
      },
    });

    const mainSql = mockPg.calls[0].text;
    assert.ok(mainSql.includes('ORDER BY'), 'ORDER BY present');
    assert.ok(mainSql.includes('SELECT SUM("session"."duration")'), `main SQL should contain SUM subquery, got: ${mainSql}`);
    assert.ok(mainSql.includes('FROM "session"'), 'subquery references session table');
    assert.ok(mainSql.includes('"session"."user_id" = "user"."id"'), `correlation present, got: ${mainSql}`);
    assert.ok(mainSql.match(/DESC/), 'DESC direction');
  });

  it('preserves plain field orderBy (regression)', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      orderBy: 'name ASC',
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.match(/ORDER BY "user"."name" ASC/));
  });

  it('supports multi-part orderBy mixing plain and aggregation', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
      { rows: [{ sum_duration: 0 }], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      orderBy: 'session.sum.duration DESC, name ASC',
      joinGroup: {
        session: { aggregations: { sum: ['duration'] } },
      },
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('DESC'), 'DESC for agg');
    assert.ok(sql.includes('"name" ASC'), 'ASC for plain field');
    // Plain field comes after the agg expression
    const descIdx = sql.indexOf('DESC');
    const nameIdx = sql.indexOf('"name" ASC');
    assert.ok(descIdx < nameIdx, 'order preserved');
  });

  it('propagates joinGroup filters into the subquery with correct placeholders', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
      { rows: [{ sum_duration: 0 }], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      filters: { active: true }, // takes $1
      orderBy: 'session.sum.duration DESC',
      joinGroup: {
        session: {
          aggregations: { sum: ['duration'] },
          filters: { status: 'completed' },
        },
      },
    });

    const mainCall = mockPg.calls[0];
    const sql = mainCall.text;
    // Subquery includes filter on status with $2 (because $1 is the main WHERE active filter)
    assert.ok(sql.includes('"status" = $2'), `placeholder $2 on status present, got: ${sql}`);
    // Values order: [main WHERE values, orderBy subquery filter values]
    assert.deepEqual(mainCall.values, [true, 'completed']);
  });

  it('supports avg aggregation', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
      { rows: [{ avg_duration: 150 }], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      orderBy: 'session.avg.duration DESC',
      joinGroup: { session: { aggregations: { avg: ['duration'] } } },
    });

    assert.ok(mockPg.calls[0].text.includes('AVG("session"."duration")'));
  });

  it('supports count aggregation', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
      { rows: [{ count_id: 3 }], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      orderBy: 'session.count.id DESC',
      joinGroup: { session: { aggregations: { count: ['id'] } } },
    });

    assert.ok(mockPg.calls[0].text.includes('COUNT("session"."id")'));
  });

  it('supports distinctCount aggregation', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
      { rows: [{ distinctCount_status: 2 }], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      orderBy: 'session.distinctCount.status DESC',
      joinGroup: { session: { aggregations: { distinctCount: ['status'] } } },
    });

    assert.ok(mockPg.calls[0].text.includes('COUNT(DISTINCT "session"."status")'));
  });

  it('rejects orderBy when joinGroup not declared', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.user,
        orderBy: 'session.sum.duration DESC',
        // no joinGroup
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /undeclared joinGroup/);
        return true;
      }
    );
  });

  it('rejects orderBy when aggregation fn/field not declared', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.user,
        orderBy: 'session.sum.duration DESC',
        joinGroup: {
          session: { aggregations: { sum: ['id'] } }, // duration not listed
        },
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /undeclared aggregation/);
        return true;
      }
    );
  });

  it('rejects orderBy when joinGroup has by on a non-FK column', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.user,
        orderBy: 'session.sum.duration DESC',
        joinGroup: {
          session: { aggregations: { sum: ['duration'], by: 'status' } },
        },
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /non-FK column/);
        return true;
      }
    );
  });

  it('accepts orderBy when joinGroup has by on the correlation FK (userId)', async () => {
    // When `by` equals the correlation FK, each main row maps to exactly one
    // group → the scalar subquery for ORDER BY is still well-defined.
    const mockPg = createMockPg([
      { rows: [{ id: 1 }, { id: 2 }], affectedRows: 0 }, // main query (non-empty so joinGroup runs)
      { rows: [{ count_id: 3, by: 1 }], affectedRows: 0 }, // joinGroup with by
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      orderBy: 'session.count.id DESC',
      joinGroup: {
        session: { aggregations: { count: ['id'], by: 'userId' } },
      },
    });

    // Main query should still generate the scalar subquery
    const mainSql = mockPg.calls[0].text;
    assert.ok(mainSql.includes('COUNT("session"."id")'), `main SQL should contain COUNT subquery, got: ${mainSql}`);
    assert.ok(mainSql.includes('"session"."user_id" = "user"."id"'), 'correlation present');
    // joinGroup query should have GROUP BY (separate query, behavior unchanged)
    const groupSql = mockPg.calls[1].text;
    assert.ok(groupSql.includes('GROUP BY'), 'joinGroup query has GROUP BY');
  });

  it('rejects unknown join table in orderBy', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.user,
        orderBy: 'unknown_table.sum.foo DESC',
        joinGroup: { unknown_table: { aggregations: { sum: ['foo'] } } },
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /Unknown join alias/);
        return true;
      }
    );
  });

  it('rejects invalid aggregation function', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.user,
        orderBy: 'session.bogus.duration DESC',
        joinGroup: { session: { aggregations: { sum: ['duration'] } } },
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /Invalid aggregation function/);
        return true;
      }
    );
  });

  it('rejects unknown field on join schema', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    // The error is thrown when validateSchemaField runs on the join schema.
    // However since we also validate that 'bogus' is declared in aggregations.sum first,
    // we must declare it to reach the schema validation.
    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.user,
        orderBy: 'session.sum.bogus DESC',
        joinGroup: { session: { aggregations: { sum: ['bogus'] } } },
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /Unknown field/);
        return true;
      }
    );
  });

  it('rejects when distinctResults is true', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg, { distinctResults: true });

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.user,
        orderBy: 'session.sum.duration DESC',
        joinGroup: { session: { aggregations: { sum: ['duration'] } } },
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /distinctResults/);
        return true;
      }
    );
  });

  it('still runs executeJoinGroups to populate breakdown', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }, { id: 2 }], affectedRows: 0 }, // main
      { rows: [{ sum_duration: 450 }], affectedRows: 0 }, // joinGroup
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      orderBy: 'session.sum.duration DESC',
      joinGroup: { session: { aggregations: { sum: ['duration'] } } },
    });

    // joinGroup still populated in response
    assert.ok(result.joinGroup);
    assert.ok(result.joinGroup.session);
    // 2 queries: main + joinGroup breakdown
    assert.equal(mockPg.calls.length, 2);
  });
});

describe('conditions - aggregation on joinGroup (HAVING-style)', () => {
  it('translates dotted field condition into scalar subquery', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      conditions: [
        { field: 'session.count.id', method: 'isEqual', params: [4] },
      ],
      joinGroup: {
        session: { aggregations: { count: ['id'] } },
      },
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('COUNT("session"."id")'), `main SQL should contain COUNT subquery, got: ${sql}`);
    assert.ok(sql.includes('"session"."user_id" = "user"."id"'), 'correlation present');
    assert.ok(sql.match(/=\s*\$\d+/), 'equality operator with placeholder');
    // values: [4] (no joinGroup filters, no plain WHERE)
    assert.deepEqual(mockPg.calls[0].values, [4]);
  });

  it('combines plain conditions and aggregation conditions', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      conditions: [
        { field: 'name', method: 'isILike', params: ['%mario%'] },
        { field: 'session.count.id', method: 'isGreater', params: [2] },
      ],
    // Declare the joinGroup so the dotted condition is allowed
      joinGroup: {
        session: { aggregations: { count: ['id'] } },
      },
    });

    const sql = mockPg.calls[0].text;
    const values = mockPg.calls[0].values;
    // Plain condition bound first (WHERE), then agg subquery values, then operand
    assert.ok(sql.includes('ILIKE'), 'plain ILIKE present');
    assert.ok(sql.includes('COUNT("session"."id")'), 'agg subquery present');
    assert.deepEqual(values, ['%mario%', 2]);
  });

  it('respects joinGroup filters in subquery when conditions reference them', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      conditions: [
        { field: 'session.count.id', method: 'isGreaterOrEqual', params: [4] },
      ],
      joinGroup: {
        session: {
          aggregations: { count: ['id'] },
          filters: { status: 'active' },
        },
      },
    });

    const sql = mockPg.calls[0].text;
    const values = mockPg.calls[0].values;
    // Subquery contains the status filter, and values include 'active' before the 4
    assert.ok(sql.includes('"status" = $1'), `status filter with $1 present, got: ${sql}`);
    assert.deepEqual(values, ['active', 4]);
  });

  it('supports isBetween on aggregation', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      conditions: [
        { field: 'session.sum.duration', method: 'isBetween', params: [100, 500] },
      ],
      joinGroup: {
        session: { aggregations: { sum: ['duration'] } },
      },
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('BETWEEN'), 'BETWEEN present');
    assert.deepEqual(mockPg.calls[0].values, [100, 500]);
  });

  it('supports isIn on aggregation', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      conditions: [
        { field: 'session.count.id', method: 'isIn', params: [[1, 3, 5]] },
      ],
      joinGroup: {
        session: { aggregations: { count: ['id'] } },
      },
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('IN ('), 'IN operator present');
    assert.deepEqual(mockPg.calls[0].values, [1, 3, 5]);
  });

  it('rejects aggregation condition when joinGroup not declared', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.user,
        conditions: [
          { field: 'session.count.id', method: 'isEqual', params: [4] },
        ],
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /undeclared joinGroup/);
        return true;
      }
    );
  });

  it('rejects invalid method on aggregation condition', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg);

    await assert.rejects(
      () => searchEngine(DbTables, {
        db,
        tableConf: DbTables.user,
        conditions: [
          { field: 'session.count.id', method: 'raw', params: [] },
        ],
        joinGroup: {
          session: { aggregations: { count: ['id'] } },
        },
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /Invalid condition method/);
        return true;
      }
    );
  });
});

describe('executeJoinGroups - avg and count', () => {
  it('handles avg aggregation', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 0 }, // main
      { rows: [{ avg_duration: 150 }], affectedRows: 0 }, // joinGroup
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      joinGroup: { session: { aggregations: { avg: ['duration'] } } },
    });

    const groupSql = mockPg.calls[1].text;
    assert.ok(groupSql.includes('AVG("session"."duration")'));
    assert.ok(result.joinGroup.session.avg);
    assert.equal(result.joinGroup.session.avg.duration, 150);
  });

  it('handles count aggregation', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 0 },
      { rows: [{ count_id: 5 }], affectedRows: 0 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg);

    const result = await searchEngine(DbTables, {
      db,
      tableConf: DbTables.user,
      joinGroup: { session: { aggregations: { count: ['id'] } } },
    });

    const groupSql = mockPg.calls[1].text;
    assert.ok(groupSql.includes('COUNT("session"."id")'));
    assert.equal(result.joinGroup.session.count.id, 5);
  });
});
