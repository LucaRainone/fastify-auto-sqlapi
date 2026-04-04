import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { updateEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/update.js'));
const { bulkUpsertEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-upsert.js'));
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

const mockRequest = {};

const sessionFields = {
  id: Type.Number(),
  name: Type.String(),
};

const periodFields = {
  id: Type.Number(),
  sessionId: Type.Number(),
  startDate: Type.String(),
  endDate: Type.String(),
};

function createTestDbTables(mockPg, opts = {}) {
  const sessionSchema = createMockSchema('session', sessionFields);
  const periodSchema = createMockSchema('session_period', periodFields);

  const sessionInfo = exportTableInfo(sessionSchema);
  const periodInfo = exportTableInfo(periodSchema);

  const DbTables = {
    session: {
      primary: 'id',
      ...sessionInfo,
      defaultOrder: 'id',
      allowedWriteJoins: [
        buildRelation(sessionSchema, 'id', periodSchema, 'sessionId'),
      ],
      ...(opts.validate ? { validate: opts.validate } : {}),
      ...(opts.validateBulk ? { validateBulk: opts.validateBulk } : {}),
      ...(opts.beforeInsert ? { beforeInsert: opts.beforeInsert } : {}),
    },
    session_period: {
      primary: 'id',
      ...periodInfo,
      defaultOrder: 'id',
    },
  };

  return { DbTables, db: new QueryClient(mockPg), sessionSchema, periodSchema };
}

// ─── validate in insertEngine ─────────────────────────────────

describe('validate - insertEngine', () => {
  it('blocks insert when validate returns errors', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: (_db, _req, main) => {
        if (!main.name) {
          return [['name', 'required', 'is required']];
        }
        return [];
      },
    });

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: DbTables.session,
        dbTables: DbTables,
        request: mockRequest,
        record: {},
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.validationErrors.length, 1);
        assert.equal(err.validationErrors[0].path, 'name');
        assert.equal(err.validationErrors[0].code, 'required');
        assert.equal(err.validationErrors[0].message, 'is required');
        return true;
      }
    );

    // No SQL should have been executed
    assert.equal(mockPg.calls.length, 0);
  });

  it('defaults message to code when message is omitted', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: () => [['name', 'required']],
    });

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: DbTables.session,
        dbTables: DbTables,
        request: mockRequest,
        record: {},
      }),
      (err) => {
        assert.equal(err.validationErrors[0].path, 'name');
        assert.equal(err.validationErrors[0].code, 'required');
        assert.equal(err.validationErrors[0].message, 'required');
        return true;
      }
    );
  });

  it('allows insert when validate returns empty array', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: () => [],
    });

    const result = await insertEngine({
      db,
      tableConf: DbTables.session,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'Session 1' },
    });

    assert.equal(result.main.id, 1);
    assert.equal(mockPg.calls.length, 1);
  });

  it('receives secondaries in validate', async () => {
    let receivedSecondaries = null;
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: (_db, _req, _main, secondaries) => {
        receivedSecondaries = secondaries;
        return [['test', 'stop']];
      },
    });

    const secs = {
      session_period: [
        { startDate: '2024-01-01', endDate: '2024-01-10' },
      ],
    };

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: DbTables.session,
        dbTables: DbTables,
        request: mockRequest,
        record: { name: 'S1' },
        secondaries: secs,
      }),
    );

    assert.ok(receivedSecondaries);
    assert.equal(receivedSecondaries.session_period.length, 1);
  });

  it('runs validate before beforeInsert', async () => {
    const order = [];
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: () => { order.push('validate'); return []; },
      beforeInsert: async () => { order.push('beforeInsert'); },
    });

    await insertEngine({
      db,
      tableConf: DbTables.session,
      dbTables: DbTables,
      request: mockRequest,
      record: { name: 'S1' },
    });

    assert.deepEqual(order, ['validate', 'beforeInsert']);
  });

  it('supports async validate', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: async () => {
        return [['name', 'async_error', 'async error']];
      },
    });

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: DbTables.session,
        dbTables: DbTables,
        request: mockRequest,
        record: { name: 'S1' },
      }),
      (err) => {
        assert.equal(err.validationErrors[0].path, 'name');
        assert.equal(err.validationErrors[0].code, 'async_error');
        assert.equal(err.validationErrors[0].message, 'async error');
        return true;
      }
    );
  });
});

// ─── validate in updateEngine ─────────────────────────────────

describe('validate - updateEngine', () => {
  it('blocks update when validate returns errors', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: (_db, _req, main) => {
        if (main.name === '') {
          return [['name', 'empty', 'cannot be empty']];
        }
        return [];
      },
    });

    await assert.rejects(
      () => updateEngine({
        db,
        tableConf: DbTables.session,
        dbTables: DbTables,
        request: mockRequest,
        record: { id: 1, name: '' },
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.validationErrors[0].path, 'name');
        assert.equal(err.validationErrors[0].code, 'empty');
        return true;
      }
    );

    assert.equal(mockPg.calls.length, 0);
  });

  it('allows update when validate returns empty array', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: () => [],
    });

    const result = await updateEngine({
      db,
      tableConf: DbTables.session,
      dbTables: DbTables,
      request: mockRequest,
      record: { id: 1, name: 'Updated' },
    });

    assert.equal(result.main.id, 1);
  });

  it('receives secondaries in validate during update', async () => {
    let receivedSecondaries = null;
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: (_db, _req, _main, secondaries) => {
        receivedSecondaries = secondaries;
        return [['test', 'stop']];
      },
    });

    const secs = {
      session_period: [
        { startDate: '2024-01-01', endDate: '2024-01-10' },
        { startDate: '2024-02-01', endDate: '2024-02-10' },
      ],
    };

    await assert.rejects(
      () => updateEngine({
        db,
        tableConf: DbTables.session,
        dbTables: DbTables,
        request: mockRequest,
        record: { id: 1, name: 'S1' },
        secondaries: secs,
      }),
    );

    assert.ok(receivedSecondaries);
    assert.equal(receivedSecondaries.session_period.length, 2);
  });
});

// ─── validate + validateBulk in bulkUpsertEngine ──────────────

describe('validate - bulkUpsertEngine', () => {
  it('blocks bulk when per-item validate returns errors', async () => {
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: (_db, _req, main) => {
        if (!main.name) {
          return [['name', 'required']];
        }
        return [];
      },
    });

    await assert.rejects(
      () => bulkUpsertEngine({
        db,
        tableConf: DbTables.session,
        dbTables: DbTables,
        request: mockRequest,
        items: [
          { main: { name: 'OK' } },
          { main: {} },
        ],
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.validationErrors[0].path, 'name');
        return true;
      }
    );

    assert.equal(mockPg.calls.length, 0);
  });

  it('calls validateBulk with all items', async () => {
    let receivedItems = null;
    const mockPg = createMockPg([]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validateBulk: (_db, _req, items) => {
        receivedItems = items;
        return [['periods', 'overlap', 'overlap detected']];
      },
    });

    await assert.rejects(
      () => bulkUpsertEngine({
        db,
        tableConf: DbTables.session,
        dbTables: DbTables,
        request: mockRequest,
        items: [
          { main: { name: 'S1' }, secondaries: { session_period: [{ startDate: '2024-01-01', endDate: '2024-01-31' }] } },
          { main: { name: 'S2' }, secondaries: { session_period: [{ startDate: '2024-01-15', endDate: '2024-02-15' }] } },
        ],
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.validationErrors[0].path, 'periods');
        assert.equal(err.validationErrors[0].code, 'overlap');
        assert.equal(err.validationErrors[0].message, 'overlap detected');
        return true;
      }
    );

    assert.ok(receivedItems);
    assert.equal(receivedItems.length, 2);
    assert.ok(receivedItems[0].secondaries);
    assert.ok(receivedItems[1].secondaries);
  });

  it('uses validateBulk instead of per-item validate when both defined', async () => {
    const order = [];
    const mockPg = createMockPg([
      { rows: [{ id: 1 }, { id: 2 }], affectedRows: 2 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: () => { order.push('validate'); return []; },
      validateBulk: () => { order.push('validateBulk'); return []; },
    });

    await bulkUpsertEngine({
      db,
      tableConf: DbTables.session,
      dbTables: DbTables,
      request: mockRequest,
      items: [
        { main: { name: 'S1' } },
        { main: { name: 'S2' } },
      ],
    });

    assert.deepEqual(order, ['validateBulk']);
  });

  it('falls back to per-item validate when validateBulk is not defined', async () => {
    const order = [];
    const mockPg = createMockPg([
      { rows: [{ id: 1 }, { id: 2 }], affectedRows: 2 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: () => { order.push('validate'); return []; },
    });

    await bulkUpsertEngine({
      db,
      tableConf: DbTables.session,
      dbTables: DbTables,
      request: mockRequest,
      items: [
        { main: { name: 'S1' } },
        { main: { name: 'S2' } },
      ],
    });

    assert.deepEqual(order, ['validate', 'validate']);
  });

  it('allows bulk when both validate and validateBulk return empty', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }, { id: 2 }], affectedRows: 2 },
    ]);
    const { DbTables, db } = createTestDbTables(mockPg, {
      validate: () => [],
      validateBulk: () => [],
    });

    const results = await bulkUpsertEngine({
      db,
      tableConf: DbTables.session,
      dbTables: DbTables,
      request: mockRequest,
      items: [
        { main: { name: 'S1' } },
        { main: { name: 'S2' } },
      ],
    });

    assert.equal(results.length, 2);
  });
});
