import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { resolveTenant, buildTenantWhere, buildTenantJoin, injectTenantValue, validateTenantFK, stripTenantColumn } =
  await import(path.join(ROOT, 'dist/lib/tenant.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
const { QueryClient } = await import(path.join(ROOT, 'dist/lib/db.js'));
const { exportTableInfo } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { getEngine } = await import(path.join(ROOT, 'dist/lib/engine/get.js'));
const { deleteEngine } = await import(path.join(ROOT, 'dist/lib/engine/delete.js'));
const { bulkDeleteEngine } = await import(path.join(ROOT, 'dist/lib/engine/bulk-delete.js'));
const { insertEngine } = await import(path.join(ROOT, 'dist/lib/engine/insert.js'));
const { searchEngine } = await import(path.join(ROOT, 'dist/lib/engine/search.js'));
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
      const response = responses[callIndex] || { rows: [], rowCount: 0 };
      callIndex++;
      return Promise.resolve(response);
    },
  };
}

// ─── resolveTenant ──────────────────────────────────────────

describe('resolveTenant', () => {
  const customerSchema = createMockSchema('customer', { id: Type.Number(), organizationId: Type.Number() });

  it('returns undefined when getTenantId is not defined', async () => {
    const options = { DbTables: {} };
    const tableConf = { Schema: customerSchema, tenantScope: { column: 'organization_id' } };
    const result = await resolveTenant(options, tableConf, {});
    assert.equal(result, undefined);
  });

  it('returns undefined when tenantScope is not defined', async () => {
    const options = { DbTables: {}, getTenantId: () => 1 };
    const tableConf = { Schema: customerSchema };
    const result = await resolveTenant(options, tableConf, {});
    assert.equal(result, undefined);
  });

  it('returns undefined when getTenantId returns null (admin)', async () => {
    const options = { DbTables: {}, getTenantId: () => null };
    const tableConf = { Schema: customerSchema, tenantScope: { column: 'organization_id' } };
    const result = await resolveTenant(options, tableConf, {});
    assert.equal(result, undefined);
  });

  it('returns undefined when getTenantId returns undefined (admin)', async () => {
    const options = { DbTables: {}, getTenantId: () => undefined };
    const tableConf = { Schema: customerSchema, tenantScope: { column: 'organization_id' } };
    const result = await resolveTenant(options, tableConf, {});
    assert.equal(result, undefined);
  });

  it('normalizes single value to array', async () => {
    const options = { DbTables: {}, getTenantId: () => 42 };
    const scope = { column: 'organization_id' };
    const tableConf = { Schema: customerSchema, tenantScope: scope };
    const result = await resolveTenant(options, tableConf, {});
    assert.deepEqual(result, { ids: [42], scope });
  });

  it('passes array as-is', async () => {
    const options = { DbTables: {}, getTenantId: () => [1, 2, 3] };
    const scope = { column: 'organization_id' };
    const tableConf = { Schema: customerSchema, tenantScope: scope };
    const result = await resolveTenant(options, tableConf, {});
    assert.deepEqual(result, { ids: [1, 2, 3], scope });
  });

  it('supports async getTenantId', async () => {
    const options = { DbTables: {}, getTenantId: async () => 99 };
    const scope = { column: 'organization_id' };
    const tableConf = { Schema: customerSchema, tenantScope: scope };
    const result = await resolveTenant(options, tableConf, {});
    assert.deepEqual(result, { ids: [99], scope });
  });
});

// ─── buildTenantWhere ───────────────────────────────────────

describe('buildTenantWhere', () => {
  it('builds = $N for single tenant ID (direct)', () => {
    const scope = { column: 'organization_id' };
    const { sql, values } = buildTenantWhere(scope, [42], 3);
    assert.equal(sql, '"organization_id" = $3');
    assert.deepEqual(values, [42]);
  });

  it('builds IN ($N, $M) for multiple tenant IDs (direct)', () => {
    const scope = { column: 'organization_id' };
    const { sql, values } = buildTenantWhere(scope, [1, 2, 3], 5);
    assert.equal(sql, '"organization_id" IN ($5, $6, $7)');
    assert.deepEqual(values, [1, 2, 3]);
  });

  it('qualifies with through table for indirect scope', () => {
    const throughSchema = createMockSchema('customer', { id: Type.Number(), organizationId: Type.Number() });
    const scope = {
      column: 'organization_id',
      through: { schema: throughSchema, localField: 'customer_id', foreignField: 'id' },
    };
    const { sql, values } = buildTenantWhere(scope, [10], 1);
    assert.equal(sql, '"customer"."organization_id" = $1');
    assert.deepEqual(values, [10]);
  });

  it('qualifies with through table for indirect scope (multiple)', () => {
    const throughSchema = createMockSchema('customer', { id: Type.Number(), organizationId: Type.Number() });
    const scope = {
      column: 'organization_id',
      through: { schema: throughSchema, localField: 'customer_id', foreignField: 'id' },
    };
    const { sql, values } = buildTenantWhere(scope, [10, 20], 1);
    assert.equal(sql, '"customer"."organization_id" IN ($1, $2)');
    assert.deepEqual(values, [10, 20]);
  });
});

// ─── buildTenantJoin ────────────────────────────────────────

describe('buildTenantJoin', () => {
  it('builds INNER JOIN clause', () => {
    const throughSchema = createMockSchema('customer', { id: Type.Number() });
    const scope = {
      column: 'organization_id',
      through: { schema: throughSchema, localField: 'customer_id', foreignField: 'id' },
    };
    const sql = buildTenantJoin(scope, 'customer_order');
    assert.equal(sql, 'INNER JOIN "customer" ON "customer_order"."customer_id" = "customer"."id"');
  });
});

// ─── injectTenantValue ──────────────────────────────────────

describe('injectTenantValue', () => {
  it('adds tenant column when not in record and single tenant', () => {
    const scope = { column: 'organization_id' };
    const record = { name: 'test' };
    injectTenantValue(record, scope, [42]);
    assert.equal(record.organization_id, 42);
  });

  it('does not overwrite existing valid value', () => {
    const scope = { column: 'organization_id' };
    const record = { name: 'test', organization_id: 42 };
    injectTenantValue(record, scope, [42]);
    assert.equal(record.organization_id, 42);
  });

  it('throws 403 when existing value does not match tenant', () => {
    const scope = { column: 'organization_id' };
    const record = { name: 'test', organization_id: 99 };
    assert.throws(
      () => injectTenantValue(record, scope, [42]),
      (err) => err.statusCode === 403
    );
  });

  it('throws 400 when multiple tenants and no value in record', () => {
    const scope = { column: 'organization_id' };
    const record = { name: 'test' };
    assert.throws(
      () => injectTenantValue(record, scope, [1, 2]),
      (err) => err.statusCode === 400
    );
  });

  it('accepts existing value that matches one of multiple tenants', () => {
    const scope = { column: 'organization_id' };
    const record = { name: 'test', organization_id: 2 };
    injectTenantValue(record, scope, [1, 2, 3]);
    assert.equal(record.organization_id, 2);
  });

  it('does nothing for indirect scope', () => {
    const scope = {
      column: 'organization_id',
      through: { schema: {}, localField: 'customer_id', foreignField: 'id' },
    };
    const record = { name: 'test' };
    injectTenantValue(record, scope, [42]);
    assert.equal(record.organization_id, undefined);
  });
});

// ─── validateTenantFK ───────────────────────────────────────

describe('validateTenantFK', () => {
  it('does nothing for empty fkValues', async () => {
    const mockPg = createMockPg();
    const db = new QueryClient(mockPg);
    const throughSchema = createMockSchema('customer', { id: Type.Number(), organizationId: Type.Number() });
    const scope = {
      column: 'organization_id',
      through: { schema: throughSchema, localField: 'customer_id', foreignField: 'id' },
    };
    await validateTenantFK(db, scope, [1], []);
    assert.equal(mockPg.calls.length, 0);
  });

  it('filters out null/undefined from fkValues', async () => {
    const mockPg = createMockPg([{ rows: [], rowCount: 0 }]);
    const db = new QueryClient(mockPg);
    const throughSchema = createMockSchema('customer', { id: Type.Number(), organizationId: Type.Number() });
    const scope = {
      column: 'organization_id',
      through: { schema: throughSchema, localField: 'customer_id', foreignField: 'id' },
    };
    await validateTenantFK(db, scope, [1], [null, undefined]);
    assert.equal(mockPg.calls.length, 0);
  });

  it('passes when no violations found', async () => {
    const mockPg = createMockPg([{ rows: [], rowCount: 0 }]);
    const db = new QueryClient(mockPg);
    const throughSchema = createMockSchema('customer', { id: Type.Number(), organizationId: Type.Number() });
    const scope = {
      column: 'organization_id',
      through: { schema: throughSchema, localField: 'customer_id', foreignField: 'id' },
    };
    await validateTenantFK(db, scope, [10], [1, 2]);
    assert.equal(mockPg.calls.length, 1);
    assert.ok(mockPg.calls[0].text.includes('SELECT "id" FROM "customer"'));
    assert.ok(mockPg.calls[0].text.includes('"id" IN ($1, $2)'));
    assert.ok(mockPg.calls[0].text.includes('"organization_id" NOT IN ($3)'));
    assert.deepEqual(mockPg.calls[0].values, [1, 2, 10]);
  });

  it('throws 403 when violations found', async () => {
    const mockPg = createMockPg([{ rows: [{ id: 2 }], rowCount: 1 }]);
    const db = new QueryClient(mockPg);
    const throughSchema = createMockSchema('customer', { id: Type.Number(), organizationId: Type.Number() });
    const scope = {
      column: 'organization_id',
      through: { schema: throughSchema, localField: 'customer_id', foreignField: 'id' },
    };
    await assert.rejects(
      () => validateTenantFK(db, scope, [10], [1, 2]),
      (err) => err.statusCode === 403
    );
  });

  it('deduplicates fkValues', async () => {
    const mockPg = createMockPg([{ rows: [], rowCount: 0 }]);
    const db = new QueryClient(mockPg);
    const throughSchema = createMockSchema('customer', { id: Type.Number(), organizationId: Type.Number() });
    const scope = {
      column: 'organization_id',
      through: { schema: throughSchema, localField: 'customer_id', foreignField: 'id' },
    };
    await validateTenantFK(db, scope, [10], [1, 1, 2, 2]);
    assert.ok(mockPg.calls[0].text.includes('$1, $2)'));
    assert.deepEqual(mockPg.calls[0].values, [1, 2, 10]);
  });
});

// ─── stripTenantColumn ──────────────────────────────────────

describe('stripTenantColumn', () => {
  it('removes tenant column from direct scope', () => {
    const scope = { column: 'organization_id' };
    const fields = { name: 'test', organization_id: 42 };
    stripTenantColumn(fields, scope);
    assert.equal(fields.organization_id, undefined);
    assert.equal(fields.name, 'test');
  });

  it('does nothing for indirect scope', () => {
    const scope = {
      column: 'organization_id',
      through: { schema: {}, localField: 'customer_id', foreignField: 'id' },
    };
    const fields = { name: 'test', organization_id: 42 };
    stripTenantColumn(fields, scope);
    assert.equal(fields.organization_id, 42);
  });
});

// ─── Engine integration: getEngine with tenant ──────────────

describe('getEngine with direct tenant', () => {
  const customerFields = { id: Type.Number(), name: Type.String(), organizationId: Type.Number() };
  const customerSchema = createMockSchema('customer', customerFields);
  const customerInfo = exportTableInfo(customerSchema);
  const tableConf = { primary: 'id', ...customerInfo, defaultOrder: 'id' };

  it('adds tenant WHERE for direct scope', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', organization_id: 42 }], rowCount: 1 },
    ]);
    const db = new QueryClient(mockPg);
    const tenant = { ids: [42], scope: { column: 'organization_id' } };

    await getEngine({ db, tableConf, id: '1', tenant });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('"id" = $1'));
    assert.ok(sql.includes('"organization_id" = $2'));
    assert.deepEqual(mockPg.calls[0].values, ['1', 42]);
  });

  it('returns 404 when tenant does not match', async () => {
    const mockPg = createMockPg([{ rows: [], rowCount: 0 }]);
    const db = new QueryClient(mockPg);
    const tenant = { ids: [99], scope: { column: 'organization_id' } };

    await assert.rejects(
      () => getEngine({ db, tableConf, id: '1', tenant }),
      (err) => err.statusCode === 404
    );
  });
});

describe('getEngine with indirect tenant', () => {
  const orderFields = { id: Type.Number(), customerId: Type.Number(), total: Type.Number() };
  const orderSchema = createMockSchema('customer_order', orderFields);
  const orderInfo = exportTableInfo(orderSchema);
  const tableConf = { primary: 'id', ...orderInfo, defaultOrder: 'id' };
  const customerSchema = createMockSchema('customer', { id: Type.Number(), organizationId: Type.Number() });

  it('adds INNER JOIN and tenant WHERE for indirect scope', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, customer_id: 10, total: 100 }], rowCount: 1 },
    ]);
    const db = new QueryClient(mockPg);
    const tenant = {
      ids: [42],
      scope: {
        column: 'organization_id',
        through: { schema: customerSchema, localField: 'customer_id', foreignField: 'id' },
      },
    };

    await getEngine({ db, tableConf, id: '1', tenant });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('INNER JOIN "customer"'));
    assert.ok(sql.includes('"customer_order"."customer_id" = "customer"."id"'));
    assert.ok(sql.includes('"customer"."organization_id" = $2'));
  });
});

// ─── Engine integration: deleteEngine with tenant ───────────

describe('deleteEngine with direct tenant', () => {
  const customerFields = { id: Type.Number(), name: Type.String(), organizationId: Type.Number() };
  const customerSchema = createMockSchema('customer', customerFields);
  const customerInfo = exportTableInfo(customerSchema);
  const tableConf = { primary: 'id', ...customerInfo, defaultOrder: 'id' };

  it('adds tenant condition to DELETE', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', organization_id: 42 }], rowCount: 1 },
    ]);
    const db = new QueryClient(mockPg);
    const tenant = { ids: [42], scope: { column: 'organization_id' } };

    await deleteEngine({ db, tableConf, id: '1', tenant });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('DELETE FROM "customer"'));
    assert.ok(sql.includes('"id" = $1'));
    assert.ok(sql.includes('"organization_id" = $2'));
    assert.ok(sql.includes('RETURNING *'));
  });
});

// ─── Engine integration: bulkDeleteEngine with tenant ───────

describe('bulkDeleteEngine with direct tenant', () => {
  const customerFields = { id: Type.Number(), name: Type.String(), organizationId: Type.Number() };
  const customerSchema = createMockSchema('customer', customerFields);
  const customerInfo = exportTableInfo(customerSchema);
  const tableConf = { primary: 'id', ...customerInfo, defaultOrder: 'id' };

  it('adds tenant condition to bulk DELETE', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', organization_id: 42 }], rowCount: 1 },
    ]);
    const db = new QueryClient(mockPg);
    const tenant = { ids: [42], scope: { column: 'organization_id' } };

    await bulkDeleteEngine({ db, tableConf, ids: [1, 2], tenant });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('DELETE FROM "customer"'));
    assert.ok(sql.includes('"id" IN ($1, $2)'));
    assert.ok(sql.includes('"organization_id" = $3'));
  });
});

// ─── Engine integration: insertEngine with tenant ───────────

describe('insertEngine with direct tenant', () => {
  const customerFields = { id: Type.Number(), name: Type.String(), organizationId: Type.Number() };
  const customerSchema = createMockSchema('customer', customerFields);
  const customerInfo = exportTableInfo(customerSchema);
  const tableConf = { primary: 'id', ...customerInfo, defaultOrder: 'id' };

  it('injects tenant value into record on insert', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', organization_id: 42 }], rowCount: 1 },
    ]);
    const db = new QueryClient(mockPg);
    const tenant = { ids: [42], scope: { column: 'organization_id' } };

    await insertEngine({
      db, tableConf, dbTables: {}, request: {},
      record: { name: 'Mario' },
      tenant,
    });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('"organization_id"'));
    assert.ok(mockPg.calls[0].values.includes(42));
  });

  it('throws 403 when record has wrong tenant value', async () => {
    const mockPg = createMockPg([]);
    const db = new QueryClient(mockPg);
    const tenant = { ids: [42], scope: { column: 'organization_id' } };

    await assert.rejects(
      () => insertEngine({
        db, tableConf, dbTables: {}, request: {},
        record: { name: 'Mario', organizationId: 99 },
        tenant,
      }),
      (err) => err.statusCode === 403
    );
  });
});

// ─── Engine integration: searchEngine with tenant ───────────

describe('searchEngine with direct tenant', () => {
  const customerFields = { id: Type.Number(), name: Type.String(), organizationId: Type.Number() };
  const customerSchema = createMockSchema('customer', customerFields);
  const customerInfo = exportTableInfo(customerSchema);
  const tableConf = { primary: 'id', ...customerInfo, defaultOrder: 'id' };
  const dbTables = { customer: tableConf };

  it('adds tenant WHERE to search query', async () => {
    const mockPg = createMockPg([
      { rows: [{ id: 1, name: 'Mario', organization_id: 42 }], rowCount: 1 },
    ]);
    const db = new QueryClient(mockPg);
    const tenant = { ids: [42], scope: { column: 'organization_id' } };

    await searchEngine(dbTables, { db, tableConf, tenant });

    const sql = mockPg.calls[0].text;
    assert.ok(sql.includes('"organization_id" = $1'));
  });

  it('no tenant filtering without tenant context', async () => {
    const mockPg = createMockPg([
      { rows: [], rowCount: 0 },
    ]);
    const db = new QueryClient(mockPg);

    await searchEngine(dbTables, { db, tableConf });

    const sql = mockPg.calls[0].text;
    assert.ok(!sql.includes('organization_id'));
  });
});
