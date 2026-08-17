// The caller's tenant is a property of the REQUEST, not of the table the request addresses.
//
// A relation is a read grant on its target, and a write join is a write grant: if the host table
// happens to declare no `tenantScope` of its own, the target's scope must still apply. Resolving
// the tenant from the host alone turned a public host into a hole through which every scoped row
// of its neighbours was readable and writable.
//
// The motivating shape: a deliberately public roster (`shift`) related to `shift_swap_request`,
// where the reason somebody wants to change the roster is private.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMockPg, createMockSchema, ROOT } from './_harness.js';

const { createSqlApi } = await import(path.join(ROOT, 'dist/lib/sql-api.js'));
const { exportTableInfo, buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { Type } = await import('@sinclair/typebox');

const shiftSchema = createMockSchema('shift', {
  id: Type.Number(),
  day: Type.String(),
});
const swapSchema = createMockSchema('shift_swap_request', {
  id: Type.Number(),
  shiftId: Type.Number(),
  agentId: Type.Number(),
  message: Type.String(),
});
const noteSchema = createMockSchema('roster_note', {
  id: Type.Number(),
  shiftId: Type.Number(),
  text: Type.String(),
});

/**
 * `shift` is public on purpose and declares no scope. It reads and writes `shift_swap_request`,
 * which is scoped, and `roster_note`, which is not.
 */
function createDbTables({ scopedChild = true } = {}) {
  return {
    shift: {
      primary: 'id',
      ...exportTableInfo(shiftSchema),
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(shiftSchema, 'id', swapSchema, 'shiftId', { alias: 'swap' }),
        buildRelation(shiftSchema, 'id', swapSchema, 'shiftId', { alias: 'one_swap', unique: true }),
      ],
      allowedWriteJoins: [
        buildRelation(shiftSchema, 'id', swapSchema, 'shiftId', { alias: 'swap' }),
      ],
    },
    shift_swap_request: {
      primary: 'id',
      ...exportTableInfo(swapSchema),
      defaultOrder: 'id',
      ...(scopedChild ? { tenantScope: { column: 'agent_id' } } : {}),
    },
    roster_note: {
      primary: 'id',
      ...exportTableInfo(noteSchema),
      defaultOrder: 'id',
    },
  };
}

/** A table that reaches nothing scoped at all. */
function createUnscopedOnlyTables() {
  return {
    roster_note: {
      primary: 'id',
      ...exportTableInfo(noteSchema),
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(noteSchema, 'shiftId', shiftSchema, 'id', { alias: 'shift', unique: true }),
      ],
    },
    shift: { primary: 'id', ...exportTableInfo(shiftSchema), defaultOrder: 'id' },
  };
}

describe('tenant scoping when the addressed table declares no scope of its own', () => {
  it('scopes a joinMultiple side query into a scoped table', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const api = createSqlApi(mockPg, createDbTables(), { getTenantId: () => 7 });

    await api.search('shift', { joinMultiple: { swap: {} } }, {});

    const side = mockPg.calls[1].text;
    assert.ok(
      side.includes('"agent_id" IN'),
      `a relation is a read grant: the target's scope must cross it, got: ${side}`
    );
    assert.ok(mockPg.calls[1].values.includes(7));
  });

  it('scopes a joinLeft into a scoped table, in the ON clause', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const api = createSqlApi(mockPg, createDbTables(), { getTenantId: () => 7 });

    await api.search('shift', { joinLeft: { one_swap: { filters: { message: 'x' } } } }, {});

    const sql = mockPg.calls[0].text;
    const on = sql.slice(sql.indexOf('LEFT JOIN'), sql.indexOf(' WHERE '));
    assert.ok(on.includes('"one_swap"."agent_id"'), `got: ${on}`);
  });

  it('leaves the public host table itself unfiltered', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const api = createSqlApi(mockPg, createDbTables(), { getTenantId: () => 7 });

    await api.search('shift', { joinMultiple: { swap: {} } }, {});

    assert.ok(
      !mockPg.calls[0].text.includes('agent_id'),
      `the host declares no scope and must stay open: ${mockPg.calls[0].text}`
    );
  });

  it('enforces the child scope on a secondary written through a public host', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 1 }], affectedRows: 1 }]);
    const api = createSqlApi(mockPg, createDbTables(), { getTenantId: () => 7 });

    await assert.rejects(
      () => api.insert('shift', {
        record: { day: '2026-09-01' },
        secondaries: { swap: [{ agentId: 999 }] },
      }, {}),
      (err) => err.statusCode === 403,
      'a write join is a write grant: the child scope must be enforced through it'
    );
  });

  it('still bypasses everything for an admin', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const api = createSqlApi(mockPg, createDbTables(), { getTenantId: () => null });

    await api.search('shift', { joinMultiple: { swap: {} } }, {});

    assert.ok(!mockPg.calls[1].text.includes('agent_id'), mockPg.calls[1].text);
  });

  it('does not scope a relation whose target declares no scope either', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const api = createSqlApi(mockPg, createDbTables({ scopedChild: false }), { getTenantId: () => 7 });

    await api.search('shift', { joinMultiple: { swap: {} } }, {});

    assert.ok(!mockPg.calls[1].text.includes('agent_id'), mockPg.calls[1].text);
  });
});

describe('getTenantId is only consulted when a scope is within reach', () => {
  it('is not called for a table that reaches nothing scoped', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    let calls = 0;
    const api = createSqlApi(mockPg, createUnscopedOnlyTables(), {
      getTenantId: () => { calls++; return 7; },
    });

    await api.search('roster_note', {}, {});

    assert.equal(calls, 0, 'a request that cannot reach a scoped row must not pay for resolving a tenant');
  });

  it('is called when the addressed table is scoped', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    let calls = 0;
    const api = createSqlApi(mockPg, createDbTables(), {
      getTenantId: () => { calls++; return 7; },
    });

    await api.search('shift_swap_request', {}, {});

    assert.equal(calls, 1);
  });

  it('is called when only a related table is scoped', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    let calls = 0;
    const api = createSqlApi(mockPg, createDbTables(), {
      getTenantId: () => { calls++; return 7; },
    });

    await api.search('shift', {}, {});

    assert.equal(calls, 1);
  });
});
