import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { exportTableInfo, buildRelation, buildUpsertRule, buildUpsertRules } =
  await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
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

describe('exportTableInfo', () => {
  it('returns Schema, filters function, and extraFilters', () => {
    const schema = createMockSchema('customer', {
      id: Type.Number(),
      name: Type.String(),
    });
    const result = exportTableInfo(schema);

    assert.equal(result.Schema, schema);
    assert.equal(typeof result.filters, 'function');
    assert.deepEqual(result.extraFilters, {});
  });

  it('filters() builds condition for present fields', () => {
    const schema = createMockSchema('customer', {
      id: Type.Number(),
      name: Type.String(),
      email: Type.String(),
    });
    const { filters } = exportTableInfo(schema);

    const condition = filters({ name: 'Mario', email: 'mario@test.it' });
    const values = condition.getValues();
    const sql = condition.build(1, (i) => `$${i}`);

    assert.equal(values.length, 2);
    assert.ok(values.includes('Mario'));
    assert.ok(values.includes('mario@test.it'));
    assert.ok(sql.includes('name'));
    assert.ok(sql.includes('email'));
  });

  it('filters() skips null and undefined values', () => {
    const schema = createMockSchema('customer', {
      id: Type.Number(),
      name: Type.String(),
    });
    const { filters } = exportTableInfo(schema);

    const condition = filters({ id: null, name: undefined });
    const values = condition.getValues();
    assert.equal(values.length, 0);
  });

  it('filters() handles extraFilters fields', () => {
    const schema = createMockSchema('customer', {
      id: Type.Number(),
      name: Type.String(),
    });
    const extraFilters = { isActive: Type.Boolean() };
    const { filters } = exportTableInfo(schema, extraFilters);

    const condition = filters({ isActive: true });
    const values = condition.getValues();
    assert.equal(values.length, 1);
    assert.ok(values.includes(true));
  });

  it('filters() invokes extendedCondition callback', () => {
    const schema = createMockSchema('customer', {
      id: Type.Number(),
      name: Type.String(),
    });
    let called = false;
    const { filters } = exportTableInfo(schema, {}, (condition, opts) => {
      called = true;
      if (opts.q) {
        condition.isLike('name', `%${opts.q}%`);
      }
    });

    const condition = filters({ q: 'test' });
    assert.ok(called);
    const values = condition.getValues();
    assert.ok(values.includes('%test%'));
  });
});

describe('buildRelation', () => {
  it('returns a JoinDefinition tuple', () => {
    const mainSchema = createMockSchema('customer', { id: Type.Number() });
    const joinSchema = createMockSchema('customer_order', { customerId: Type.Number() });

    const result = buildRelation(mainSchema, 'id', joinSchema, 'customerId');

    assert.equal(result.length, 4);
    assert.equal(result[0], joinSchema);
    assert.equal(result[1], 'customerId');
    assert.equal(result[2], 'id');
    assert.equal(result[3], '*');
  });

  it('supports custom selection', () => {
    const mainSchema = createMockSchema('customer', { id: Type.Number() });
    const joinSchema = createMockSchema('customer_order', { customerId: Type.Number() });

    const result = buildRelation(mainSchema, 'id', joinSchema, 'customerId', 'id, total');

    assert.equal(result[3], 'id, total');
  });

  it('supports array mainField', () => {
    const mainSchema = createMockSchema('customer', { id: Type.Number() });
    const joinSchema = createMockSchema('report', { customerId: Type.Number() });

    const result = buildRelation(mainSchema, ['id', 'name'], joinSchema, 'customerId');

    assert.deepEqual(result[2], ['id', 'name']);
  });
});

describe('buildUpsertRule', () => {
  it('returns a tuple [schema, columns]', () => {
    const schema = createMockSchema('customer', { id: Type.Number() });
    const result = buildUpsertRule(schema, ['id']);

    assert.equal(result[0], schema);
    assert.deepEqual(result[1], ['id']);
  });
});

describe('buildUpsertRules', () => {
  it('creates a Map from rules', () => {
    const schema1 = createMockSchema('customer', { id: Type.Number() });
    const schema2 = createMockSchema('product', { id: Type.Number() });

    const map = buildUpsertRules(
      buildUpsertRule(schema1, ['id']),
      buildUpsertRule(schema2, ['id', 'name'])
    );

    assert.ok(map instanceof Map);
    assert.equal(map.size, 2);
    assert.deepEqual(map.get(schema1), ['id']);
    assert.deepEqual(map.get(schema2), ['id', 'name']);
  });
});
