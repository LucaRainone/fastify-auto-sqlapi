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
const { getDialect } = await import(path.join(ROOT, 'dist/lib/dialect.js'));
const { Type } = await import('@sinclair/typebox');

const DIALECTS = ['postgres', 'mysql'];

function createMockSchema(tableName, fields) {
  return { col: (f) => toUnderscore(f), fields, validation: Type.Object(fields), tableName, partialValidation: Type.Object(fields) };
}


const userFields = { id: Type.Number(), name: Type.String(), active: Type.Boolean(), orgId: Type.Number() };
const sessionFields = { id: Type.Number(), userId: Type.Number(), duration: Type.Number(), status: Type.String() };
const orgFields = { id: Type.Number(), name: Type.String() };

function createTestDbTables(mockPg, dialect) {
  const userSchema = createMockSchema('user', userFields);
  const sessionSchema = createMockSchema('session', sessionFields);
  const orgSchema = createMockSchema('org', orgFields);

  const DbTables = {
    user: {
      primary: 'id',
      ...exportTableInfo(userSchema),
      defaultOrder: 'id',
      allowedReadJoins: [
        buildRelation(userSchema, 'id', sessionSchema, 'userId', { alias: 'session' }),             // unique:false → joinGroup
        buildRelation(userSchema, 'orgId', orgSchema, 'id', { alias: 'org', unique: true }),         // unique:true → joinLeft
      ],
    },
    session: { primary: 'id', ...exportTableInfo(sessionSchema), defaultOrder: 'id' },
    org: { primary: 'id', ...exportTableInfo(orgSchema), defaultOrder: 'id' },
  };
  return { DbTables, db: new QueryClient(mockPg, getDialect(dialect)) };
}

for (const dialect of DIALECTS) {
  describe(`search placeholders — aggregation orderBy + filtered joinLeft together [${dialect}]`, () => {
    it('binds joinLeft filter and orderBy subquery filter to distinct params (no overlap)', async () => {
      // main returns empty → no joinLeft/joinGroup side queries run; assert on the main SQL only.
      const mockPg = createMockPg([{ rows: [] }]);
      const { DbTables, db } = createTestDbTables(mockPg, dialect);

      await searchEngine(DbTables, {
        db,
        tableConf: DbTables.user,
        filters: { active: true },                        // WHERE
        joinLeft: { org: { filters: { name: 'acme' } } }, // LEFT JOIN filter
        orderBy: 'session.sum.duration DESC',
        joinGroup: {
          session: { aggregations: { sum: ['duration'] }, filters: { status: 'completed' } }, // agg subquery filter
        },
      });

      const call = mockPg.calls[0];
      const sql = call.text;

      // The dialect-independent correctness invariant: values bind in [WHERE, leftJoin, orderBy] order.
      // Before the fix, on Postgres both filters reused $2 (status silently read 'acme').
      assert.deepEqual(call.values, [true, 'acme', 'completed'], sql);

      const qorg = dialect === 'postgres' ? '"org"."name"' : '`org`.`name`';
      const qstatus = dialect === 'postgres' ? '"status"' : '`status`';
      assert.ok(sql.includes(`LEFT JOIN ${dialect === 'postgres' ? '"org"' : '`org`'}`), sql);
      assert.ok(sql.includes(`SUM(${dialect === 'postgres' ? '"session"."duration"' : '`session`.`duration`'})`), sql);

      if (dialect === 'postgres') {
        // Explicit, human-visible proof of non-overlap: distinct placeholder numbers.
        assert.ok(sql.includes(`${qorg} = $2`), `joinLeft filter should be $2: ${sql}`);
        assert.ok(sql.includes(`${qstatus} = $3`), `orderBy subquery filter should be $3: ${sql}`);
      } else {
        // MySQL uses positional '?'; exactly three of them, bound in the asserted value order.
        assert.equal((sql.match(/\?/g) || []).length, 3, sql);
        assert.ok(sql.includes(`${qorg} = ?`), sql);
        assert.ok(sql.includes(`${qstatus} = ?`), sql);
      }
    });

    it('regression: aggregation orderBy alone still binds right after WHERE values', async () => {
      const mockPg = createMockPg([{ rows: [] }]);
      const { DbTables, db } = createTestDbTables(mockPg, dialect);

      await searchEngine(DbTables, {
        db,
        tableConf: DbTables.user,
        filters: { active: true },
        orderBy: 'session.sum.duration DESC',
        joinGroup: { session: { aggregations: { sum: ['duration'] }, filters: { status: 'done' } } },
      });

      const call = mockPg.calls[0];
      assert.deepEqual(call.values, [true, 'done']);
      if (dialect === 'postgres') {
        assert.ok(call.text.includes('"status" = $2'), call.text);
      }
    });
  });
}
