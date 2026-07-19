import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPg } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { assertTenantOwnsConflicts } = await import(path.join(ROOT, 'dist/lib/tenant.js'));
const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/insert.js'));
const { bulkUpsertEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk/bulk-upsert.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { getDialect } = await import(path.join(ROOT, 'dist/lib/dialect.js'));
const { Type } = await import('@sinclair/typebox');

const DIALECTS = ['postgres', 'mysql'];
const qcol = (d, t, c) => (d === 'postgres' ? `"${t}"."${c}"` : `\`${t}\`.\`${c}\``);

function createMockSchema(tableName, fields) {
  return { col: (f) => toUnderscore(f), fields, validation: Type.Object(fields), tableName, partialValidation: Type.Object(fields) };
}


const customerFields = { id: Type.Number(), name: Type.String(), email: Type.String(), organizationId: Type.Number() };

function makeTable(upsertKeys) {
  const schema = createMockSchema('customer', customerFields);
  const tableConf = {
    primary: 'id',
    ...exportTableInfo(schema),
    defaultOrder: 'id',
    tenantScope: { column: 'organization_id' },
    upsertMap: new Map([[schema, upsertKeys]]),
  };
  return { schema, tableConf };
}

const directTenant = { ids: [42], scope: { column: 'organization_id' } };

for (const dialect of DIALECTS) {
  const client = (mockPg) => new QueryClient(mockPg, getDialect(dialect));

  describe(`assertTenantOwnsConflicts [${dialect}]`, () => {
    it('no-op without tenant', async () => {
      const mockPg = createMockPg();
      await assertTenantOwnsConflicts(client(mockPg), undefined, 'customer', ['id'], [{ id: 1 }]);
      assert.equal(mockPg.calls.length, 0);
    });

    it('skips records missing the conflict key', async () => {
      const mockPg = createMockPg();
      await assertTenantOwnsConflicts(client(mockPg), directTenant, 'customer', ['id'], [{ name: 'x' }]);
      assert.equal(mockPg.calls.length, 0);
    });

    it('probes a single conflict key against foreign tenants', async () => {
      const mockPg = createMockPg([{ rows: [] }]);
      await assertTenantOwnsConflicts(client(mockPg), directTenant, 'customer', ['id'], [{ id: 7 }, { id: 8 }]);
      const sql = mockPg.calls[0].text;
      assert.ok(sql.includes('SELECT 1 FROM ' + (dialect === 'postgres' ? '"customer"' : '`customer`')));
      assert.ok(sql.includes(`${qcol(dialect, 'customer', 'id')} IN (`), sql);
      assert.ok(sql.includes(`${qcol(dialect, 'customer', 'organization_id')} NOT IN (`), sql);
      assert.ok(sql.includes('LIMIT 1'));
      // Value order is the dialect-independent invariant.
      assert.deepEqual(mockPg.calls[0].values, [7, 8, 42]);
    });

    it('throws 403 when a conflict row belongs to another tenant', async () => {
      const mockPg = createMockPg([{ rows: [{ x: 1 }] }]);
      await assert.rejects(
        () => assertTenantOwnsConflicts(client(mockPg), directTenant, 'customer', ['id'], [{ id: 7 }]),
        (err) => err.statusCode === 403
      );
    });

    it('passes when no foreign-owned conflict row exists', async () => {
      const mockPg = createMockPg([{ rows: [] }]);
      await assertTenantOwnsConflicts(client(mockPg), directTenant, 'customer', ['id'], [{ id: 7 }]);
      assert.equal(mockPg.calls.length, 1);
    });

    it('builds OR-of-AND tuples for composite conflict keys', async () => {
      const mockPg = createMockPg([{ rows: [] }]);
      await assertTenantOwnsConflicts(
        client(mockPg), directTenant, 'customer', ['id', 'email'],
        [{ id: 1, email: 'a@x' }, { id: 2, email: 'b@x' }]
      );
      const sql = mockPg.calls[0].text;
      assert.ok(sql.includes(`(${qcol(dialect, 'customer', 'id')} =`), sql);
      assert.ok(sql.includes(` OR (${qcol(dialect, 'customer', 'id')} =`), sql);
      assert.deepEqual(mockPg.calls[0].values, [1, 'a@x', 2, 'b@x', 42]);
    });

    it('probes through the tenant JOIN for indirect scopes', async () => {
      const mockPg = createMockPg([{ rows: [] }]);
      const throughSchema = createMockSchema('customer', { id: Type.Number(), organizationId: Type.Number() });
      const indirect = {
        ids: [5],
        scope: { column: 'organization_id', through: { schema: throughSchema, localField: 'customer_id', foreignField: 'id' } },
      };
      await assertTenantOwnsConflicts(client(mockPg), indirect, 'customer_order', ['id'], [{ id: 9 }]);
      const sql = mockPg.calls[0].text;
      assert.ok(sql.includes('INNER JOIN ' + (dialect === 'postgres' ? '"customer"' : '`customer`')), sql);
      assert.ok(sql.includes(`${qcol(dialect, 'customer', 'organization_id')} NOT IN (`), sql);
      assert.deepEqual(mockPg.calls[0].values, [9, 5]);
    });
  });

  describe(`insertEngine upsert with tenant [${dialect}]`, () => {
    it('rejects (403) when the upsert conflict target is owned by another tenant', async () => {
      const { tableConf } = makeTable(['id']);
      const mockPg = createMockPg([{ rows: [{ x: 1 }] }]);
      await assert.rejects(
        () => insertEngine({ db: client(mockPg), tableConf, dbTables: {}, request: {}, record: { id: 99, name: 'Stolen' }, tenant: directTenant }),
        (err) => err.statusCode === 403
      );
      assert.equal(mockPg.calls.length, 1);
      assert.ok(!/ON CONFLICT|ON DUPLICATE KEY/.test(mockPg.calls[0].text));
    });

    it('proceeds to upsert when no foreign-owned conflict exists', async () => {
      const { tableConf } = makeTable(['id']);
      const mockPg = createMockPg([{ rows: [] }, { rows: [{ id: 99 }] }]);
      const res = await insertEngine({ db: client(mockPg), tableConf, dbTables: {}, request: {}, record: { id: 99, name: 'Mine' }, tenant: directTenant });
      assert.equal(res.main.id, 99);
      assert.equal(mockPg.calls.length, 2);
      assert.ok(/ON CONFLICT|ON DUPLICATE KEY/.test(mockPg.calls[1].text));
    });

    it('does not probe when there is no upsertMap (plain insert)', async () => {
      const schema = createMockSchema('customer', customerFields);
      const tableConf = { primary: 'id', ...exportTableInfo(schema), defaultOrder: 'id', tenantScope: { column: 'organization_id' } };
      const mockPg = createMockPg([{ rows: [{ id: 1 }] }]);
      await insertEngine({ db: client(mockPg), tableConf, dbTables: {}, request: {}, record: { name: 'Mario' }, tenant: directTenant });
      assert.equal(mockPg.calls.length, 1);
      assert.ok(mockPg.calls[0].text.includes('INSERT INTO ' + (dialect === 'postgres' ? '"customer"' : '`customer`')));
    });
  });

  describe(`bulkUpsertEngine upsert with tenant [${dialect}]`, () => {
    it('rejects (403) when any conflict target is owned by another tenant', async () => {
      const { tableConf } = makeTable(['id']);
      const mockPg = createMockPg([{ rows: [{ x: 1 }] }]);
      await assert.rejects(
        () => bulkUpsertEngine({ db: client(mockPg), tableConf, dbTables: {}, request: {}, items: [{ main: { id: 1, name: 'A' } }, { main: { id: 2, name: 'B' } }], tenant: directTenant }),
        (err) => err.statusCode === 403
      );
      assert.equal(mockPg.calls.length, 1);
      assert.ok(!/ON CONFLICT|ON DUPLICATE KEY/.test(mockPg.calls[0].text));
    });

    it('proceeds when all conflict targets are owned or new', async () => {
      const { tableConf } = makeTable(['id']);
      const mockPg = createMockPg([{ rows: [] }, { rows: [{ id: 1 }, { id: 2 }] }]);
      const res = await bulkUpsertEngine({ db: client(mockPg), tableConf, dbTables: {}, request: {}, items: [{ main: { id: 1, name: 'A' } }, { main: { id: 2, name: 'B' } }], tenant: directTenant });
      assert.equal(res.length, 2);
      assert.equal(mockPg.calls.length, 2);
      assert.ok(/ON CONFLICT|ON DUPLICATE KEY/.test(mockPg.calls[1].text));
    });
  });
}
