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

  it('filters() does not auto-apply extraFilters (they go through extendedCondition)', () => {
    const schema = createMockSchema('customer', {
      id: Type.Number(),
      name: Type.String(),
    });
    const extraFilters = { q: Type.String() };
    const { filters } = exportTableInfo(schema, extraFilters);

    // q is an extraFilter, not a real column - should not generate a condition
    const condition = filters({ q: 'test' });
    const values = condition.getValues();
    assert.equal(values.length, 0);
  });

  it('filters() extraFilters are available via extendedCondition', () => {
    const schema = createMockSchema('customer', {
      id: Type.Number(),
      name: Type.String(),
    });
    const extraFilters = { q: Type.String() };
    const { filters } = exportTableInfo(schema, extraFilters, (condition, opts) => {
      if (opts.q) {
        condition.isILike('name', `%${opts.q}%`);
      }
    });

    const condition = filters({ q: 'test' });
    const values = condition.getValues();
    assert.equal(values.length, 1);
    assert.ok(values.includes('%test%'));
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
  it('returns a JoinDefinition object with explicit alias', () => {
    const mainSchema = createMockSchema('customer', { id: Type.Number() });
    const joinSchema = createMockSchema('customer_order', { customerId: Type.Number() });

    const result = buildRelation(mainSchema, 'id', joinSchema, 'customerId', { alias: 'orders' });

    assert.equal(result.joinSchema, joinSchema);
    assert.equal(result.joinField, 'customerId');
    assert.equal(result.mainField, 'id');
    assert.equal(result.alias, 'orders');
    assert.equal(result.selection, '*');
    assert.equal(result.unique, false);
  });

  it('defaults alias to joinSchema.tableName when omitted', () => {
    const mainSchema = createMockSchema('customer', { id: Type.Number() });
    const joinSchema = createMockSchema('customer_order', { customerId: Type.Number() });

    const a = buildRelation(mainSchema, 'id', joinSchema, 'customerId');
    assert.equal(a.alias, 'customer_order');

    const b = buildRelation(mainSchema, 'id', joinSchema, 'customerId', {});
    assert.equal(b.alias, 'customer_order');

    const c = buildRelation(mainSchema, 'id', joinSchema, 'customerId', { selection: 'id' });
    assert.equal(c.alias, 'customer_order');
    assert.equal(c.selection, 'id');
  });

  it('supports custom selection and unique flag', () => {
    const mainSchema = createMockSchema('customer', { id: Type.Number() });
    const joinSchema = createMockSchema('customer_order', { customerId: Type.Number() });

    const result = buildRelation(mainSchema, 'id', joinSchema, 'customerId', {
      alias: 'orders',
      selection: 'id, total',
      unique: true,
    });

    assert.equal(result.selection, 'id, total');
    assert.equal(result.unique, true);
  });

  it('supports array mainField', () => {
    const mainSchema = createMockSchema('customer', { id: Type.Number() });
    const joinSchema = createMockSchema('report', { customerId: Type.Number() });

    const result = buildRelation(mainSchema, ['id', 'name'], joinSchema, 'customerId', { alias: 'reports' });

    assert.deepEqual(result.mainField, ['id', 'name']);
  });
});

describe('defineTable - computedFields validation', () => {
  it('throws when computed name collides with a schema field', async () => {
    const { defineTable } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
    const schema = createMockSchema('customer', { id: Type.Number(), name: Type.String() });
    assert.throws(
      () => defineTable({
        primary: 'id',
        ...exportTableInfo(schema),
        computedFields: {
          name: ({ qiCol }) => ({ expr: qiCol('name'), values: [], type: Type.String() }),
        },
      }),
      /collides with a schema field/
    );
  });

  it('throws when computed name collides with an extraFilters key', async () => {
    const { defineTable } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
    const schema = createMockSchema('customer', { id: Type.Number() });
    assert.throws(
      () => defineTable({
        primary: 'id',
        ...exportTableInfo(schema, { q: Type.String() }, () => {}),
        computedFields: {
          q: ({ qiCol }) => ({ expr: qiCol('id'), values: [], type: Type.String() }),
        },
      }),
      /collides with an extraFilters key/
    );
  });

  it('accepts computed fields with no clashes', async () => {
    const { defineTable } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
    const schema = createMockSchema('customer', {
      id: Type.Number(),
      firstName: Type.String(),
      lastName: Type.String(),
    });
    const conf = defineTable({
      primary: 'id',
      ...exportTableInfo(schema),
      computedFields: {
        fullName: ({ qiCol }) => ({
          expr: `${qiCol('firstName')} || ' ' || ${qiCol('lastName')}`,
          values: [],
          type: Type.String(),
        }),
      },
    });
    assert.ok(conf.computedFields.fullName);
  });
});

describe('defineTable - alias uniqueness', () => {
  it('rejects duplicate aliases in allowedReadJoins', async () => {
    const { defineTable } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
    const mainSchema = createMockSchema('session', { id: Type.Number(), userId: Type.Number() });
    const userSchema = createMockSchema('user', { id: Type.Number() });

    assert.throws(
      () => defineTable({
        primary: 'id',
        ...exportTableInfo(mainSchema),
        allowedReadJoins: [
          buildRelation(mainSchema, 'userId', userSchema, 'id', { unique: true }), // alias defaults to 'user'
          buildRelation(mainSchema, 'userId', userSchema, 'id', { unique: true }), // alias defaults to 'user' again
        ],
      }),
      /duplicate alias 'user'/
    );
  });

  it('accepts duplicate join targets when aliases are explicit and distinct', async () => {
    const { defineTable } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
    const mainSchema = createMockSchema('session', { id: Type.Number(), createdBy: Type.Number(), updatedBy: Type.Number() });
    const userSchema = createMockSchema('user', { id: Type.Number() });

    const conf = defineTable({
      primary: 'id',
      ...exportTableInfo(mainSchema),
      allowedReadJoins: [
        buildRelation(mainSchema, 'createdBy', userSchema, 'id', { alias: 'creator', unique: true }),
        buildRelation(mainSchema, 'updatedBy', userSchema, 'id', { alias: 'updater', unique: true }),
      ],
    });
    assert.equal(conf.allowedReadJoins.length, 2);
    assert.equal(conf.allowedReadJoins[0].alias, 'creator');
    assert.equal(conf.allowedReadJoins[1].alias, 'updater');
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
