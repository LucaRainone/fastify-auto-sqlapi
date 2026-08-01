import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg, createMockSchema } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { exportTableInfo, buildRelation, defineTable } =
  await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { SearchTableBodyPost, SearchTableResponse } =
  await import(path.join(ROOT, 'dist/lib/schema/search.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { Type } = await import('@sinclair/typebox');

// `fields` narrows a relation to an allowlist: the join exposes those columns and nothing
// else, on every read surface. Without it the only way to expose a table broadly while
// keeping some columns narrow was to hand-maintain a trimmed copy of its Schema — which
// silently drifts, since schemas are regenerated from the DB (ADR 0007).

const agentSchema = createMockSchema('agent', {
  id: Type.Number(),
  name: Type.String(),
  userId: Type.Number(),
  salary: Type.Number(),
});

const userSchema = createMockSchema('user', {
  id: Type.Number(),
  name: Type.String(),
  email: Type.String(),
});

function createDbTables() {
  // agent → user (N:1, joinLeft): the shift planner needs the account's name, never its email.
  // user → agent (1:N): the child list must not carry salary.
  return {
    agent: {
      primary: 'id',
      ...exportTableInfo(agentSchema),
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(agentSchema, 'userId', userSchema, 'id', {
          alias: 'user',
          unique: true,
          fields: ['id', 'name'],
        }),
      ],
    },
    user: {
      primary: 'id',
      ...exportTableInfo(userSchema),
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(userSchema, 'id', agentSchema, 'userId', {
          alias: 'agents',
          fields: ['id', 'name', 'userId'],
        }),
      ],
    },
  };
}

/** Same tables, with computed fields on `agent` — one reaching past the allowlist, one not. */
function createDbTablesWithComputed() {
  const dbTables = createDbTables();
  dbTables.agent.computedFields = {
    // reaches `salary`, which the `agents` relation does not expose
    salaryBand: ({ qiCol }) => ({ expr: `CASE WHEN ${qiCol('salary')} > 100 THEN 'high' ELSE 'low' END`, type: Type.String() }),
    // stays inside the allowlist
    nameUpper: ({ qiCol }) => ({ expr: `UPPER(${qiCol('name')})`, type: Type.String() }),
  };
  return dbTables;
}

function run(tableName, params) {
  const mockPg = createMockPg();
  const DbTables = createDbTables();
  return {
    mockPg,
    promise: searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables[tableName],
      ...params,
    }),
  };
}

async function expect400(tableName, params, messageRe) {
  const { promise } = run(tableName, params);
  await assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, 400, `expected 400, got ${err.statusCode}: ${err.message}`);
    assert.match(err.message, messageRe);
    return true;
  });
}

describe('buildRelation fields — declaration-time checks', () => {
  it('rejects a field that is not on the join schema', () => {
    assert.throws(
      () => buildRelation(agentSchema, 'userId', userSchema, 'id', {
        unique: true,
        fields: ['id', 'nosuchfield'],
      }),
      /nosuchfield/
    );
  });

  it('rejects an allowlist that omits the correlation field', () => {
    // joinField is what ties the rows back to the main result set: dropping it from the
    // projection leaves the caller unable to match parents to rows.
    assert.throws(
      () => buildRelation(agentSchema, 'userId', userSchema, 'id', {
        unique: true,
        fields: ['name'],
      }),
      /id/
    );
  });

  it('rejects fields on a write join', () => {
    // Write paths look the relation's schema up by identity (upsertMap) and must write
    // every column the caller sent: a narrowed relation there would silently degrade.
    const rel = buildRelation(userSchema, 'id', agentSchema, 'userId', {
      alias: 'agents',
      fields: ['id', 'name', 'userId'],
    });
    assert.throws(
      () => defineTable({
        primary: 'id',
        ...exportTableInfo(userSchema),
        allowedWriteJoins: [rel],
      }),
      /fields/
    );
  });

  it('leaves an unrestricted relation untouched', () => {
    const rel = buildRelation(agentSchema, 'userId', userSchema, 'id', { unique: true });
    assert.equal(rel.joinSchema, userSchema, 'the original schema object must be reused');
    assert.equal(rel.fields, undefined);
  });
});

describe('buildRelation fields — generated schemas', () => {
  it('the relation exposes only the allowed fields', () => {
    const rel = createDbTables().agent.allowedReadJoins[0];
    assert.deepEqual(Object.keys(rel.joinSchema.fields), ['id', 'name']);
    assert.equal(rel.joinSchema.tableName, 'user', 'table name must survive the narrowing');
  });

  it('the request body advertises only the allowed fields', () => {
    const body = SearchTableBodyPost(createDbTables(), 'agent');
    const filters = body.properties.joinLeft.properties.user.properties.filters;
    assert.ok(filters.properties.name);
    assert.equal(filters.properties.email, undefined);
  });

  it('the response schema advertises only the allowed fields', () => {
    const res = SearchTableResponse(createDbTables(), 'agent');
    const item = res.properties.joinLeft.properties.user.items;
    assert.ok(item.properties.name);
    assert.equal(item.properties.email, undefined);
  });
});

describe('buildRelation fields — engine enforcement', () => {
  it('rejects a disallowed field in an explicit selection', async () => {
    await expect400('agent', { joinLeft: { user: { selection: 'id, email' } } }, /Unknown field: email/);
  });

  it('rejects a disallowed field in join filters', async () => {
    await expect400('agent', { joinLeft: { user: { filters: { email: 'a@b.c' } } } }, /Unknown filter field: email/);
  });

  it('rejects a disallowed field in join conditions', async () => {
    await expect400(
      'agent',
      { joinLeft: { user: { conditions: [{ field: 'email', method: 'isLike', params: ['%@x%'] }] } } },
      /Unknown field: email/
    );
  });

  it('rejects a disallowed field in 2-part orderBy', async () => {
    await expect400('agent', { orderBy: 'user.email' }, /email/);
  });

  it('rejects a disallowed field in a joinGroup aggregation', async () => {
    await expect400(
      'user',
      { joinGroup: { agents: { aggregations: { sum: ['salary'] } } } },
      /salary/
    );
  });

  it('still allows the fields on the list', async () => {
    const { promise } = run('agent', { joinLeft: { user: { filters: { name: 'Mario' } } } });
    await promise;
  });
});

describe('buildRelation fields — computed fields cannot reach past the allowlist', () => {
  // A computed field is a derived value that may read any column of its table. Resolving it
  // against the full table schema would let `salaryBand` return what `salary` says, through a
  // relation declared not to expose it — an allowlist with a documented way around it.
  function runComputed(params) {
    const dbTables = createDbTablesWithComputed();
    return searchEngine(dbTables, {
      db: new QueryClient(createMockPg()),
      tableConf: dbTables.user,
      ...params,
    });
  }

  it('rejects a computed field that reads a field outside the allowlist', async () => {
    await assert.rejects(
      () => runComputed({ joinMustExist: { agents: { filters: { salaryBand: 'high' } } } }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /salary/);
        return true;
      }
    );
  });

  it('allows a computed field that stays inside the allowlist', async () => {
    await runComputed({ joinMustExist: { agents: { filters: { nameUpper: 'MARIO' } } } });
  });

  it('the same computed stays usable on the table that owns it', async () => {
    const dbTables = createDbTablesWithComputed();
    await searchEngine(dbTables, {
      db: new QueryClient(createMockPg()),
      tableConf: dbTables.agent,
      filters: { salaryBand: 'high' },
    });
  });
});

describe('buildRelation fields — the default selection is not SELECT *', () => {
  it('expands the default selection to the allowed columns', async () => {
    // A relation left at selection '*' used to emit a literal SELECT *: the extra columns
    // were removed only by the response serializer, so they still reached a caller of
    // sqlApi.search(). An allowlist that leaks on its default is not an allowlist.
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', user_id: 7 }], rowCount: 1 },
      { rows: [{ total: '1' }], rowCount: 1 },
      { rows: [{ id: 7, name: 'Account', email: 'leak@x.it' }], rowCount: 1 },
    ]);
    const DbTables = createDbTables();

    const result = await searchEngine(DbTables, {
      db: new QueryClient(mockPg),
      tableConf: DbTables.agent,
      joinLeft: { user: {} },
    });

    const joinQuery = mockPg.calls.find((c) => c.text.includes('FROM "user"'));
    assert.ok(joinQuery, 'the parent side query must have run');
    assert.ok(!/SELECT \*/i.test(joinQuery.text), `still a SELECT *: ${joinQuery.text}`);
    assert.ok(joinQuery.text.includes('"user"."name"'), `name not projected: ${joinQuery.text}`);
    assert.ok(!joinQuery.text.includes('email'), `email projected: ${joinQuery.text}`);

    // Belt and braces: whatever the driver hands back, the engine result carries only the
    // declared shape — the programmatic path has no serializer to strip anything.
    assert.equal(result.joinLeft.user[0].email, undefined);
  });
});
