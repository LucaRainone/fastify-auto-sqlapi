import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { deleteEngine } = await import(path.join(ROOT, 'dist/lib/engine/rest/delete.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
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

const customerFields = {
  id: Type.Number(),
  name: Type.String(),
  email: Type.String(),
};

function createTestTableConf(mockPg) {
  const customerSchema = createMockSchema('customer', customerFields);
  const customerInfo = exportTableInfo(customerSchema);

  const tableConf = {
    primary: 'id',
    ...customerInfo,
    defaultOrder: 'id',
  };

  return { tableConf, db: new QueryClient(mockPg) };
}

describe('deleteEngine', () => {
  it('deletes record by PK and returns PK-only', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    const result = await deleteEngine({ db, tableConf, id: '1' });

    assert.equal(result.main.id, '1');
    assert.equal(result.main.name, undefined);
    assert.ok(mockPg.calls[0].text.includes('DELETE FROM "customer"'));
    assert.ok(mockPg.calls[0].text.includes('WHERE'));
    assert.ok(!mockPg.calls[0].text.includes('RETURNING'));
  });

  it('uses correct PK column in WHERE', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    await deleteEngine({ db, tableConf, id: '42' });

    assert.ok(mockPg.calls[0].text.includes('"id"'));
    assert.deepEqual(mockPg.calls[0].values, ['42']);
  });

  it('throws 404 when record not found', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 0 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    await assert.rejects(
      () => deleteEngine({ db, tableConf, id: '999' }),
      (err) => err.statusCode === 404
    );
  });

  it('executes exactly one query', async () => {
    const mockPg = createMockPg([
      { rows: [], affectedRows: 1 },
    ]);
    const { tableConf, db } = createTestTableConf(mockPg);

    await deleteEngine({ db, tableConf, id: '1' });

    assert.equal(mockPg.calls.length, 1);
  });

  describe('beforeDelete hook', () => {
    it('calls beforeDelete with (db, request, id) then deletes', async () => {
      const mockPg = createMockPg([{ rows: [], affectedRows: 1 }]);
      const { tableConf, db } = createTestTableConf(mockPg);
      const seen = [];
      tableConf.beforeDelete = (hookDb, req, id) => {
        seen.push({ sameDb: hookDb === db, req, id });
      };
      const request = { url: '/x' };

      await deleteEngine({ db, tableConf, id: '7', request });

      assert.equal(seen.length, 1);
      assert.equal(seen[0].sameDb, true);
      assert.equal(seen[0].req, request);
      assert.equal(seen[0].id, '7');
      // Without tenant: no ownership SELECT, just the DELETE → single query
      assert.equal(mockPg.calls.length, 1);
      assert.ok(mockPg.calls[0].text.includes('DELETE FROM "customer"'));
    });

    it('aborts the deletion when beforeDelete throws (no DELETE executed)', async () => {
      const mockPg = createMockPg([{ rows: [], affectedRows: 1 }]);
      const { tableConf, db } = createTestTableConf(mockPg);
      tableConf.beforeDelete = () => {
        const e = new Error('blocked by referential rule');
        e.statusCode = 409;
        throw e;
      };

      await assert.rejects(
        () => deleteEngine({ db, tableConf, id: '7', request: {} }),
        (err) => err.statusCode === 409 && err.message === 'blocked by referential rule'
      );
      assert.equal(mockPg.calls.length, 0);
    });

    it('tenant: runs hook only after ownership confirmed, then deletes', async () => {
      const mockPg = createMockPg([
        { rows: [{ pk: 7 }], affectedRows: 1 }, // ownership SELECT → owned
        { rows: [], affectedRows: 1 },          // DELETE
      ]);
      const { tableConf, db } = createTestTableConf(mockPg);
      tableConf.tenantScope = { column: 'organization_id' };
      let called = false;
      tableConf.beforeDelete = () => { called = true; };

      const result = await deleteEngine({
        db, tableConf, id: '7', request: {},
        tenant: { ids: [3], scope: { column: 'organization_id' } },
      });

      assert.equal(called, true);
      assert.equal(result.main.id, '7');
      // ownership SELECT then tenant-scoped DELETE
      assert.equal(mockPg.calls.length, 2);
      assert.ok(mockPg.calls[0].text.startsWith('SELECT DISTINCT'));
      assert.ok(mockPg.calls[0].text.includes('"organization_id" IN'));
      assert.ok(mockPg.calls[1].text.includes('DELETE FROM "customer"'));
    });

    it('tenant: does NOT run hook for a non-owned record (404, no DELETE)', async () => {
      const mockPg = createMockPg([
        { rows: [], affectedRows: 0 }, // ownership SELECT → not owned
      ]);
      const { tableConf, db } = createTestTableConf(mockPg);
      tableConf.tenantScope = { column: 'organization_id' };
      let called = false;
      tableConf.beforeDelete = () => { called = true; };

      await assert.rejects(
        () => deleteEngine({
          db, tableConf, id: '7', request: {},
          tenant: { ids: [3], scope: { column: 'organization_id' } },
        }),
        (err) => err.statusCode === 404
      );

      assert.equal(called, false);
      // Only the ownership SELECT ran; no DELETE
      assert.equal(mockPg.calls.length, 1);
      assert.ok(mockPg.calls[0].text.startsWith('SELECT DISTINCT'));
    });
  });
});
