import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search/search.js'));
const { getEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/get.js'));
const { buildRelation, defineTable } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { SearchTableBodyPost, SearchTableResponse } = await import(path.join(ROOT, 'dist/lib/schema/search.js'));
const { InsertTableBody } = await import(path.join(ROOT, 'dist/lib/schema/insert.js'));
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


// team 1:N player; team.secretBudget and player.hiddenPotential are read-excluded
const teamSchema = createMockSchema('team', {
  id: Type.Number(),
  name: Type.String(),
  secretBudget: Type.Number(),
});
const playerSchema = createMockSchema('player', {
  id: Type.Number(),
  teamId: Type.Number(),
  name: Type.String(),
  hiddenPotential: Type.Number(),
});

function createDbTables() {
  return {
    team: {
      primary: 'id',
      schema: teamSchema,
      readExclude: ['secretBudget'],
      readJoins: [
        buildRelation(teamSchema, 'id', playerSchema, 'teamId', { alias: 'player' }),
      ],
    },
    player: {
      primary: 'id',
      schema: playerSchema,
      readExclude: ['hiddenPotential'],
      readJoins: [
        buildRelation(playerSchema, 'teamId', teamSchema, 'id', { alias: 'team', unique: true }),
      ],
    },
  };
}

describe('readExclude - main table reads', () => {
  it('search SELECT projects only readable columns', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const dbTables = createDbTables();

    await searchEngine(dbTables, {
      db: new QueryClient(mockPg),
      tableConf: dbTables.player,
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes(`"player"."id", "player"."team_id", "player"."name"`), `expected explicit columns in: ${sql}`);
    assert.ok(!sql.includes('hidden_potential'), `excluded column must not be selected: ${sql}`);
  });

  it('get SELECT projects only readable columns', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, team_id: 2, name: 'Mario' }], affectedRows: 1 },
    ]);
    const dbTables = createDbTables();

    const result = await getEngine({
      db: new QueryClient(mockPg),
      tableConf: dbTables.player,
      id: '1',
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes(`"player"."id", "player"."team_id", "player"."name"`), `expected explicit columns in: ${sql}`);
    assert.ok(!/SELECT \*/.test(sql), `must not select * when readExclude is set: ${sql}`);
    assert.ok(!sql.includes('hidden_potential'), `excluded column must not be selected: ${sql}`);
    assert.equal(result.main.name, 'Mario');
  });

  it('a computed field in select keeps working alongside readExclude', async () => {
    const mockPg = createMockPg([{ rows: [], affectedRows: 0 }]);
    const dbTables = createDbTables();
    dbTables.player.computedFields = {
      upperName: ({ qiCol }) => ({
        expr: `UPPER(${qiCol('name')})`,
        values: [],
        type: Type.String(),
      }),
    };

    await searchEngine(dbTables, {
      db: new QueryClient(mockPg),
      tableConf: dbTables.player,
      select: ['id', 'teamId', 'name', 'upperName'],
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('AS "upperName"'));
    assert.ok(sql.includes(`"player"."id", "player"."team_id", "player"."name"`), `expected explicit columns in: ${sql}`);
    assert.ok(!/SELECT \*/.test(sql), `must not select * when readExclude is set: ${sql}`);
    assert.ok(!sql.includes('hidden_potential'), `excluded column must not be selected: ${sql}`);
  });
});

describe('readExclude - excluded fields cannot be referenced (no value probing)', () => {
  const cases = [
    ['filters', { filters: { hiddenPotential: 9 } }],
    ['conditions', { conditions: [{ field: 'hiddenPotential', method: 'isGreater', params: [5] }] }],
    ['orderBy', { orderBy: 'hiddenPotential DESC' }],
    ['compute.max', { paginator: { page: 1, itemsPerPage: 10 }, compute: { max: ['hiddenPotential'] } }],
  ];

  for (const [label, params] of cases) {
    it(`rejects ${label} on an excluded field with 400`, async () => {
      const mockPg = createMockPg([
        { rows: [], affectedRows: 0 },
        { rows: [{ total: '0' }], affectedRows: 1 },
      ]);
      const dbTables = createDbTables();

      await assert.rejects(
        () => searchEngine(dbTables, {
          db: new QueryClient(mockPg),
          tableConf: dbTables.player,
          ...params,
        }),
        (err) => err.statusCode === 400 && /hiddenPotential/.test(err.message)
      );
    });
  }
});

describe('readExclude - joined tables', () => {
  it('joinMultiple default projection omits the excluded column', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Alpha' }], affectedRows: 1 }, // main (team)
      { rows: [], affectedRows: 0 },                          // side query (player)
    ]);
    const dbTables = createDbTables();

    await searchEngine(dbTables, {
      db: new QueryClient(mockPg),
      tableConf: dbTables.team,
      joinMultiple: { player: {} },
    });

    const sideSql = mockPg.calls[1].text;
    assert.ok(sideSql.includes('"name"'));
    assert.ok(!sideSql.includes('hidden_potential'), `excluded join column selected: ${sideSql}`);
  });

  it('rejects an explicit join select naming an excluded field with 400', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Alpha' }], affectedRows: 1 },
    ]);
    const dbTables = createDbTables();

    await assert.rejects(
      () => searchEngine(dbTables, {
        db: new QueryClient(mockPg),
        tableConf: dbTables.team,
        joinMultiple: { player: { select: ['id', 'hiddenPotential'] } },
      }),
      (err) => err.statusCode === 400 && /hiddenPotential/.test(err.message)
    );
  });

  it('rejects join filters on an excluded field with 400', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Alpha' }], affectedRows: 1 },
    ]);
    const dbTables = createDbTables();

    await assert.rejects(
      () => searchEngine(dbTables, {
        db: new QueryClient(mockPg),
        tableConf: dbTables.team,
        joinMultiple: { player: { filters: { hiddenPotential: 9 } } },
      }),
      (err) => err.statusCode === 400 && /hiddenPotential/.test(err.message)
    );
  });

  it('rejects joinGroup aggregations on an excluded field with 400', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Alpha' }], affectedRows: 1 },
    ]);
    const dbTables = createDbTables();

    await assert.rejects(
      () => searchEngine(dbTables, {
        db: new QueryClient(mockPg),
        tableConf: dbTables.team,
        joinGroup: { player: { sum: ['hiddenPotential'] } },
      }),
      (err) => err.statusCode === 400 && /hiddenPotential/.test(err.message)
    );
  });

  it('rejects joinGroup aggregations.by on an excluded field with 400 (GROUP BY would leak distinct values)', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Alpha' }], affectedRows: 1 },
    ]);
    const dbTables = createDbTables();

    await assert.rejects(
      () => searchEngine(dbTables, {
        db: new QueryClient(mockPg),
        tableConf: dbTables.team,
        joinGroup: { player: { by: 'hiddenPotential', count: ['id'] } },
      }),
      (err) => err.statusCode === 400 && /hiddenPotential/.test(err.message)
    );
  });

  it('rejects HAVING-style conditions on an excluded field even with empty main results (bisection oracle)', async () => {
    // Empty main result set: executeJoinGroup's own validation is skipped
    // (ids.length === 0), so the guard must fire at condition-build time —
    // otherwise 400-vs-200 becomes a binary oracle on the hidden aggregate.
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const dbTables = createDbTables();

    await assert.rejects(
      () => searchEngine(dbTables, {
        db: new QueryClient(mockPg),
        tableConf: dbTables.team,
        conditions: [{ field: 'player.sum.hiddenPotential', method: 'isGreater', params: [100] }],
        joinGroup: { player: { sum: ['hiddenPotential'] } },
      }),
      (err) => err.statusCode === 400 && /hiddenPotential/.test(err.message)
    );
  });

  it('rejects 3-part aggregation orderBy on an excluded field with 400', async () => {
    const dbTables = createDbTables();

    await assert.rejects(
      () => searchEngine(dbTables, {
        db: new QueryClient(createMockPg([{ rows: [], affectedRows: 0 }])),
        tableConf: dbTables.team,
        orderBy: 'player.sum.hiddenPotential DESC',
        joinGroup: { player: { sum: ['hiddenPotential'] } },
      }),
      (err) => err.statusCode === 400 && /hiddenPotential/.test(err.message)
    );
  });

  it('rejects joinLeft filters and 2-part orderBy on an excluded parent field with 400', async () => {
    const dbTables = createDbTables();

    await assert.rejects(
      () => searchEngine(dbTables, {
        db: new QueryClient(createMockPg()),
        tableConf: dbTables.player,
        joinLeft: { team: { filters: { secretBudget: 1 } } },
      }),
      (err) => err.statusCode === 400 && /secretBudget/.test(err.message)
    );

    await assert.rejects(
      () => searchEngine(dbTables, {
        db: new QueryClient(createMockPg()),
        tableConf: dbTables.player,
        joinLeft: { team: {} },
        orderBy: 'team.secretBudget DESC',
      }),
      (err) => err.statusCode === 400 && /secretBudget/.test(err.message)
    );
  });
});

describe('readExclude - schema builders', () => {
  it('SearchTableResponse omits excluded fields from main and join items', () => {
    const dbTables = createDbTables();
    const response = SearchTableResponse(dbTables, 'team');

    const mainProps = response.properties.main.items.properties;
    assert.ok(mainProps.name);
    assert.ok(!mainProps.secretBudget, 'main response must omit excluded field');

    const joinProps = response.properties.joinMultiple.properties.player.items.properties;
    assert.ok(joinProps.name);
    assert.ok(!joinProps.hiddenPotential, 'join response must omit excluded field');
  });

  it('SearchTableBodyPost omits excluded fields from main and join filters', () => {
    const dbTables = createDbTables();
    const body = SearchTableBodyPost(dbTables, 'team');

    const filterProps = body.properties.filters.properties;
    assert.ok(filterProps.name);
    assert.ok(!filterProps.secretBudget, 'main filters must omit excluded field');

    const joinFilterProps =
      body.properties.joinMultiple.properties.player.properties.filters.properties;
    assert.ok(joinFilterProps.name);
    assert.ok(!joinFilterProps.hiddenPotential, 'join filters must omit excluded field');
  });

  it('InsertTableBody still accepts excluded fields (writes unaffected)', () => {
    const dbTables = createDbTables();
    const body = InsertTableBody(dbTables, 'player');

    assert.ok(body.properties.main.properties.hiddenPotential,
      'readExclude must not affect write schemas');
  });
});

describe('readExclude - defineTable validation', () => {
  it('rejects readExclude entries that are not schema fields', () => {
    assert.throws(
      () => defineTable({
        primary: 'id',
        schema: playerSchema,
        readExclude: ['nonExistent'],
      }),
      /readExclude|nonExistent/
    );
  });

  it('rejects readExclude on a primary-key field', () => {
    assert.throws(
      () => defineTable({
        primary: 'id',
        schema: playerSchema,
        readExclude: ['id'],
      }),
      /primary/i
    );
  });
});
