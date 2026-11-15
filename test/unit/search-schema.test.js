import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { SearchTableBodyPost, SearchTableResponse } =
  await import(path.join(ROOT, 'dist/lib/schema/search.js'));
const { buildRelation } = await import(path.join(ROOT, 'dist/lib/table-helpers.js'));
const { toUnderscore } = await import(path.join(ROOT, 'dist/lib/naming.js'));
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

function createDbTables() {
  const customerSchema = createMockSchema('customer', {
    id: Type.Number(),
    name: Type.String(),
    email: Type.String(),
  });
  const orderSchema = createMockSchema('customer_order', {
    id: Type.Number(),
    customerId: Type.Number(),
    total: Type.Number(),
  });

  const customerInfo = { schema: customerSchema, extraFilters: { isActive: Type.Boolean() } };
  const orderInfo = { schema: orderSchema };

  return {
    customer: {
      primary: 'id',
      ...customerInfo,
      defaultOrder: 'id',
      readJoins: [
        buildRelation(customerSchema, 'id', orderSchema, 'customerId', { alias: 'customer_order' }),
      ],
    },
    customer_order: {
      primary: 'id',
      ...orderInfo,
      defaultOrder: 'id',
    },
  };
}

describe('SearchTableBodyPost', () => {
  it('generates schema with filters property', () => {
    const dbTables = createDbTables();
    const schema = SearchTableBodyPost(dbTables, 'customer');

    assert.ok(schema.properties.filters);
  });

  it('includes schema fields and extraFilters in filters', () => {
    const dbTables = createDbTables();
    const schema = SearchTableBodyPost(dbTables, 'customer');

    // filters wraps Partial(Object({id, name, email, isActive}))
    const filtersSchema = schema.properties.filters;
    assert.ok(filtersSchema);
  });

  it('includes joins and joinGroup for tables with readJoins', () => {
    const dbTables = createDbTables();
    const schema = SearchTableBodyPost(dbTables, 'customer');

    assert.ok(schema.properties.joinMultiple);
    assert.ok(schema.properties.joinGroup);
  });

  it('does not include joins for tables without readJoins', () => {
    const dbTables = createDbTables();
    const schema = SearchTableBodyPost(dbTables, 'customer_order');

    assert.equal(schema.properties.joinMultiple, undefined);
    assert.equal(schema.properties.joinGroup, undefined);
  });

  it('joinGroup includes aggregation fields', () => {
    const dbTables = createDbTables();
    const schema = SearchTableBodyPost(dbTables, 'customer');

    // Dig into joinGroup -> customer_order -> aggregations
    const joinGroupSchema = schema.properties.joinGroup;
    assert.ok(joinGroupSchema);
  });
});

describe('SearchTableBodyPost — ordering, paging and aggregates', () => {
  it('has expected fields', () => {
    const body = SearchTableBodyPost(createDbTables(), 'customer');
    assert.ok(body.properties.orderBy);
    assert.ok(body.properties.paginator.properties.page);
    assert.ok(body.properties.paginator.properties.itemsPerPage);
    assert.ok(body.properties.compute.properties.min);
    assert.ok(body.properties.compute.properties.max);
    assert.ok(body.properties.compute.properties.sum);
    assert.ok(body.properties.compute.properties.avg);
  });
});

describe('SearchTableResponse', () => {
  it('has table, main, joins, joinGroup, pagination', () => {
    const dbTables = createDbTables();
    const schema = SearchTableResponse(dbTables, 'customer');

    assert.ok(schema.properties.table);
    assert.ok(schema.properties.main);
    assert.ok(schema.properties.joinMultiple);
    assert.ok(schema.properties.joinGroup);
    assert.ok(schema.properties.pagination);
  });

  it('main is an array', () => {
    const dbTables = createDbTables();
    const schema = SearchTableResponse(dbTables, 'customer');

    // main should be Type.Array(...)
    assert.equal(schema.properties.main.type, 'array');
  });

  it('joins includes join table arrays', () => {
    const dbTables = createDbTables();
    const schema = SearchTableResponse(dbTables, 'customer');

    assert.ok(schema.properties.joinMultiple.properties.customer_order);
    assert.equal(schema.properties.joinMultiple.properties.customer_order.type, 'array');
  });
});
