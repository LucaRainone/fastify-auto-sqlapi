// A tenant scope over more than one column: a row owned by two parties, visible to either.
//
// The domain here is a shift swap — `requester_agent_id` / `target_agent_id`. Neither column
// alone owns the row, so the predicate is an OR and nothing is auto-injected on write.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { buildTenantCondition, buildTenantRowGuard, stripTenantColumn, assertTenantOwnsConflicts } =
  await import(path.join(ROOT, 'dist/lib/tenant.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { exportTableInfo, defineTable, buildRelation } =
  await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { getEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/get.js'));
const { deleteEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/delete.js'));
const { bulkDeleteEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-delete.js'));
const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { updateEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/update.js'));
const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { Type } = await import('@sinclair/typebox');

const swapFields = {
  id: Type.Number(),
  requesterAgentId: Type.Number(),
  targetAgentId: Type.Number(),
  message: Type.String(),
};

const SCOPE = { anyOf: ['requester_agent_id', 'target_agent_id'] };
const swapSchema = createMockSchema('shift_swap_request', swapFields);
const swapConf = { primary: 'id', ...exportTableInfo(swapSchema), defaultOrder: 'id' };
const dbTables = { shift_swap_request: swapConf };

// ─── the predicate itself ───────────────────────────────────

describe('buildTenantCondition with an anyOf scope', () => {
  it('ORs one IN per listed column, each qualified with the table', () => {
    const db = new QueryClient(createMockPg());
    const cb = buildTenantCondition(db, SCOPE, [7], 'shift_swap_request');

    assert.equal(
      cb.build(1, db.ph),
      '("shift_swap_request"."requester_agent_id" IN ($1) OR ' +
      '"shift_swap_request"."target_agent_id" IN ($2))'
    );
    assert.deepEqual(cb.getValues(), [7, 7]);
  });

  it('binds every tenant id on every column when the caller holds several', () => {
    const db = new QueryClient(createMockPg());
    const cb = buildTenantCondition(db, SCOPE, [1, 2], 'shift_swap_request');

    assert.equal(
      cb.build(1, db.ph),
      '("shift_swap_request"."requester_agent_id" IN ($1, $2) OR ' +
      '"shift_swap_request"."target_agent_id" IN ($3, $4))'
    );
    assert.deepEqual(cb.getValues(), [1, 2, 1, 2]);
  });

  it('qualifies with the reference it was given, so a join alias survives', () => {
    const db = new QueryClient(createMockPg());
    const cb = buildTenantCondition(db, SCOPE, [7], 'swap');

    assert.ok(cb.build(1, db.ph).includes('"swap"."requester_agent_id"'));
    assert.ok(cb.build(1, db.ph).includes('"swap"."target_agent_id"'));
  });

  it('emits the single-column SQL unchanged for a one-entry anyOf', () => {
    const db = new QueryClient(createMockPg());
    const anyOf = buildTenantCondition(db, { anyOf: ['agent_id'] }, [7], 'shift');
    const direct = buildTenantCondition(db, { column: 'agent_id' }, [7], 'shift');

    assert.equal(anyOf.build(1, db.ph), direct.build(1, db.ph));
    assert.deepEqual(anyOf.getValues(), direct.getValues());
  });

  it('carries the OR into a row guard, for ON clauses and correlated subqueries', () => {
    const db = new QueryClient(createMockPg());
    const guard = buildTenantRowGuard(db, { ids: [7], scope: SCOPE }, 'swap');

    const sql = guard.build(1, db.ph);
    assert.ok(sql.includes('OR'), `expected an OR group, got: ${sql}`);
    assert.ok(sql.includes('"swap"."requester_agent_id"'), sql);
    assert.ok(sql.includes('"swap"."target_agent_id"'), sql);
  });
});

// ─── reads ──────────────────────────────────────────────────

describe('reads on an anyOf-scoped table', () => {
  it('filters a search on either column', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const db = new QueryClient(mockPg);

    await searchEngine(dbTables, { db, tableConf: swapConf, tenant: { ids: [7], scope: SCOPE } });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('"requester_agent_id" IN'), sql);
    assert.ok(sql.includes('OR'), sql);
    assert.ok(sql.includes('"target_agent_id" IN'), sql);
    assert.deepEqual(mockPg.calls[0].values, [7, 7]);
  });

  it('applies no predicate at all when getTenantId yields nothing (admin)', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const db = new QueryClient(mockPg);

    await searchEngine(dbTables, { db, tableConf: swapConf });

    assert.ok(!mockPg.calls[0].text.includes('agent_id'), mockPg.calls[0].text);
  });

  it('scopes a get by id', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const db = new QueryClient(mockPg);

    await getEngine({ db, tableConf: swapConf, id: '1', tenant: { ids: [7], scope: SCOPE } });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('"requester_agent_id" IN'), sql);
    assert.ok(sql.includes('"target_agent_id" IN'), sql);
    assert.deepEqual(mockPg.calls[0].values, ['1', 7, 7]);
  });

  it('answers 404, not 403, for a row outside the scope', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const db = new QueryClient(mockPg);

    await assert.rejects(
      () => getEngine({ db, tableConf: swapConf, id: '1', tenant: { ids: [99], scope: SCOPE } }),
      (err) => err.statusCode === 404
    );
  });
});

// ─── deletes ────────────────────────────────────────────────

describe('deletes on an anyOf-scoped table', () => {
  it('scopes a single delete', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }, { rows: [], affectedRows: 1 }]);
    const db = new QueryClient(mockPg);

    await deleteEngine({ db, tableConf: swapConf, id: '1', tenant: { ids: [7], scope: SCOPE } });

    const del = mockPg.calls.find((c) => c.text.startsWith('DELETE'));
    assert.ok(del.text.includes('"requester_agent_id" IN'), del.text);
    assert.ok(del.text.includes('"target_agent_id" IN'), del.text);
  });

  it('scopes a bulk delete', async () => {
    const mockPg = createMockPg([
      { rows: [{ pk: 1 }, { pk: 2 }], affectedRows: 2 },
      { rows: [], affectedRows: 2 },
    ]);
    const db = new QueryClient(mockPg);

    await bulkDeleteEngine({ db, tableConf: swapConf, ids: [1, 2], tenant: { ids: [7], scope: SCOPE } });

    const del = mockPg.calls.find((c) => c.text.startsWith('DELETE'));
    assert.ok(del.text.includes('"requester_agent_id" IN'), del.text);
    assert.ok(del.text.includes('"target_agent_id" IN'), del.text);
  });
});

// ─── insert: anchor, never inject ───────────────────────────

describe('insert on an anyOf-scoped table', () => {
  const insertArgs = (db, record, ids) => ({
    db, tableConf: swapConf, dbTables, request: {}, record, tenant: { ids, scope: SCOPE },
  });

  it('accepts a row anchored on one column and leaves the other party untouched', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const db = new QueryClient(mockPg);

    await insertEngine(insertArgs(db, { requesterAgentId: 7, targetAgentId: 9, message: 'dentist' }, [7]));

    assert.ok(mockPg.calls[0].values.includes(9), 'the other party must survive the write');
    assert.ok(mockPg.calls[0].values.includes(7));
    assert.equal(
      mockPg.calls[0].values.length, 3,
      `nothing may be auto-injected: ${mockPg.calls[0].text}`
    );
  });

  it('accepts a row anchored on the second column', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const db = new QueryClient(mockPg);

    await insertEngine(insertArgs(db, { requesterAgentId: 9, targetAgentId: 7 }, [7]));

    assert.equal(mockPg.calls.length, 1);
    assert.deepEqual(mockPg.calls[0].values, [9, 7]);
  });

  it('rejects with 400 when no listed column is present — nothing anchors the row', async () => {
    const db = new QueryClient(createMockPg());

    await assert.rejects(
      () => insertEngine(insertArgs(db, { message: 'orphan' }, [7])),
      (err) => err.statusCode === 400
    );
  });

  it('rejects with 400 when the listed columns are present but null', async () => {
    const db = new QueryClient(createMockPg());

    await assert.rejects(
      () => insertEngine(insertArgs(db, { requesterAgentId: null, targetAgentId: null }, [7])),
      (err) => err.statusCode === 400
    );
  });

  it('rejects with 403 when both parties are foreign', async () => {
    const db = new QueryClient(createMockPg());

    await assert.rejects(
      () => insertEngine(insertArgs(db, { requesterAgentId: 9, targetAgentId: 12 }, [7])),
      (err) => err.statusCode === 403
    );
  });

  it('is never ambiguous for a caller holding several tenant ids', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const db = new QueryClient(mockPg);

    // The single-column scope answers 400 here, having no way to pick which id to inject.
    // An anyOf scope injects nothing, so an explicitly anchored row is simply accepted.
    await insertEngine(insertArgs(db, { requesterAgentId: 8, targetAgentId: 9 }, [7, 8]));

    assert.equal(mockPg.calls.length, 1);
  });
});

// ─── update: neither party can be reassigned ────────────────

describe('update on an anyOf-scoped table', () => {
  it('strips every listed column from the SET', () => {
    const fields = { message: 'new', requester_agent_id: 99, target_agent_id: 12 };
    stripTenantColumn(fields, SCOPE);

    assert.deepEqual(fields, { message: 'new' });
  });

  it('adds the OR predicate to the WHERE and leaves the columns out of the SET', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 1 }]);
    const db = new QueryClient(mockPg);

    await updateEngine({
      db,
      tableConf: swapConf,
      dbTables,
      request: {},
      record: { id: 1, message: 'new', requesterAgentId: 99 },
      tenant: { ids: [7], scope: SCOPE },
    });

    const sql = mockPg.calls[0].text;
    const [set, where] = sql.split(' SET ')[1].split(' WHERE ');
    assert.ok(!set.includes('requester_agent_id'), `SET must not reassign a party: ${set}`);
    assert.ok(!set.includes('target_agent_id'), `SET must not reassign a party: ${set}`);
    assert.ok(where.includes('requester_agent_id'), where);
    assert.ok(where.includes('target_agent_id'), where);
  });

  it('answers 404 when the row belongs to neither party', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const db = new QueryClient(mockPg);

    await assert.rejects(
      () => updateEngine({
        db,
        tableConf: swapConf,
        dbTables,
        request: {},
        record: { id: 1, message: 'new' },
        tenant: { ids: [99], scope: SCOPE },
      }),
      (err) => err.statusCode === 404
    );
  });
});

// ─── upsert conflict guard ──────────────────────────────────

describe('upsert conflict guard on an anyOf-scoped table', () => {
  it('probes for a conflict target visible to neither party', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const db = new QueryClient(mockPg);

    await assertTenantOwnsConflicts(
      db, { ids: [7], scope: SCOPE }, 'shift_swap_request', ['id'],
      [{ id: 1, requester_agent_id: 7 }]
    );

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('requester_agent_id'), sql);
    assert.ok(sql.includes('target_agent_id'), sql);
    // A NULL party must not read as "not foreign": the probe has to be null-safe, otherwise a
    // row with one party NULL and the other owned by a stranger slips through as unmatched.
    assert.ok(
      /COALESCE/i.test(sql) || /IS NOT NULL/i.test(sql),
      `the mismatch clause must be null-safe, got: ${sql}`
    );
  });

  it('rejects with 403 when the conflict target belongs to neither party', async () => {
    const mockPg = createMockPg([{ rows: [{ '?column?': 1 }], affectedRows: 1 }]);
    const db = new QueryClient(mockPg);

    await assert.rejects(
      () => assertTenantOwnsConflicts(
        db, { ids: [7], scope: SCOPE }, 'shift_swap_request', ['id'],
        [{ id: 1, requester_agent_id: 9 }]
      ),
      (err) => err.statusCode === 403
    );
  });
});

// ─── declaration-time validation ────────────────────────────

describe('defineTable validation of an anyOf scope', () => {
  const base = { primary: 'id', ...exportTableInfo(swapSchema), defaultOrder: 'id' };

  it('accepts a well-formed anyOf', () => {
    assert.doesNotThrow(() => defineTable({ ...base, tenantScope: SCOPE }));
  });

  it('throws when anyOf is combined with column', () => {
    assert.throws(
      () => defineTable({ ...base, tenantScope: { column: 'requester_agent_id', anyOf: ['target_agent_id'] } }),
      /anyOf/
    );
  });

  it('throws when anyOf is combined with through', () => {
    assert.throws(
      () => defineTable({
        ...base,
        tenantScope: {
          anyOf: ['requester_agent_id'],
          through: { schema: swapSchema, localField: 'id', foreignField: 'id' },
        },
      }),
      /anyOf/
    );
  });

  it('throws on an empty anyOf, which would silently deny every row', () => {
    assert.throws(() => defineTable({ ...base, tenantScope: { anyOf: [] } }), /anyOf/);
  });

  it('throws when anyOf is not an array of column names', () => {
    assert.throws(() => defineTable({ ...base, tenantScope: { anyOf: 'requester_agent_id' } }), /anyOf/);
    assert.throws(() => defineTable({ ...base, tenantScope: { anyOf: [1] } }), /anyOf/);
  });

  it('throws on a duplicated column', () => {
    assert.throws(
      () => defineTable({ ...base, tenantScope: { anyOf: ['requester_agent_id', 'requester_agent_id'] } }),
      /anyOf/
    );
  });

  it('throws when the scope declares neither column nor anyOf', () => {
    assert.throws(() => defineTable({ ...base, tenantScope: {} }), /tenantScope/);
  });
});

// ─── secondaries ────────────────────────────────────────────

// A table with an anyOf scope stays writable as a secondary of another table. The anchor rule
// is the child's own, re-targeted onto it: the parent's FK is auto-filled, but the FK is not an
// owner, so the payload must still name a party. Nothing about the write join relaxes the scope.
describe('an anyOf-scoped table written as a secondary', () => {
  const shiftFields = { id: Type.Number(), day: Type.String(), agentId: Type.Number() };
  const shiftSchema = createMockSchema('shift', shiftFields);
  const childSchema = createMockSchema('shift_swap_request', {
    ...swapFields,
    shiftId: Type.Number(),
  });

  // The host carries an ordinary single-column scope: the caller's tenant is resolved from the
  // table the request addresses, then re-targeted onto the child's own anyOf scope.
  const HOST_TENANT = { ids: [7], scope: { column: 'agent_id' } };

  function createDbTables(mockPg) {
    return {
      db: new QueryClient(mockPg),
      DbTables: {
        shift: {
          primary: 'id',
          ...exportTableInfo(shiftSchema),
          defaultOrder: 'id',
          tenantScope: { column: 'agent_id' },
          allowedWriteJoins: [
            buildRelation(shiftSchema, 'id', childSchema, 'shiftId', { alias: 'swap' }),
          ],
        },
        shift_swap_request: {
          primary: 'id',
          ...exportTableInfo(childSchema),
          defaultOrder: 'id',
          tenantScope: SCOPE,
        },
      },
    };
  }

  it('accepts a child anchored on one party', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },   // main
      { rows: [{ id: 10 }], affectedRows: 1 },  // secondary
    ]);
    const { db, DbTables } = createDbTables(mockPg);

    await insertEngine({
      db,
      tableConf: DbTables.shift,
      dbTables: DbTables,
      request: {},
      record: { day: '2026-09-01' },
      secondaries: { swap: [{ requesterAgentId: 7, targetAgentId: 9 }] },
      tenant: HOST_TENANT,
    });

    assert.equal(mockPg.calls.length, 2);
  });

  it('rejects with 403 a child whose parties are both foreign', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const { db, DbTables } = createDbTables(mockPg);

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: DbTables.shift,
        dbTables: DbTables,
        request: {},
        record: { day: '2026-09-01' },
        secondaries: { swap: [{ requesterAgentId: 9, targetAgentId: 12 }] },
        tenant: HOST_TENANT,
      }),
      (err) => err.statusCode === 403
    );
  });

  it('rejects with 400 a child the FK alone would anchor', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const { db, DbTables } = createDbTables(mockPg);

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: DbTables.shift,
        dbTables: DbTables,
        request: {},
        record: { day: '2026-09-01' },
        secondaries: { swap: [{ message: 'no party named' }] },
        tenant: HOST_TENANT,
      }),
      (err) => err.statusCode === 400
    );
  });
});
