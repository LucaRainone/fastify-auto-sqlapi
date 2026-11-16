import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { updateEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/update.js'));
const { bulkUpsertEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-upsert.js'));
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

  const sessionInfo = { schema: sessionSchema };
  const periodInfo = { schema: periodSchema };

  const dbTables = {
    session: {
      primary: 'id',
      ...sessionInfo,
      defaultOrder: 'id',
      writeJoins: [
        buildRelation(sessionSchema, 'id', periodSchema, 'sessionId', { alias: 'period' }),
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

  return { dbTables, db: new QueryClient(mockPg), sessionSchema, periodSchema };
}

// ─── validate in insertEngine ─────────────────────────────────

describe('validate - insertEngine', () => {
  it('blocks insert when validate returns errors', async () => {
    const mockPg = createMockPg([]);
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: ({ main }) => {
        if (!main.name) {
          return [{ path: 'name', code: 'required' }];
        }
        return [];
      },
    });

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: dbTables.session,
        dbTables: dbTables,
        request: mockRequest,
        record: {},
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.validationErrors.length, 1);
        assert.equal(err.validationErrors[0].path, 'name');
        assert.equal(err.validationErrors[0].code, 'required');
        return true;
      }
    );

    // No SQL should have been executed
    assert.equal(mockPg.calls.length, 0);
  });

  it('a hook entry carries no message: a hook writes no prose, the code is the whole answer', async () => {
    const mockPg = createMockPg([]);
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: () => [{ path: 'name', code: 'required' }],
    });

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: dbTables.session,
        dbTables: dbTables,
        request: mockRequest,
        record: {},
      }),
      (err) => {
        assert.deepEqual(err.validationErrors, [{ path: 'name', code: 'required' }]);
        return true;
      }
    );
  });

  it('allows insert when validate returns empty array', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
    ]);
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: () => [],
    });

    const result = await insertEngine({
      db,
      tableConf: dbTables.session,
      dbTables: dbTables,
      request: mockRequest,
      record: { name: 'Session 1' },
    });

    assert.equal(result.main.id, 1);
    assert.equal(mockPg.calls.length, 1);
  });

  it('receives secondaries in validate', async () => {
    let receivedSecondaries = null;
    const mockPg = createMockPg([]);
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: ({ upsert }) => {
        receivedSecondaries = upsert;
        return [{ path: 'test', code: 'stop' }];
      },
    });

    const secs = {
      period: [
        { startDate: '2024-01-01', endDate: '2024-01-10' },
      ],
    };

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: dbTables.session,
        dbTables: dbTables,
        request: mockRequest,
        record: { name: 'S1' },
        upsert: secs,
      }),
    );

    assert.ok(receivedSecondaries);
    assert.equal(receivedSecondaries.period.length, 1);
  });

  it('receives camelCase record in validate (not snake_case)', async () => {
    let receivedMain = null;
    const mockPg = createMockPg([]);
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: ({ main }) => {
        receivedMain = main;
        return [{ path: 'test', code: 'stop' }];
      },
    });

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: dbTables.session,
        dbTables: dbTables,
        request: mockRequest,
        // Pass camelCase field names
        record: { name: 'S1' },
        upsert: {
          period: [{ startDate: '2024-01-01', endDate: '2024-01-10' }],
        },
      }),
    );

    // validate receives camelCase (original record), not snake_case
    assert.ok(receivedMain);
    assert.equal(receivedMain.name, 'S1');
    // Fields should be camelCase, not snake_case
    assert.equal(receivedMain.start_date, undefined);
  });

  it('runs validate before beforeInsert', async () => {
    const order = [];
    const mockPg = createMockPg([
      { rows: [{ id: 1 }], affectedRows: 1 },
    ]);
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: () => { order.push('validate'); return []; },
      beforeInsert: async () => { order.push('beforeInsert'); },
    });

    await insertEngine({
      db,
      tableConf: dbTables.session,
      dbTables: dbTables,
      request: mockRequest,
      record: { name: 'S1' },
    });

    assert.deepEqual(order, ['validate', 'beforeInsert']);
  });

  it('supports async validate', async () => {
    const mockPg = createMockPg([]);
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: async () => {
        return [{ path: 'name', code: 'async_error' }];
      },
    });

    await assert.rejects(
      () => insertEngine({
        db,
        tableConf: dbTables.session,
        dbTables: dbTables,
        request: mockRequest,
        record: { name: 'S1' },
      }),
      (err) => {
        assert.equal(err.validationErrors[0].path, 'name');
        assert.equal(err.validationErrors[0].code, 'async_error');
        return true;
      }
    );
  });
});

// ─── validate in updateEngine ─────────────────────────────────

describe('validate - updateEngine', () => {
  it('blocks update when validate returns errors', async () => {
    const mockPg = createMockPg([]);
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: ({ main }) => {
        if (main.name === '') {
          return [{ path: 'name', code: 'empty' }];
        }
        return [];
      },
    });

    await assert.rejects(
      () => updateEngine({
        db,
        tableConf: dbTables.session,
        dbTables: dbTables,
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
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: () => [],
    });

    const result = await updateEngine({
      db,
      tableConf: dbTables.session,
      dbTables: dbTables,
      request: mockRequest,
      record: { id: 1, name: 'Updated' },
    });

    assert.equal(result.main.id, 1);
  });

  it('receives secondaries in validate during update', async () => {
    let receivedSecondaries = null;
    const mockPg = createMockPg([]);
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: ({ upsert }) => {
        receivedSecondaries = upsert;
        return [{ path: 'test', code: 'stop' }];
      },
    });

    const secs = {
      period: [
        { startDate: '2024-01-01', endDate: '2024-01-10' },
        { startDate: '2024-02-01', endDate: '2024-02-10' },
      ],
    };

    await assert.rejects(
      () => updateEngine({
        db,
        tableConf: dbTables.session,
        dbTables: dbTables,
        request: mockRequest,
        record: { id: 1, name: 'S1' },
        upsert: secs,
      }),
    );

    assert.ok(receivedSecondaries);
    assert.equal(receivedSecondaries.period.length, 2);
  });
});

// ─── validate + validateBulk in bulkUpsertEngine ──────────────

describe('validate - bulkUpsertEngine', () => {
  it('blocks bulk when per-item validate returns errors', async () => {
    const mockPg = createMockPg([]);
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: ({ main }) => {
        if (!main.name) {
          return [{ path: 'name', code: 'required' }];
        }
        return [];
      },
    });

    await assert.rejects(
      () => bulkUpsertEngine({
        db,
        tableConf: dbTables.session,
        dbTables: dbTables,
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
    const { dbTables, db } = createTestDbTables(mockPg, {
      validateBulk: ({ items }) => {
        receivedItems = items;
        return [{ path: 'periods', code: 'overlap' }];
      },
    });

    await assert.rejects(
      () => bulkUpsertEngine({
        db,
        tableConf: dbTables.session,
        dbTables: dbTables,
        request: mockRequest,
        items: [
          { main: { name: 'S1' }, upsert: { period: [{ startDate: '2024-01-01', endDate: '2024-01-31' }] } },
          { main: { name: 'S2' }, upsert: { period: [{ startDate: '2024-01-15', endDate: '2024-02-15' }] } },
        ],
      }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.validationErrors[0].path, 'periods');
        assert.equal(err.validationErrors[0].code, 'overlap');
        return true;
      }
    );

    assert.ok(receivedItems);
    assert.equal(receivedItems.length, 2);
    assert.ok(receivedItems[0].upsert);
    assert.ok(receivedItems[1].upsert);
  });

  it('uses validateBulk instead of per-item validate when both defined', async () => {
    const order = [];
    const mockPg = createMockPg([
      { rows: [{ id: 1 }, { id: 2 }], affectedRows: 2 },
    ]);
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: () => { order.push('validate'); return []; },
      validateBulk: () => { order.push('validateBulk'); return []; },
    });

    await bulkUpsertEngine({
      db,
      tableConf: dbTables.session,
      dbTables: dbTables,
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
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: () => { order.push('validate'); return []; },
    });

    await bulkUpsertEngine({
      db,
      tableConf: dbTables.session,
      dbTables: dbTables,
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
    const { dbTables, db } = createTestDbTables(mockPg, {
      validate: () => [],
      validateBulk: () => [],
    });

    const results = await bulkUpsertEngine({
      db,
      tableConf: dbTables.session,
      dbTables: dbTables,
      request: mockRequest,
      items: [
        { main: { name: 'S1' } },
        { main: { name: 'S2' } },
      ],
    });

    assert.equal(results.length, 2);
  });
});
