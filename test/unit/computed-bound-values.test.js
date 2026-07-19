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

// Computed fields may bind their own parameters. Their `expr` marks each bound value
// with `?`; the engine assigns the placeholder indexes. Every `$n` in the generated SQL
// must therefore point at the value the computed actually declared.

function createMockSchema(tableName, fields) {
  return {
    col: (f) => toUnderscore(f),
    fields,
    validation: Type.Object(fields),
    tableName,
    partialValidation: Type.Object(fields),
  };
}


const employeeSchema = createMockSchema('employee', {
  id: Type.Number(),
  name: Type.String(),
  role: Type.String(),
  salary: Type.Number(),
  deptId: Type.Number(),
});

const deptSchema = createMockSchema('dept', {
  id: Type.Number(),
  label: Type.String(),
  budget: Type.Number(),
});

const bonusField = ({ qiCol }) => ({
  expr: `CASE WHEN ${qiCol('role')} = ? THEN ${qiCol('salary')} ELSE 0 END`,
  values: ['admin'],
  type: Type.Number(),
});

function createDbTables() {
  return {
    employee: {
      primary: 'id',
      ...exportTableInfo(employeeSchema),
      defaultOrder: 'id',
      computedFields: { bonus: bonusField },
      allowedReadJoins: [
        buildRelation(employeeSchema, 'deptId', deptSchema, 'id', { alias: 'dept', unique: true }),
      ],
    },
    dept: {
      primary: 'id',
      ...exportTableInfo(deptSchema),
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(deptSchema, 'id', employeeSchema, 'deptId', { alias: 'staff' }),
      ],
      computedFields: {
        richBudget: ({ qiCol }) => ({
          expr: `CASE WHEN ${qiCol('label')} = ? THEN ${qiCol('budget')} ELSE 0 END`,
          values: ['rnd'],
          type: Type.Number(),
        }),
      },
    },
  };
}

/**
 * Reads the SQL of a query and resolves every `$n` to the value actually bound at that
 * position, so a test can assert what the database really sees.
 */
function resolvePlaceholders(call) {
  return call.text.replace(/\$(\d+)/g, (_m, n) => JSON.stringify(call.values[Number(n) - 1]));
}

describe('computed fields - marker/value consistency', () => {
  function tableWithComputed(computed) {
    return {
      employee: {
        primary: 'id',
        ...exportTableInfo(employeeSchema),
        defaultOrder: 'id',
        computedFields: { probe: computed },
      },
    };
  }

  it('rejects a computed that declares values but has no ? marker', async () => {
    // The pre-1.2 style: placeholders hardcoded in the expression. It cannot bind
    // correctly, so it must fail loudly instead of producing a silently wrong query.
    const DbTables = tableWithComputed(({ db, qiCol }) => ({
      expr: `CASE WHEN ${qiCol('role')} = ${db.ph(1)} THEN 1 ELSE 0 END`,
      values: ['admin'],
      type: Type.Number(),
    }));

    await assert.rejects(
      () => searchEngine(DbTables, {
        db: new QueryClient(createMockPg()),
        tableConf: DbTables.employee,
        filters: { probe: 1 },
      }),
      (err) => /probe/.test(err.message) && /\?/.test(err.message)
    );
  });

  it('rejects a marker count that does not match the number of values', async () => {
    const DbTables = tableWithComputed(({ qiCol }) => ({
      expr: `CASE WHEN ${qiCol('role')} = ? AND ${qiCol('name')} = ? THEN 1 ELSE 0 END`,
      values: ['admin'],
      type: Type.Number(),
    }));

    await assert.rejects(
      () => searchEngine(DbTables, {
        db: new QueryClient(createMockPg()),
        tableConf: DbTables.employee,
        filters: { probe: 1 },
      }),
      (err) => /probe/.test(err.message)
    );
  });

  it('allows a value-less expression containing a literal question mark', async () => {
    // Postgres jsonb `?` operator, no bound values: emitted verbatim, never a marker.
    const mockPg = createMockPg();
    const DbTables = tableWithComputed(({ qiCol }) => ({
      expr: `(${qiCol('name')}::jsonb ? 'key')`,
      values: [],
      type: Type.Boolean(),
    }));

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.employee,
      filters: { probe: true },
    });

    assert.match(mockPg.calls[0].text, /::jsonb \? 'key'/);
  });
});

describe('computed fields with bound values - placeholder binding', () => {
  it('binds the computed value correctly when it is the only filter', async () => {
    const mockPg = createMockPg();
    const DbTables = createDbTables();

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.employee,
      filters: { bonus: 500 },
    });

    const resolved = resolvePlaceholders(mockPg.calls[0]);
    assert.match(resolved, /"role" = "admin"/, `computed value misbound: ${resolved}`);
    assert.match(resolved, /END = 500/, `compared value misbound: ${resolved}`);
  });

  it('binds correctly when another filter precedes the computed one', async () => {
    const mockPg = createMockPg();
    const DbTables = createDbTables();

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.employee,
      filters: { name: 'Mario', bonus: 500 },
    });

    const call = mockPg.calls[0];
    const resolved = resolvePlaceholders(call);
    assert.match(resolved, /"name" = "Mario"/, `plain filter misbound: ${resolved}`);
    assert.match(resolved, /"role" = "admin"/, `computed value misbound: ${resolved}`);
    assert.match(resolved, /END = 500/, `compared value misbound: ${resolved}`);

    // Every bound value must actually be referenced by the SQL
    const referenced = new Set((call.text.match(/\$(\d+)/g) || []).map((p) => Number(p.slice(1))));
    for (let i = 1; i <= call.values.length; i++) {
      assert.ok(referenced.has(i), `value $${i} (${JSON.stringify(call.values[i - 1])}) is bound but never referenced`);
    }
  });

  it('binds correctly for a condition on a computed field', async () => {
    const mockPg = createMockPg();
    const DbTables = createDbTables();

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.employee,
      filters: { name: 'Mario' },
      conditions: [{ field: 'bonus', method: 'isGreater', params: [500] }],
    });

    const resolved = resolvePlaceholders(mockPg.calls[0]);
    assert.match(resolved, /"name" = "Mario"/, `plain filter misbound: ${resolved}`);
    assert.match(resolved, /"role" = "admin"/, `computed value misbound: ${resolved}`);
    assert.match(resolved, /END > 500/, `compared value misbound: ${resolved}`);
  });

  it('binds correctly for orderBy on a computed field', async () => {
    const mockPg = createMockPg();
    const DbTables = createDbTables();

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.employee,
      filters: { name: 'Mario' },
      orderBy: 'bonus DESC',
    });

    const call = mockPg.calls[0];
    const resolved = resolvePlaceholders(call);
    assert.match(resolved, /"name" = "Mario"/, `plain filter misbound: ${resolved}`);
    assert.match(resolved, /ORDER BY CASE WHEN "role" = "admin"/, `orderBy computed misbound: ${resolved}`);
  });

  it('binds correctly with several computed references at once', async () => {
    const mockPg = createMockPg();
    const DbTables = createDbTables();

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.employee,
      filters: { name: 'Mario', bonus: 500 },
      conditions: [{ field: 'bonus', method: 'isLess', params: [9000] }],
    });

    const call = mockPg.calls[0];
    const resolved = resolvePlaceholders(call);
    assert.equal(
      (resolved.match(/"role" = "admin"/g) || []).length,
      2,
      `both computed references must bind 'admin': ${resolved}`
    );
    assert.match(resolved, /END = 500/, `equality value misbound: ${resolved}`);
    assert.match(resolved, /END < 9000/, `comparison value misbound: ${resolved}`);
  });

  it('binds correctly when a joined table is filtered on its computed field', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, label: 'rnd', budget: 10 }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const DbTables = createDbTables();

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.dept,
      filters: { label: 'rnd' },
      // The join side-query filters on a plain column AND on employee's computed `bonus`
      joinMultiple: { staff: { filters: { name: 'Mario', bonus: 500 } } },
    });

    const sideCall = mockPg.calls[1];
    const resolved = resolvePlaceholders(sideCall);
    assert.match(resolved, /"name" = "Mario"/, `join filter misbound: ${resolved}`);
    assert.match(resolved, /"role" = "admin"/, `join computed value misbound: ${resolved}`);
    assert.match(resolved, /END = 500/, `join compared value misbound: ${resolved}`);
  });

  it('binds correctly for a computed filter inside joinMustExist (EXISTS)', async () => {
    const mockPg = createMockPg();
    const DbTables = createDbTables();

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.dept,
      filters: { label: 'rnd' },
      joinMustExist: { staff: { filters: { name: 'Mario', bonus: 500 } } },
    });

    const call = mockPg.calls[0];
    const resolved = resolvePlaceholders(call);
    assert.match(resolved, /"label" = "rnd"/, `outer filter misbound: ${resolved}`);
    assert.match(resolved, /"name" = "Mario"/, `EXISTS filter misbound: ${resolved}`);
    assert.match(resolved, /"role" = "admin"/, `EXISTS computed value misbound: ${resolved}`);
    assert.match(resolved, /END = 500/, `EXISTS compared value misbound: ${resolved}`);
  });

  it('binds correctly for a computed filter on a joinLeft parent', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', dept_id: 2 }], affectedRows: 1 },
      { rows: [], affectedRows: 0 },
    ]);
    const DbTables = createDbTables();

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.employee,
      filters: { name: 'Mario' },
      joinLeft: { dept: { filters: { richBudget: 99 } } },
    });

    const call = mockPg.calls[0];
    const resolved = resolvePlaceholders(call);
    assert.match(resolved, /"name" = "Mario"/, `main filter misbound: ${resolved}`);
    assert.match(resolved, /"label" = "rnd"/, `joinLeft computed value misbound: ${resolved}`);
    assert.match(resolved, /END = 99/, `joinLeft compared value misbound: ${resolved}`);
  });

  it('binds correctly when the computed is used with pagination', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
      { rows: [{ total: '0' }], affectedRows: 1 },
    ]);
    const DbTables = createDbTables();

    await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.employee,
      filters: { name: 'Mario', bonus: 500 },
      paginator: { page: 1, itemsPerPage: 10 },
    });

    // The COUNT query reuses the WHERE clause and must bind the same values
    const countCall = mockPg.calls[1];
    const resolved = resolvePlaceholders(countCall);
    assert.match(resolved, /"name" = "Mario"/, `count filter misbound: ${resolved}`);
    assert.match(resolved, /"role" = "admin"/, `count computed misbound: ${resolved}`);
  });
});
