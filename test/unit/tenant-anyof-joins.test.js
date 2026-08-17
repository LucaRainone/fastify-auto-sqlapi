// An anyOf scope has to cross joins exactly as a single-column one does. A relation IS a read
// grant on its target, so a join that dropped the predicate would hand out rows nobody declared
// visible — the whole point of `tenantScope` being a cap rather than a per-request default.
//
// `shift` (main, unscoped: the roster is deliberately public) reads `shift_swap_request` — the
// reason somebody wants to change the roster is not public — through the alias `swap`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import('@sinclair/typebox');

const shiftFields = { id: Type.Number(), agentId: Type.Number(), day: Type.String() };
const swapFields = {
  id: Type.Number(),
  shiftId: Type.Number(),
  requesterAgentId: Type.Number(),
  targetAgentId: Type.Number(),
  message: Type.String(),
};

const SCOPE = { anyOf: ['requester_agent_id', 'target_agent_id'] };
const TENANT = { ids: [7], scope: SCOPE };

function createDbTables(mockPg) {
  const shiftSchema = createMockSchema('shift', shiftFields);
  const swapSchema = createMockSchema('shift_swap_request', swapFields);

  return {
    db: new QueryClient(mockPg),
    DbTables: {
      shift: {
        primary: 'id',
        ...exportTableInfo(shiftSchema),
        defaultOrder: 'id',
        allowedReadJoins: [
          buildRelation(shiftSchema, 'id', swapSchema, 'shiftId', { alias: 'swap' }),
          buildRelation(shiftSchema, 'id', swapSchema, 'shiftId', { alias: 'one_swap', unique: true }),
        ],
      },
      shift_swap_request: {
        primary: 'id',
        ...exportTableInfo(swapSchema),
        defaultOrder: 'id',
        tenantScope: SCOPE,
      },
    },
  };
}

/** The ON clause of the LEFT JOIN: from `LEFT JOIN` to the statement's own WHERE. */
function leftJoinClause(sql) {
  const start = sql.indexOf('LEFT JOIN');
  assert.notEqual(start, -1, `expected a LEFT JOIN in: ${sql}`);

  let depth = 0;
  for (let i = start; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
    else if (depth === 0 && sql.startsWith(' WHERE ', i)) return sql.slice(start, i);
  }
  return sql.slice(start);
}

describe('anyOf scope across a joinMultiple side query', () => {
  it('scopes the side query on both columns', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },  // main
      { rows: [], affectedRows: 0 },           // side query
    ]);
    const { db, DbTables } = createDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.shift,
      joinMultiple: { swap: {} },
      tenant: TENANT,
    });

    const side = mockPg.calls[1].text;
    assert.ok(side.includes('"requester_agent_id" IN'), side);
    assert.ok(side.includes('"target_agent_id" IN'), side);
    assert.ok(mockPg.calls[1].values.filter((v) => v === 7).length === 2, mockPg.calls[1].values);
  });
});

describe('anyOf scope across a joinLeft', () => {
  it('scopes the joined table in the ON clause, alias-qualified', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { db, DbTables } = createDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.shift,
      joinLeft: { one_swap: { filters: { message: 'dentist' } } },
      tenant: TENANT,
    });

    const on = leftJoinClause(mockPg.calls[0].text);
    assert.ok(on.includes('"one_swap"."requester_agent_id"'), `got: ${on}`);
    assert.ok(on.includes('"one_swap"."target_agent_id"'), `got: ${on}`);
  });

  it('keeps the predicate out of the WHERE, so LEFT semantics survive', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { db, DbTables } = createDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.shift,
      joinLeft: { one_swap: { filters: { message: 'dentist' } } },
      tenant: TENANT,
    });

    const sql = mockPg.calls[0].text;
    const whereOnwards = sql.slice(sql.indexOf(' WHERE '));
    assert.ok(!whereOnwards.includes('"one_swap"."requester_agent_id"'), whereOnwards);
  });

  it('scopes the LEFT JOIN forced by a 2-part orderBy', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { db, DbTables } = createDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.shift,
      orderBy: 'one_swap.message',
      tenant: TENANT,
    });

    const on = leftJoinClause(mockPg.calls[0].text);
    assert.ok(on.includes('"one_swap"."requester_agent_id"'), `got: ${on}`);
    assert.ok(on.includes('"one_swap"."target_agent_id"'), `got: ${on}`);
  });
});

describe('anyOf scope across joinMustExist', () => {
  it('scopes the EXISTS subquery on both columns', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { db, DbTables } = createDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.shift,
      joinMustExist: { swap: { filters: { message: 'dentist' } } },
      tenant: TENANT,
    });

    const sql = mockPg.calls[0].text;
    const exists = sql.slice(sql.indexOf('EXISTS'));
    assert.ok(exists.includes('requester_agent_id'), exists);
    assert.ok(exists.includes('target_agent_id'), exists);
  });
});

describe('anyOf scope across an aggregation subquery', () => {
  it('scopes the correlated subquery of a dotted condition', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const { db, DbTables } = createDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.shift,
      joinGroup: { swap: { aggregations: { count: ['id'] } } },
      conditions: [{ field: 'swap.count.id', method: 'isGreater', params: [0] }],
      tenant: TENANT,
    });

    const sql = mockPg.calls[0].text;
    const sub = sql.slice(sql.indexOf('COALESCE((SELECT'));
    assert.ok(sub.includes('requester_agent_id'), sub);
    assert.ok(sub.includes('target_agent_id'), sub);
  });

  it('scopes the joinGroup side query', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const { db, DbTables } = createDbTables(mockPg);

    await searchEngine(DbTables, {
      db,
      tableConf: DbTables.shift,
      joinGroup: { swap: { aggregations: { count: ['id'] } } },
      tenant: TENANT,
    });

    const side = mockPg.calls[1].text;
    assert.ok(side.includes('requester_agent_id'), side);
    assert.ok(side.includes('target_agent_id'), side);
  });
});
