// `tenantScope: { anyOf: [...] }` against a real database: a row owned by two parties, visible
// to either. The unit tests pin the SQL; these pin what the database actually returns — in
// particular that a NULL party neither matches nor blocks the other one.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALECT,
  createTestApp,
  cleanTables,
  seedRows,
  exportTableInfo,
  toUnderscore,
  Type,
} from './_helpers.js';

function createSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}

const swapSchema = createSchema('shift_swap_request', {
  id: Type.Optional(Type.Integer()),
  shiftId: Type.Optional(Type.Integer()),
  requesterAgentId: Type.Optional(Type.Integer()),
  targetAgentId: Type.Optional(Type.Integer()),
  message: Type.Optional(Type.String()),
});

const DbTables = {
  shift_swap_request: {
    primary: 'id',
    ...exportTableInfo(swapSchema),
    defaultOrder: 'id',
    tenantScope: { anyOf: ['requester_agent_id', 'target_agent_id'] },
    upsertMap: new Map([[swapSchema, ['id']]]),
  },
};

/** `x-agent: admin` bypasses the scope; a comma-separated header becomes a multi-id caller. */
const pluginOpts = {
  prefix: '/auto',
  getTenantId: (request) => {
    const header = request.headers['x-agent'];
    if (!header || header === 'admin') return null;
    const ids = String(header).split(',').map(Number);
    return ids.length === 1 ? ids[0] : ids;
  },
};

const as = (agent, payload) => ({
  headers: agent ? { 'x-agent': String(agent) } : {},
  payload,
});

describe(`[${DIALECT}] tenantScope anyOf integration`, () => {
  let app;
  let db;
  let rows;

  before(async () => {
    ({ app, db } = await createTestApp(DbTables, pluginOpts));
    await cleanTables(db, ['shift_swap_request']);

    rows = await seedRows(db, 'shift_swap_request', [
      { shift_id: 1, requester_agent_id: 7, target_agent_id: 9, message: 'dentist' },
      { shift_id: 2, requester_agent_id: 9, target_agent_id: 7, message: 'school run' },
      { shift_id: 3, requester_agent_id: 7, target_agent_id: 7, message: 'both sides mine' },
      { shift_id: 4, requester_agent_id: 9, target_agent_id: 12, message: 'none of my business' },
      { shift_id: 5, requester_agent_id: null, target_agent_id: 7, message: 'requester dropped' },
      { shift_id: 6, requester_agent_id: 7, target_agent_id: null, message: 'target dropped' },
      { shift_id: 7, requester_agent_id: null, target_agent_id: null, message: 'orphan' },
    ]);
  });

  after(async () => {
    await app.close();
  });

  const search = async (agent, payload = {}) => {
    const res = await app.inject({ method: 'POST', url: '/auto/search/shift_swap_request', ...as(agent, payload) });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().main;
  };

  it('returns a row matched on the first column alone', async () => {
    const shifts = (await search(7)).map((r) => r.shiftId);
    assert.ok(shifts.includes(1), `expected shift 1 in ${shifts}`);
  });

  it('returns a row matched on the second column alone', async () => {
    const shifts = (await search(7)).map((r) => r.shiftId);
    assert.ok(shifts.includes(2), `expected shift 2 in ${shifts}`);
  });

  it('returns a row matching on both columns once, not twice', async () => {
    const shifts = (await search(7)).map((r) => r.shiftId);
    assert.equal(shifts.filter((s) => s === 3).length, 1, `expected shift 3 exactly once in ${shifts}`);
  });

  it('withholds a row belonging to neither party', async () => {
    const shifts = (await search(7)).map((r) => r.shiftId);
    assert.ok(!shifts.includes(4), `shift 4 belongs to nobody the caller is: ${shifts}`);
  });

  it('matches on the surviving column when the other party is NULL', async () => {
    const shifts = (await search(7)).map((r) => r.shiftId);
    assert.ok(shifts.includes(5), `a NULL requester must not hide a matching target: ${shifts}`);
    assert.ok(shifts.includes(6), `a NULL target must not hide a matching requester: ${shifts}`);
  });

  it('withholds a row with no party at all', async () => {
    const shifts = (await search(7)).map((r) => r.shiftId);
    assert.ok(!shifts.includes(7), `an unowned row is nobody's to read: ${shifts}`);
  });

  it('applies no predicate when getTenantId yields null (admin)', async () => {
    const shifts = (await search('admin')).map((r) => r.shiftId);
    assert.equal(shifts.length, 7, `admin sees every row, got ${shifts}`);
  });

  it('tests every tenant id against every column for a multi-id caller', async () => {
    const shifts = (await search('7,12')).map((r) => r.shiftId);
    assert.ok(shifts.includes(4), `12 owns shift 4 through target_agent_id: ${shifts}`);
    assert.equal(shifts.length, 6, `only the unowned row stays hidden, got ${shifts}`);
  });

  it('filters the scope alongside a request filter, not instead of it', async () => {
    const shifts = (await search(7, { filters: { shiftId: 4 } })).map((r) => r.shiftId);
    assert.equal(shifts.length, 0, `a filter must not widen the scope: ${shifts}`);
  });

  it('answers 404 on a get outside the scope, and 200 inside it', async () => {
    const mine = rows[0].id;
    const foreign = rows[3].id;

    const ok = await app.inject({ method: 'GET', url: `/auto/rest/shift_swap_request/${mine}`, ...as(7) });
    assert.equal(ok.statusCode, 200, ok.body);

    const denied = await app.inject({ method: 'GET', url: `/auto/rest/shift_swap_request/${foreign}`, ...as(7) });
    assert.equal(denied.statusCode, 404, denied.body);
  });

  describe('writes', () => {
    const insert = (agent, main) =>
      app.inject({ method: 'POST', url: '/auto/rest/shift_swap_request', ...as(agent, { main }) });

    it('accepts an insert anchored on one party and stores the other untouched', async () => {
      const res = await insert(7, { shiftId: 20, requesterAgentId: 7, targetAgentId: 42, message: 'new' });
      assert.equal(res.statusCode, 201, res.body);

      const stored = await db.query(
        `SELECT target_agent_id FROM ${db.qi('shift_swap_request')} WHERE ${db.qi('shift_id')} = ${db.ph(1)}`,
        [20]
      );
      assert.equal(Number(stored.rows[0].target_agent_id), 42, 'the other party must survive the write');
    });

    it('rejects an insert with 400 when no party is named', async () => {
      const res = await insert(7, { shiftId: 21, message: 'orphan' });
      assert.equal(res.statusCode, 400, res.body);
    });

    it('rejects an insert with 403 when both parties are foreign', async () => {
      const res = await insert(7, { shiftId: 22, requesterAgentId: 9, targetAgentId: 12 });
      assert.equal(res.statusCode, 403, res.body);
    });

    it('updates a row inside the scope without letting either party be reassigned', async () => {
      const id = rows[0].id;
      const res = await app.inject({
        method: 'PUT',
        url: '/auto/rest/shift_swap_request',
        ...as(7, { main: { id, message: 'rescheduled', requesterAgentId: 99, targetAgentId: 99 } }),
      });
      assert.equal(res.statusCode, 200, res.body);

      const after = await db.query(
        `SELECT requester_agent_id, target_agent_id, message FROM ${db.qi('shift_swap_request')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
        [id]
      );
      assert.equal(after.rows[0].message, 'rescheduled');
      assert.equal(Number(after.rows[0].requester_agent_id), 7, 'neither party may be reassigned');
      assert.equal(Number(after.rows[0].target_agent_id), 9, 'neither party may be reassigned');
    });

    it('answers 404 on an update outside the scope', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/auto/rest/shift_swap_request',
        ...as(7, { main: { id: rows[3].id, message: 'not mine' } }),
      });
      assert.equal(res.statusCode, 404, res.body);
    });

    const upsert = (agent, main) =>
      app.inject({ method: 'PUT', url: '/auto/bulk/shift_swap_request', ...as(agent, [{ main }]) });

    it('refuses an upsert that names no party, having nothing to anchor a new row to', async () => {
      const res = await upsert(7, { id: rows[0].id, message: 'anonymous' });
      assert.equal(res.statusCode, 400, res.body);
    });

    it('refuses an upsert whose conflict target belongs to neither party', async () => {
      const res = await upsert(7, { id: rows[3].id, requesterAgentId: 7, message: 'hijack' });
      assert.equal(res.statusCode, 403, res.body);
    });

    it('refuses an upsert onto a row whose parties are both NULL', async () => {
      // `IN` on a NULL column yields NULL, and a plain negation would read "unknown" as
      // "not foreign", handing an unowned row to whoever claimed it first.
      const res = await upsert(7, { id: rows[6].id, requesterAgentId: 7, message: 'claim' });
      assert.equal(res.statusCode, 403, res.body);
    });

    it('upserts a row it owns without letting the payload re-assign either party', async () => {
      const id = rows[1].id; // requester 9, target 7 — the caller is the target
      const res = await upsert(7, { id, requesterAgentId: 7, targetAgentId: 7, message: 'swapped over' });
      assert.equal(res.statusCode, 200, res.body);

      const after = await db.query(
        `SELECT requester_agent_id, target_agent_id, message FROM ${db.qi('shift_swap_request')} WHERE ${db.qi('id')} = ${db.ph(1)}`,
        [id]
      );
      assert.equal(after.rows[0].message, 'swapped over');
      assert.equal(Number(after.rows[0].requester_agent_id), 9, 'an upsert must not take over the other slot');
      assert.equal(Number(after.rows[0].target_agent_id), 7);
    });

    it('answers 404 on a delete outside the scope, and removes it inside', async () => {
      const denied = await app.inject({
        method: 'DELETE',
        url: `/auto/rest/shift_swap_request/${rows[3].id}`,
        ...as(7),
      });
      assert.equal(denied.statusCode, 404, denied.body);

      const ok = await app.inject({
        method: 'DELETE',
        url: `/auto/rest/shift_swap_request/${rows[2].id}`,
        ...as(7),
      });
      assert.equal(ok.statusCode, 200, ok.body);
    });
  });
});
